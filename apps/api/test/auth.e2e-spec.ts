import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createAdmin, createTestApp, DEMO_PASSWORD, signIn } from './helpers.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';

describe('Authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });
  afterAll(async () => app.close());

  it('serves health checks without a session', async () => {
    await request(app.getHttpServer()).get(`${API}/health`).expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get(`${API}/health/ready`).expect(200);
  });

  it('denies protected routes without a session', async () => {
    const res = await request(app.getHttpServer()).get(`${API}/auth/me`).expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
    expect(res.body.requestId).toBeTruthy();
  });

  it('signs in with a valid password and returns the user, permissions and CSRF token', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ username: 'DEMO.Sales', password: DEMO_PASSWORD })
      .expect(200);
    expect(res.body.user.username).toBe('demo.sales');
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.permissions).toContain('job.create');
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/jf_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('rejects a wrong password with a generic message and audits it', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ username: 'demo.design', password: 'wrong-password' })
      .expect(401);
    expect(res.body.message).toBe('Invalid username or password');
    const unknown = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ username: 'nobody.here', password: 'wrong-password' })
      .expect(401);
    expect(unknown.body.message).toBe('Invalid username or password');
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'demo.design' } });
    expect(await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.login_failed' } })).toBeGreaterThan(0);
  });

  it('locks the account after 5 failed attempts, even for the right password', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'design_member' } });
    const user = await prisma.user.create({
      data: {
        username: 'lock.test',
        fullName: 'Lock Test',
        passwordHash: await hashPassword('Right-Password-123'),
        roles: { create: [{ roleId: role.id }] },
      },
    });
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).post(`${API}/auth/login`).send({ username: 'lock.test', password: 'nope' }).expect(401);
    }
    await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ username: 'lock.test', password: 'Right-Password-123' })
      .expect(423);
    expect(await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.account_locked' } })).toBe(1);

    // An administrator unlocks it.
    const admin = await createAdmin(prisma);
    const { agent, csrf } = await signIn(app, admin.username, admin.password);
    await agent.post(`${API}/users/${user.id}/unlock`).set('X-CSRF-Token', csrf).expect(200);
    await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ username: 'lock.test', password: 'Right-Password-123' })
      .expect(200);
  });

  it('rejects state-changing requests without the CSRF token', async () => {
    const { agent, csrf } = await signIn(app, 'demo.quality');
    await agent.post(`${API}/auth/logout`).expect(403);
    await agent.post(`${API}/auth/logout`).set('X-CSRF-Token', 'wrong').expect(403);
    await agent.post(`${API}/auth/logout`).set('X-CSRF-Token', csrf).expect(204);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('Origin', 'http://evil.example')
      .send({ username: 'demo.sales', password: DEMO_PASSWORD })
      .expect(403);
    expect(res.body.message).toMatch(/Cross-origin/);
  });

  it('invalidates the session on logout', async () => {
    const { agent, csrf } = await signIn(app, 'demo.logistic');
    await agent.get(`${API}/auth/me`).expect(200);
    await agent.post(`${API}/auth/logout`).set('X-CSRF-Token', csrf).expect(204);
    await agent.get(`${API}/auth/me`).expect(401);
  });

  it('forces a password change, then rotates the session and ends other sessions', async () => {
    const admin = await createAdmin(prisma);
    const adminSession = await signIn(app, admin.username, admin.password);
    const departments = await adminSession.agent.get(`${API}/departments`).expect(200);
    const sales = departments.body.find((d: { code: string }) => d.code === 'SALES');
    const roles = await adminSession.agent.get(`${API}/roles`).expect(200);
    const salesMember = roles.body.find((r: { key: string }) => r.key === 'sales_member');

    const created = await adminSession.agent
      .post(`${API}/users`)
      .set('X-CSRF-Token', adminSession.csrf)
      .send({
        username: 'new.starter',
        fullName: 'New Starter',
        password: 'Temporary-Pass-1',
        roleIds: [salesMember.id],
        departments: [{ departmentId: sales.id }],
      })
      .expect(201);
    expect(created.body.mustChangePassword).toBe(true);

    const first = await signIn(app, 'new.starter', 'Temporary-Pass-1');
    const second = await signIn(app, 'new.starter', 'Temporary-Pass-1');
    // Blocked everywhere except me / change-password / logout.
    await first.agent.get(`${API}/departments`).expect(403);
    await first.agent.get(`${API}/auth/me`).expect(200);

    await first.agent
      .post(`${API}/auth/change-password`)
      .set('X-CSRF-Token', first.csrf)
      .send({ currentPassword: 'Temporary-Pass-1', newPassword: 'short' })
      .expect(400);
    await first.agent
      .post(`${API}/auth/change-password`)
      .set('X-CSRF-Token', first.csrf)
      .send({ currentPassword: 'wrong-current-password', newPassword: 'Brand-New-Pass-99' })
      .expect(400);
    const changed = await first.agent
      .post(`${API}/auth/change-password`)
      .set('X-CSRF-Token', first.csrf)
      .send({ currentPassword: 'Temporary-Pass-1', newPassword: 'Brand-New-Pass-99' })
      .expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    expect(changed.body.csrfToken).not.toBe(first.csrf);

    // The other browser was signed out; this one continues with the new cookie.
    await second.agent.get(`${API}/auth/me`).expect(401);
    await first.agent.get(`${API}/departments`).expect(200);
    await signIn(app, 'new.starter', 'Brand-New-Pass-99');
  });

  it('rejects malformed bodies with field messages', async () => {
    const res = await request(app.getHttpServer()).post(`${API}/auth/login`).send({ username: 'x' }).expect(400);
    expect(JSON.stringify(res.body.message)).toMatch(/password/);
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get(`${API}/health`);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

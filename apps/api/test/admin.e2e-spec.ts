import type { INestApplication } from '@nestjs/common';
import { API, createAdmin, createTestApp, signIn, type SignedIn, uniqueName } from './helpers.js';
import type { PrismaService } from '../src/core/prisma.service.js';

describe('Administration: users, departments, roles, audit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: SignedIn;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const creds = await createAdmin(prisma);
    admin = await signIn(app, creds.username, creds.password);
  });
  afterAll(async () => app.close());

  const post = (path: string, body: unknown) => admin.agent.post(`${API}${path}`).set('X-CSRF-Token', admin.csrf).send(body as object);
  const put = (path: string, body: unknown) => admin.agent.put(`${API}${path}`).set('X-CSRF-Token', admin.csrf).send(body as object);
  const patch = (path: string, body: unknown) => admin.agent.patch(`${API}${path}`).set('X-CSRF-Token', admin.csrf).send(body as object);

  it('lets an administrator create a department, and audits it', async () => {
    const res = await post('/departments', { code: 'acp', name: 'ACP Cladding' }).expect(201);
    expect(res.body.code).toBe('ACP');
    const audit = await admin.agent.get(`${API}/audit-logs?entityId=${res.body.id}`).expect(200);
    expect(audit.body.items[0]).toMatchObject({ action: 'department.created', entityType: 'department' });
    expect(audit.body.items[0].actorUsername).toMatch(/^admin\./);

    await post('/departments', { code: 'ACP', name: 'Duplicate' }).expect(409);
    const renamed = await patch(`/departments/${res.body.id}`, { name: 'ACP Cladding Team' }).expect(200);
    expect(renamed.body.name).toBe('ACP Cladding Team');
  });

  it('manages users: create, search, roles, departments, disable', async () => {
    const departments = (await admin.agent.get(`${API}/departments`)).body as { id: string; code: string }[];
    const design = departments.find((d) => d.code === 'DESIGN')!;
    const roles = (await admin.agent.get(`${API}/roles`)).body as { id: string; key: string }[];
    const designLeader = roles.find((r) => r.key === 'design_leader')!;
    const username = uniqueName('designer');

    const created = await post('/users', {
      username,
      fullName: 'Dina Designer',
      password: 'Initial-Password-1',
    }).expect(201);
    expect(created.body.roles).toEqual([]);

    const withRoles = await put(`/users/${created.body.id}/roles`, { roleIds: [designLeader.id] }).expect(200);
    expect(withRoles.body.roles.map((r: { key: string }) => r.key)).toEqual(['design_leader']);
    const withDept = await put(`/users/${created.body.id}/departments`, {
      departments: [{ departmentId: design.id, isLeader: true }],
    }).expect(200);
    expect(withDept.body.departments[0]).toMatchObject({ code: 'DESIGN', isLeader: true });

    const search = await admin.agent.get(`${API}/users?search=dina`).expect(200);
    expect(search.body.items.some((u: { id: string }) => u.id === created.body.id)).toBe(true);

    await post('/users', { username, fullName: 'Duplicate', password: 'Initial-Password-1' }).expect(409);

    // Disabling ends the user's sessions immediately.
    await post(`/users/${created.body.id}/reset-password`, { newPassword: 'Another-Password-2' }).expect(200);
    await prisma.user.update({ where: { id: created.body.id }, data: { mustChangePassword: false } });
    const userSession = await signIn(app, username, 'Another-Password-2');
    await userSession.agent.get(`${API}/departments`).expect(200);
    await patch(`/users/${created.body.id}`, { status: 'DISABLED' }).expect(200);
    await userSession.agent.get(`${API}/departments`).expect(401);
    const login = await userSession.agent.post(`${API}/auth/login`).send({ username, password: 'Another-Password-2' });
    expect(login.status).toBe(401);

    const actions = (
      await admin.agent.get(`${API}/audit-logs?entityId=${created.body.id}&pageSize=50`).expect(200)
    ).body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.created', 'user.roles_changed', 'user.departments_changed', 'user.password_reset', 'user.disabled']),
    );
  });

  it('never stores passwords in the audit log', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: 'user.created' } });
    for (const r of rows) expect(JSON.stringify(r.after ?? {})).not.toMatch(/password/i);
  });

  it('keeps at least one active System Administrator', async () => {
    const me = (await admin.agent.get(`${API}/auth/me`)).body.user;
    await patch(`/users/${me.id}`, { status: 'DISABLED' }).expect(400);
  });

  it('protects the administrator role from losing user and role management', async () => {
    const roles = (await admin.agent.get(`${API}/roles`)).body as { id: string; key: string; permissionKeys: string[] }[];
    const sysAdmin = roles.find((r) => r.key === 'system_admin')!;
    await put(`/roles/${sysAdmin.id}/permissions`, { permissionKeys: ['audit.view'] }).expect(400);
  });

  it('edits role permissions, records the change and emits an outbox event', async () => {
    const created = await post('/roles', { key: uniqueName('viewer').replace(/\./g, '_'), name: 'Viewer', scope: 'GLOBAL' }).expect(201);
    await put(`/roles/${created.body.id}/permissions`, { permissionKeys: ['job.view', 'unknown.key'] }).expect(400);
    const updated = await put(`/roles/${created.body.id}/permissions`, { permissionKeys: ['job.view', 'report.view'] }).expect(200);
    expect(updated.body.permissionKeys).toEqual(['job.view', 'report.view']);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: created.body.id, type: 'role.permissions_changed' } })).toBe(1);
    const audit = await admin.agent.get(`${API}/audit-logs?entityId=${created.body.id}&action=role.permissions`).expect(200);
    expect(audit.body.items[0].after.added).toEqual(['job.view', 'report.view']);

    await put(`/roles/${created.body.id}/departments`, { departmentIds: [] }).expect(200);
    const dept = (await admin.agent.get(`${API}/departments`)).body[0];
    await put(`/roles/${created.body.id}/departments`, { departmentIds: [dept.id] }).expect(400);
  });

  it('applies permission changes to signed-in users on their next request', async () => {
    const roles = (await admin.agent.get(`${API}/roles`)).body as { id: string; key: string; permissionKeys: string[] }[];
    const proLeader = roles.find((r) => r.key === 'pro_leader')!;
    const pro = await signIn(app, 'demo.pro.lead');
    expect((await pro.agent.get(`${API}/auth/me`)).body.permissions).toContain('authority.mark_not_required');

    await put(`/roles/${proLeader.id}/permissions`, {
      permissionKeys: proLeader.permissionKeys.filter((k) => k !== 'authority.mark_not_required'),
    }).expect(200);
    expect((await pro.agent.get(`${API}/auth/me`)).body.permissions).not.toContain('authority.mark_not_required');
    await put(`/roles/${proLeader.id}/permissions`, { permissionKeys: proLeader.permissionKeys }).expect(200);
  });

  it('returns 404 for unknown ids and 400 for malformed ids', async () => {
    await admin.agent.get(`${API}/users/0197a3c4-0000-7000-8000-000000000000`).expect(404);
    await admin.agent.get(`${API}/users/not-a-uuid`).expect(400);
  });

  describe('non-administrators', () => {
    it.each(['demo.sales', 'demo.pro.lead', 'demo.management'])('%s cannot use admin endpoints, even by calling the API directly', async (username) => {
      const s = await signIn(app, username);
      await s.agent.get(`${API}/users`).expect(403);
      await s.agent.get(`${API}/roles`).expect(403);
      await s.agent.get(`${API}/permissions`).expect(403);
      await s.agent.get(`${API}/audit-logs`).expect(403);
      await s.agent.post(`${API}/departments`).set('X-CSRF-Token', s.csrf).send({ code: 'HACK', name: 'Hack' }).expect(403);
      await s.agent.put(`${API}/users/${s.userId}/roles`).set('X-CSRF-Token', s.csrf).send({ roleIds: [] }).expect(403);
    });

    it('management is view-only', async () => {
      const s = await signIn(app, 'demo.management');
      const me = (await s.agent.get(`${API}/auth/me`)).body;
      expect(me.permissions).toContain('job.view');
      for (const p of ['job.create', 'stage.complete', 'stage.reopen', 'task.assign', 'authority.mark_not_required', 'message.post']) {
        expect(me.permissions).not.toContain(p);
      }
    });

    it('PRO has no design permissions and Design has no authority permissions', async () => {
      const pro = (await (await signIn(app, 'demo.pro.lead')).agent.get(`${API}/auth/me`)).body.permissions as string[];
      const design = (await (await signIn(app, 'demo.design.lead')).agent.get(`${API}/auth/me`)).body.permissions as string[];
      expect(pro.filter((p) => p.startsWith('artwork.') || p.startsWith('correction_round.'))).toEqual([]);
      expect(design.filter((p) => p.startsWith('authority.'))).toEqual([]);
    });
  });

  it('refuses to modify or delete audit history at the database level', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { summary: 'tampered' } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
  });
});

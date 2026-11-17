import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import type {
  DashboardDto,
  OperationsDto,
  ReportDto,
  TaskDto,
  WorkflowDto,
} from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
import {
  Actors,
  COMPLETE_SG_BRIEF,
  COMPLETE_VB_BRIEF,
  PDF,
} from './workflow-helpers.js';

/** Regression tests for defects found in the pre-release code review. */
describe('Hardening (review findings)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const role = await prisma.role.findUniqueOrThrow({
      where: { key: 'system_admin' },
    });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: {
        username: 'admin.helper',
        fullName: 'Helper Admin',
        passwordHash: await hashPassword('Demo-Password-2026'),
        roles: { create: [{ roleId: role.id }] },
      },
      update: {},
    });
    as = new Actors(app);
  });
  afterAll(async () => app.close());

  async function vbAt(
    key: string,
  ): Promise<{ jobId: string; wf: WorkflowDto }> {
    const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
    let wf = await as.workflow(job.id);
    while (as.current(wf).key !== key) wf = await as.completeCurrent(job.id);
    return { jobId: job.id, wf };
  }

  it('parallel wrong passwords still lock the account (atomic failure count)', async () => {
    await prisma.user.create({
      data: {
        username: 'lock.target',
        fullName: 'Lock Target',
        passwordHash: await hashPassword('Right-Password-2026'),
      },
    });
    const server = app.getHttpServer();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(server)
          .post(`${API}/auth/login`)
          .send({ username: 'lock.target', password: 'wrong-password-123' }),
      ),
    );
    expect(attempts.every((r) => r.status === 401 || r.status === 423)).toBe(
      true,
    );
    const right = await request(server)
      .post(`${API}/auth/login`)
      .send({ username: 'lock.target', password: 'Right-Password-2026' });
    expect(right.status).toBe(423);
  });

  it('a socket cannot crash the API with a bad ack, and is dropped once its session ends', async () => {
    const server = app.getHttpServer();
    await app.get(RealtimeService).attach(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const login = await request(server)
      .post(`${API}/auth/login`)
      .send({ username: 'demo.design', password: 'Demo-Password-2026' });
    const cookie = (
      login.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    const sock = connect(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
    });
    await new Promise<void>((r) => sock.on('connect', () => r()));
    sock.emit('channel:join', 'not-a-channel', 1); // ack is not a function
    const ok = await new Promise<boolean>((r) =>
      sock.emit('channel:join', 'still-alive', r),
    );
    expect(ok).toBe(false); // the server is still answering
    await request(server)
      .post(`${API}/auth/logout`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', login.body.csrfToken)
      .expect(204);
    const dropped = new Promise<string>((r) =>
      sock.on('disconnect', (reason) => r(reason)),
    );
    sock.emit('channel:join', 'anything');
    expect(await dropped).toBe('io server disconnect');
    sock.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a department’s tasks are hidden from other departments, even by id; duplicate assignees are merged', async () => {
    const { jobId, wf } = await vbAt('design');
    const member = (
      await prisma.user.findUniqueOrThrow({
        where: { username: 'demo.design' },
      })
    ).id;
    const created = await as.post('demo.design.lead', `/jobs/${jobId}/tasks`, {
      stageId: as.current(wf).id,
      title: 'Internal draft',
      assigneeIds: [member, member],
    });
    expect(created.status).toBe(201);
    const task = created.body as TaskDto;
    expect(task.assignees).toHaveLength(1);
    expect((await as.get('demo.pro', `/tasks/${task.id}`)).status).toBe(404);
    expect(
      (
        (await as.get('demo.pro', `/jobs/${jobId}/tasks`)).body as TaskDto[]
      ).some((t) => t.id === task.id),
    ).toBe(false);
    expect((await as.get('demo.design', `/tasks/${task.id}`)).status).toBe(200);
  });

  it('a vehicle schedule cannot be marked completed before it is confirmed', async () => {
    const { jobId } = await vbAt('vehicle_schedule');
    const ops = (
      await as.post('demo.logistic', `/jobs/${jobId}/vehicle-schedules`, {
        vehicleRef: 'Van 1',
        plannedStart: new Date(Date.now() + 86_400_000).toISOString(),
        location: 'Bay 1',
      })
    ).body as OperationsDto;
    const res = await as.patch(
      'demo.logistic',
      `/vehicle-schedules/${ops.schedules[0]!.id}`,
      { status: 'COMPLETED' },
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/confirm it first/);
  });

  it('only the PRO Leader or an administrator can cancel an authority approval (same as Not Required)', async () => {
    const { jobId } = await vbAt('government_approval');
    const types = (await as.get('demo.pro.lead', '/authority-types')).body as {
      id: string;
      code: string;
    }[];
    const typeId = types.find((t) => t.code !== 'RTA')!.id;
    const created = await as.post(
      'demo.pro',
      `/jobs/${jobId}/authority-applications`,
      { authorityTypeId: typeId },
    );
    const appId = (
      created.body.applications as {
        id: string;
        authorityTypeId?: string;
        authorityType?: { id: string };
      }[]
    ).at(-1)!.id;
    expect(
      (
        await as.patch('demo.pro', `/authority-applications/${appId}`, {
          status: 'CANCELLED',
          note: 'not needed',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as.patch('demo.pro.lead', `/authority-applications/${appId}`, {
          status: 'CANCELLED',
          note: 'Duplicate request',
        })
      ).status,
    ).toBe(200);
    // ...and a cancelled application can be reopened by them instead of blocking the authority for good.
    expect(
      (
        await as.patch('demo.pro.lead', `/authority-applications/${appId}`, {
          status: 'PENDING_PREPARATION',
        })
      ).status,
    ).toBe(200);
  });

  it('an upload rejected by validation leaves no temporary file behind', async () => {
    const { jobId } = await vbAt('design');
    const tmp = join(
      resolve(process.env['FILES_ROOT'] ?? './.e2e-files'),
      'tmp',
    );
    const count = () => {
      try {
        return readdirSync(tmp).length;
      } catch {
        return 0;
      }
    };
    const before = count();
    const s = await as.as('demo.design');
    const res = await s.agent
      .post(`${API}/jobs/${jobId}/design-files?kind=bogus`)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', PDF, 'x.pdf');
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 200));
    expect(count()).toBe(before);
  });

  it('reports and the dashboard use office (Dubai) calendar days', async () => {
    const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
    const s = await as.as('demo.sales');
    await s.agent
      .post(`${API}/jobs/${job.id}/files`)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', PDF, 'drawing.pdf')
      .expect(201);
    let wf = await as.workflow(job.id);
    while (wf.status !== 'COMPLETED') wf = await as.completeCurrent(job.id);
    // 01:30 on 1 March 2026 in Dubai is still 28 February in UTC.
    await prisma.job.update({
      where: { id: job.id },
      data: {
        closedAt: new Date('2026-02-28T21:30:00Z'),
        createdAt: new Date('2026-02-20T08:00:00Z'),
      },
    });
    const march = (
      await as.get(
        'demo.management',
        '/reports/closures?from=2026-03-01&to=2026-03-31',
      )
    ).body as ReportDto;
    expect(march.rows.map((r) => r['jobNumber'])).toContain(job.jobNumber);
    expect(
      march.rows.find((r) => r['jobNumber'] === job.jobNumber)!['closedAt'],
    ).toBe('2026-03-01 01:30');
    const feb = (
      await as.get(
        'demo.management',
        '/reports/closures?from=2026-02-01&to=2026-02-28',
      )
    ).body as ReportDto;
    expect(feb.rows.map((r) => r['jobNumber'])).not.toContain(job.jobNumber);
    expect(march).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });

    const dash = (await as.get('demo.management', '/dashboard'))
      .body as DashboardDto;
    expect(dash.queues.length).toBeGreaterThan(5);
  });
});

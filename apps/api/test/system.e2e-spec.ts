import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { OutboxEventDto, SystemStatusDto } from '@jobflow/shared';
import { createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { Actors } from './workflow-helpers.js';
import { resetConfigCache } from '../src/config/config.js';

describe('Phase 7: maintenance mode, system status and dead letters', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;
  const dir = mkdtempSync(join(tmpdir(), 'jf-backup-'));

  beforeAll(async () => {
    process.env['BACKUP_STATUS_FILE'] = join(dir, 'status.json');
    resetConfigCache();
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
  afterAll(async () => {
    await as.put('admin.helper', '/system/maintenance', { enabled: false });
    await app.close();
  });

  it('maintenance mode stops everyone except administrators, and is audited', async () => {
    expect(
      (
        await as.put('demo.sales.lead', '/system/maintenance', {
          enabled: true,
        })
      ).status,
    ).toBe(403);
    const on = await as.put('admin.helper', '/system/maintenance', {
      enabled: true,
      message: 'Server update until 18:00',
    });
    expect(on.status).toBe(200);
    const pub = await as.anonymous().get('/api/v1/system/maintenance');
    expect(pub.body).toMatchObject({
      enabled: true,
      message: 'Server update until 18:00',
    });

    const blocked = await as.get('demo.sales', '/jobs');
    expect(blocked.status).toBe(503);
    expect(blocked.body.message).toMatch(/Server update until 18:00/);
    expect((await as.get('demo.sales', '/auth/me')).status).toBe(200);
    expect((await as.get('admin.helper', '/jobs')).status).toBe(200);

    await as.put('admin.helper', '/system/maintenance', { enabled: false });
    expect((await as.get('demo.sales', '/jobs')).status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: {
          action: { in: ['system.maintenance_on', 'system.maintenance_off'] },
        },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('administrators see service health, disk, outbox and backup status', async () => {
    expect((await as.get('demo.management', '/system/status')).status).toBe(
      403,
    );
    let s = (await as.get('admin.helper', '/system/status'))
      .body as SystemStatusDto;
    expect(s.database.ok).toBe(true);
    expect(s.backups.available).toBe(false);
    expect(s.backups.warnings[0]).toMatch(/status file not found/);

    const now = new Date().toISOString();
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({
        database: { ok: true, at: now },
        files: { ok: false, at: now, detail: 'restic: repository locked' },
        offsite: { ok: true, at: '2020-01-01T00:00:00Z' },
      }),
    );
    s = (await as.get('admin.helper', '/system/status'))
      .body as SystemStatusDto;
    expect(s.backups.database).toMatchObject({ ok: true });
    expect(s.backups.warnings.join(' ')).toMatch(/last file backup failed/);
    expect(s.backups.warnings.join(' ')).toMatch(
      /weekly external copy is older than 8 days/,
    );
    expect(s.backups.warnings.join(' ')).toMatch(/No restore test/);
  });

  it('dead-lettered events are listed and can be retried', async () => {
    const job = await prisma.job.findFirst();
    const ev = await prisma.outboxEvent.create({
      data: {
        type: 'test.event',
        aggregateType: 'job',
        aggregateId: job?.id ?? '00000000-0000-7000-8000-000000000000',
        payload: {},
        idempotencyKey: `test-dead-${Date.now()}`,
        status: 'DEAD',
        attempts: 8,
        lastError: 'boom',
      },
    });
    const list = (await as.get('admin.helper', '/system/outbox?status=DEAD'))
      .body as OutboxEventDto[];
    expect(list.find((e) => e.id === ev.id)).toMatchObject({
      lastError: 'boom',
      attempts: 8,
    });
    expect(
      (await as.post('demo.management', `/system/outbox/${ev.id}/retry`))
        .status,
    ).toBe(403);
    expect(
      (await as.post('admin.helper', `/system/outbox/${ev.id}/retry`)).status,
    ).toBe(204);
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(
      (await as.post('admin.helper', `/system/outbox/${ev.id}/retry`)).status,
    ).toBe(404);
  });
});

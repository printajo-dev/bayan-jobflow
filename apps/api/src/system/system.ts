import { readFile, statfs } from 'node:fs/promises';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  maintenanceSchema,
  uuidSchema,
  type BackupRunStatus,
  type MaintenanceState,
  type OutboxEventDto,
  type SystemStatusDto,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  type ActionMeta,
  Meta,
  Public,
  RequirePermissions,
} from '../access/decorators.js';
import { config } from '../config/config.js';

export const MAINTENANCE_KEY = 'maintenance';
export const WORKER_HEARTBEAT_KEY = 'worker.heartbeat';
const startedAt = Date.now();
const DAY = 86_400_000;

export async function readMaintenance(db: Tx): Promise<MaintenanceState> {
  const row = await db.systemSetting.findUnique({
    where: { key: MAINTENANCE_KEY },
  });
  const v = (row?.value ?? {}) as {
    enabled?: boolean;
    message?: string | null;
    since?: string | null;
  };
  return {
    enabled: v.enabled === true,
    message: v.message ?? null,
    since: v.since ?? null,
  };
}

/** Writes the maintenance flag (used by the API and by the maintenance CLI). */
export async function writeMaintenance(
  tx: Tx,
  enabled: boolean,
  message: string | null,
  actorId: string | null,
  meta: { ip: string | null; requestId: string | null },
) {
  const value = {
    enabled,
    message: enabled ? message : null,
    since: enabled ? new Date().toISOString() : null,
  };
  await tx.systemSetting.upsert({
    where: { key: MAINTENANCE_KEY },
    create: { key: MAINTENANCE_KEY, value, updatedById: actorId },
    update: { value, updatedById: actorId },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: enabled ? 'system.maintenance_on' : 'system.maintenance_off',
      entityType: 'settings',
      summary: enabled
        ? `Maintenance mode on${message ? `: ${message}` : ''}`
        : 'Maintenance mode off',
      after: value,
      ip: meta.ip,
      requestId: meta.requestId,
    },
  });
  return value;
}

@Injectable()
export class SystemService {
  private cache: { at: number; state: MaintenanceState } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Cached for a few seconds: checked on every authenticated request. */
  async maintenance(): Promise<MaintenanceState> {
    if (this.cache && Date.now() - this.cache.at < 3000)
      return this.cache.state;
    const state = await readMaintenance(this.prisma);
    this.cache = { at: Date.now(), state };
    return state;
  }

  async setMaintenance(
    input: z.output<typeof maintenanceSchema>,
    meta: ActionMeta,
  ): Promise<MaintenanceState> {
    const v = await this.prisma.$transaction((tx) =>
      writeMaintenance(
        tx,
        input.enabled,
        input.message ?? null,
        meta.actorId,
        meta,
      ),
    );
    this.cache = null;
    return v;
  }

  async status(): Promise<SystemStatusDto> {
    const cfg = config();
    let dbOk = true;
    let size: number | null = null;
    try {
      const r = await this.prisma.$queryRaw<
        { s: bigint }[]
      >`SELECT pg_database_size(current_database()) AS s`;
      size = Number(r[0]?.s ?? 0);
    } catch {
      dbOk = false;
    }
    const [counts, oldest, hb] = await Promise.all([
      this.prisma.outboxEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { status: { in: ['PENDING', 'FAILED', 'DEAD', 'PROCESSING'] } },
      }),
      this.prisma.outboxEvent.findFirst({
        where: { status: { in: ['PENDING', 'FAILED'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.systemSetting.findUnique({
        where: { key: WORKER_HEARTBEAT_KEY },
      }),
    ]);
    const c = (s: string) =>
      counts.find((x) => x.status === s)?._count._all ?? 0;
    const lastHeartbeat =
      (hb?.value as { at?: string } | undefined)?.at ?? null;

    let disk: SystemStatusDto['disk'] = null;
    try {
      const st = await statfs(cfg.FILES_ROOT);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const used = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
      disk = {
        path: cfg.FILES_ROOT,
        totalBytes: total,
        freeBytes: free,
        usedPercent: used,
        warning: used >= 85,
      };
    } catch {
      disk = null;
    }

    const backups = await this.backupStatus(cfg.BACKUP_STATUS_FILE);
    return {
      checkedAt: new Date().toISOString(),
      version: process.env['JOBFLOW_RELEASE'] ?? 'dev',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      database: { ok: dbOk, sizeBytes: size },
      worker: {
        lastHeartbeat,
        healthy:
          !!lastHeartbeat &&
          Date.now() - Date.parse(lastHeartbeat) < 3 * 60_000,
      },
      outbox: {
        pending: c('PENDING') + c('PROCESSING'),
        failed: c('FAILED'),
        dead: c('DEAD'),
        oldestPendingSeconds: oldest
          ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)
          : null,
      },
      disk,
      backups,
      maintenance: await this.maintenance(),
    };
  }

  /** Reads the status file the backup scripts write after every run. */
  private async backupStatus(
    file: string,
  ): Promise<SystemStatusDto['backups']> {
    let raw: Record<string, BackupRunStatus | undefined> = {};
    let available = true;
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as typeof raw;
    } catch {
      available = false;
    }
    const pick = (k: string): BackupRunStatus | null => {
      const v = raw[k];
      return v && typeof v.at === 'string'
        ? {
            ok: v.ok === true,
            at: v.at,
            detail:
              typeof v.detail === 'string' ? v.detail.slice(0, 500) : undefined,
          }
        : null;
    };
    const s = {
      database: pick('database'),
      files: pick('files'),
      offsite: pick('offsite'),
      restoreTest: pick('restore_test'),
    };
    const warnings: string[] = [];
    const check = (
      label: string,
      v: BackupRunStatus | null,
      maxAgeDays: number,
    ) => {
      if (!v) warnings.push(`No ${label} has been recorded yet.`);
      else if (!v.ok) warnings.push(`The last ${label} failed (${v.at}).`);
      else if (Date.now() - Date.parse(v.at) > maxAgeDays * DAY)
        warnings.push(
          `The last successful ${label} is older than ${maxAgeDays} days.`,
        );
    };
    if (!available)
      warnings.push(
        'Backup status file not found. Are the backup timers installed?',
      );
    else {
      check('database backup', s.database, 1.5);
      check('file backup', s.files, 1.5);
      check('weekly external copy', s.offsite, 8);
      check('restore test', s.restoreTest, 35);
    }
    return { available, ...s, warnings };
  }

  async outbox(status: 'DEAD' | 'FAILED'): Promise<OutboxEventDto[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      aggregateType: r.aggregateType,
      aggregateId: r.aggregateId,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
      nextAttemptAt: r.nextAttemptAt.toISOString(),
    }));
  }

  /** Sends a failed or dead event back to the queue; consumers are idempotent. */
  async retry(id: string, meta: ActionMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ev = await tx.outboxEvent.findUnique({ where: { id } });
      if (!ev || (ev.status !== 'DEAD' && ev.status !== 'FAILED'))
        throw new NotFoundException('No failed event with this id');
      await tx.outboxEvent.update({
        where: { id },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() },
      });
      await this.audit.record(tx, meta, {
        action: 'outbox.retried',
        entityType: 'outbox_event',
        entityId: id,
        summary: `Retried background event ${ev.type}`,
      });
    });
  }
}

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  /** Public: the sign-in page shows the maintenance notice. */
  @Get('maintenance')
  @Public()
  maintenance() {
    return this.system.maintenance();
  }

  @Put('maintenance')
  @RequirePermissions('settings.manage')
  setMaintenance(
    @Body({ schema: maintenanceSchema })
    body: z.output<typeof maintenanceSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.system.setMaintenance(body, meta);
  }

  @Get('status')
  @RequirePermissions('outbox.manage')
  status() {
    return this.system.status();
  }

  @Get('outbox')
  @RequirePermissions('outbox.manage')
  outbox(
    @Query('status', { schema: z.enum(['DEAD', 'FAILED']).default('DEAD') })
    status: 'DEAD' | 'FAILED',
  ) {
    return this.system.outbox(status);
  }

  @Post('outbox/:id/retry')
  @HttpCode(204)
  @RequirePermissions('outbox.manage')
  retry(
    @Param('id', { schema: uuidSchema }) id: string,
    @Meta() meta: ActionMeta,
  ) {
    return this.system.retry(id, meta);
  }
}

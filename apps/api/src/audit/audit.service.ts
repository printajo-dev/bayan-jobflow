import { Injectable } from '@nestjs/common';
import type { Tx } from '../core/prisma.service.js';
import type { ActionMeta } from '../access/decorators.js';
import { Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

const SECRET_KEYS = /password|token|secret|hash/i;

/** Removes anything that looks like a secret before it is stored. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(redact(value))) as Prisma.InputJsonValue;
}

/**
 * Writes audit rows. Always called with the business transaction so the audit
 * entry and the change commit or roll back together.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, meta: ActionMeta, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: meta.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        summary: entry.summary.slice(0, 500),
        before: json(entry.before),
        after: json(entry.after),
        ip: meta.ip,
        requestId: meta.requestId,
      },
    });
  }
}

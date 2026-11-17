import { z } from 'zod';

export const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).nullish(),
});
export type MaintenanceState = {
  enabled: boolean;
  message: string | null;
  since: string | null;
};

export interface BackupRunStatus {
  ok: boolean;
  at: string;
  detail?: string;
}

export interface SystemStatusDto {
  checkedAt: string;
  version: string;
  uptimeSeconds: number;
  database: { ok: boolean; sizeBytes: number | null };
  worker: { lastHeartbeat: string | null; healthy: boolean };
  outbox: {
    pending: number;
    failed: number;
    dead: number;
    oldestPendingSeconds: number | null;
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedPercent: number;
    warning: boolean;
  } | null;
  backups: {
    available: boolean;
    database: BackupRunStatus | null;
    files: BackupRunStatus | null;
    offsite: BackupRunStatus | null;
    restoreTest: BackupRunStatus | null;
    warnings: string[];
  };
  maintenance: MaintenanceState;
}

export interface OutboxEventDto {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
}

import type { JobPriority, JobStatus, StageStatus } from '@jobflow/shared';

export const STAGE_STATUS: Record<StageStatus, { label: string; color: string }> = {
  PENDING: { label: 'Not started', color: 'gray' },
  ACTIVE: { label: 'In progress', color: 'blue' },
  ON_HOLD: { label: 'On hold', color: 'orange' },
  COMPLETED: { label: 'Completed', color: 'green' },
  RETURNED: { label: 'Returned', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
};

export const JOB_STATUS: Record<JobStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'blue' },
  CLOSED: { label: 'Closed', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
};

export const PRIORITY: Record<JobPriority, { label: string; color: string }> = {
  LOW: { label: 'Low', color: 'gray' },
  NORMAL: { label: 'Normal', color: 'blue' },
  HIGH: { label: 'High', color: 'orange' },
  URGENT: { label: 'Urgent', color: 'red' },
};

export const COVERAGE: Record<string, string> = {
  FULL_WRAP: 'Full wrap',
  PARTIAL_WRAP: 'Partial wrap',
  DECALS: 'Decals / lettering',
  OTHER: 'Other',
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

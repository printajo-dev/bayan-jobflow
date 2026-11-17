import { z } from 'zod';

export const REPORTS = [
  { key: 'active-jobs', title: 'Active jobs by stage', scope: 'global' },
  {
    key: 'throughput',
    title: 'Completed jobs and cycle time',
    scope: 'global',
  },
  {
    key: 'department-workload',
    title: 'Department workload',
    scope: 'department',
  },
  { key: 'employee-workload', title: 'Employee workload', scope: 'leader' },
  {
    key: 'design',
    title: 'Design corrections and time to approval',
    scope: 'global',
  },
  { key: 'authority', title: 'PRO authority approvals', scope: 'global' },
  {
    key: 'operations',
    title: 'Production and installation progress',
    scope: 'global',
  },
  { key: 'quality', title: 'QC pass/fail and rework', scope: 'global' },
  {
    key: 'schedule-delivery',
    title: 'Vehicle schedule adherence and delivery',
    scope: 'global',
  },
  {
    key: 'closures',
    title: 'Job closure after QC (Signage) and delivery (Vehicle Branding)',
    scope: 'global',
  },
] as const;
export type ReportKey = (typeof REPORTS)[number]['key'];

export const reportQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  group: z.enum(['week', 'month']).default('month'),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});

export interface ReportDto {
  key: ReportKey;
  title: string;
  from: string;
  to: string;
  generatedAt: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number | null>[];
  /** Short notes on how figures are calculated. */
  notes: string[];
}

export interface DashboardQueueJob {
  jobId: string;
  jobNumber: string;
  title: string;
  serviceType: string;
  stageName: string;
  stageStatus: string;
  occurrenceNo: number;
  daysInStage: number;
  internalDeadline: string | null;
  customerCommitmentDate: string | null;
  overdue: boolean;
  priority: string;
}

export interface DashboardDto {
  me: {
    openTasks: number;
    overdueTasks: number;
    openCorrections: number;
    unreadNotifications: number;
  };
  queues: {
    department: { id: string; code: string; name: string };
    jobs: DashboardQueueJob[];
    openTasks: number;
    unassignedTasks: number;
    overdueTasks: number;
    openCorrections: number;
    extras: { label: string; value: number }[];
  }[];
  overview: null | {
    activeJobs: number;
    completedLast30: number;
    avgCycleDays: number | null;
    onHold: number;
    reworkRoundsLast30: number;
    overdueTasks: number;
    byStage: {
      service: string;
      stage: string;
      sequence: number;
      count: number;
      avgDays: number;
    }[];
  };
}

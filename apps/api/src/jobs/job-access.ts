import type { JobAction, StageAction } from '@jobflow/shared';
import type { Principal } from '../access/principal.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Resource-level access for jobs and their stages. Every check here runs on
 * the server; the web app only uses the resulting `allowedActions` lists to
 * decide which buttons to show.
 *
 * A user can see a job when they:
 * - hold `job.view` globally (administrators, management), or
 * - hold `job.view` in a department that owns a stage of the job's workflow
 *   (so PRO and Logistic see Vehicle Branding jobs but not Signage jobs), or
 * - created the job.
 */
export interface JobAccessFacts {
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  createdById: string | null;
  /** Departments owning any stage of the job's workflow. */
  stageDepartmentIds: string[];
  /** Department owning the first stage (the job brief), normally Sales. */
  briefDepartmentId: string;
}

export function canViewJob(p: Principal, job: JobAccessFacts): boolean {
  if (p.hasGlobal('job.view')) return true;
  if (!p.has('job.view')) return false;
  if (job.createdById === p.userId) return true;
  return job.stageDepartmentIds.some((d) => p.hasInDepartment('job.view', d));
}

/** Prisma filter matching the jobs a principal may see (used for lists). */
export function visibleJobsWhere(p: Principal): Prisma.JobWhereInput {
  if (p.hasGlobal('job.view')) return {};
  const departments = p.departmentsWith('job.view');
  if (departments.length === 0) return { id: { in: [] } };
  return {
    OR: [
      { createdById: p.userId },
      { workflow: { templateVersion: { stages: { some: { departmentId: { in: departments } } } } } },
    ],
  };
}

export function jobActions(p: Principal, job: JobAccessFacts): JobAction[] {
  const actions: JobAction[] = [];
  const d = job.briefDepartmentId;
  if (job.status === 'OPEN' && p.hasInDepartment('job.edit_brief', d)) actions.push('edit', 'editBrief', 'uploadFile', 'removeFile');
  if (job.status !== 'CANCELLED' && p.hasInDepartment('job.edit_number', d)) actions.push('changeNumber');
  if (job.status === 'OPEN' && p.hasInDepartment('job.cancel', d)) actions.push('cancel');
  return actions;
}

export interface StageAccessFacts {
  status: 'PENDING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'RETURNED' | 'CANCELLED';
  departmentId: string;
  /** True when this is the newest occurrence of its template stage. */
  isLatestOccurrence: boolean;
  hasReturnTargets: boolean;
  jobStatus: 'OPEN' | 'CLOSED' | 'CANCELLED';
}

export function stageActions(p: Principal, s: StageAccessFacts): StageAction[] {
  if (s.jobStatus === 'CANCELLED') return [];
  const d = s.departmentId;
  const actions: StageAction[] = [];
  if (s.status === 'ACTIVE') {
    if (p.hasInDepartment('stage.complete', d) || p.hasInDepartment('task.update_own', d)) actions.push('check');
    if (p.hasInDepartment('stage.complete', d)) actions.push('complete');
    if (p.hasGlobal('stage.exception')) actions.push('completeWithException');
    if (p.hasInDepartment('stage.hold', d)) actions.push('hold');
    if (s.hasReturnTargets && p.hasInDepartment('stage.return', d)) actions.push('return');
  }
  if (s.status === 'ON_HOLD' && p.hasInDepartment('stage.hold', d)) actions.push('resume');
  if (s.status === 'COMPLETED' && s.isLatestOccurrence && p.hasGlobal('stage.reopen')) actions.push('reopen');
  return actions;
}

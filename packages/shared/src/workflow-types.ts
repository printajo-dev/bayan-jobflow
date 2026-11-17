import type {
  GateKey,
  JobBrief,
  JobPriority,
  JobStatus,
  ServiceTypeCode,
  StageStatus,
  TemplateVersionStatus,
} from './workflow.js';

export interface ServiceTypeDto {
  id: string;
  code: ServiceTypeCode;
  name: string;
}

export interface JobSummaryDto {
  id: string;
  jobNumber: string;
  serviceType: ServiceTypeDto;
  title: string;
  status: JobStatus;
  priority: JobPriority;
  customerCommitmentDate: string | null;
  createdAt: string;
  closedAt: string | null;
  /** The stage currently being worked on (ACTIVE or ON_HOLD), if any. */
  currentStage: { id: string; key: string; name: string; status: StageStatus; departmentName: string } | null;
}

export type JobAction = 'edit' | 'editBrief' | 'changeNumber' | 'cancel' | 'uploadFile' | 'removeFile';

export interface JobFileDto {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  purpose: string;
  uploadedBy: string | null;
  createdAt: string;
}

export interface JobDetailDto extends JobSummaryDto {
  cancelReason: string | null;
  createdBy: string | null;
  brief: JobBrief;
  /** Missing items that block the brief.complete gate (empty when complete). */
  briefProblems: string[];
  templateVersion: { id: string; templateName: string; versionNo: number };
  files: JobFileDto[];
  allowedActions: JobAction[];
}

export type StageAction = 'complete' | 'completeWithException' | 'hold' | 'resume' | 'return' | 'reopen' | 'check';

export interface GateResultDto {
  key: GateKey | 'checklist';
  label: string;
  passed: boolean;
  detail?: string;
}

export interface StageChecklistItemDto {
  id: string;
  label: string;
  required: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
}

export interface StageDto {
  id: string;
  key: string;
  name: string;
  sequence: number;
  occurrenceNo: number;
  status: StageStatus;
  department: { id: string; code: string; name: string };
  activatedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  returnedFrom: { stageId: string; key: string; name: string } | null;
  returnReason: string | null;
  holdReason: string | null;
  exceptionReason: string | null;
  checklist: StageChecklistItemDto[];
  /** Gate evaluation; only computed for the current stage. */
  gates: GateResultDto[];
  allowedActions: StageAction[];
  returnTargets: { key: string; name: string }[];
}

export interface WorkflowDto {
  id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  templateVersion: { id: string; templateName: string; versionNo: number };
  /** Every stage occurrence in template order, rework occurrences after the original. */
  stages: StageDto[];
}

export interface TemplateStageDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sequence: number;
  department: { id: string; code: string; name: string };
  gateKeys: GateKey[];
  checklist: { label: string; required: boolean }[];
}

export interface TemplateVersionDto {
  id: string;
  templateId: string;
  versionNo: number;
  status: TemplateVersionStatus;
  notes: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  jobCount: number;
  stages: TemplateStageDto[];
  returnRules: { fromKey: string; toKey: string }[];
}

export interface TemplateSummaryDto {
  id: string;
  code: string;
  name: string;
  serviceType: ServiceTypeDto;
  versions: { id: string; versionNo: number; status: TemplateVersionStatus; publishedAt: string | null; jobCount: number }[];
}

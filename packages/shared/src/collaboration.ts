import { z } from 'zod';
import { JOB_PRIORITIES, type JobPriority } from './workflow.js';

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();
const uuid = z.uuid();

// ================================================================ Tasks

export const TASK_STATUSES = ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const createTaskSchema = z.strictObject({
  stageId: uuid,
  title: text(200).min(1, 'Give the task a title'),
  description: text(5000).optional().nullable(),
  priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  startDate: isoDate.optional().nullable(),
  dueDate: isoDate.optional().nullable(),
  /** Required tasks must be completed before the stage can complete. */
  required: z.boolean().default(true),
  assigneeIds: z.array(uuid).max(20).default([]),
  dependsOnIds: z.array(uuid).max(20).default([]),
  checklist: z.array(text(300).min(1)).max(50).default([]),
});

export const updateTaskSchema = z.strictObject({
  title: text(200).min(1).optional(),
  description: text(5000).optional().nullable(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  startDate: isoDate.optional().nullable(),
  dueDate: isoDate.optional().nullable(),
  required: z.boolean().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  /** Required when cancelling or reopening a completed task. */
  reason: text(1000).optional(),
});

export const setAssigneesSchema = z.strictObject({ userIds: z.array(uuid).max(20) });
export const taskCommentSchema = z.strictObject({ body: text(5000).min(1) });
export const taskChecklistToggleSchema = z.strictObject({ done: z.boolean() });
export const stageDeadlineSchema = z.strictObject({ internalDeadline: isoDate.nullable() });

export const listTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  mine: z.enum(['true', 'false']).optional(),
  departmentId: uuid.optional(),
  status: z.enum(['open', 'overdue', 'completed', 'all']).default('open'),
  unassigned: z.enum(['true', 'false']).optional(),
});

export interface TaskDto {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  stage: { id: string; key: string; name: string; occurrenceNo: number };
  department: { id: string; code: string; name: string };
  title: string;
  description: string | null;
  priority: JobPriority;
  status: TaskStatus;
  required: boolean;
  startDate: string | null;
  dueDate: string | null;
  overdue: boolean;
  assignees: { id: string; fullName: string }[];
  dependsOn: { id: string; title: string; status: TaskStatus }[];
  checklist: { id: string; label: string; done: boolean; doneBy: string | null }[];
  comments: { id: string; author: string; body: string; createdAt: string }[];
  createdBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  allowedActions: ('edit' | 'assign' | 'updateStatus' | 'comment' | 'cancel')[];
}

// ================================================================ Design

export const APPROVAL_METHODS = ['IN_PERSON', 'EMAIL', 'WHATSAPP', 'PHONE', 'SIGNED_FORM', 'OTHER'] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

export const recordApprovalSchema = z.strictObject({
  approverName: text(150).min(1, 'Who approved?'),
  approverRole: text(150).optional().nullable(),
  method: z.enum(APPROVAL_METHODS),
  approvedAt: z.iso.datetime({ offset: true }),
  notes: text(2000).optional().nullable(),
  evidenceFileId: uuid.optional().nullable(),
});

export const createCorrectionRoundSchema = z.strictObject({
  description: text(5000).min(1),
  sourceMessageId: uuid.optional().nullable(),
  assignedDesignerId: uuid.optional().nullable(),
  deadline: isoDate.optional().nullable(),
  fileIds: z.array(uuid).max(20).default([]),
});

export interface ArtworkVersionDto {
  id: string;
  versionNo: number;
  file: { id: string; originalName: string; mimeType: string; size: number; sha256: string };
  notes: string | null;
  correctionRoundNo: number | null;
  uploadedBy: string | null;
  createdAt: string;
  approvals: ApprovalRecordDto[];
}

export interface ApprovalRecordDto {
  id: string;
  artworkVersionId: string;
  versionNo: number;
  approverName: string;
  approverRole: string | null;
  method: ApprovalMethod;
  approvedAt: string;
  notes: string | null;
  evidenceFile: { id: string; originalName: string } | null;
  recordedBy: string | null;
  createdAt: string;
}

export interface CorrectionRoundDto {
  id: string;
  roundNo: number;
  description: string;
  requestedBy: string | null;
  assignedDesigner: { id: string; fullName: string } | null;
  deadline: string | null;
  status: 'OPEN' | 'RESOLVED';
  resolvedByVersionNo: number | null;
  files: { id: string; originalName: string }[];
  createdAt: string;
}

export interface DesignDto {
  versions: ArtworkVersionDto[];
  rounds: CorrectionRoundDto[];
  /** True when the newest artwork version has a recorded customer approval. */
  latestApproved: boolean;
  allowedActions: ('upload' | 'recordApproval' | 'manageRounds')[];
}

// ================================================================ Discussions

export const MAX_VOICE_SECONDS = 600;

export const postMessageSchema = z.strictObject({
  body: text(10000).default(''),
  parentMessageId: uuid.optional().nullable(),
  fileIds: z.array(uuid).max(10).default([]),
  mentionUserIds: z.array(uuid).max(50).default([]),
  stageId: uuid.optional().nullable(),
});
export const editMessageSchema = z.strictObject({ body: text(10000).min(1) });
export const reactionSchema = z.strictObject({ emoji: z.enum(['👍', '✅', '❤️', '😂', '❗', '👀']) });
export const addParticipantSchema = z.strictObject({ userId: uuid });
export const createChannelSchema = z.strictObject({ departmentId: uuid });
export const listMessagesQuerySchema = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  parentMessageId: uuid.optional(),
  q: z.string().trim().max(200).optional(),
});

export interface ChannelDto {
  id: string;
  type: 'DEPARTMENT' | 'GENERAL';
  name: string;
  department: { id: string; code: string; name: string } | null;
  unread: number;
  canPost: boolean;
  canManage: boolean;
  participants: { id: string; fullName: string }[];
}

export interface MessageAttachmentDto {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  isVoice: boolean;
  durationSec: number | null;
}

export interface MessageDto {
  id: string;
  channelId: string;
  parentMessageId: string | null;
  kind: 'USER' | 'SYSTEM';
  author: { id: string; fullName: string } | null;
  body: string;
  deleted: boolean;
  edited: boolean;
  createdAt: string;
  attachments: MessageAttachmentDto[];
  mentions: { id: string; fullName: string }[];
  reactions: { emoji: string; count: number; mine: boolean }[];
  replyCount: number;
  pinned: boolean;
  readBy: number;
  canEdit: boolean;
  canDelete: boolean;
}

// ================================================================ Corrections

export const CORRECTION_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_INFO', 'RESOLVED', 'REOPENED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const createCorrectionSchema = z.strictObject({
  jobId: uuid,
  departmentId: uuid,
  stageId: uuid.optional().nullable(),
  channelId: uuid.optional().nullable(),
  sourceMessageId: uuid.optional().nullable(),
  title: text(200).min(1),
  description: text(5000).min(1),
  assignedToId: uuid.optional().nullable(),
  priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  deadline: isoDate.optional().nullable(),
  blocking: z.boolean().default(true),
  fileIds: z.array(uuid).max(20).default([]),
});

export const updateCorrectionSchema = z.strictObject({
  status: z.enum(['ASSIGNED', 'IN_PROGRESS', 'WAITING_INFO']).optional(),
  assignedToId: uuid.optional().nullable(),
  deadline: isoDate.optional().nullable(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  reason: text(1000).optional(),
});
export const resolveCorrectionSchema = z.strictObject({
  notes: text(5000).min(1, 'Describe the resolution'),
  fileIds: z.array(uuid).max(20).default([]),
});

export interface CorrectionDto {
  id: string;
  jobId: string;
  jobNumber: string;
  department: { id: string; code: string; name: string };
  stage: { id: string; name: string; occurrenceNo: number } | null;
  sourceMessageId: string | null;
  channelId: string | null;
  title: string;
  description: string;
  requestedBy: string | null;
  assignedTo: { id: string; fullName: string } | null;
  priority: JobPriority;
  deadline: string | null;
  status: CorrectionStatus;
  blocking: boolean;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  files: { id: string; originalName: string; kind: 'ATTACHMENT' | 'RESOLUTION' }[];
  history: { from: CorrectionStatus | null; to: CorrectionStatus; actor: string | null; reason: string | null; at: string }[];
  createdAt: string;
  allowedActions: ('assign' | 'update' | 'resolve' | 'reopen')[];
}

// ================================================================ Notifications

export const NOTIFICATION_TYPES = [
  'stage.activated',
  'stage.returned',
  'task.assigned',
  'task.due_soon',
  'task.overdue',
  'mention',
  'reply',
  'approval.recorded',
  'correction.assigned',
  'correction.resolved',
  'correction.reopened',
  'job.closed',
  'authority.decision',
  'qc.result',
  'delivery.completed',
  'schedule.changed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  'stage.activated': 'A stage starts for my department',
  'stage.returned': 'Work is returned to my department',
  'task.assigned': 'I am assigned a task',
  'task.due_soon': 'My task is due within a day',
  'task.overdue': 'My task is overdue',
  mention: 'Someone mentions me',
  reply: 'Someone replies to my message',
  'approval.recorded': 'Customer approval is recorded',
  'correction.assigned': 'A correction is assigned to me',
  'correction.resolved': 'A correction I requested is resolved',
  'correction.reopened': 'A correction is reopened',
  'job.closed': 'A job I created is closed',
  'authority.decision': 'An authority approves or rejects an application',
  'qc.result': 'A QC inspection passes or fails',
  'delivery.completed': 'A delivery is completed',
  'schedule.changed': 'A vehicle schedule is confirmed or changed',
};

export const preferencesSchema = z.strictObject({
  disabled: z.array(z.enum(NOTIFICATION_TYPES)).max(NOTIFICATION_TYPES.length),
});

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  jobNumber: string | null;
  readAt: string | null;
  createdAt: string;
}

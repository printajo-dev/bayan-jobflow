import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const uuid = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

// ================================================================ PRO / authority approvals

export const AUTHORITY_STATUSES = [
  'NOT_REQUIRED',
  'PENDING_PREPARATION',
  'READY_TO_SUBMIT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'REJECTED',
  'APPROVED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type AuthorityStatus = (typeof AUTHORITY_STATUSES)[number];

/** Allowed status moves (Not Required has its own endpoint because it needs special permission). */
export const AUTHORITY_TRANSITIONS: Record<AuthorityStatus, AuthorityStatus[]> = {
  NOT_REQUIRED: ['PENDING_PREPARATION'],
  PENDING_PREPARATION: ['READY_TO_SUBMIT', 'SUBMITTED', 'CANCELLED'],
  READY_TO_SUBMIT: ['PENDING_PREPARATION', 'SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'MORE_INFO_REQUIRED', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'MORE_INFO_REQUIRED', 'CANCELLED'],
  MORE_INFO_REQUIRED: ['SUBMITTED', 'CANCELLED'],
  REJECTED: ['SUBMITTED', 'CANCELLED'],
  APPROVED: ['EXPIRED'],
  EXPIRED: ['SUBMITTED', 'CANCELLED'],
  // Reopen: the PRO Leader or an administrator only (like Not Required).
  CANCELLED: ['PENDING_PREPARATION'],
};

export const PAYMENT_STATUSES = ['NOT_DUE', 'PENDING', 'PAID', 'WAIVED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const AUTHORITY_DOCUMENT_KINDS = ['APPLICATION', 'APPROVAL', 'REJECTION', 'RECEIPT', 'OTHER'] as const;
export type AuthorityDocumentKind = (typeof AUTHORITY_DOCUMENT_KINDS)[number];

export const createAuthorityApplicationSchema = z.strictObject({
  authorityTypeId: uuid,
  comments: text(2000).optional().nullable(),
});

export const updateAuthorityApplicationSchema = z.strictObject({
  status: z.enum(AUTHORITY_STATUSES).optional(),
  referenceNumber: text(100).optional().nullable(),
  submissionDate: dateTime.optional().nullable(),
  expectedResponseDate: isoDate.optional().nullable(),
  actualResponseDate: dateTime.optional().nullable(),
  validUntil: isoDate.optional().nullable(),
  fees: z.number().min(0).max(10_000_000).optional().nullable(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  rejectionReason: text(2000).optional().nullable(),
  comments: text(2000).optional().nullable(),
  /** Free-text note stored in the status history (required for cancel). */
  note: text(1000).optional(),
});

export const authorityDocumentSchema = z.strictObject({
  fileId: uuid,
  kind: z.enum(AUTHORITY_DOCUMENT_KINDS),
});

export const authorityPaymentSchema = z.strictObject({
  amount: z.number().positive().max(10_000_000),
  paidAt: dateTime,
  reference: text(100).optional().nullable(),
  receiptFileId: uuid.optional().nullable(),
});

export const authorityTypeSchema = z.strictObject({
  code: text(20).toUpperCase().regex(/^[A-Z0-9_]+$/),
  name: text(100).min(1),
  description: text(500).optional().nullable(),
  isActive: z.boolean().default(true),
});

export interface AuthorityTypeDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface AuthorityApplicationDto {
  id: string;
  authorityType: AuthorityTypeDto;
  status: AuthorityStatus;
  referenceNumber: string | null;
  submissionDate: string | null;
  expectedResponseDate: string | null;
  actualResponseDate: string | null;
  validUntil: string | null;
  fees: number | null;
  paymentStatus: PaymentStatus;
  rejectionReason: string | null;
  notRequiredReason: string | null;
  notRequiredBy: string | null;
  comments: string | null;
  submissions: { id: string; submissionNo: number; submittedAt: string; referenceNumber: string | null; outcome: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MORE_INFO'; outcomeAt: string | null; outcomeNotes: string | null }[];
  documents: { id: string; fileId: string; originalName: string; kind: AuthorityDocumentKind; uploadedBy: string | null; createdAt: string }[];
  payments: { id: string; amount: number; paidAt: string; reference: string | null; receiptFileId: string | null; recordedBy: string | null }[];
  history: { from: AuthorityStatus | null; to: AuthorityStatus; actor: string | null; note: string | null; at: string }[];
  createdAt: string;
  allowedStatuses: AuthorityStatus[];
}

export interface AuthorityDto {
  applications: AuthorityApplicationDto[];
  types: AuthorityTypeDto[];
  /** True when every application is Approved or Not Required (and at least one exists). */
  cleared: boolean;
  allowedActions: ('manage' | 'markNotRequired')[];
}

// ================================================================ Vehicle schedule

export const SCHEDULE_STATUSES = ['PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const createScheduleSchema = z.strictObject({
  vehicleRef: text(200).min(1, 'Which vehicle(s)?'),
  plannedStart: dateTime,
  plannedEnd: dateTime.optional().nullable(),
  location: text(300).min(1, 'Where?'),
  notes: text(2000).optional().nullable(),
});

export const updateScheduleSchema = z.strictObject({
  vehicleRef: text(200).min(1).optional(),
  plannedStart: dateTime.optional(),
  plannedEnd: dateTime.optional().nullable(),
  location: text(300).min(1).optional(),
  notes: text(2000).optional().nullable(),
  status: z.enum(SCHEDULE_STATUSES).optional(),
  /** Who confirmed the vehicle will be available (required to confirm). */
  confirmationNote: text(500).optional(),
  reason: text(1000).optional(),
});

export interface VehicleScheduleDto {
  id: string;
  vehicleRef: string;
  plannedStart: string;
  plannedEnd: string | null;
  location: string;
  notes: string | null;
  status: ScheduleStatus;
  confirmationNote: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  history: { action: string; actor: string | null; reason: string | null; at: string; snapshot: unknown }[];
  createdAt: string;
}

// ================================================================ Production

export const PRODUCTION_STATUSES = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];
export const PRODUCTION_ACTIVITIES = ['PRINTING', 'LAMINATION', 'CUTTING', 'FABRICATION', 'ASSEMBLY', 'PAINTING', 'ELECTRICAL', 'OTHER'] as const;

export const createProductionOrderSchema = z.strictObject({
  stageId: uuid,
  title: text(200).min(1),
  activity: z.enum(PRODUCTION_ACTIVITIES).default('PRINTING'),
  artworkVersionId: uuid.optional().nullable(),
  material: text(200).optional().nullable(),
  quantity: z.number().int().min(1).max(1_000_000).optional().nullable(),
  dimensions: text(200).optional().nullable(),
  machineId: uuid.optional().nullable(),
  operatorId: uuid.optional().nullable(),
  plannedStart: dateTime.optional().nullable(),
  plannedFinish: dateTime.optional().nullable(),
  notes: text(2000).optional().nullable(),
});

export const updateProductionOrderSchema = z.strictObject({
  title: text(200).min(1).optional(),
  material: text(200).optional().nullable(),
  quantity: z.number().int().min(1).max(1_000_000).optional().nullable(),
  dimensions: text(200).optional().nullable(),
  machineId: uuid.optional().nullable(),
  operatorId: uuid.optional().nullable(),
  plannedStart: dateTime.optional().nullable(),
  plannedFinish: dateTime.optional().nullable(),
  actualStart: dateTime.optional().nullable(),
  actualFinish: dateTime.optional().nullable(),
  status: z.enum(PRODUCTION_STATUSES).optional(),
  wastageNotes: text(2000).optional().nullable(),
  notes: text(2000).optional().nullable(),
  reason: text(1000).optional(),
});

export const operationLogSchema = z.strictObject({
  note: text(2000).min(1),
  quantityDone: z.number().int().min(0).max(1_000_000).optional().nullable(),
  fileIds: z.array(uuid).max(20).default([]),
});

export const machineSchema = z.strictObject({
  code: text(30).toUpperCase().regex(/^[A-Z0-9_-]+$/),
  name: text(100).min(1),
  kind: text(50).optional().nullable(),
  isActive: z.boolean().default(true),
});

export interface MachineDto {
  id: string;
  code: string;
  name: string;
  kind: string | null;
  isActive: boolean;
}

export interface OperationLogDto {
  id: string;
  note: string;
  quantityDone: number | null;
  status: string | null;
  actor: string | null;
  files: { id: string; originalName: string; mimeType: string }[];
  createdAt: string;
}

export interface ProductionOrderDto {
  id: string;
  stage: { id: string; key: string; name: string; occurrenceNo: number };
  title: string;
  activity: string;
  artworkVersionNo: number | null;
  material: string | null;
  quantity: number | null;
  dimensions: string | null;
  machine: MachineDto | null;
  operator: { id: string; fullName: string } | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  status: ProductionStatus;
  wastageNotes: string | null;
  notes: string | null;
  logs: OperationLogDto[];
  createdAt: string;
}

// ================================================================ Installation

export const INSTALLATION_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'PARTIAL', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const createInstallationOrderSchema = z.strictObject({
  stageId: uuid,
  target: text(300).min(1, 'Vehicle or site'),
  address: text(500).optional().nullable(),
  accessNotes: text(2000).optional().nullable(),
  safetyNotes: text(2000).optional().nullable(),
  instructions: text(5000).optional().nullable(),
  scheduledStart: dateTime.optional().nullable(),
  scheduledEnd: dateTime.optional().nullable(),
  teamLeaderId: uuid.optional().nullable(),
  technicianIds: z.array(uuid).max(30).default([]),
  materials: z.array(z.strictObject({ item: text(200).min(1), quantity: z.number().min(0).max(1_000_000), unit: text(20).optional().nullable() })).max(100).default([]),
});

export const updateInstallationOrderSchema = z.strictObject({
  target: text(300).min(1).optional(),
  address: text(500).optional().nullable(),
  accessNotes: text(2000).optional().nullable(),
  safetyNotes: text(2000).optional().nullable(),
  instructions: text(5000).optional().nullable(),
  scheduledStart: dateTime.optional().nullable(),
  scheduledEnd: dateTime.optional().nullable(),
  teamLeaderId: uuid.optional().nullable(),
  technicianIds: z.array(uuid).max(30).optional(),
  status: z.enum(INSTALLATION_STATUSES).optional(),
  issues: text(5000).optional().nullable(),
  reason: text(1000).optional(),
});

export interface InstallationOrderDto {
  id: string;
  stage: { id: string; key: string; name: string; occurrenceNo: number };
  target: string;
  address: string | null;
  accessNotes: string | null;
  safetyNotes: string | null;
  instructions: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  teamLeader: { id: string; fullName: string } | null;
  technicians: { id: string; fullName: string }[];
  materials: { item: string; quantity: number; unit: string | null }[];
  status: InstallationStatus;
  issues: string | null;
  logs: OperationLogDto[];
  createdAt: string;
}

export interface OperationsDto {
  schedules: VehicleScheduleDto[];
  productionOrders: ProductionOrderDto[];
  installationOrders: InstallationOrderDto[];
  machines: MachineDto[];
  /** Stages (occurrences) orders can be attached to, by kind. */
  stages: { production: { id: string; name: string; occurrenceNo: number }[]; installation: { id: string; name: string; occurrenceNo: number }[] };
  allowedActions: ('schedule' | 'production' | 'installation')[];
}

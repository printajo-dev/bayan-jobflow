import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const uuid = z.uuid();

export const QC_RESULTS = ['PASS', 'FAIL', 'NA'] as const;
export type QcResult = (typeof QC_RESULTS)[number];

export const saveQcTemplateSchema = z.strictObject({
  name: text(100).min(1),
  items: z
    .array(z.strictObject({ label: text(300).min(1), required: z.boolean().default(true), requiresEvidence: z.boolean().default(false) }))
    .min(1, 'Add at least one checklist item')
    .max(100),
});

export const startInspectionSchema = z.strictObject({ stageId: uuid });

export const saveQcResultsSchema = z.strictObject({
  results: z
    .array(z.strictObject({ itemId: uuid, result: z.enum(QC_RESULTS).nullable(), comment: text(1000).optional().nullable(), fileIds: z.array(uuid).max(10).default([]) }))
    .max(100),
  notes: text(5000).optional().nullable(),
});

export const failInspectionSchema = z.strictObject({
  defects: text(5000).min(3, 'Describe the defects'),
  /** Stage key to send the work back to (must be an allowed return of the QC stage). */
  responsibleStageKey: z.string().min(1).max(50),
  assignedToId: uuid.optional().nullable(),
});

export interface QcTemplateDto {
  id: string;
  serviceType: { code: string; name: string };
  name: string;
  version: number;
  isActive: boolean;
  items: { id: string; label: string; required: boolean; requiresEvidence: boolean }[];
}

export interface QcInspectionDto {
  id: string;
  stage: { id: string; name: string; occurrenceNo: number };
  templateName: string;
  status: 'DRAFT' | 'PASSED' | 'FAILED';
  inspector: string | null;
  inspectedAt: string | null;
  notes: string | null;
  defects: string | null;
  responsibleStage: string | null;
  correctionId: string | null;
  results: { itemId: string; label: string; required: boolean; requiresEvidence: boolean; result: QcResult | null; comment: string | null; files: { id: string; originalName: string; mimeType: string }[] }[];
  createdAt: string;
}

export interface QualityDto {
  inspections: QcInspectionDto[];
  /** QC stage occurrences an inspection can be started on. */
  activeStage: { id: string; name: string; occurrenceNo: number } | null;
  returnTargets: { key: string; name: string; departmentId: string }[];
  allowedActions: ('inspect' | 'decide')[];
}

// ================================================================ Delivery

export const createDeliverySchema = z.strictObject({
  stageId: uuid,
  plannedAt: z.iso.datetime({ offset: true }),
  notes: text(2000).optional().nullable(),
});

export const completeDeliverySchema = z.strictObject({
  actualAt: z.iso.datetime({ offset: true }),
  recipientName: text(150).min(1, 'Who received the vehicle(s)?'),
  handoverNotes: text(5000).optional().nullable(),
  fileIds: z.array(uuid).min(1, 'Attach handover evidence (photo, signed note…)').max(20),
});

export interface DeliveryDto {
  id: string;
  stage: { id: string; name: string; occurrenceNo: number };
  plannedAt: string;
  actualAt: string | null;
  recipientName: string | null;
  handoverNotes: string | null;
  notes: string | null;
  status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
  completedBy: string | null;
  files: { id: string; originalName: string; mimeType: string }[];
  createdAt: string;
}

export interface DeliveriesDto {
  deliveries: DeliveryDto[];
  activeStage: { id: string; name: string; occurrenceNo: number } | null;
  allowedActions: ('manage')[];
}

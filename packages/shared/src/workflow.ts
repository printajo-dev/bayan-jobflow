import { z } from 'zod';

/**
 * Gate keys a template stage can require. The workflow engine runs the
 * evaluator registered for each key before a stage may complete. Keys marked
 * `available: false` belong to modules of later phases; the template editor
 * offers only available keys, and later phases publish new template versions
 * that use them.
 */
export const GATES = [
  { key: 'brief.complete', label: 'Job brief has all required fields', available: true },
  { key: 'brief.attachments', label: 'At least one drawing or specification file is attached to the brief', available: true },
  { key: 'tasks.complete', label: 'All required tasks are completed', available: true },
  { key: 'corrections.closed', label: 'No open blocking corrections', available: true },
  { key: 'design.customer_approval', label: 'Customer approval recorded for the latest artwork version', available: true },
  { key: 'authority.all_cleared', label: 'Every required authority approval is Approved or Not Required', available: true },
  { key: 'logistics.schedule_confirmed', label: 'Vehicle schedule confirmed', available: true },
  { key: 'production.completed', label: 'All production orders completed', available: true },
  { key: 'installation.completed', label: 'Installation completed with evidence', available: true },
  { key: 'quality.passed', label: 'Latest QC inspection passed', available: true },
  { key: 'logistics.delivery_completed', label: 'Delivery and handover recorded', available: true },
] as const;

export type GateKey = (typeof GATES)[number]['key'];
export const AVAILABLE_GATE_KEYS = GATES.filter((g) => g.available).map((g) => g.key) as GateKey[];

export const SERVICE_TYPE_CODES = ['VB', 'SG'] as const;
export type ServiceTypeCode = (typeof SERVICE_TYPE_CODES)[number];

export const JOB_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const STAGE_STATUSES = ['PENDING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'RETURNED', 'CANCELLED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const TEMPLATE_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUSES)[number];

// ---------------------------------------------------------------- Job briefs

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();

/** Vehicle Branding brief: operational details only. No customer fields exist here. */
export const vehicleSchema = z.strictObject({
  description: text(200).min(1, 'Describe the vehicle (make / model)'),
  year: text(10).optional().nullable(),
  plateOrChassis: text(50).optional().nullable(),
  colour: text(50).optional().nullable(),
});

export const VB_COVERAGE = ['FULL_WRAP', 'PARTIAL_WRAP', 'DECALS', 'OTHER'] as const;

const vbDetailsDraft = z.strictObject({
  vehicles: z.array(vehicleSchema).max(200).default([]),
  coverage: z.enum(VB_COVERAGE).optional().nullable(),
});
const vbDetailsComplete = vbDetailsDraft.extend({
  vehicles: z.array(vehicleSchema).min(1, 'Add at least one vehicle').max(200),
  coverage: z.enum(VB_COVERAGE, { message: 'Choose the coverage' }),
});

const sgDetailsDraft = z.strictObject({
  siteName: text(200).optional().nullable(),
  siteAddress: text(500).optional().nullable(),
  siteAccessNotes: text(2000).optional().nullable(),
  dimensions: text(2000).optional().nullable(),
  specifications: text(5000).optional().nullable(),
  quantity: z.number().int().min(1).max(100000).optional().nullable(),
});
const sgDetailsComplete = sgDetailsDraft.extend({
  siteName: text(200).min(1, 'Site name is required'),
  dimensions: text(2000).min(1, 'Dimensions are required'),
  specifications: text(5000).min(1, 'Specifications are required'),
});

const briefCommonDraft = {
  scope: text(5000).optional().nullable(),
  requirements: text(5000).optional().nullable(),
  notes: text(5000).optional().nullable(),
  targetDate: isoDate.optional().nullable(),
};

export const vbBriefDraftSchema = z.strictObject({ ...briefCommonDraft, details: vbDetailsDraft.default({ vehicles: [] }) });
export const sgBriefDraftSchema = z.strictObject({ ...briefCommonDraft, details: sgDetailsDraft.default({}) });

export const vbBriefCompleteSchema = vbBriefDraftSchema.extend({
  scope: text(5000).min(1, 'Scope is required'),
  details: vbDetailsComplete,
});
export const sgBriefCompleteSchema = sgBriefDraftSchema.extend({
  scope: text(5000).min(1, 'Scope is required'),
  details: sgDetailsComplete,
});

export type VbBrief = z.infer<typeof vbBriefDraftSchema>;
export type SgBrief = z.infer<typeof sgBriefDraftSchema>;
export type JobBrief = VbBrief | SgBrief;

export function briefSchemas(code: ServiceTypeCode) {
  return code === 'VB'
    ? { draft: vbBriefDraftSchema, complete: vbBriefCompleteSchema }
    : { draft: sgBriefDraftSchema, complete: sgBriefCompleteSchema };
}

// ---------------------------------------------------------------- Jobs

export const jobNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Enter the Job Number (ERP invoice number)')
  .max(50)
  .regex(/^[A-Z0-9][A-Z0-9/_.-]*$/, 'Use letters, digits, / _ . or -');

export const createJobSchema = z.strictObject({
  jobNumber: jobNumberSchema,
  serviceType: z.enum(SERVICE_TYPE_CODES),
  title: text(200).min(1, 'Give the job a short title'),
  priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  customerCommitmentDate: isoDate.optional().nullable(),
  /** Validated against the service type's draft brief schema by the API. */
  brief: z.record(z.string(), z.unknown()).default({}),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

export const updateJobSchema = z.strictObject({
  title: text(200).min(1).optional(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  customerCommitmentDate: isoDate.optional().nullable(),
});

export const changeJobNumberSchema = z.strictObject({
  jobNumber: jobNumberSchema,
  reason: text(500).min(3, 'Give a reason'),
});

export const reasonSchema = z.strictObject({ reason: text(1000).min(3, 'Give a reason') });

export const listJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  serviceType: z.enum(SERVICE_TYPE_CODES).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  /** Jobs whose current stage belongs to this department. */
  departmentId: z.uuid().optional(),
  stageKey: z.string().trim().max(50).optional(),
  sort: z.enum(['created_desc', 'created_asc', 'commitment_asc', 'job_number_asc']).default('created_desc'),
});

// ---------------------------------------------------------------- Workflow actions

export const returnStageSchema = z.strictObject({
  targetStageKey: z.string().min(1).max(50),
  reason: text(1000).min(3, 'Give a reason'),
});

export const checklistToggleSchema = z.strictObject({ checked: z.boolean() });

// ---------------------------------------------------------------- Templates

export const stageKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscore');

const gateKeySchema = z.enum(AVAILABLE_GATE_KEYS as [GateKey, ...GateKey[]], { message: 'Unknown or not yet available gate' });

export const templateStageInputSchema = z.strictObject({
  key: stageKeySchema,
  name: text(100).min(1),
  description: text(1000).optional().nullable(),
  departmentId: z.uuid(),
  gateKeys: z.array(gateKeySchema).max(20).default([]),
  checklist: z
    .array(z.strictObject({ label: text(300).min(1), required: z.boolean().default(true) }))
    .max(50)
    .default([]),
});

export const saveTemplateVersionSchema = z.strictObject({
  notes: text(2000).optional().nullable(),
  stages: z.array(templateStageInputSchema).min(1, 'A workflow needs at least one stage').max(30),
  returnRules: z
    .array(z.strictObject({ fromKey: stageKeySchema, toKey: stageKeySchema }))
    .max(200)
    .default([]),
});
export type SaveTemplateVersionInput = z.input<typeof saveTemplateVersionSchema>;

export const jobNumberSettingsSchema = z.strictObject({
  /** Optional regular expression the Job Number must match (e.g. the ERP invoice format). */
  pattern: z
    .string()
    .max(200)
    .nullable()
    .refine((p) => {
      if (p === null || p === '') return true;
      try {
        new RegExp(p);
        return true;
      } catch {
        return false;
      }
    }, 'Not a valid regular expression'),
  example: text(50).nullable().optional(),
});
export type JobNumberSettings = z.infer<typeof jobNumberSettingsSchema>;

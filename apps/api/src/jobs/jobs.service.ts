import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { z } from 'zod';
import {
  briefSchemas,
  type createJobSchema,
  type JobAction,
  type JobBrief,
  type JobDetailDto,
  type JobSummaryDto,
  type listJobsQuerySchema,
  type Paginated,
  type ServiceTypeCode,
  type updateJobSchema,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { SettingsService } from '../settings/settings.js';
import { WorkflowEngine } from '../workflow/engine.service.js';
import { briefProblems, briefToInput } from '../workflow/gates.js';
import { ensureChannels } from '../discussions/channels.js';
import { canViewJob, jobActions, visibleJobsWhere, type JobAccessFacts } from './job-access.js';
import type { Prisma } from '../generated/prisma/client.js';

type CreateJob = z.output<typeof createJobSchema>;
type UpdateJob = z.output<typeof updateJobSchema>;
type ListJobs = z.output<typeof listJobsQuerySchema>;

const CURRENT: ('ACTIVE' | 'ON_HOLD')[] = ['ACTIVE', 'ON_HOLD'];

const summaryInclude = {
  serviceType: true,
  workflow: {
    include: {
      stages: {
        where: { status: { in: CURRENT } },
        include: { templateStage: { select: { key: true, name: true } }, department: { select: { name: true } } },
      },
    },
  },
} as const;

type SummaryRow = Prisma.JobGetPayload<{ include: typeof summaryInclude }>;

const toDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00.000Z`) : null);
const fromDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly engine: WorkflowEngine,
  ) {}

  // ------------------------------------------------------------ reads

  async list(q: ListJobs, p: Principal): Promise<Paginated<JobSummaryDto>> {
    const and: Prisma.JobWhereInput[] = [visibleJobsWhere(p)];
    if (q.search) {
      and.push({
        OR: [
          { jobNumber: { contains: q.search.toUpperCase() } },
          { title: { contains: q.search, mode: 'insensitive' } },
        ],
      });
    }
    if (q.serviceType) and.push({ serviceType: { code: q.serviceType } });
    if (q.status) and.push({ status: q.status });
    if (q.priority) and.push({ priority: q.priority });
    if (q.departmentId || q.stageKey) {
      and.push({
        workflow: {
          stages: {
            some: {
              status: { in: ['ACTIVE', 'ON_HOLD'] },
              ...(q.departmentId ? { departmentId: q.departmentId } : {}),
              ...(q.stageKey ? { templateStage: { key: q.stageKey } } : {}),
            },
          },
        },
      });
    }
    const orderBy: Prisma.JobOrderByWithRelationInput[] = {
      created_desc: [{ createdAt: 'desc' as const }],
      created_asc: [{ createdAt: 'asc' as const }],
      commitment_asc: [{ customerCommitmentDate: { sort: 'asc' as const, nulls: 'last' as const } }, { createdAt: 'desc' as const }],
      job_number_asc: [{ jobNumber: 'asc' as const }],
    }[q.sort];
    const where = { AND: and };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.job.count({ where }),
      this.prisma.job.findMany({ where, include: summaryInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: rows.map((r) => this.toSummary(r)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string, p: Principal, db: Tx = this.prisma): Promise<JobDetailDto> {
    const job = await db.job.findUnique({
      where: { id },
      include: {
        ...summaryInclude,
        brief: true,
        createdBy: { select: { fullName: true } },
        workflow: {
          include: {
            ...summaryInclude.workflow.include,
            templateVersion: { include: { template: true, stages: { select: { departmentId: true, sequence: true } } } },
          },
        },
        files: {
          where: { removedAt: null, file: { deletedAt: null } },
          include: { file: { include: { uploadedBy: { select: { fullName: true } } } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!job || !job.workflow) throw new NotFoundException('Job not found');
    const facts = this.factsOf(job);
    if (!canViewJob(p, facts)) throw new NotFoundException('Job not found');
    const code = job.serviceType.code as ServiceTypeCode;
    const brief = job.brief ? briefToInput(job.brief) : { details: {} };
    return {
      ...this.toSummary(job),
      cancelReason: job.cancelReason,
      createdBy: job.createdBy?.fullName ?? null,
      brief: brief as JobBrief,
      briefProblems: briefProblems(code, brief),
      templateVersion: {
        id: job.workflow.templateVersionId,
        templateName: job.workflow.templateVersion.template.name,
        versionNo: job.workflow.templateVersion.versionNo,
      },
      files: job.files.map((f) => ({
        id: f.file.id,
        originalName: f.file.originalName,
        mimeType: f.file.mimeType,
        size: Number(f.file.size),
        sha256: f.file.sha256,
        purpose: f.purpose,
        uploadedBy: f.file.uploadedBy?.fullName ?? null,
        createdAt: f.createdAt.toISOString(),
      })),
      allowedActions: jobActions(p, facts),
    };
  }

  /** Loads access facts and checks visibility plus an optional action. 404 hides jobs the user cannot see. */
  async authorize(id: string, p: Principal, action?: JobAction, db: Tx = this.prisma): Promise<JobAccessFacts & { jobNumber: string; serviceTypeCode: ServiceTypeCode }> {
    const job = await db.job.findUnique({
      where: { id },
      include: { serviceType: true, workflow: { include: { templateVersion: { include: { stages: { select: { departmentId: true, sequence: true } } } } } } },
    });
    if (!job || !job.workflow) throw new NotFoundException('Job not found');
    const facts = this.factsOf(job);
    if (!canViewJob(p, facts)) throw new NotFoundException('Job not found');
    if (action && !jobActions(p, facts).includes(action)) {
      if (job.status !== 'OPEN' && action !== 'changeNumber') throw new ConflictException(`This job is ${job.status.toLowerCase()}`);
      throw new ForbiddenException('You do not have permission to do this on this job');
    }
    return { ...facts, jobNumber: job.jobNumber, serviceTypeCode: job.serviceType.code as ServiceTypeCode };
  }

  // ------------------------------------------------------------ writes

  async create(input: CreateJob, p: Principal, meta: ActionMeta): Promise<JobDetailDto> {
    if (!p.has('job.create')) throw new ForbiddenException('You do not have permission to create jobs');
    const brief = briefSchemas(input.serviceType).draft.safeParse(input.brief);
    if (!brief.success) throw new BadRequestException(formatIssues(brief.error));

    const id = await this.prisma.$transaction(async (tx) => {
      const formatError = await this.settings.checkJobNumberFormat(input.jobNumber, tx);
      if (formatError) throw new BadRequestException(formatError);
      await this.assertNumberFree(tx, input.jobNumber);
      const serviceType = await tx.serviceType.findUnique({ where: { code: input.serviceType } });
      if (!serviceType || !serviceType.isActive) throw new BadRequestException('Unknown service type');
      const version = await tx.workflowTemplateVersion.findFirst({
        where: { status: 'PUBLISHED', template: { serviceTypeId: serviceType.id } },
        include: { template: true },
      });
      if (!version) throw new ConflictException(`No published workflow template for ${serviceType.name}`);

      const job = await tx.job.create({
        data: {
          jobNumber: input.jobNumber,
          serviceTypeId: serviceType.id,
          title: input.title,
          priority: input.priority,
          customerCommitmentDate: toDate(input.customerCommitmentDate),
          createdById: meta.actorId,
          brief: { create: this.briefData(brief.data, meta.actorId) },
        },
      });
      await this.engine.instantiate(tx, job.id, version.id, meta);
      const stageDepartments = await tx.workflowTemplateStage.findMany({ where: { versionId: version.id }, select: { departmentId: true } });
      await ensureChannels(tx, job.id, stageDepartments.map((s) => s.departmentId));
      await this.audit.record(tx, meta, {
        action: 'job.created',
        entityType: 'job',
        entityId: job.id,
        summary: `${serviceType.name} job ${job.jobNumber} created using ${version.template.name} v${version.versionNo}`,
        after: { jobNumber: job.jobNumber, title: job.title, serviceType: serviceType.code, brief: brief.data },
      });
      await this.outbox.enqueue(tx, {
        type: 'job.created',
        aggregateType: 'job',
        aggregateId: job.id,
        payload: { jobId: job.id, jobNumber: job.jobNumber, serviceType: serviceType.code },
        idempotencyKey: `job.created:${job.id}`,
      });
      return job.id;
    });
    return this.get(id, p);
  }

  async update(id: string, input: UpdateJob, p: Principal, meta: ActionMeta): Promise<JobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.authorize(id, p, 'edit', tx);
      const before = await tx.job.findUniqueOrThrow({ where: { id } });
      const after = await tx.job.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.customerCommitmentDate !== undefined ? { customerCommitmentDate: toDate(input.customerCommitmentDate) } : {}),
        },
      });
      const pick = (j: typeof before) => ({ title: j.title, priority: j.priority, customerCommitmentDate: fromDate(j.customerCommitmentDate) });
      await this.audit.record(tx, meta, {
        action: 'job.updated',
        entityType: 'job',
        entityId: id,
        summary: `Job ${after.jobNumber} details updated`,
        before: pick(before),
        after: pick(after),
      });
    });
    return this.get(id, p);
  }

  async updateBrief(id: string, raw: unknown, p: Principal, meta: ActionMeta): Promise<JobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const facts = await this.authorize(id, p, 'editBrief', tx);
      const parsed = briefSchemas(facts.serviceTypeCode).draft.safeParse(raw);
      if (!parsed.success) throw new BadRequestException(formatIssues(parsed.error));
      const before = await tx.jobBrief.findUnique({ where: { jobId: id } });
      await tx.jobBrief.upsert({
        where: { jobId: id },
        create: { jobId: id, ...this.briefData(parsed.data, meta.actorId) },
        update: this.briefData(parsed.data, meta.actorId),
      });
      await this.audit.record(tx, meta, {
        action: 'job.brief_updated',
        entityType: 'job',
        entityId: id,
        summary: `Job brief of ${facts.jobNumber} updated`,
        before: before ? briefToInput(before) : null,
        after: parsed.data,
      });
    });
    return this.get(id, p);
  }

  async changeNumber(id: string, jobNumber: string, reason: string, p: Principal, meta: ActionMeta): Promise<JobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const facts = await this.authorize(id, p, 'changeNumber', tx);
      if (facts.jobNumber === jobNumber) throw new BadRequestException('That is already the Job Number');
      const formatError = await this.settings.checkJobNumberFormat(jobNumber, tx);
      if (formatError) throw new BadRequestException(formatError);
      await this.assertNumberFree(tx, jobNumber);
      await tx.job.update({ where: { id }, data: { jobNumber } });
      await this.audit.record(tx, meta, {
        action: 'job.number_changed',
        entityType: 'job',
        entityId: id,
        summary: `Job Number changed from ${facts.jobNumber} to ${jobNumber}: ${reason}`,
        before: { jobNumber: facts.jobNumber },
        after: { jobNumber, reason },
      });
    });
    return this.get(id, p);
  }

  async cancel(id: string, reason: string, p: Principal, meta: ActionMeta): Promise<JobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM job_workflows WHERE job_id = ${id}::uuid FOR UPDATE`;
      const facts = await this.authorize(id, p, 'cancel', tx);
      await tx.job.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.engine.cancel(tx, id, reason, meta);
      await this.audit.record(tx, meta, { action: 'job.cancelled', entityType: 'job', entityId: id, summary: `Job ${facts.jobNumber} cancelled: ${reason}` });
      await this.outbox.enqueue(tx, {
        type: 'job.cancelled',
        aggregateType: 'job',
        aggregateId: id,
        payload: { jobId: id, reason },
        idempotencyKey: `job.cancelled:${id}`,
      });
    });
    return this.get(id, p);
  }

  // ------------------------------------------------------------ helpers

  private async assertNumberFree(tx: Tx, jobNumber: string): Promise<void> {
    const existing = await tx.job.findUnique({ where: { jobNumber }, select: { title: true } });
    if (existing) throw new ConflictException(`Job Number ${jobNumber} is already used by "${existing.title}"`);
  }

  private briefData(b: JobBrief, actorId: string | null) {
    return {
      scope: b.scope ?? null,
      requirements: b.requirements ?? null,
      notes: b.notes ?? null,
      targetDate: toDate(b.targetDate),
      details: b.details as Prisma.InputJsonValue,
      updatedById: actorId,
    };
  }

  private factsOf(job: {
    status: 'OPEN' | 'CLOSED' | 'CANCELLED';
    createdById: string | null;
    workflow: { templateVersion: { stages: { departmentId: string; sequence: number }[] } } | null;
  }): JobAccessFacts {
    const stages = [...(job.workflow?.templateVersion.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
    return {
      status: job.status,
      createdById: job.createdById,
      stageDepartmentIds: [...new Set(stages.map((s) => s.departmentId))],
      briefDepartmentId: stages[0]?.departmentId ?? '',
    };
  }

  private toSummary(job: SummaryRow): JobSummaryDto {
    const current = job.workflow?.stages[0];
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      serviceType: { id: job.serviceType.id, code: job.serviceType.code as ServiceTypeCode, name: job.serviceType.name },
      title: job.title,
      status: job.status,
      priority: job.priority,
      customerCommitmentDate: fromDate(job.customerCommitmentDate),
      createdAt: job.createdAt.toISOString(),
      closedAt: job.closedAt?.toISOString() ?? null,
      currentStage: current
        ? { id: current.id, key: current.templateStage.key, name: current.templateStage.name, status: current.status, departmentName: current.department.name }
        : null,
    };
  }
}

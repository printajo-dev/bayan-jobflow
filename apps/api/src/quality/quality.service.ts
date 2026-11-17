import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type {
  completeDeliverySchema,
  createDeliverySchema,
  DeliveriesDto,
  DeliveryDto,
  failInspectionSchema,
  QcInspectionDto,
  QcTemplateDto,
  QualityDto,
  saveQcResultsSchema,
  saveQcTemplateSchema,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { WorkflowEngine } from '../workflow/engine.service.js';
import { postSystemMessage } from '../discussions/channels.js';
import type { Prisma } from '../generated/prisma/client.js';

type SaveResults = z.output<typeof saveQcResultsSchema>;
type Fail = z.output<typeof failInspectionSchema>;

const inspectionInclude = {
  stage: { select: { id: true, occurrenceNo: true, templateStage: { select: { name: true } } } },
  template: { select: { name: true } },
  results: { orderBy: { sequence: 'asc' } },
} as const;
type InspectionRow = Prisma.QcInspectionGetPayload<{ include: typeof inspectionInclude }>;

/**
 * QC inspections and Vehicle Branding delivery.
 * - Each inspection uses the active QC checklist of the job's service type.
 * - Pass: the QC stage completes automatically (the job then goes to Delivery,
 *   or — for Signage — closes immediately).
 * - Fail: defects are recorded, a blocking correction is raised for the
 *   responsible department and the job returns to that stage only; after the
 *   rework a new inspection is needed. Failed inspections are kept.
 * - Delivery: completing the handover (recipient + evidence) completes the
 *   Delivery stage, which closes the job.
 */
@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly engine: WorkflowEngine,
  ) {}

  // ------------------------------------------------------------ templates

  async templates(): Promise<QcTemplateDto[]> {
    const rows = await this.prisma.qcChecklistTemplate.findMany({
      where: { isActive: true },
      include: { serviceType: true, items: { orderBy: { sequence: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id,
      serviceType: { code: t.serviceType.code, name: t.serviceType.name },
      name: t.name,
      version: t.version,
      isActive: t.isActive,
      items: t.items.map((i) => ({ id: i.id, label: i.label, required: i.required, requiresEvidence: i.requiresEvidence })),
    }));
  }

  /** Saves a new version of a service type's QC checklist (earlier inspections keep their copy). */
  async saveTemplate(serviceTypeCode: string, input: z.output<typeof saveQcTemplateSchema>, meta: ActionMeta): Promise<QcTemplateDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const st = await tx.serviceType.findUnique({ where: { code: serviceTypeCode } });
      if (!st) throw new NotFoundException('Unknown service type');
      const last = await tx.qcChecklistTemplate.findFirst({ where: { serviceTypeId: st.id }, orderBy: { version: 'desc' } });
      await tx.qcChecklistTemplate.updateMany({ where: { serviceTypeId: st.id, isActive: true }, data: { isActive: false } });
      await tx.qcChecklistTemplate.create({
        data: {
          serviceTypeId: st.id,
          name: input.name,
          version: (last?.version ?? 0) + 1,
          createdById: meta.actorId,
          items: { create: input.items.map((i, n) => ({ sequence: n + 1, label: i.label, required: i.required, requiresEvidence: i.requiresEvidence })) },
        },
      });
      await this.audit.record(tx, meta, { action: 'qc.template_saved', entityType: 'settings', summary: `QC checklist for ${st.name} saved as version ${(last?.version ?? 0) + 1} (${input.items.length} items)` });
    });
    return this.templates();
  }

  // ------------------------------------------------------------ inspections

  private async qcDepartment(db: Tx, jobId: string): Promise<string | null> {
    const wf = await db.jobWorkflow.findUnique({ where: { jobId }, include: { templateVersion: { include: { stages: { where: { key: 'qc_inspection' } } } } } });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  async get(jobId: string, p: Principal): Promise<QualityDto> {
    const facts = await this.jobs.authorize(jobId, p);
    if (!p.has('qc.view')) throw new ForbiddenException('You do not have access to QC inspections');
    const dept = await this.qcDepartment(this.prisma, jobId);
    const rows = await this.prisma.qcInspection.findMany({ where: { jobId }, include: inspectionInclude, orderBy: { createdAt: 'desc' } });
    const active = await this.prisma.departmentStage.findFirst({
      where: { workflow: { jobId }, templateStage: { key: 'qc_inspection' }, status: 'ACTIVE' },
      include: { templateStage: { include: { returnsFrom: { include: { toStage: true } } } } },
    });
    const open = facts.status === 'OPEN';
    const actions: QualityDto['allowedActions'] = [];
    if (open && dept && p.hasInDepartment('qc.inspect', dept)) actions.push('inspect');
    if (open && dept && p.hasInDepartment('qc.approve', dept)) actions.push('decide');
    return {
      inspections: await this.toDtos(rows),
      activeStage: active ? { id: active.id, name: active.templateStage.name, occurrenceNo: active.occurrenceNo } : null,
      returnTargets: active ? active.templateStage.returnsFrom.map((t) => ({ key: t.toStage.key, name: t.toStage.name, departmentId: t.toStage.departmentId })) : [],
      allowedActions: actions,
    };
  }

  async start(jobId: string, stageId: string, p: Principal, meta: ActionMeta): Promise<QualityDto> {
    await this.jobs.authorize(jobId, p);
    const dept = await this.qcDepartment(this.prisma, jobId);
    if (!dept || !p.hasInDepartment('qc.inspect', dept)) throw new ForbiddenException('Only the Quality Team can inspect');
    await this.prisma.$transaction(async (tx) => {
      const stage = await tx.departmentStage.findUnique({ where: { id: stageId }, include: { workflow: { include: { job: { include: { serviceType: true } } } }, templateStage: true } });
      if (!stage || stage.workflow.jobId !== jobId || stage.templateStage.key !== 'qc_inspection') throw new BadRequestException('Choose the QC stage of this job');
      if (stage.status !== 'ACTIVE') throw new ConflictException('The QC stage is not active');
      if (await tx.qcInspection.count({ where: { stageId, status: 'DRAFT' } })) throw new ConflictException('An inspection is already in progress');
      const template = await tx.qcChecklistTemplate.findFirst({
        where: { serviceTypeId: stage.workflow.job.serviceTypeId, isActive: true },
        include: { items: { orderBy: { sequence: 'asc' } } },
      });
      if (!template) throw new ConflictException('No QC checklist is configured for this service type');
      const ins = await tx.qcInspection.create({
        data: {
          jobId,
          stageId,
          templateId: template.id,
          inspectorId: p.userId,
          createdById: p.userId,
          results: {
            create: template.items.map((i) => ({ itemId: i.id, sequence: i.sequence, label: i.label, required: i.required, requiresEvidence: i.requiresEvidence })),
          },
        },
      });
      await this.audit.record(tx, meta, { action: 'qc.inspection_started', entityType: 'job', entityId: jobId, summary: `QC inspection started (${template.name} v${template.version}${stage.occurrenceNo > 1 ? `, round ${stage.occurrenceNo}` : ''})`, after: { inspectionId: ins.id } });
    });
    return this.get(jobId, p);
  }

  async saveResults(id: string, input: SaveResults, p: Principal): Promise<QualityDto> {
    const ins = await this.loadDraft(id, p, 'qc.inspect');
    await this.prisma.$transaction(async (tx) => {
      const fileIds = input.results.flatMap((r) => r.fileIds);
      if (fileIds.length) {
        const n = await tx.jobFile.count({ where: { jobId: ins.jobId, fileId: { in: fileIds }, purpose: 'QC', removedAt: null } });
        if (n !== new Set(fileIds).size) throw new BadRequestException('Upload the evidence photos first');
      }
      for (const r of input.results) {
        const { count } = await tx.qcChecklistResult.updateMany({ where: { inspectionId: id, itemId: r.itemId }, data: { result: r.result, comment: r.comment ?? null, fileIds: r.fileIds } });
        if (!count) throw new BadRequestException('Unknown checklist item');
      }
      if (input.notes !== undefined) await tx.qcInspection.update({ where: { id }, data: { notes: input.notes } });
    });
    return this.get(ins.jobId, p);
  }

  /** Passes the inspection; the QC stage completes automatically when nothing else is open. */
  async pass(id: string, p: Principal, meta: ActionMeta): Promise<QualityDto> {
    const ins = await this.loadDraft(id, p, 'qc.approve');
    await this.prisma.$transaction(async (tx) => {
      const results = await tx.qcChecklistResult.findMany({ where: { inspectionId: id }, orderBy: { sequence: 'asc' } });
      const problems: string[] = [];
      for (const r of results) {
        if (r.result === 'FAIL') problems.push(`"${r.label}" failed — use Fail instead`);
        else if (r.required && !r.result) problems.push(`"${r.label}" is not checked`);
        else if (r.required && r.result === 'NA' && !r.comment) problems.push(`"${r.label}" is marked N/A without a comment`);
        if (r.result === 'PASS' && r.requiresEvidence && r.fileIds.length === 0) problems.push(`"${r.label}" needs an evidence photo`);
      }
      if (problems.length) throw new BadRequestException(problems);
      await tx.qcInspection.update({ where: { id }, data: { status: 'PASSED', inspectedAt: new Date(), inspectorId: p.userId } });
      await this.audit.record(tx, meta, { action: 'qc.passed', entityType: 'job', entityId: ins.jobId, summary: `QC inspection passed` });
      await this.outbox.enqueue(tx, {
        type: 'qc.result',
        aggregateType: 'job',
        aggregateId: ins.jobId,
        payload: { jobId: ins.jobId, inspectionId: id, result: 'PASSED', summary: 'All checks passed' },
        idempotencyKey: `qc.result:${id}`,
      });
      await this.outbox.enqueue(tx, { type: 'qc.passed', aggregateType: 'job', aggregateId: ins.jobId, payload: { jobId: ins.jobId, inspectionId: id }, idempotencyKey: `qc.passed:${id}` });
      await postSystemMessage(tx, ins.jobId, null, 'QC inspection passed.', ins.stageId);
      await this.engine.systemComplete(tx, ins.jobId, ins.stageId, meta);
    });
    return this.get(ins.jobId, p);
  }

  /** Fails the inspection, raises a blocking correction and returns the job to the responsible stage. */
  async fail(id: string, input: Fail, p: Principal, meta: ActionMeta): Promise<QualityDto> {
    const ins = await this.loadDraft(id, p, 'qc.approve');
    await this.prisma.$transaction(async (tx) => {
      const qcStage = await tx.departmentStage.findUniqueOrThrow({
        where: { id: ins.stageId },
        include: { templateStage: { include: { returnsFrom: { include: { toStage: true } } } } },
      });
      const target = qcStage.templateStage.returnsFrom.find((t) => t.toStage.key === input.responsibleStageKey)?.toStage;
      if (!target) throw new BadRequestException('Choose one of the stages QC can return work to');
      if (input.assignedToId) {
        const ok = await tx.userDepartment.count({ where: { userId: input.assignedToId, departmentId: target.departmentId, user: { status: 'ACTIVE' } } });
        if (!ok) throw new BadRequestException('The assignee must be an active member of the responsible department');
      }
      const failed = await tx.qcChecklistResult.findMany({ where: { inspectionId: id, result: 'FAIL' }, select: { label: true } });
      const correction = await tx.correctionItem.create({
        data: {
          jobId: ins.jobId,
          departmentId: target.departmentId,
          title: `QC rework: ${failed.map((f) => f.label).join(', ').slice(0, 150) || 'defects found'}`,
          description: input.defects,
          requestedById: p.userId,
          assignedToId: input.assignedToId ?? null,
          status: input.assignedToId ? 'ASSIGNED' : 'OPEN',
          blocking: true,
          priority: 'HIGH',
          history: { create: [{ fromStatus: null, toStatus: input.assignedToId ? 'ASSIGNED' : 'OPEN', actorId: p.userId, reason: 'Raised by a failed QC inspection' }] },
        },
      });
      await tx.qcInspection.update({
        where: { id },
        data: { status: 'FAILED', inspectedAt: new Date(), inspectorId: p.userId, defects: input.defects, responsibleStageKey: target.key, correctionId: correction.id },
      });
      await this.audit.record(tx, meta, {
        action: 'qc.failed',
        entityType: 'job',
        entityId: ins.jobId,
        summary: `QC inspection failed — rework by ${target.name}: ${input.defects.slice(0, 200)}`,
        after: { inspectionId: id, correctionId: correction.id },
      });
      await this.outbox.enqueue(tx, {
        type: 'qc.result',
        aggregateType: 'job',
        aggregateId: ins.jobId,
        payload: { jobId: ins.jobId, inspectionId: id, result: 'FAILED', summary: input.defects.slice(0, 200), responsibleDepartmentId: target.departmentId },
        idempotencyKey: `qc.result:${id}`,
      });
      await this.outbox.enqueue(tx, {
        type: 'qc.failed',
        aggregateType: 'job',
        aggregateId: ins.jobId,
        payload: { jobId: ins.jobId, inspectionId: id, correctionId: correction.id },
        idempotencyKey: `qc.failed:${id}`,
      });
      if (input.assignedToId) {
        await this.outbox.enqueue(tx, {
          type: 'correction.assigned',
          aggregateType: 'job',
          aggregateId: ins.jobId,
          payload: { correctionId: correction.id, jobId: ins.jobId, assignedToId: input.assignedToId },
          idempotencyKey: `correction.assigned:${correction.id}`,
        });
      } else {
        await this.outbox.enqueue(tx, {
          type: 'correction.created',
          aggregateType: 'job',
          aggregateId: ins.jobId,
          payload: { correctionId: correction.id, jobId: ins.jobId, departmentId: target.departmentId, assignedToId: null },
          idempotencyKey: `correction.created:${correction.id}`,
        });
      }
      await this.engine.systemReturn(tx, ins.jobId, ins.stageId, target.key, `QC failed: ${input.defects}`, meta);
    });
    return this.get(ins.jobId, p);
  }

  private async loadDraft(id: string, p: Principal, perm: 'qc.inspect' | 'qc.approve') {
    const ins = await this.prisma.qcInspection.findUnique({ where: { id } });
    if (!ins) throw new NotFoundException('Inspection not found');
    const facts = await this.jobs.authorize(ins.jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    const dept = await this.qcDepartment(this.prisma, ins.jobId);
    if (!dept || !p.hasInDepartment(perm, dept)) throw new ForbiddenException(perm === 'qc.approve' ? 'You cannot pass or fail inspections' : 'Only the Quality Team can inspect');
    if (ins.status !== 'DRAFT') throw new ConflictException('This inspection is already submitted; start a re-inspection instead');
    return ins;
  }

  private async toDtos(rows: InspectionRow[]): Promise<QcInspectionDto[]> {
    const userIds = [...new Set(rows.map((r) => r.inspectorId).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const fileIds = [...new Set(rows.flatMap((r) => r.results.flatMap((x) => x.fileIds)))];
    const files = new Map((await this.prisma.file.findMany({ where: { id: { in: fileIds } }, select: { id: true, originalName: true, mimeType: true } })).map((f) => [f.id, f]));
    const stageNames = new Map<string, string>();
    for (const r of rows) if (r.responsibleStageKey) stageNames.set(r.responsibleStageKey, r.responsibleStageKey.replace(/_/g, ' '));
    return rows.map((r) => ({
      id: r.id,
      stage: { id: r.stage.id, name: r.stage.templateStage.name, occurrenceNo: r.stage.occurrenceNo },
      templateName: r.template.name,
      status: r.status,
      inspector: r.inspectorId ? (users.get(r.inspectorId) ?? null) : null,
      inspectedAt: r.inspectedAt?.toISOString() ?? null,
      notes: r.notes,
      defects: r.defects,
      responsibleStage: r.responsibleStageKey ? (stageNames.get(r.responsibleStageKey) ?? null) : null,
      correctionId: r.correctionId,
      results: r.results.map((x) => ({
        itemId: x.itemId,
        label: x.label,
        required: x.required,
        requiresEvidence: x.requiresEvidence,
        result: x.result,
        comment: x.comment,
        files: x.fileIds.map((f) => files.get(f)).filter((f): f is { id: string; originalName: string; mimeType: string } => !!f),
      })),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async authorizeQcUpload(jobId: string, p: Principal): Promise<void> {
    await this.jobs.authorize(jobId, p);
    const dept = await this.qcDepartment(this.prisma, jobId);
    if (!dept || !p.hasInDepartment('qc.inspect', dept)) throw new ForbiddenException('Only the Quality Team can upload QC evidence');
  }

  // ------------------------------------------------------------ delivery

  private async deliveryDepartment(db: Tx, jobId: string): Promise<string | null> {
    const wf = await db.jobWorkflow.findUnique({ where: { jobId }, include: { templateVersion: { include: { stages: { where: { key: 'delivery' } } } } } });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  async deliveries(jobId: string, p: Principal): Promise<DeliveriesDto> {
    const facts = await this.jobs.authorize(jobId, p);
    const dept = await this.deliveryDepartment(this.prisma, jobId);
    if (!dept) throw new NotFoundException('This job has no delivery stage');
    const rows = await this.prisma.deliveryRecord.findMany({ where: { jobId }, include: { stage: { select: { id: true, occurrenceNo: true, templateStage: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } });
    const active = await this.prisma.departmentStage.findFirst({ where: { workflow: { jobId }, templateStage: { key: 'delivery' }, status: { in: ['ACTIVE', 'PENDING'] } }, include: { templateStage: true }, orderBy: { occurrenceNo: 'desc' } });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.completedById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const files = new Map((await this.prisma.file.findMany({ where: { id: { in: rows.flatMap((r) => r.fileIds) } }, select: { id: true, originalName: true, mimeType: true } })).map((f) => [f.id, f]));
    return {
      deliveries: rows.map(
        (r): DeliveryDto => ({
          id: r.id,
          stage: { id: r.stage.id, name: r.stage.templateStage.name, occurrenceNo: r.stage.occurrenceNo },
          plannedAt: r.plannedAt.toISOString(),
          actualAt: r.actualAt?.toISOString() ?? null,
          recipientName: r.recipientName,
          handoverNotes: r.handoverNotes,
          notes: r.notes,
          status: r.status,
          completedBy: r.completedById ? (users.get(r.completedById) ?? null) : null,
          files: r.fileIds.map((f) => files.get(f)).filter((f): f is { id: string; originalName: string; mimeType: string } => !!f),
          createdAt: r.createdAt.toISOString(),
        }),
      ),
      activeStage: active ? { id: active.id, name: active.templateStage.name, occurrenceNo: active.occurrenceNo } : null,
      allowedActions: facts.status === 'OPEN' && p.hasInDepartment('delivery.manage', dept) ? ['manage'] : [],
    };
  }

  async planDelivery(jobId: string, input: z.output<typeof createDeliverySchema>, p: Principal, meta: ActionMeta): Promise<DeliveriesDto> {
    await this.requireDelivery(jobId, p);
    await this.prisma.$transaction(async (tx) => {
      const stage = await tx.departmentStage.findUnique({ where: { id: input.stageId }, include: { workflow: true, templateStage: true } });
      if (!stage || stage.workflow.jobId !== jobId || stage.templateStage.key !== 'delivery') throw new BadRequestException('Choose the Delivery stage of this job');
      if (!['PENDING', 'ACTIVE'].includes(stage.status)) throw new ConflictException('The Delivery stage is closed');
      await tx.deliveryRecord.create({ data: { jobId, stageId: stage.id, plannedAt: new Date(input.plannedAt), notes: input.notes ?? null, createdById: p.userId } });
      await this.audit.record(tx, meta, { action: 'delivery.planned', entityType: 'job', entityId: jobId, summary: `Delivery planned for ${input.plannedAt}` });
    });
    return this.deliveries(jobId, p);
  }

  async completeDelivery(id: string, input: z.output<typeof completeDeliverySchema>, p: Principal, meta: ActionMeta): Promise<DeliveriesDto> {
    const rec = await this.prisma.deliveryRecord.findUnique({ where: { id }, include: { stage: true } });
    if (!rec) throw new NotFoundException('Delivery not found');
    await this.requireDelivery(rec.jobId, p);
    if (rec.status !== 'PLANNED') throw new ConflictException('This delivery is already closed');
    if (rec.stage.status !== 'ACTIVE') throw new ConflictException('Delivery can only be completed once QC has passed and the Delivery stage is active');
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.jobFile.count({ where: { jobId: rec.jobId, fileId: { in: input.fileIds }, purpose: 'DELIVERY', removedAt: null } });
      if (n !== new Set(input.fileIds).size) throw new BadRequestException('Upload the handover evidence first');
      await tx.deliveryRecord.update({
        where: { id },
        data: { status: 'COMPLETED', actualAt: new Date(input.actualAt), recipientName: input.recipientName, handoverNotes: input.handoverNotes ?? null, fileIds: input.fileIds, completedById: p.userId },
      });
      await this.audit.record(tx, meta, { action: 'delivery.completed', entityType: 'job', entityId: rec.jobId, summary: `Delivered and handed over to ${input.recipientName}` });
      await this.outbox.enqueue(tx, { type: 'delivery.completed', aggregateType: 'job', aggregateId: rec.jobId, payload: { jobId: rec.jobId, deliveryId: id }, idempotencyKey: `delivery.completed:${id}` });
      await postSystemMessage(tx, rec.jobId, null, `Delivered and handed over to ${input.recipientName}.`, rec.stageId);
      await this.engine.systemComplete(tx, rec.jobId, rec.stageId, meta);
    });
    return this.deliveries(rec.jobId, p);
  }

  async authorizeDeliveryUpload(jobId: string, p: Principal): Promise<void> {
    await this.requireDelivery(jobId, p);
  }

  private async requireDelivery(jobId: string, p: Principal): Promise<void> {
    const facts = await this.jobs.authorize(jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    const dept = await this.deliveryDepartment(this.prisma, jobId);
    if (!dept) throw new NotFoundException('This job has no delivery stage');
    if (!p.hasInDepartment('delivery.manage', dept)) throw new ForbiddenException('Only the Logistic Team records deliveries');
  }
}

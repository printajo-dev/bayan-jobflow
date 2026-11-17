import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { GateResultDto, ServiceTypeCode, StageAction, StageDto, StageStatus, WorkflowDto } from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { canViewJob, stageActions, type JobAccessFacts } from '../jobs/job-access.js';
import { GateRegistry } from './gates.js';

interface TemplateStageRow {
  id: string;
  key: string;
  name: string;
  sequence: number;
  departmentId: string;
  gateKeys: string[];
  department: { id: string; code: string; name: string };
  checklist: { sequence: number; label: string; required: boolean }[];
}

interface StageRow {
  id: string;
  templateStageId: string;
  occurrenceNo: number;
  status: StageStatus;
  departmentId: string;
  activatedAt: Date | null;
  completedAt: Date | null;
  returnedFromStageId: string | null;
  returnReason: string | null;
  holdReason: string | null;
  exceptionReason: string | null;
  completedBy: { fullName: string } | null;
  checklist: { id: string; sequence: number; label: string; required: boolean; checkedAt: Date | null; checkedBy: { fullName: string } | null }[];
}

export interface WorkflowContext {
  job: { id: string; jobNumber: string; status: 'OPEN' | 'CLOSED' | 'CANCELLED'; createdById: string | null; serviceTypeCode: ServiceTypeCode };
  workflow: { id: string; status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'; templateVersionId: string; templateName: string; versionNo: number };
  templateStages: TemplateStageRow[];
  stages: StageRow[];
  returnRules: { fromStageId: string; toStageId: string }[];
}

const stageInclude = {
  completedBy: { select: { fullName: true } },
  checklist: { orderBy: { sequence: 'asc' }, include: { checkedBy: { select: { fullName: true } } } },
} as const;

/**
 * The workflow engine is the only code that changes stage status. Every
 * operation runs in one transaction that first locks the job's workflow row,
 * so two people acting at once are serialised: the second sees the new state
 * and gets a clear 409 instead of creating duplicate stages.
 *
 * Rework rule (confirmed by the business): a return, QC failure or reopen
 * re-runs only the reopened stage. When that occurrence completes, work goes
 * straight back to a new occurrence of the stage that sent it back.
 */
@Injectable()
export class WorkflowEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly gates: GateRegistry,
  ) {}

  // ------------------------------------------------------------ instantiate

  /** Creates the workflow for a new job from a published template version. */
  async instantiate(tx: Tx, jobId: string, templateVersionId: string, meta: ActionMeta): Promise<void> {
    const version = await tx.workflowTemplateVersion.findUniqueOrThrow({
      where: { id: templateVersionId },
      include: { stages: { orderBy: { sequence: 'asc' }, include: { checklist: { orderBy: { sequence: 'asc' } } } } },
    });
    if (version.status !== 'PUBLISHED') throw new ConflictException('Only a published template version can start a job');
    const workflow = await tx.jobWorkflow.create({ data: { jobId, templateVersionId } });
    let first: string | null = null;
    for (const ts of version.stages) {
      const id = await this.createOccurrence(tx, workflow.id, ts, 1, first ? 'PENDING' : 'ACTIVE');
      if (!first) {
        first = id;
        await this.transition(tx, workflow.id, id, 'activate', null, 'ACTIVE', meta.actorId, null);
        await this.outbox.enqueue(tx, {
          type: 'workflow.stage.activated',
          aggregateType: 'job',
          aggregateId: jobId,
          payload: { jobId, stageId: id, stageKey: ts.key, departmentId: ts.departmentId },
          idempotencyKey: `workflow.stage.activated:${id}`,
        });
      }
    }
  }

  // ------------------------------------------------------------ queries

  async getWorkflow(jobId: string, p: Principal): Promise<WorkflowDto> {
    return this.prisma.$transaction(async (tx) => {
      const ctx = await this.load(tx, jobId, false);
      this.assertVisible(p, ctx);
      return this.toDto(tx, ctx, p);
    });
  }

  // ------------------------------------------------------------ actions

  complete(jobId: string, stageId: string, p: Principal, meta: ActionMeta, exceptionReason?: string): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, exceptionReason ? 'completeWithException' : 'complete', async (tx, ctx, stage, ts) => {
      const results = await this.evaluate(tx, ctx, stage, ts);
      const failed = results.filter((r) => !r.passed);
      if (failed.length && !exceptionReason) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: failed.map((f) => (f.detail ? `${f.label}: ${f.detail}` : f.label)),
        });
      }
      const now = new Date();
      await tx.departmentStage.update({
        where: { id: stage.id },
        data: { status: 'COMPLETED', completedAt: now, completedById: meta.actorId, exceptionReason: exceptionReason ?? null },
      });
      await this.transition(tx, ctx.workflow.id, stage.id, exceptionReason ? 'complete_with_exception' : 'complete', 'ACTIVE', 'COMPLETED', meta.actorId, exceptionReason ?? null);
      await this.audit.record(tx, meta, {
        action: exceptionReason ? 'workflow.stage_completed_with_exception' : 'workflow.stage_completed',
        entityType: 'job',
        entityId: ctx.job.id,
        summary: exceptionReason
          ? `${ts.name} completed by exception: ${exceptionReason}`
          : `${ts.name} completed${stage.occurrenceNo > 1 ? ` (round ${stage.occurrenceNo})` : ''}`,
        after: exceptionReason ? { unmetChecks: failed.map((f) => f.label) } : undefined,
      });
      await this.outbox.enqueue(tx, {
        type: 'workflow.stage.completed',
        aggregateType: 'job',
        aggregateId: ctx.job.id,
        payload: { jobId: ctx.job.id, stageId: stage.id, stageKey: ts.key },
        idempotencyKey: `workflow.stage.completed:${stage.id}`,
      });
      await this.advance(tx, ctx, stage, ts, meta);
    });
  }

  hold(jobId: string, stageId: string, reason: string, p: Principal, meta: ActionMeta): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, 'hold', async (tx, ctx, stage, ts) => {
      await tx.departmentStage.update({ where: { id: stage.id }, data: { status: 'ON_HOLD', holdReason: reason } });
      await this.transition(tx, ctx.workflow.id, stage.id, 'hold', 'ACTIVE', 'ON_HOLD', meta.actorId, reason);
      await this.audit.record(tx, meta, { action: 'workflow.stage_held', entityType: 'job', entityId: ctx.job.id, summary: `${ts.name} put on hold: ${reason}` });
    });
  }

  resume(jobId: string, stageId: string, p: Principal, meta: ActionMeta): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, 'resume', async (tx, ctx, stage, ts) => {
      await tx.departmentStage.update({ where: { id: stage.id }, data: { status: 'ACTIVE', holdReason: null } });
      await this.transition(tx, ctx.workflow.id, stage.id, 'resume', 'ON_HOLD', 'ACTIVE', meta.actorId, null);
      await this.audit.record(tx, meta, { action: 'workflow.stage_resumed', entityType: 'job', entityId: ctx.job.id, summary: `${ts.name} resumed` });
    });
  }

  /** Sends the job back to an earlier stage allowed by the template (e.g. PRO -> Design). */
  returnTo(jobId: string, stageId: string, targetKey: string, reason: string, p: Principal, meta: ActionMeta): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, 'return', async (tx, ctx, stage, ts) => {
      const target = this.returnTargets(ctx, ts.id).find((t) => t.key === targetKey);
      if (!target) throw new ConflictException(`${ts.name} cannot be returned to "${targetKey}"`);
      await tx.departmentStage.update({ where: { id: stage.id }, data: { status: 'RETURNED', returnReason: reason } });
      await this.transition(tx, ctx.workflow.id, stage.id, 'return', 'ACTIVE', 'RETURNED', meta.actorId, reason);
      const occ = this.nextOccurrenceNo(ctx, target.id);
      const newId = await this.createOccurrence(tx, ctx.workflow.id, target, occ, 'ACTIVE', { returnedFromStageId: stage.id, returnReason: reason });
      await this.transition(tx, ctx.workflow.id, newId, 'activate_rework', null, 'ACTIVE', meta.actorId, reason);
      await this.audit.record(tx, meta, {
        action: 'workflow.stage_returned',
        entityType: 'job',
        entityId: ctx.job.id,
        summary: `${ts.name} returned the job to ${target.name} (round ${occ}): ${reason}`,
      });
      await this.activated(tx, ctx, newId, target, 'workflow.stage.returned', { fromStageId: stage.id, reason });
    });
  }

  /**
   * Administrator reopens a completed stage. The current stage (or, for a
   * closed job, the final stage) is where work returns to afterwards.
   */
  reopen(jobId: string, stageId: string, reason: string, p: Principal, meta: ActionMeta): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, 'reopen', async (tx, ctx, stage, ts) => {
      const current = ctx.stages.find((s) => s.status === 'ACTIVE' || s.status === 'ON_HOLD');
      let originId: string | null = null;
      if (current) {
        await tx.departmentStage.update({ where: { id: current.id }, data: { status: 'RETURNED', returnReason: `Reopened ${ts.name}: ${reason}` } });
        await this.transition(tx, ctx.workflow.id, current.id, 'return_for_reopen', current.status, 'RETURNED', meta.actorId, reason);
        originId = current.id;
      } else {
        const last = ctx.templateStages[ctx.templateStages.length - 1]!;
        if (last.id !== ts.id) originId = this.latest(ctx, last.id)?.id ?? null;
        await tx.jobWorkflow.update({ where: { id: ctx.workflow.id }, data: { status: 'ACTIVE', completedAt: null } });
        await tx.job.update({ where: { id: ctx.job.id }, data: { status: 'OPEN', closedAt: null } });
      }
      const occ = this.nextOccurrenceNo(ctx, ts.id);
      const newId = await this.createOccurrence(tx, ctx.workflow.id, ts, occ, 'ACTIVE', { returnedFromStageId: originId, returnReason: reason });
      await this.transition(tx, ctx.workflow.id, newId, 'reopen', null, 'ACTIVE', meta.actorId, reason);
      await this.audit.record(tx, meta, {
        action: 'workflow.stage_reopened',
        entityType: 'job',
        entityId: ctx.job.id,
        summary: `${ts.name} reopened (round ${occ}): ${reason}`,
      });
      await this.activated(tx, ctx, newId, ts, 'workflow.stage.reopened', { reason });
    });
  }

  toggleChecklist(jobId: string, stageId: string, itemId: string, checked: boolean, p: Principal, meta: ActionMeta): Promise<WorkflowDto> {
    return this.act(jobId, stageId, p, 'check', async (tx, ctx, stage, ts) => {
      const item = stage.checklist.find((i) => i.id === itemId);
      if (!item) throw new NotFoundException('Checklist item not found');
      if (checked === (item.checkedAt !== null)) return;
      await tx.stageChecklistItem.update({
        where: { id: item.id },
        data: checked ? { checkedAt: new Date(), checkedById: meta.actorId } : { checkedAt: null, checkedById: null },
      });
      await this.audit.record(tx, meta, {
        action: checked ? 'workflow.checklist_checked' : 'workflow.checklist_unchecked',
        entityType: 'job',
        entityId: ctx.job.id,
        summary: `${ts.name}: "${item.label}" ${checked ? 'ticked' : 'unticked'}`,
      });
    });
  }

  /** Called by job cancellation inside its transaction. */
  async cancel(tx: Tx, jobId: string, reason: string, meta: ActionMeta): Promise<void> {
    const ctx = await this.load(tx, jobId, true);
    await tx.jobWorkflow.update({ where: { id: ctx.workflow.id }, data: { status: 'CANCELLED' } });
    for (const s of ctx.stages.filter((x) => ['ACTIVE', 'ON_HOLD', 'PENDING'].includes(x.status))) {
      await tx.departmentStage.update({ where: { id: s.id }, data: { status: 'CANCELLED' } });
      await this.transition(tx, ctx.workflow.id, s.id, 'cancel_job', s.status, 'CANCELLED', meta.actorId, reason);
    }
  }

  // ------------------------------------------------------------ internals

  private async act(
    jobId: string,
    stageId: string,
    p: Principal,
    action: StageAction,
    fn: (tx: Tx, ctx: WorkflowContext, stage: StageRow, ts: TemplateStageRow) => Promise<void>,
  ): Promise<WorkflowDto> {
    return this.prisma.$transaction(async (tx) => {
      const ctx = await this.load(tx, jobId, true);
      this.assertVisible(p, ctx);
      const stage = ctx.stages.find((s) => s.id === stageId);
      if (!stage) throw new NotFoundException('Stage not found');
      const ts = ctx.templateStages.find((t) => t.id === stage.templateStageId)!;
      const facts = this.stageFacts(ctx, stage, ts);
      if (!stageActions(p, facts).includes(action)) {
        // Would the user be allowed if the stage were in the right state? Then
        // it is a state problem (409), otherwise a permission problem (403).
        const needed: StageStatus = action === 'resume' ? 'ON_HOLD' : action === 'reopen' ? 'COMPLETED' : 'ACTIVE';
        const inRightState = stageActions(p, { ...facts, status: needed, isLatestOccurrence: true, hasReturnTargets: true, jobStatus: 'OPEN' });
        if (!inRightState.includes(action)) throw new ForbiddenException('You do not have permission to do this on this stage');
        if (ctx.job.status === 'CANCELLED') throw new ConflictException('This job is cancelled');
        if (action === 'return' && !facts.hasReturnTargets) throw new ConflictException(`${ts.name} has no stages it can return to`);
        if (action === 'reopen' && stage.status === 'COMPLETED') throw new ConflictException('Only the latest round of a stage can be reopened');
        throw new ConflictException(`${ts.name} is ${stage.status.toLowerCase().replace('_', ' ')}; this action is not possible now`);
      }
      await fn(tx, ctx, stage, ts);
      return this.toDto(tx, await this.load(tx, jobId, false), p);
    });
  }

  /** Moves work on after a stage completes. */
  private async advance(tx: Tx, ctx: WorkflowContext, stage: StageRow, ts: TemplateStageRow, meta: ActionMeta): Promise<void> {
    if (stage.returnedFromStageId) {
      const origin = ctx.stages.find((s) => s.id === stage.returnedFromStageId);
      if (origin) {
        const ots = ctx.templateStages.find((t) => t.id === origin.templateStageId)!;
        const occ = this.nextOccurrenceNo(ctx, ots.id);
        // Keep the origin's own "return to" link, so nested rework unwinds in order.
        const id = await this.createOccurrence(tx, ctx.workflow.id, ots, occ, 'ACTIVE', {
          returnedFromStageId: origin.returnedFromStageId,
          returnReason: origin.returnedFromStageId ? origin.returnReason : null,
        });
        await this.transition(tx, ctx.workflow.id, id, 'activate_after_rework', null, 'ACTIVE', meta.actorId, null);
        await this.activated(tx, ctx, id, ots, 'workflow.stage.activated', { afterReworkOf: stage.id });
        return;
      }
    }
    const next = ctx.templateStages.find((t) => t.sequence > ts.sequence);
    if (!next) {
      const now = new Date();
      await tx.jobWorkflow.update({ where: { id: ctx.workflow.id }, data: { status: 'COMPLETED', completedAt: now } });
      await tx.job.update({ where: { id: ctx.job.id }, data: { status: 'CLOSED', closedAt: now } });
      await this.audit.record(tx, meta, { action: 'job.closed', entityType: 'job', entityId: ctx.job.id, summary: `Job ${ctx.job.jobNumber} closed after ${ts.name}` });
      await this.outbox.enqueue(tx, {
        type: 'job.closed',
        aggregateType: 'job',
        aggregateId: ctx.job.id,
        payload: { jobId: ctx.job.id, lastStageId: stage.id },
        idempotencyKey: `job.closed:${stage.id}`,
      });
      return;
    }
    const pending = this.latest(ctx, next.id);
    let id: string;
    if (pending && pending.status === 'PENDING') {
      await tx.departmentStage.update({ where: { id: pending.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      id = pending.id;
    } else {
      id = await this.createOccurrence(tx, ctx.workflow.id, next, this.nextOccurrenceNo(ctx, next.id), 'ACTIVE');
    }
    await this.transition(tx, ctx.workflow.id, id, 'activate', 'PENDING', 'ACTIVE', meta.actorId, null);
    await this.activated(tx, ctx, id, next, 'workflow.stage.activated', {});
  }

  private async activated(tx: Tx, ctx: WorkflowContext, stageId: string, ts: TemplateStageRow, type: string, extra: Record<string, unknown>) {
    await this.outbox.enqueue(tx, {
      type,
      aggregateType: 'job',
      aggregateId: ctx.job.id,
      payload: { jobId: ctx.job.id, stageId, stageKey: ts.key, departmentId: ts.departmentId, ...extra },
      idempotencyKey: `${type}:${stageId}`,
    });
  }

  private async createOccurrence(
    tx: Tx,
    workflowId: string,
    ts: { id: string; departmentId: string; checklist: { sequence: number; label: string; required: boolean }[] },
    occurrenceNo: number,
    status: 'ACTIVE' | 'PENDING',
    extra: { returnedFromStageId?: string | null; returnReason?: string | null } = {},
  ): Promise<string> {
    const created = await tx.departmentStage.create({
      data: {
        jobWorkflowId: workflowId,
        templateStageId: ts.id,
        occurrenceNo,
        departmentId: ts.departmentId,
        status,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
        returnedFromStageId: extra.returnedFromStageId ?? null,
        returnReason: extra.returnReason ?? null,
        checklist: { create: ts.checklist.map((c) => ({ sequence: c.sequence, label: c.label, required: c.required })) },
      },
    });
    return created.id;
  }

  private transition(tx: Tx, workflowId: string, stageId: string, action: string, from: StageStatus | null, to: StageStatus, actorId: string | null, reason: string | null) {
    return tx.workflowTransition.create({ data: { jobWorkflowId: workflowId, stageId, action, fromStatus: from, toStatus: to, actorId, reason } });
  }

  private async evaluate(tx: Tx, ctx: WorkflowContext, stage: StageRow, ts: TemplateStageRow): Promise<GateResultDto[]> {
    const required = stage.checklist.filter((c) => c.required);
    const open = required.filter((c) => !c.checkedAt);
    const results: GateResultDto[] = [];
    if (required.length) {
      results.push({
        key: 'checklist',
        label: 'Required checklist items are ticked',
        passed: open.length === 0,
        ...(open.length ? { detail: open.map((c) => c.label).join('; ') } : {}),
      });
    }
    results.push(...(await this.gates.evaluate(ts.gateKeys, { tx, jobId: ctx.job.id, serviceTypeCode: ctx.job.serviceTypeCode, stageId: stage.id })));
    return results;
  }

  private returnTargets(ctx: WorkflowContext, templateStageId: string): TemplateStageRow[] {
    const to = ctx.returnRules.filter((r) => r.fromStageId === templateStageId).map((r) => r.toStageId);
    return ctx.templateStages.filter((t) => to.includes(t.id));
  }

  private latest(ctx: WorkflowContext, templateStageId: string): StageRow | undefined {
    return ctx.stages.filter((s) => s.templateStageId === templateStageId).sort((a, b) => b.occurrenceNo - a.occurrenceNo)[0];
  }

  private nextOccurrenceNo(ctx: WorkflowContext, templateStageId: string): number {
    return (this.latest(ctx, templateStageId)?.occurrenceNo ?? 0) + 1;
  }

  facts(ctx: WorkflowContext): JobAccessFacts {
    return {
      status: ctx.job.status,
      createdById: ctx.job.createdById,
      stageDepartmentIds: [...new Set(ctx.templateStages.map((t) => t.departmentId))],
      briefDepartmentId: ctx.templateStages[0]!.departmentId,
    };
  }

  private stageFacts(ctx: WorkflowContext, stage: StageRow, ts: TemplateStageRow) {
    return {
      status: stage.status,
      departmentId: stage.departmentId,
      isLatestOccurrence: this.latest(ctx, ts.id)?.id === stage.id,
      hasReturnTargets: this.returnTargets(ctx, ts.id).length > 0,
      jobStatus: ctx.job.status,
    };
  }

  private assertVisible(p: Principal, ctx: WorkflowContext): void {
    // 404, not 403: do not reveal that a job exists to users who cannot see it.
    if (!canViewJob(p, this.facts(ctx))) throw new NotFoundException('Job not found');
  }

  async load(tx: Tx, jobId: string, lock: boolean): Promise<WorkflowContext> {
    if (lock) {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM job_workflows WHERE job_id = ${jobId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Job not found');
    }
    const wf = await tx.jobWorkflow.findUnique({
      where: { jobId },
      include: {
        job: { include: { serviceType: true } },
        templateVersion: {
          include: {
            template: true,
            stages: {
              orderBy: { sequence: 'asc' },
              include: { department: { select: { id: true, code: true, name: true } }, checklist: { orderBy: { sequence: 'asc' } } },
            },
            transitions: true,
          },
        },
        stages: { include: stageInclude, orderBy: [{ occurrenceNo: 'asc' }] },
      },
    });
    if (!wf) throw new NotFoundException('Job not found');
    return {
      job: {
        id: wf.job.id,
        jobNumber: wf.job.jobNumber,
        status: wf.job.status,
        createdById: wf.job.createdById,
        serviceTypeCode: wf.job.serviceType.code as ServiceTypeCode,
      },
      workflow: {
        id: wf.id,
        status: wf.status,
        templateVersionId: wf.templateVersionId,
        templateName: wf.templateVersion.template.name,
        versionNo: wf.templateVersion.versionNo,
      },
      templateStages: wf.templateVersion.stages,
      stages: wf.stages,
      returnRules: wf.templateVersion.transitions,
    };
  }

  async toDto(tx: Tx, ctx: WorkflowContext, p: Principal): Promise<WorkflowDto> {
    const order = new Map(ctx.templateStages.map((t) => [t.id, t.sequence]));
    const sorted = [...ctx.stages].sort(
      (a, b) => order.get(a.templateStageId)! - order.get(b.templateStageId)! || a.occurrenceNo - b.occurrenceNo,
    );
    const stages: StageDto[] = [];
    for (const s of sorted) {
      const ts = ctx.templateStages.find((t) => t.id === s.templateStageId)!;
      const from = s.returnedFromStageId ? ctx.stages.find((x) => x.id === s.returnedFromStageId) : undefined;
      const fromTs = from ? ctx.templateStages.find((t) => t.id === from.templateStageId) : undefined;
      const isCurrent = s.status === 'ACTIVE' || s.status === 'ON_HOLD';
      stages.push({
        id: s.id,
        key: ts.key,
        name: ts.name,
        sequence: ts.sequence,
        occurrenceNo: s.occurrenceNo,
        status: s.status,
        department: ts.department,
        activatedAt: s.activatedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
        completedBy: s.completedBy?.fullName ?? null,
        returnedFrom: from && fromTs ? { stageId: from.id, key: fromTs.key, name: fromTs.name } : null,
        returnReason: s.returnReason,
        holdReason: s.holdReason,
        exceptionReason: s.exceptionReason,
        checklist: s.checklist.map((c) => ({
          id: c.id,
          label: c.label,
          required: c.required,
          checkedAt: c.checkedAt?.toISOString() ?? null,
          checkedBy: c.checkedBy?.fullName ?? null,
        })),
        gates: isCurrent ? await this.evaluate(tx, ctx, s, ts) : [],
        allowedActions: stageActions(p, this.stageFacts(ctx, s, ts)),
        returnTargets: s.status === 'ACTIVE' ? this.returnTargets(ctx, ts.id).map((t) => ({ key: t.key, name: t.name })) : [],
      });
    }
    return {
      id: ctx.workflow.id,
      status: ctx.workflow.status,
      templateVersion: { id: ctx.workflow.templateVersionId, templateName: ctx.workflow.templateName, versionNo: ctx.workflow.versionNo },
      stages,
    };
  }
}

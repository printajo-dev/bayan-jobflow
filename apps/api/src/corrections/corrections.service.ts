import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { CorrectionDto, CorrectionStatus, createCorrectionSchema, resolveCorrectionSchema, updateCorrectionSchema } from '@jobflow/shared';
import { visibleJobsWhere } from '../jobs/job-access.js';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService, type StoredFile, type StoredUpload } from '../files/files.service.js';
import { DiscussionsService } from '../discussions/discussions.service.js';
import type { Prisma } from '../generated/prisma/client.js';

type CreateCorrection = z.output<typeof createCorrectionSchema>;
type UpdateCorrection = z.output<typeof updateCorrectionSchema>;
type ResolveCorrection = z.output<typeof resolveCorrectionSchema>;

const include = {
  job: { select: { jobNumber: true, status: true } },
  department: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { fullName: true } },
  assignedTo: { select: { id: true, fullName: true } },
  files: { include: { file: { select: { id: true, originalName: true } } } },
  history: { orderBy: { createdAt: 'asc' } },
} as const;
type Row = Prisma.CorrectionItemGetPayload<{ include: typeof include }>;

/**
 * Formal correction items: a tracked request to fix something, distinct from
 * chat. A comment can be converted into one (sourceMessageId). Blocking
 * corrections stop a stage from completing when its template uses the
 * corrections.closed check.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly discussions: DiscussionsService,
  ) {}

  async listForJob(jobId: string, p: Principal): Promise<CorrectionDto[]> {
    await this.jobs.authorize(jobId, p);
    const rows = await this.prisma.correctionItem.findMany({ where: { jobId }, include, orderBy: { createdAt: 'desc' } });
    return this.toDtos(rows, p);
  }

  async mine(p: Principal): Promise<CorrectionDto[]> {
    const rows = await this.prisma.correctionItem.findMany({
      // Only on jobs the user can still see (they may have changed department).
      where: { assignedToId: p.userId, status: { not: 'RESOLVED' }, job: visibleJobsWhere(p) },
      include,
      orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: 100,
    });
    return this.toDtos(rows, p);
  }

  async uploadFile(jobId: string, upload: StoredUpload | undefined, p: Principal, meta: ActionMeta): Promise<StoredFile> {
    try {
      await this.jobs.authorize(jobId, p);
      if (!p.has('correction.create') && !p.has('correction.resolve')) throw new ForbiddenException('You cannot attach correction files');
    } catch (e) {
      await this.files.discard(upload);
      throw e;
    }
    return this.files.store(jobId, upload, 'CORRECTION', meta);
  }

  async create(input: CreateCorrection, p: Principal, meta: ActionMeta): Promise<CorrectionDto> {
    const facts = await this.jobs.authorize(input.jobId, p);
    if (!p.has('correction.create')) throw new ForbiddenException('You cannot create corrections');
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    if (!facts.stageDepartmentIds.includes(input.departmentId)) {
      const extra = await this.prisma.discussionChannel.count({ where: { jobId: input.jobId, departmentId: input.departmentId } });
      if (!extra) throw new BadRequestException('That department has no part in this job');
    }
    const id = await this.prisma.$transaction(async (tx) => {
      await this.files.assertOwnUnusedUploads(tx, input.jobId, input.fileIds, ['CORRECTION'], p.userId);
      let channelId = input.channelId ?? null;
      if (input.sourceMessageId) {
        const m = await tx.discussionMessage.findUnique({ where: { id: input.sourceMessageId } });
        if (!m || m.jobId !== input.jobId || m.deletedAt) throw new BadRequestException('Source message not found in this job');
        await this.discussions.channelFor(m.channelId, p, tx);
        channelId = m.channelId;
      }
      let stageId = input.stageId ?? null;
      if (stageId) {
        const s = await tx.departmentStage.findUnique({ where: { id: stageId }, include: { workflow: true } });
        if (!s || s.workflow.jobId !== input.jobId) throw new BadRequestException('Stage not found in this job');
      } else {
        const s = await tx.departmentStage.findFirst({
          where: { workflow: { jobId: input.jobId }, departmentId: input.departmentId },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
        stageId = s?.id ?? null;
      }
      let assignedToId: string | null = null;
      if (input.assignedToId) {
        if (!p.hasInDepartment('correction.assign', input.departmentId)) throw new ForbiddenException('Only the department leader can assign corrections');
        await this.assertMember(tx, input.departmentId, input.assignedToId);
        assignedToId = input.assignedToId;
      }
      const status: CorrectionStatus = assignedToId ? 'ASSIGNED' : 'OPEN';
      const c = await tx.correctionItem.create({
        data: {
          jobId: input.jobId,
          departmentId: input.departmentId,
          stageId,
          channelId,
          sourceMessageId: input.sourceMessageId ?? null,
          title: input.title,
          description: input.description,
          requestedById: p.userId,
          assignedToId,
          priority: input.priority,
          deadline: input.deadline ? new Date(`${input.deadline}T00:00:00.000Z`) : null,
          status,
          blocking: input.blocking,
          files: { create: input.fileIds.map((fileId) => ({ fileId, kind: 'ATTACHMENT' })) },
          history: { create: [{ fromStatus: null, toStatus: status, actorId: p.userId, reason: null }] },
        },
        include: { department: true },
      });
      await this.audit.record(tx, meta, {
        action: 'correction.created',
        entityType: 'job',
        entityId: input.jobId,
        summary: `Correction "${c.title}" raised for ${c.department.name}${c.blocking ? ' (blocks the stage)' : ''}`,
        after: { correctionId: c.id, sourceMessageId: c.sourceMessageId },
      });
      await this.event(tx, 'correction.created', c.id, input.jobId, { departmentId: c.departmentId, assignedToId });
      if (assignedToId) await this.event(tx, 'correction.assigned', c.id, input.jobId, { assignedToId }, meta.requestId);
      await this.discussions.systemMessage(tx, input.jobId, c.departmentId, `Correction raised: ${c.title}`);
      return c.id;
    });
    return this.get(id, p);
  }

  async get(id: string, p: Principal): Promise<CorrectionDto> {
    const c = await this.prisma.correctionItem.findUnique({ where: { id }, include });
    if (!c) throw new NotFoundException('Correction not found');
    await this.jobs.authorize(c.jobId, p);
    return (await this.toDtos([c], p))[0]!;
  }

  async update(id: string, input: UpdateCorrection, p: Principal, meta: ActionMeta): Promise<CorrectionDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.load(tx, id, p);
      const leader = p.hasInDepartment('correction.assign', c.departmentId);
      const assignee = c.assignedToId === p.userId;
      if (c.status === 'RESOLVED') throw new ConflictException('Reopen the correction first');
      const data: Prisma.CorrectionItemUncheckedUpdateInput = {};
      let next: CorrectionStatus | null = null;
      if (input.assignedToId !== undefined && input.assignedToId !== c.assignedToId) {
        if (!leader) throw new ForbiddenException('Only the department leader can assign corrections');
        if (input.assignedToId) await this.assertMember(tx, c.departmentId, input.assignedToId);
        data.assignedToId = input.assignedToId;
        if (input.assignedToId && (c.status === 'OPEN' || c.status === 'REOPENED')) next = 'ASSIGNED';
      }
      if (input.deadline !== undefined || input.priority !== undefined) {
        if (!leader) throw new ForbiddenException('Only the department leader can change the deadline or priority');
        if (input.deadline !== undefined) data.deadline = input.deadline ? new Date(`${input.deadline}T00:00:00.000Z`) : null;
        if (input.priority !== undefined) data.priority = input.priority;
      }
      if (input.status !== undefined && input.status !== c.status) {
        if (!leader && !assignee) throw new ForbiddenException('Only the assignee or the leader can change the status');
        next = input.status;
      }
      if (next) {
        data.status = next;
        await tx.correctionStatusHistory.create({ data: { correctionId: id, fromStatus: c.status, toStatus: next, actorId: p.userId, reason: input.reason ?? null } });
      }
      await tx.correctionItem.update({ where: { id }, data });
      await this.audit.record(tx, meta, {
        action: 'correction.updated',
        entityType: 'job',
        entityId: c.jobId,
        summary: `Correction "${c.title}" updated${next ? `: ${next.replace('_', ' ').toLowerCase()}` : ''}`,
        before: { status: c.status, assignedToId: c.assignedToId },
        after: { status: next ?? c.status, assignedToId: data.assignedToId ?? c.assignedToId },
      });
      if (input.assignedToId && input.assignedToId !== c.assignedToId) await this.event(tx, 'correction.assigned', id, c.jobId, { assignedToId: input.assignedToId }, meta.requestId);
      else await this.event(tx, 'correction.updated', id, c.jobId, { status: next }, meta.requestId);
    });
    return this.get(id, p);
  }

  async resolve(id: string, input: ResolveCorrection, p: Principal, meta: ActionMeta): Promise<CorrectionDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.load(tx, id, p);
      const allowed = (c.assignedToId === p.userId && p.has('correction.resolve')) || p.hasInDepartment('correction.assign', c.departmentId);
      if (!allowed) throw new ForbiddenException('Only the assignee or the department leader can resolve this correction');
      if (c.status === 'RESOLVED') throw new ConflictException('Already resolved');
      await this.files.assertOwnUnusedUploads(tx, c.jobId, input.fileIds, ['CORRECTION'], p.userId);
      await tx.correctionItem.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolutionNotes: input.notes,
          resolvedAt: new Date(),
          resolvedById: p.userId,
          files: { create: input.fileIds.map((fileId) => ({ fileId, kind: 'RESOLUTION' })) },
        },
      });
      await tx.correctionStatusHistory.create({ data: { correctionId: id, fromStatus: c.status, toStatus: 'RESOLVED', actorId: p.userId, reason: input.notes.slice(0, 1000) } });
      await this.audit.record(tx, meta, { action: 'correction.resolved', entityType: 'job', entityId: c.jobId, summary: `Correction "${c.title}" resolved: ${input.notes.slice(0, 200)}` });
      await this.event(tx, 'correction.resolved', id, c.jobId, { requestedById: c.requestedById }, meta.requestId);
      await this.discussions.systemMessage(tx, c.jobId, c.departmentId, `Correction resolved: ${c.title}`);
    });
    return this.get(id, p);
  }

  async reopen(id: string, reason: string, p: Principal, meta: ActionMeta): Promise<CorrectionDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.load(tx, id, p);
      const allowed = p.hasInDepartment('correction.reopen', c.departmentId) || (c.requestedById === p.userId && p.has('correction.create'));
      if (!allowed) throw new ForbiddenException('Only the requester or the department leader can reopen this correction');
      if (c.status !== 'RESOLVED') throw new ConflictException('Only resolved corrections can be reopened');
      await tx.correctionItem.update({ where: { id }, data: { status: 'REOPENED', resolvedAt: null, resolvedById: null } });
      await tx.correctionStatusHistory.create({ data: { correctionId: id, fromStatus: 'RESOLVED', toStatus: 'REOPENED', actorId: p.userId, reason } });
      await this.audit.record(tx, meta, { action: 'correction.reopened', entityType: 'job', entityId: c.jobId, summary: `Correction "${c.title}" reopened: ${reason}` });
      await this.event(tx, 'correction.reopened', id, c.jobId, { assignedToId: c.assignedToId, departmentId: c.departmentId }, meta.requestId);
      await this.discussions.systemMessage(tx, c.jobId, c.departmentId, `Correction reopened: ${c.title} — ${reason}`);
    });
    return this.get(id, p);
  }

  private async load(tx: Tx, id: string, p: Principal) {
    await tx.$queryRaw`SELECT id FROM correction_items WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.correctionItem.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Correction not found');
    const facts = await this.jobs.authorize(c.jobId, p, undefined, tx);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    return c;
  }

  private async assertMember(tx: Tx, departmentId: string, userId: string): Promise<void> {
    const ok = await tx.userDepartment.count({ where: { departmentId, userId, user: { status: 'ACTIVE' } } });
    if (!ok) throw new BadRequestException('Corrections can only be assigned to active members of the department');
  }

  private event(tx: Tx, type: string, id: string, jobId: string, extra: Record<string, unknown>, nonce = '') {
    return this.outbox.enqueue(tx, {
      type,
      aggregateType: 'job',
      aggregateId: jobId,
      payload: { correctionId: id, jobId, ...extra },
      idempotencyKey: `${type}:${id}${nonce ? `:${nonce}` : ''}`,
    });
  }

  private async toDtos(rows: Row[], p: Principal): Promise<CorrectionDto[]> {
    const userIds = [...new Set(rows.flatMap((r) => [r.resolvedById, ...r.history.map((h) => h.actorId)]).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const stageIds = rows.map((r) => r.stageId).filter((x): x is string => !!x);
    const stages = new Map(
      (await this.prisma.departmentStage.findMany({ where: { id: { in: stageIds } }, include: { templateStage: { select: { name: true } } } })).map((s) => [
        s.id,
        { id: s.id, name: s.templateStage.name, occurrenceNo: s.occurrenceNo },
      ]),
    );
    return rows.map((c) => {
      const leader = p.hasInDepartment('correction.assign', c.departmentId);
      const assignee = c.assignedToId === p.userId;
      const open = c.job.status === 'OPEN';
      const actions: CorrectionDto['allowedActions'] = [];
      if (open && c.status !== 'RESOLVED') {
        if (leader) actions.push('assign');
        if (leader || assignee) actions.push('update');
        if (leader || (assignee && p.has('correction.resolve'))) actions.push('resolve');
      }
      if (open && c.status === 'RESOLVED' && (p.hasInDepartment('correction.reopen', c.departmentId) || (c.requestedById === p.userId && p.has('correction.create')))) {
        actions.push('reopen');
      }
      return {
        id: c.id,
        jobId: c.jobId,
        jobNumber: c.job.jobNumber,
        department: c.department,
        stage: c.stageId ? (stages.get(c.stageId) ?? null) : null,
        sourceMessageId: c.sourceMessageId,
        channelId: c.channelId,
        title: c.title,
        description: c.description,
        requestedBy: c.requestedBy?.fullName ?? null,
        assignedTo: c.assignedTo,
        priority: c.priority,
        deadline: c.deadline ? c.deadline.toISOString().slice(0, 10) : null,
        status: c.status,
        blocking: c.blocking,
        resolutionNotes: c.resolutionNotes,
        resolvedAt: c.resolvedAt?.toISOString() ?? null,
        resolvedBy: c.resolvedById ? (users.get(c.resolvedById) ?? null) : null,
        files: c.files.map((f) => ({ ...f.file, kind: f.kind as 'ATTACHMENT' | 'RESOLUTION' })),
        history: c.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, actor: h.actorId ? (users.get(h.actorId) ?? null) : null, reason: h.reason, at: h.createdAt.toISOString() })),
        createdAt: c.createdAt.toISOString(),
        allowedActions: actions,
      };
    });
  }
}

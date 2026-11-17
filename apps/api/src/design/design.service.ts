import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { createCorrectionRoundSchema, DesignDto, recordApprovalSchema } from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService, type StoredFile, type StoredUpload } from '../files/files.service.js';
import { DiscussionsService } from '../discussions/discussions.service.js';

type RecordApproval = z.output<typeof recordApprovalSchema>;
type CreateRound = z.output<typeof createCorrectionRoundSchema>;

const METHOD_LABEL: Record<string, string> = {
  IN_PERSON: 'in person',
  EMAIL: 'by email',
  WHATSAPP: 'by WhatsApp',
  PHONE: 'by phone',
  SIGNED_FORM: 'on a signed form',
  OTHER: 'other',
};

/**
 * Artwork versions, correction rounds and customer approvals.
 * - Every upload is a new immutable version (never overwritten).
 * - Sales records customer approval manually against one exact version.
 * - A new version needs a new approval; the design.customer_approval check
 *   looks only at the newest version.
 */
@Injectable()
export class DesignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly discussions: DiscussionsService,
  ) {}

  canView(p: Principal): boolean {
    return p.has('artwork.view') || p.has('customer_approval.record');
  }

  /** The department owning the job's design stage (normally the Design Team). */
  private async designDepartment(db: Tx, jobId: string): Promise<string | null> {
    const wf = await db.jobWorkflow.findUnique({ where: { jobId }, include: { templateVersion: { include: { stages: { where: { key: 'design' } } } } } });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  private async canUpload(db: Tx, jobId: string, p: Principal): Promise<boolean> {
    const dept = await this.designDepartment(db, jobId);
    return dept ? p.hasInDepartment('artwork.upload', dept) : p.hasGlobal('artwork.upload');
  }

  private async assertView(jobId: string, p: Principal) {
    const facts = await this.jobs.authorize(jobId, p);
    if (!this.canView(p)) throw new ForbiddenException('You do not have access to design work');
    return facts;
  }

  async get(jobId: string, p: Principal): Promise<DesignDto> {
    await this.assertView(jobId, p);
    const [versions, rounds] = await Promise.all([
      this.prisma.artworkVersion.findMany({
        where: { jobId },
        orderBy: { versionNo: 'desc' },
        include: {
          file: true,
          uploadedBy: { select: { fullName: true } },
          correctionRound: { select: { roundNo: true } },
          approvals: { orderBy: { createdAt: 'asc' }, include: { evidenceFile: { select: { id: true, originalName: true } }, recordedBy: { select: { fullName: true } } } },
        },
      }),
      this.prisma.correctionRound.findMany({
        where: { jobId },
        orderBy: { roundNo: 'desc' },
        include: {
          requestedBy: { select: { fullName: true } },
          assignedDesigner: { select: { id: true, fullName: true } },
          versions: { select: { versionNo: true } },
          files: { include: { file: { select: { id: true, originalName: true } } } },
        },
      }),
    ]);
    const facts = await this.jobs.authorize(jobId, p);
    const open = facts.status === 'OPEN';
    const actions: DesignDto['allowedActions'] = [];
    if (open && (await this.canUpload(this.prisma, jobId, p))) actions.push('upload');
    if (open && p.has('customer_approval.record')) actions.push('recordApproval');
    if (open && (p.has('correction_round.manage') || p.has('customer_approval.record'))) actions.push('manageRounds');
    return {
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        file: { id: v.file.id, originalName: v.file.originalName, mimeType: v.file.mimeType, size: Number(v.file.size), sha256: v.file.sha256 },
        notes: v.notes,
        correctionRoundNo: v.correctionRound?.roundNo ?? null,
        uploadedBy: v.uploadedBy?.fullName ?? null,
        createdAt: v.createdAt.toISOString(),
        approvals: v.approvals.map((a) => ({
          id: a.id,
          artworkVersionId: v.id,
          versionNo: v.versionNo,
          approverName: a.approverName,
          approverRole: a.approverRole,
          method: a.method,
          approvedAt: a.approvedAt.toISOString(),
          notes: a.notes,
          evidenceFile: a.evidenceFile,
          recordedBy: a.recordedBy?.fullName ?? null,
          createdAt: a.createdAt.toISOString(),
        })),
      })),
      rounds: rounds.map((r) => ({
        id: r.id,
        roundNo: r.roundNo,
        description: r.description,
        requestedBy: r.requestedBy?.fullName ?? null,
        assignedDesigner: r.assignedDesigner,
        deadline: r.deadline ? r.deadline.toISOString().slice(0, 10) : null,
        status: r.resolvedAt ? 'RESOLVED' : 'OPEN',
        resolvedByVersionNo: r.versions[0]?.versionNo ?? null,
        files: r.files.map((f) => f.file),
        createdAt: r.createdAt.toISOString(),
      })),
      latestApproved: versions.length > 0 && versions[0]!.approvals.length > 0,
      allowedActions: actions,
    };
  }

  /** Stores supporting files (approval evidence, correction-round references) before they are attached. */
  async uploadSupportingFile(jobId: string, upload: StoredUpload | undefined, kind: 'APPROVAL_EVIDENCE' | 'ROUND', p: Principal, meta: ActionMeta): Promise<StoredFile> {
    try {
      await this.assertView(jobId, p);
      const allowed = kind === 'APPROVAL_EVIDENCE' ? p.has('customer_approval.record') : p.has('correction_round.manage') || p.has('customer_approval.record');
      if (!allowed) throw new ForbiddenException('You cannot upload this file');
    } catch (e) {
      await this.files.discard(upload);
      throw e;
    }
    return this.files.store(jobId, upload, kind, meta);
  }

  async uploadVersion(jobId: string, upload: StoredUpload | undefined, notes: string | null, correctionRoundId: string | null, p: Principal, meta: ActionMeta): Promise<DesignDto> {
    let facts;
    try {
      facts = await this.assertView(jobId, p);
      if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
      if (!(await this.canUpload(this.prisma, jobId, p))) throw new ForbiddenException('Only the Design Team can upload artwork');
      if (correctionRoundId) {
        // Checked again inside the transaction; this avoids storing a file for a request that will fail.
        const r = await this.prisma.correctionRound.findUnique({ where: { id: correctionRoundId } });
        if (!r || r.jobId !== jobId) throw new BadRequestException('Correction round not found');
        if (r.resolvedAt) throw new ConflictException(`Correction round ${r.roundNo} is already resolved`);
      }
    } catch (e) {
      await this.files.discard(upload);
      throw e;
    }
    const stored = await this.files.store(jobId, upload, 'ARTWORK', meta);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const last = await tx.artworkVersion.findFirst({ where: { jobId }, orderBy: { versionNo: 'desc' } });
      const versionNo = (last?.versionNo ?? 0) + 1;
      let round = null;
      if (correctionRoundId) {
        round = await tx.correctionRound.findUnique({ where: { id: correctionRoundId } });
        if (!round || round.jobId !== jobId) throw new BadRequestException('Correction round not found');
        if (round.resolvedAt) throw new ConflictException(`Correction round ${round.roundNo} is already resolved`);
        await tx.correctionRound.update({ where: { id: round.id }, data: { resolvedAt: new Date() } });
      }
      const designStage = await tx.departmentStage.findFirst({
        where: { workflow: { jobId }, templateStage: { key: 'design' }, status: { in: ['ACTIVE', 'ON_HOLD'] } },
      });
      const v = await tx.artworkVersion.create({
        data: { jobId, versionNo, fileId: stored.id, stageId: designStage?.id ?? null, correctionRoundId: round?.id ?? null, notes, uploadedById: p.userId },
      });
      await this.audit.record(tx, meta, {
        action: 'artwork.version_uploaded',
        entityType: 'job',
        entityId: jobId,
        summary: `Artwork version ${versionNo} uploaded (${stored.originalName})${round ? ` for correction round ${round.roundNo}` : ''}`,
        after: { versionId: v.id, sha256: stored.sha256 },
      });
      await this.outbox.enqueue(tx, {
        type: 'artwork.version.uploaded',
        aggregateType: 'job',
        aggregateId: jobId,
        payload: { jobId, versionId: v.id, versionNo },
        idempotencyKey: `artwork.version.uploaded:${v.id}`,
      });
      await this.discussions.systemMessage(tx, jobId, await this.designDepartment(tx, jobId), `Artwork version ${versionNo} uploaded${versionNo > 1 ? ' — it needs a new customer approval' : ''}.`);
    }).catch(async (e: unknown) => {
      await this.files.purge(stored.id).catch(() => undefined);
      throw e;
    });
    return this.get(jobId, p);
  }

  async recordApproval(versionId: string, input: RecordApproval, p: Principal, meta: ActionMeta): Promise<DesignDto> {
    const version = await this.prisma.artworkVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('Artwork version not found');
    const facts = await this.assertView(version.jobId, p);
    if (!p.has('customer_approval.record')) throw new ForbiddenException('Only Sales records customer approval');
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    if (new Date(input.approvedAt) > new Date(Date.now() + 5 * 60_000)) throw new BadRequestException('The approval date cannot be in the future');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${version.jobId}::uuid FOR UPDATE`;
      const latest = await tx.artworkVersion.findFirst({ where: { jobId: version.jobId }, orderBy: { versionNo: 'desc' } });
      if (latest?.id !== version.id) throw new ConflictException(`Version ${version.versionNo} is not the latest artwork (latest is ${latest?.versionNo}). Record approval for the latest version.`);
      if (input.evidenceFileId) {
        const link = await tx.jobFile.findFirst({ where: { jobId: version.jobId, fileId: input.evidenceFileId, purpose: 'APPROVAL_EVIDENCE', addedById: p.userId } });
        if (!link) throw new BadRequestException('Upload the evidence file first');
      }
      const a = await tx.approvalRecord.create({
        data: {
          jobId: version.jobId,
          artworkVersionId: version.id,
          approverName: input.approverName,
          approverRole: input.approverRole ?? null,
          method: input.method,
          approvedAt: new Date(input.approvedAt),
          notes: input.notes ?? null,
          evidenceFileId: input.evidenceFileId ?? null,
          recordedById: p.userId,
        },
      });
      const summary = `Customer approval of artwork version ${version.versionNo} recorded: ${input.approverName}${input.approverRole ? ` (${input.approverRole})` : ''}, ${METHOD_LABEL[input.method]}`;
      await this.audit.record(tx, meta, { action: 'artwork.approved', entityType: 'job', entityId: version.jobId, summary, after: { approvalId: a.id, versionNo: version.versionNo } });
      await this.outbox.enqueue(tx, {
        type: 'artwork.approved',
        aggregateType: 'job',
        aggregateId: version.jobId,
        payload: { jobId: version.jobId, versionId: version.id, versionNo: version.versionNo, approvalId: a.id },
        idempotencyKey: `artwork.approved:${a.id}`,
      });
      await this.discussions.systemMessage(tx, version.jobId, await this.designDepartment(tx, version.jobId), `${summary}.`);
    });
    return this.get(version.jobId, p);
  }

  async createRound(jobId: string, input: CreateRound, p: Principal, meta: ActionMeta): Promise<DesignDto> {
    const facts = await this.assertView(jobId, p);
    if (!p.has('correction_round.manage') && !p.has('customer_approval.record')) throw new ForbiddenException('You cannot open correction rounds');
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      await this.files.assertOwnUnusedUploads(tx, jobId, input.fileIds, ['ROUND'], p.userId);
      const dept = await this.designDepartment(tx, jobId);
      if (input.assignedDesignerId) {
        const ok = await tx.userDepartment.count({ where: { userId: input.assignedDesignerId, departmentId: dept ?? undefined, user: { status: 'ACTIVE' } } });
        if (!ok) throw new BadRequestException('The designer must be an active member of the Design Team');
      }
      if (input.sourceMessageId) {
        const m = await tx.discussionMessage.findUnique({ where: { id: input.sourceMessageId } });
        if (!m || m.jobId !== jobId) throw new BadRequestException('Source message not found in this job');
      }
      const last = await tx.correctionRound.findFirst({ where: { jobId }, orderBy: { roundNo: 'desc' } });
      const roundNo = (last?.roundNo ?? 0) + 1;
      const r = await tx.correctionRound.create({
        data: {
          jobId,
          roundNo,
          description: input.description,
          sourceMessageId: input.sourceMessageId ?? null,
          requestedById: p.userId,
          assignedDesignerId: input.assignedDesignerId ?? null,
          deadline: input.deadline ? new Date(`${input.deadline}T00:00:00.000Z`) : null,
          files: { create: input.fileIds.map((fileId) => ({ fileId })) },
        },
      });
      await this.audit.record(tx, meta, { action: 'design.round_opened', entityType: 'job', entityId: jobId, summary: `Design correction round ${roundNo} opened: ${input.description.slice(0, 200)}` });
      await this.outbox.enqueue(tx, {
        type: 'design.round.opened',
        aggregateType: 'job',
        aggregateId: jobId,
        payload: { jobId, roundId: r.id, roundNo, assignedDesignerId: input.assignedDesignerId ?? null },
        idempotencyKey: `design.round.opened:${r.id}`,
      });
      await this.discussions.systemMessage(tx, jobId, dept, `Design correction round ${roundNo} opened: ${input.description.slice(0, 300)}`);
    });
    return this.get(jobId, p);
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import {
  AUTHORITY_TRANSITIONS,
  type authorityPaymentSchema,
  type AuthorityApplicationDto,
  type AuthorityDocumentKind,
  type AuthorityDto,
  type AuthorityStatus,
  type authorityTypeSchema,
  type AuthorityTypeDto,
  type updateAuthorityApplicationSchema,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { postSystemMessage } from '../discussions/channels.js';
import type { Prisma } from '../generated/prisma/client.js';

type UpdateApplication = z.output<typeof updateAuthorityApplicationSchema>;
type Payment = z.output<typeof authorityPaymentSchema>;

const include = {
  authorityType: true,
  submissions: { orderBy: { submissionNo: 'asc' } },
  documents: { orderBy: { createdAt: 'asc' }, include: { file: { select: { originalName: true } } } },
  payments: { orderBy: { paidAt: 'asc' } },
  history: { orderBy: { createdAt: 'asc' } },
} as const;
type Row = Prisma.AuthorityApplicationGetPayload<{ include: typeof include }>;

const toTypeDto = (t: { id: string; code: string; name: string; description: string | null; isActive: boolean }): AuthorityTypeDto => ({
  id: t.id,
  code: t.code,
  name: t.name,
  description: t.description,
  isActive: t.isActive,
});
const day = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00.000Z`) : null);

/**
 * PRO / government approvals for a job (e.g. RTA). The Government Approval
 * stage cannot complete — and so Print and Wrap cannot start — until every
 * application is Approved (with an approval document) or marked Not Required
 * with a reason by the PRO Leader or an administrator.
 */
@Injectable()
export class AuthorityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
  ) {}

  /** The department owning the job's government approval stage (PRO Section). */
  private async proDepartment(db: Tx, jobId: string): Promise<string | null> {
    const wf = await db.jobWorkflow.findUnique({ where: { jobId }, include: { templateVersion: { include: { stages: { where: { key: 'government_approval' } } } } } });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  private async access(jobId: string, p: Principal, db: Tx = this.prisma) {
    const facts = await this.jobs.authorize(jobId, p, undefined, db);
    if (!p.has('authority.view')) throw new ForbiddenException('You do not have access to authority approvals');
    const dept = await this.proDepartment(db, jobId);
    const manage = facts.status === 'OPEN' && (dept ? p.hasInDepartment('authority.manage', dept) : p.hasGlobal('authority.manage'));
    const notRequired = facts.status === 'OPEN' && (dept ? p.hasInDepartment('authority.mark_not_required', dept) : p.hasGlobal('authority.mark_not_required'));
    return { facts, dept, manage, notRequired };
  }

  async types(): Promise<AuthorityTypeDto[]> {
    return (await this.prisma.authorityType.findMany({ orderBy: { name: 'asc' } })).map(toTypeDto);
  }

  async saveType(id: string | null, input: z.output<typeof authorityTypeSchema>, meta: ActionMeta): Promise<AuthorityTypeDto> {
    return this.prisma.$transaction(async (tx) => {
      const t = id
        ? await tx.authorityType.update({ where: { id }, data: { name: input.name, description: input.description ?? null, isActive: input.isActive } })
        : await tx.authorityType.create({ data: { code: input.code, name: input.name, description: input.description ?? null, isActive: input.isActive } });
      await this.audit.record(tx, meta, { action: id ? 'authority_type.updated' : 'authority_type.created', entityType: 'settings', summary: `Authority type ${t.name} ${id ? 'updated' : 'created'}` });
      return toTypeDto(t);
    });
  }

  async get(jobId: string, p: Principal): Promise<AuthorityDto> {
    const a = await this.access(jobId, p);
    const rows = await this.prisma.authorityApplication.findMany({ where: { jobId }, include, orderBy: { createdAt: 'asc' } });
    const live = rows.filter((r) => r.status !== 'CANCELLED');
    return {
      applications: await this.toDtos(rows, a.manage, a.notRequired),
      types: await this.types(),
      cleared: live.length > 0 && live.every((r) => r.status === 'APPROVED' || r.status === 'NOT_REQUIRED'),
      allowedActions: [...(a.manage ? (['manage'] as const) : []), ...(a.notRequired ? (['markNotRequired'] as const) : [])],
    };
  }

  async create(jobId: string, authorityTypeId: string, comments: string | null, p: Principal, meta: ActionMeta): Promise<AuthorityDto> {
    const a = await this.access(jobId, p);
    if (!a.manage) throw new ForbiddenException('Only the PRO Section can create authority applications');
    await this.prisma.$transaction(async (tx) => {
      const type = await tx.authorityType.findUnique({ where: { id: authorityTypeId } });
      if (!type || !type.isActive) throw new BadRequestException('Unknown authority');
      const existing = await tx.authorityApplication.findUnique({ where: { jobId_authorityTypeId: { jobId, authorityTypeId } } });
      if (existing) throw new ConflictException(`There is already a ${type.name} application for this job`);
      const app = await tx.authorityApplication.create({
        data: { jobId, authorityTypeId, comments, createdById: p.userId, history: { create: [{ fromStatus: null, toStatus: 'PENDING_PREPARATION', actorId: p.userId }] } },
      });
      await this.audit.record(tx, meta, { action: 'authority.application_created', entityType: 'job', entityId: jobId, summary: `${type.name} application opened`, after: { applicationId: app.id } });
    });
    return this.get(jobId, p);
  }

  async update(id: string, input: UpdateApplication, p: Principal, meta: ActionMeta): Promise<AuthorityDto> {
    const app = await this.prisma.authorityApplication.findUnique({ where: { id }, include: { authorityType: true } });
    if (!app) throw new NotFoundException('Application not found');
    const a = await this.access(app.jobId, p);
    if (!a.manage) throw new ForbiddenException('Only the PRO Section can update authority applications');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM authority_applications WHERE id = ${id}::uuid FOR UPDATE`;
      const cur = await tx.authorityApplication.findUniqueOrThrow({ where: { id }, include: { documents: true, submissions: { orderBy: { submissionNo: 'desc' }, take: 1 } } });
      const data: Prisma.AuthorityApplicationUncheckedUpdateInput = {};
      if (input.referenceNumber !== undefined) data.referenceNumber = input.referenceNumber;
      if (input.expectedResponseDate !== undefined) data.expectedResponseDate = day(input.expectedResponseDate);
      if (input.validUntil !== undefined) data.validUntil = day(input.validUntil);
      if (input.fees !== undefined) data.fees = input.fees;
      if (input.paymentStatus !== undefined) data.paymentStatus = input.paymentStatus;
      if (input.comments !== undefined) data.comments = input.comments;
      const next = input.status && input.status !== cur.status ? input.status : null;
      if (next) {
        if (next === 'NOT_REQUIRED') throw new BadRequestException('Use "Mark Not Required" for that');
        if (!AUTHORITY_TRANSITIONS[cur.status].includes(next)) throw new ConflictException(`An application cannot move from ${label(cur.status)} to ${label(next)}`);
        if (cur.status === 'NOT_REQUIRED' && !a.notRequired) throw new ForbiddenException('Only the PRO Leader or an administrator can revoke Not Required');
        // Cancelling takes an approval out of the Government Approval gate, the
        // same effect as Not Required, so it needs the same authority.
        if ((next === 'CANCELLED' || cur.status === 'CANCELLED') && !a.notRequired) throw new ForbiddenException('Only the PRO Leader or an administrator can cancel or reopen an approval');
        const now = new Date();
        if (next === 'SUBMITTED') {
          const submittedAt = input.submissionDate ? new Date(input.submissionDate) : now;
          data.submissionDate = submittedAt;
          data.actualResponseDate = null;
          data.rejectionReason = null;
          await tx.authoritySubmission.create({
            data: { applicationId: id, submissionNo: (cur.submissions[0]?.submissionNo ?? 0) + 1, submittedAt, referenceNumber: input.referenceNumber ?? cur.referenceNumber, createdById: p.userId },
          });
        }
        if (next === 'APPROVED') {
          if (!cur.documents.some((d) => d.kind === 'APPROVAL')) throw new BadRequestException('Upload the approval document before marking the application Approved');
          data.actualResponseDate = input.actualResponseDate ? new Date(input.actualResponseDate) : now;
        }
        if (next === 'REJECTED') {
          const reason = input.rejectionReason ?? input.note;
          if (!reason) throw new BadRequestException('Give the rejection reason');
          data.rejectionReason = reason;
          data.actualResponseDate = input.actualResponseDate ? new Date(input.actualResponseDate) : now;
        }
        if (next === 'MORE_INFO_REQUIRED' && !input.note) throw new BadRequestException('Describe what information the authority needs');
        if (next === 'CANCELLED' && !input.note) throw new BadRequestException('Give a reason for cancelling');
        if (next === 'PENDING_PREPARATION' && cur.status === 'NOT_REQUIRED') {
          data.notRequiredReason = null;
          data.notRequiredById = null;
        }
        const outcome = ({ APPROVED: 'APPROVED', REJECTED: 'REJECTED', MORE_INFO_REQUIRED: 'MORE_INFO' } as const)[next as 'APPROVED'];
        if (outcome && cur.submissions[0]) {
          await tx.authoritySubmission.update({ where: { id: cur.submissions[0].id }, data: { outcome, outcomeAt: now, outcomeNotes: input.note ?? input.rejectionReason ?? null } });
        }
        data.status = next;
        await tx.authorityStatusHistory.create({ data: { applicationId: id, fromStatus: cur.status, toStatus: next, actorId: p.userId, note: input.note ?? input.rejectionReason ?? null } });
      }
      await tx.authorityApplication.update({ where: { id }, data });
      const summary = next
        ? `${app.authorityType.name}: ${label(cur.status)} → ${label(next)}${input.note || input.rejectionReason ? ` (${input.note ?? input.rejectionReason})` : ''}`
        : `${app.authorityType.name} application details updated`;
      await this.audit.record(tx, meta, {
        action: next ? 'authority.status_changed' : 'authority.updated',
        entityType: 'job',
        entityId: app.jobId,
        summary,
        before: { status: cur.status, referenceNumber: cur.referenceNumber, fees: cur.fees?.toString() ?? null },
        after: { status: next ?? cur.status, referenceNumber: data.referenceNumber ?? cur.referenceNumber },
      });
      if (next === 'APPROVED' || next === 'REJECTED' || next === 'MORE_INFO_REQUIRED') {
        await this.outbox.enqueue(tx, {
          type: 'authority.decision',
          aggregateType: 'job',
          aggregateId: app.jobId,
          payload: { jobId: app.jobId, applicationId: id, authority: app.authorityType.name, status: next, note: input.note ?? input.rejectionReason ?? null },
          idempotencyKey: `authority.decision:${id}:${next}:${meta.requestId}`,
        });
        await postSystemMessage(tx, app.jobId, a.dept, `${summary}.`);
      }
    });
    return this.get(app.jobId, p);
  }

  /** PRO Leader or administrator: this authority approval is not needed for this job. */
  async markNotRequired(id: string, reason: string, p: Principal, meta: ActionMeta): Promise<AuthorityDto> {
    const app = await this.prisma.authorityApplication.findUnique({ where: { id }, include: { authorityType: true } });
    if (!app) throw new NotFoundException('Application not found');
    const a = await this.access(app.jobId, p);
    if (!a.notRequired) throw new ForbiddenException('Only the PRO Leader or an administrator can mark an approval Not Required');
    if (app.status === 'APPROVED' || app.status === 'NOT_REQUIRED') throw new ConflictException(`The application is already ${label(app.status)}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.authorityApplication.update({ where: { id }, data: { status: 'NOT_REQUIRED', notRequiredReason: reason, notRequiredById: p.userId } });
      await tx.authorityStatusHistory.create({ data: { applicationId: id, fromStatus: app.status, toStatus: 'NOT_REQUIRED', actorId: p.userId, note: reason } });
      const summary = `${app.authorityType.name} marked Not Required: ${reason}`;
      await this.audit.record(tx, meta, { action: 'authority.not_required', entityType: 'job', entityId: app.jobId, summary, before: { status: app.status }, after: { status: 'NOT_REQUIRED', reason } });
      await postSystemMessage(tx, app.jobId, a.dept, summary);
    });
    return this.get(app.jobId, p);
  }

  async addDocument(id: string, fileId: string, kind: AuthorityDocumentKind, p: Principal, meta: ActionMeta): Promise<AuthorityDto> {
    const app = await this.prisma.authorityApplication.findUnique({ where: { id }, include: { authorityType: true } });
    if (!app) throw new NotFoundException('Application not found');
    const a = await this.access(app.jobId, p);
    if (!a.manage) throw new ForbiddenException('Only the PRO Section can add authority documents');
    await this.prisma.$transaction(async (tx) => {
      const link = await tx.jobFile.findFirst({ where: { jobId: app.jobId, fileId, purpose: 'AUTHORITY', addedById: p.userId, removedAt: null } });
      if (!link) throw new BadRequestException('Upload the document first');
      const latest = await tx.authoritySubmission.findFirst({ where: { applicationId: id }, orderBy: { submissionNo: 'desc' } });
      await tx.authorityDocument.create({ data: { applicationId: id, fileId, kind, uploadedById: p.userId } });
      await this.audit.record(tx, meta, {
        action: 'authority.document_added',
        entityType: 'job',
        entityId: app.jobId,
        summary: `${app.authorityType.name}: ${kind.toLowerCase()} document added${latest ? ` (submission ${latest.submissionNo})` : ''}`,
      });
    });
    return this.get(app.jobId, p);
  }

  async addPayment(id: string, input: Payment, p: Principal, meta: ActionMeta): Promise<AuthorityDto> {
    const app = await this.prisma.authorityApplication.findUnique({ where: { id }, include: { authorityType: true } });
    if (!app) throw new NotFoundException('Application not found');
    const a = await this.access(app.jobId, p);
    if (!a.manage) throw new ForbiddenException('Only the PRO Section can record payments');
    await this.prisma.$transaction(async (tx) => {
      if (input.receiptFileId) {
        const link = await tx.jobFile.findFirst({ where: { jobId: app.jobId, fileId: input.receiptFileId, purpose: 'AUTHORITY', addedById: p.userId, removedAt: null } });
        if (!link) throw new BadRequestException('Upload the receipt first');
      }
      await tx.authorityPayment.create({
        data: { applicationId: id, amount: input.amount, paidAt: new Date(input.paidAt), reference: input.reference ?? null, receiptFileId: input.receiptFileId ?? null, recordedById: p.userId },
      });
      await tx.authorityApplication.update({ where: { id }, data: { paymentStatus: 'PAID' } });
      await this.audit.record(tx, meta, { action: 'authority.payment_recorded', entityType: 'job', entityId: app.jobId, summary: `${app.authorityType.name}: payment of ${input.amount.toFixed(2)} recorded` });
    });
    return this.get(app.jobId, p);
  }

  /** Lists open applications for the PRO dashboard. */
  async openApplications(p: Principal) {
    if (!p.has('authority.view')) throw new ForbiddenException();
    const rows = await this.prisma.authorityApplication.findMany({
      where: { status: { notIn: ['APPROVED', 'NOT_REQUIRED', 'CANCELLED'] }, job: { status: 'OPEN' } },
      include: { authorityType: true, job: { select: { id: true, jobNumber: true, title: true } } },
      orderBy: [{ expectedResponseDate: { sort: 'asc', nulls: 'last' } }],
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      job: r.job,
      authority: r.authorityType.name,
      status: r.status,
      referenceNumber: r.referenceNumber,
      expectedResponseDate: r.expectedResponseDate?.toISOString().slice(0, 10) ?? null,
      overdue: !!r.expectedResponseDate && r.expectedResponseDate < new Date(new Date().toISOString().slice(0, 10)),
    }));
  }

  private async toDtos(rows: Row[], manage: boolean, notRequired: boolean): Promise<AuthorityApplicationDto[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.notRequiredById, ...r.documents.map((d) => d.uploadedById), ...r.payments.map((x) => x.recordedById), ...r.history.map((h) => h.actorId)]).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const name = (id: string | null) => (id ? (users.get(id) ?? null) : null);
    return rows.map((r) => ({
      id: r.id,
      authorityType: toTypeDto(r.authorityType),
      status: r.status,
      referenceNumber: r.referenceNumber,
      submissionDate: r.submissionDate?.toISOString() ?? null,
      expectedResponseDate: r.expectedResponseDate?.toISOString().slice(0, 10) ?? null,
      actualResponseDate: r.actualResponseDate?.toISOString() ?? null,
      validUntil: r.validUntil?.toISOString().slice(0, 10) ?? null,
      fees: r.fees ? Number(r.fees) : null,
      paymentStatus: r.paymentStatus,
      rejectionReason: r.rejectionReason,
      notRequiredReason: r.notRequiredReason,
      notRequiredBy: name(r.notRequiredById),
      comments: r.comments,
      submissions: r.submissions.map((s) => ({
        id: s.id,
        submissionNo: s.submissionNo,
        submittedAt: s.submittedAt.toISOString(),
        referenceNumber: s.referenceNumber,
        outcome: s.outcome,
        outcomeAt: s.outcomeAt?.toISOString() ?? null,
        outcomeNotes: s.outcomeNotes,
      })),
      documents: r.documents.map((d) => ({ id: d.id, fileId: d.fileId, originalName: d.file.originalName, kind: d.kind as AuthorityDocumentKind, uploadedBy: name(d.uploadedById), createdAt: d.createdAt.toISOString() })),
      payments: r.payments.map((x) => ({ id: x.id, amount: Number(x.amount), paidAt: x.paidAt.toISOString(), reference: x.reference, receiptFileId: x.receiptFileId, recordedBy: name(x.recordedById) })),
      history: r.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, actor: name(h.actorId), note: h.note, at: h.createdAt.toISOString() })),
      createdAt: r.createdAt.toISOString(),
      allowedStatuses: manage
        ? AUTHORITY_TRANSITIONS[r.status].filter((s) => notRequired || !(s === 'CANCELLED' || r.status === 'CANCELLED' || (s === 'PENDING_PREPARATION' && r.status === 'NOT_REQUIRED')))
        : [],
    }));
  }
}

export function label(s: AuthorityStatus): string {
  return s.toLowerCase().replace(/_/g, ' ');
}

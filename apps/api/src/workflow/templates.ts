import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { z } from 'zod';
import {
  GATES,
  saveTemplateVersionSchema,
  uuidSchema,
  type GateKey,
  type TemplateSummaryDto,
  type TemplateVersionDto,
  type TemplateVersionStatus,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { type ActionMeta, Meta, RequirePermissions } from '../access/decorators.js';

type SaveVersion = z.output<typeof saveTemplateVersionSchema>;

const versionInclude = {
  stages: {
    orderBy: { sequence: 'asc' },
    include: { department: { select: { id: true, code: true, name: true } }, checklist: { orderBy: { sequence: 'asc' } } },
  },
  transitions: { include: { fromStage: { select: { key: true } }, toStage: { select: { key: true } } } },
  _count: { select: { workflows: true } },
} as const;

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(): Promise<TemplateSummaryDto[]> {
    const rows = await this.prisma.workflowTemplate.findMany({
      include: {
        serviceType: true,
        versions: { orderBy: { versionNo: 'desc' }, include: { _count: { select: { workflows: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      serviceType: { id: t.serviceType.id, code: t.serviceType.code as 'VB' | 'SG', name: t.serviceType.name },
      versions: t.versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        status: v.status as TemplateVersionStatus,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        jobCount: v._count.workflows,
      })),
    }));
  }

  async getVersion(id: string, db: Tx = this.prisma): Promise<TemplateVersionDto> {
    const v = await db.workflowTemplateVersion.findUnique({
      where: { id },
      include: { ...versionInclude, template: true },
    });
    if (!v) throw new NotFoundException('Template version not found');
    const publishedBy = v.publishedById
      ? (await db.user.findUnique({ where: { id: v.publishedById }, select: { fullName: true } }))?.fullName ?? null
      : null;
    return {
      id: v.id,
      templateId: v.templateId,
      versionNo: v.versionNo,
      status: v.status,
      notes: v.notes,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      publishedBy,
      createdAt: v.createdAt.toISOString(),
      jobCount: v._count.workflows,
      stages: v.stages.map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        description: s.description,
        sequence: s.sequence,
        department: s.department,
        gateKeys: s.gateKeys as GateKey[],
        checklist: s.checklist.map((c) => ({ label: c.label, required: c.required })),
      })),
      returnRules: v.transitions.map((t) => ({ fromKey: t.fromStage.key, toKey: t.toStage.key })),
    };
  }

  /** Starts a new draft from an existing version (default: the published one). */
  createDraft(templateId: string, fromVersionId: string | undefined, meta: ActionMeta): Promise<TemplateVersionDto> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.findUnique({ where: { id: templateId }, include: { versions: true } });
      if (!template) throw new NotFoundException('Template not found');
      const existingDraft = template.versions.find((v) => v.status === 'DRAFT');
      if (existingDraft) throw new ConflictException(`Version ${existingDraft.versionNo} is already a draft; edit or delete it first`);
      const source = fromVersionId
        ? template.versions.find((v) => v.id === fromVersionId)
        : template.versions.find((v) => v.status === 'PUBLISHED');
      if (!source) throw new NotFoundException('Source version not found');
      const src = await this.getVersion(source.id, tx);
      const versionNo = Math.max(...template.versions.map((v) => v.versionNo)) + 1;
      const draft = await tx.workflowTemplateVersion.create({
        data: { templateId, versionNo, status: 'DRAFT', notes: null, createdById: meta.actorId },
      });
      await this.writeStages(tx, draft.id, {
        notes: null,
        stages: src.stages.map((s) => ({
          key: s.key,
          name: s.name,
          description: s.description,
          departmentId: s.department.id,
          gateKeys: s.gateKeys,
          checklist: s.checklist,
        })),
        returnRules: src.returnRules,
      });
      await this.audit.record(tx, meta, {
        action: 'template.draft_created',
        entityType: 'workflow_template',
        entityId: templateId,
        summary: `Draft version ${versionNo} of ${template.name} created from version ${src.versionNo}`,
      });
      return this.getVersion(draft.id, tx);
    });
  }

  saveDraft(versionId: string, input: SaveVersion, meta: ActionMeta): Promise<TemplateVersionDto> {
    return this.prisma.$transaction(async (tx) => {
      // One change at a time per version (save vs publish vs delete).
      await tx.$queryRaw`SELECT id FROM workflow_template_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      const v = await tx.workflowTemplateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
      if (!v) throw new NotFoundException('Template version not found');
      if (v.status !== 'DRAFT') throw new ConflictException('Only draft versions can be edited. Create a new draft instead.');
      await this.validate(tx, input);
      const before = await this.getVersion(versionId, tx);
      await tx.workflowTemplateStage.deleteMany({ where: { versionId } });
      await tx.workflowTemplateVersion.update({ where: { id: versionId }, data: { notes: input.notes ?? null } });
      await this.writeStages(tx, versionId, input);
      const after = await this.getVersion(versionId, tx);
      await this.audit.record(tx, meta, {
        action: 'template.draft_saved',
        entityType: 'workflow_template',
        entityId: v.templateId,
        summary: `Draft version ${v.versionNo} of ${v.template.name} saved (${after.stages.length} stages)`,
        before: { stages: before.stages.map((s) => s.key), returnRules: before.returnRules },
        after: { stages: after.stages.map((s) => s.key), returnRules: after.returnRules },
      });
      return after;
    });
  }

  /** Publishes a draft; the previously published version is retired (jobs using it keep it). */
  publish(versionId: string, meta: ActionMeta): Promise<TemplateVersionDto> {
    return this.prisma.$transaction(async (tx) => {
      // One change at a time per version (save vs publish vs delete).
      await tx.$queryRaw`SELECT id FROM workflow_template_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      const v = await tx.workflowTemplateVersion.findUnique({
        where: { id: versionId },
        include: { template: true, stages: true },
      });
      if (!v) throw new NotFoundException('Template version not found');
      if (v.status !== 'DRAFT') throw new ConflictException('This version is already published');
      if (v.stages.length === 0) throw new BadRequestException('A workflow needs at least one stage');
      const previous = await tx.workflowTemplateVersion.findFirst({ where: { templateId: v.templateId, status: 'PUBLISHED' } });
      if (previous) await tx.workflowTemplateVersion.update({ where: { id: previous.id }, data: { status: 'RETIRED' } });
      await tx.workflowTemplateVersion.update({
        where: { id: versionId },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: meta.actorId },
      });
      await this.audit.record(tx, meta, {
        action: 'template.published',
        entityType: 'workflow_template',
        entityId: v.templateId,
        summary: `Version ${v.versionNo} of ${v.template.name} published${previous ? `; version ${previous.versionNo} retired (existing jobs keep it)` : ''}`,
      });
      await this.outbox.enqueue(tx, {
        type: 'workflow.template.published',
        aggregateType: 'workflow_template',
        aggregateId: v.templateId,
        payload: { templateId: v.templateId, versionId, versionNo: v.versionNo },
        idempotencyKey: `workflow.template.published:${versionId}`,
      });
      return this.getVersion(versionId, tx);
    });
  }

  deleteDraft(versionId: string, meta: ActionMeta): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      // One change at a time per version (save vs publish vs delete).
      await tx.$queryRaw`SELECT id FROM workflow_template_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      const v = await tx.workflowTemplateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
      if (!v) throw new NotFoundException('Template version not found');
      if (v.status !== 'DRAFT') throw new ConflictException('Only drafts can be deleted');
      await tx.workflowTemplateVersion.delete({ where: { id: versionId } });
      await this.audit.record(tx, meta, {
        action: 'template.draft_deleted',
        entityType: 'workflow_template',
        entityId: v.templateId,
        summary: `Draft version ${v.versionNo} of ${v.template.name} deleted`,
      });
    });
  }

  private async validate(tx: Tx, input: SaveVersion): Promise<void> {
    const keys = input.stages.map((s) => s.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new BadRequestException(`Stage key "${dup}" is used twice`);
    const deptIds = [...new Set(input.stages.map((s) => s.departmentId))];
    if ((await tx.department.count({ where: { id: { in: deptIds }, isActive: true } })) !== deptIds.length) {
      throw new BadRequestException('Every stage needs an existing, active responsible department');
    }
    for (const r of input.returnRules) {
      const from = keys.indexOf(r.fromKey);
      const to = keys.indexOf(r.toKey);
      if (from < 0 || to < 0) throw new BadRequestException(`Return rule ${r.fromKey} → ${r.toKey} refers to a stage that does not exist`);
      if (to >= from) throw new BadRequestException(`Return rule ${r.fromKey} → ${r.toKey} must go back to an earlier stage`);
    }
  }

  private async writeStages(tx: Tx, versionId: string, input: SaveVersion): Promise<void> {
    const ids = new Map<string, string>();
    for (const [i, s] of input.stages.entries()) {
      const stage = await tx.workflowTemplateStage.create({
        data: {
          versionId,
          sequence: i + 1,
          key: s.key,
          name: s.name,
          description: s.description ?? null,
          departmentId: s.departmentId,
          gateKeys: s.gateKeys,
          checklist: { create: s.checklist.map((c, j) => ({ sequence: j + 1, label: c.label, required: c.required })) },
        },
      });
      ids.set(s.key, stage.id);
    }
    const seen = new Set<string>();
    for (const r of input.returnRules) {
      const k = `${r.fromKey}>${r.toKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await tx.workflowTemplateTransition.create({ data: { versionId, fromStageId: ids.get(r.fromKey)!, toStageId: ids.get(r.toKey)! } });
    }
  }
}

@Controller()
@RequirePermissions('template.manage')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('workflow-templates')
  list() {
    return this.templates.list();
  }

  @Get('workflow-gates')
  gates() {
    return GATES;
  }

  @Get('workflow-template-versions/:id')
  version(@Param('id', { schema: uuidSchema }) id: string) {
    return this.templates.getVersion(id);
  }

  @Post('workflow-templates/:id/versions')
  createDraft(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body('fromVersionId', { schema: uuidSchema.optional() }) fromVersionId: string | undefined,
    @Meta() meta: ActionMeta,
  ) {
    return this.templates.createDraft(id, fromVersionId, meta);
  }

  @Put('workflow-template-versions/:id')
  save(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: saveTemplateVersionSchema }) body: SaveVersion,
    @Meta() meta: ActionMeta,
  ) {
    return this.templates.saveDraft(id, body, meta);
  }

  @Post('workflow-template-versions/:id/publish')
  @HttpCode(200)
  publish(@Param('id', { schema: uuidSchema }) id: string, @Meta() meta: ActionMeta) {
    return this.templates.publish(id, meta);
  }

  @Delete('workflow-template-versions/:id')
  @HttpCode(204)
  remove(@Param('id', { schema: uuidSchema }) id: string, @Meta() meta: ActionMeta) {
    return this.templates.deleteDraft(id, meta);
  }
}

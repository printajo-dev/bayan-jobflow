import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  changeJobNumberSchema,
  checklistToggleSchema,
  createJobSchema,
  listJobsQuerySchema,
  paginationQuerySchema,
  reasonSchema,
  returnStageSchema,
  updateJobSchema,
  uuidSchema,
  type AuditLogDto,
  type Paginated,
} from '@jobflow/shared';
import { type ActionMeta, CurrentPrincipal, Meta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { PrismaService } from '../core/prisma.service.js';
import { uploadInterceptor } from '../files/upload.js';
import { WorkflowEngine } from '../workflow/engine.service.js';
import { FilesService, type StoredUpload } from '../files/files.service.js';
import { JobsService } from './jobs.service.js';
import { DiscussionsService } from '../discussions/discussions.service.js';

const upload = uploadInterceptor();

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly engine: WorkflowEngine,
    private readonly files: FilesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query({ schema: listJobsQuerySchema }) q: z.output<typeof listJobsQuerySchema>, @CurrentPrincipal() p: Principal) {
    return this.jobs.list(q, p);
  }

  @Post()
  create(@Body({ schema: createJobSchema }) body: z.output<typeof createJobSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.jobs.create(body, p, meta);
  }

  @Get(':id')
  get(@Param('id', { schema: uuidSchema }) id: string, @CurrentPrincipal() p: Principal) {
    return this.jobs.get(id, p);
  }

  @Patch(':id')
  update(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: updateJobSchema }) body: z.output<typeof updateJobSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.jobs.update(id, body, p, meta);
  }

  /** The brief body is validated against the job's service type schema by the service. */
  @Patch(':id/brief')
  updateBrief(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: z.record(z.string(), z.unknown()) }) body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.jobs.updateBrief(id, body, p, meta);
  }

  @Post(':id/job-number')
  @HttpCode(200)
  changeNumber(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: changeJobNumberSchema }) body: z.output<typeof changeJobNumberSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.jobs.changeNumber(id, body.jobNumber, body.reason, p, meta);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: reasonSchema }) body: z.output<typeof reasonSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.jobs.cancel(id, body.reason, p, meta);
  }

  @Get(':id/activity')
  async activity(
    @Param('id', { schema: uuidSchema }) id: string,
    @Query({ schema: paginationQuerySchema }) q: z.output<typeof paginationQuerySchema>,
    @CurrentPrincipal() p: Principal,
  ): Promise<Paginated<AuditLogDto>> {
    await this.jobs.authorize(id, p);
    const where = { entityType: 'job', entityId: id };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { username: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actorId: r.actorId,
        actorUsername: r.actor?.fullName ?? r.actor?.username ?? null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        summary: r.summary,
        // Before/after details stay in the admin audit log.
        before: null,
        after: null,
        ip: null,
        requestId: null,
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  // ------------------------------------------------------------ files

  @Post(':id/files')
  @UseInterceptors(upload)
  uploadFile(
    @Param('id', { schema: uuidSchema }) id: string,
    @UploadedFile() file: StoredUpload | undefined,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.files.addJobFile(id, file, p, meta);
  }

  @Delete(':id/files/:fileId')
  @HttpCode(204)
  removeFile(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('fileId', { schema: uuidSchema }) fileId: string,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.files.removeJobFile(id, fileId, p, meta);
  }

  // ------------------------------------------------------------ workflow

  @Get(':id/workflow')
  workflow(@Param('id', { schema: uuidSchema }) id: string, @CurrentPrincipal() p: Principal) {
    return this.engine.getWorkflow(id, p);
  }

  @Post(':id/stages/:stageId/complete')
  @HttpCode(200)
  complete(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.complete(id, stageId, p, meta);
  }

  @Post(':id/stages/:stageId/complete-with-exception')
  @HttpCode(200)
  completeWithException(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @Body({ schema: reasonSchema }) body: z.output<typeof reasonSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.complete(id, stageId, p, meta, body.reason);
  }

  @Post(':id/stages/:stageId/hold')
  @HttpCode(200)
  hold(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @Body({ schema: reasonSchema }) body: z.output<typeof reasonSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.hold(id, stageId, body.reason, p, meta);
  }

  @Post(':id/stages/:stageId/resume')
  @HttpCode(200)
  resume(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.resume(id, stageId, p, meta);
  }

  @Post(':id/stages/:stageId/return')
  @HttpCode(200)
  returnTo(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @Body({ schema: returnStageSchema }) body: z.output<typeof returnStageSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.returnTo(id, stageId, body.targetStageKey, body.reason, p, meta);
  }

  @Post(':id/stages/:stageId/reopen')
  @HttpCode(200)
  reopen(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @Body({ schema: reasonSchema }) body: z.output<typeof reasonSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.reopen(id, stageId, body.reason, p, meta);
  }

  @Post(':id/stages/:stageId/checklist/:itemId')
  @HttpCode(200)
  check(
    @Param('id', { schema: uuidSchema }) id: string,
    @Param('stageId', { schema: uuidSchema }) stageId: string,
    @Param('itemId', { schema: uuidSchema }) itemId: string,
    @Body({ schema: checklistToggleSchema }) body: z.output<typeof checklistToggleSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.engine.toggleChecklist(id, stageId, itemId, body.checked, p, meta);
  }
}

@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly discussions: DiscussionsService,
  ) {}

  @Get(':id/download')
  async download(
    @Param('id', { schema: uuidSchema }) id: string,
    @Query('inline', { schema: z.enum(['0', '1']).optional() }) inline: '0' | '1' | undefined,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const f = await this.files.openForDownload(id, p, meta, inline === '1', (channelId) =>
      this.discussions.channelFor(channelId, p).then(
        () => true,
        () => false,
      ),
    );
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // A previewed file can never run scripts or reach other pages.
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    return new StreamableFile(f.stream, { type: f.mimeType, disposition: f.disposition, length: f.size });
  }
}

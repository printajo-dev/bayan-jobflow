import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import {
  addParticipantSchema,
  createChannelSchema,
  createCorrectionRoundSchema,
  createCorrectionSchema,
  createTaskSchema,
  editMessageSchema,
  listMessagesQuerySchema,
  listTasksQuerySchema,
  MAX_VOICE_SECONDS,
  postMessageSchema,
  reactionSchema,
  reasonSchema,
  recordApprovalSchema,
  resolveCorrectionSchema,
  setAssigneesSchema,
  stageDeadlineSchema,
  taskChecklistToggleSchema,
  taskCommentSchema,
  updateCorrectionSchema,
  updateTaskSchema,
  uuidSchema,
} from '@jobflow/shared';
import { type ActionMeta, CurrentPrincipal, Meta } from './access/decorators.js';
import type { Principal } from './access/principal.js';
import { uploadInterceptor } from './files/upload.js';
import { FilesService, type StoredUpload } from './files/files.service.js';
import { TasksService } from './tasks/tasks.service.js';
import { DesignService } from './design/design.service.js';
import { DiscussionsService } from './discussions/discussions.service.js';
import { CorrectionsService } from './corrections/corrections.service.js';

const id = { schema: uuidSchema };
const optionalText = z.string().trim().max(2000).optional();

// ---------------------------------------------------------------- Tasks

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('jobs/:id/tasks')
  forJob(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.tasks.listForJob(jobId, p);
  }

  @Post('jobs/:id/tasks')
  create(@Param('id', id) jobId: string, @Body({ schema: createTaskSchema }) body: z.output<typeof createTaskSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.tasks.create(jobId, body, p, meta);
  }

  @Put('jobs/:id/stages/:stageId/deadline')
  @HttpCode(204)
  deadline(
    @Param('id', id) jobId: string,
    @Param('stageId', id) stageId: string,
    @Body({ schema: stageDeadlineSchema }) body: z.output<typeof stageDeadlineSchema>,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.tasks.setStageDeadline(jobId, stageId, body.internalDeadline, p, meta);
  }

  @Get('tasks')
  list(@Query({ schema: listTasksQuerySchema }) q: z.output<typeof listTasksQuerySchema>, @CurrentPrincipal() p: Principal) {
    return this.tasks.list(q, p);
  }

  @Get('tasks/:id')
  get(@Param('id', id) taskId: string, @CurrentPrincipal() p: Principal) {
    return this.tasks.get(taskId, p);
  }

  @Patch('tasks/:id')
  update(@Param('id', id) taskId: string, @Body({ schema: updateTaskSchema }) body: z.output<typeof updateTaskSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.tasks.update(taskId, body, p, meta);
  }

  @Put('tasks/:id/assignments')
  assign(@Param('id', id) taskId: string, @Body({ schema: setAssigneesSchema }) body: z.output<typeof setAssigneesSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.tasks.setAssignees(taskId, body.userIds, p, meta);
  }

  @Post('tasks/:id/comments')
  comment(@Param('id', id) taskId: string, @Body({ schema: taskCommentSchema }) body: z.output<typeof taskCommentSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.tasks.comment(taskId, body.body, p, meta);
  }

  @Post('tasks/:id/checklist/:itemId')
  @HttpCode(200)
  check(
    @Param('id', id) taskId: string,
    @Param('itemId', id) itemId: string,
    @Body({ schema: taskChecklistToggleSchema }) body: z.output<typeof taskChecklistToggleSchema>,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tasks.toggleChecklist(taskId, itemId, body.done, p);
  }
}

// ---------------------------------------------------------------- Design

@Controller()
export class DesignController {
  constructor(private readonly design: DesignService) {}

  @Get('jobs/:id/design')
  get(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.design.get(jobId, p);
  }

  @Post('jobs/:id/artwork-versions')
  @UseInterceptors(uploadInterceptor())
  upload(
    @Param('id', id) jobId: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Body('notes', { schema: optionalText }) notes: string | undefined,
    @Body('correctionRoundId', { schema: uuidSchema.optional().or(z.literal('')) }) roundId: string | undefined,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.design.uploadVersion(jobId, file, notes || null, roundId || null, p, meta);
  }

  @Post('jobs/:id/design-files')
  @UseInterceptors(uploadInterceptor())
  supportingFile(
    @Param('id', id) jobId: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Query('kind', { schema: z.enum(['evidence', 'round']) }) kind: 'evidence' | 'round',
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    return this.design.uploadSupportingFile(jobId, file, kind === 'evidence' ? 'APPROVAL_EVIDENCE' : 'ROUND', p, meta);
  }

  @Post('artwork-versions/:id/approval-records')
  approve(@Param('id', id) versionId: string, @Body({ schema: recordApprovalSchema }) body: z.output<typeof recordApprovalSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.design.recordApproval(versionId, body, p, meta);
  }

  @Post('jobs/:id/correction-rounds')
  round(@Param('id', id) jobId: string, @Body({ schema: createCorrectionRoundSchema }) body: z.output<typeof createCorrectionRoundSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.design.createRound(jobId, body, p, meta);
  }
}

// ---------------------------------------------------------------- Discussions

@Controller()
export class DiscussionsController {
  constructor(
    private readonly discussions: DiscussionsService,
    private readonly files: FilesService,
  ) {}

  @Get('jobs/:id/discussions')
  channels(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.discussions.listChannels(jobId, p);
  }

  @Post('jobs/:id/discussions')
  createChannel(@Param('id', id) jobId: string, @Body({ schema: createChannelSchema }) body: z.output<typeof createChannelSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.createChannel(jobId, body.departmentId, p, meta);
  }

  @Get('discussions/:id/messages')
  messages(@Param('id', id) channelId: string, @Query({ schema: listMessagesQuerySchema }) q: z.output<typeof listMessagesQuerySchema>, @CurrentPrincipal() p: Principal) {
    return this.discussions.listMessages(channelId, q, p);
  }

  @Get('discussions/:id/pins')
  pins(@Param('id', id) channelId: string, @CurrentPrincipal() p: Principal) {
    return this.discussions.pinned(channelId, p);
  }

  @Post('discussions/:id/messages')
  post(@Param('id', id) channelId: string, @Body({ schema: postMessageSchema }) body: z.output<typeof postMessageSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.post(channelId, body, p, meta);
  }

  /** Upload an attachment or a voice note before posting the message that uses it. */
  @Post('discussions/:id/attachments')
  @UseInterceptors(uploadInterceptor())
  async attach(
    @Param('id', id) channelId: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Query('voice', { schema: z.enum(['0', '1']).optional() }) voice: '0' | '1' | undefined,
    @Query('durationSec', { schema: z.coerce.number().min(0).max(MAX_VOICE_SECONDS + 5).optional() }) durationSec: number | undefined,
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    let jobId: string;
    try {
      const ch = await this.discussions.channelFor(channelId, p);
      if (!this.discussions.canPost(p, ch)) throw new ForbiddenException('You cannot post in this channel');
      if (voice === '1' && !p.has('message.voice')) throw new ForbiddenException('You cannot record voice notes');
      jobId = ch.jobId;
    } catch (e) {
      await this.files.discard(file);
      throw e;
    }
    return this.files.store(jobId, file, voice === '1' ? 'VOICE' : 'DISCUSSION', meta, { clientDurationSec: durationSec });
  }

  @Post('discussions/:id/read')
  @HttpCode(200)
  read(@Param('id', id) channelId: string, @CurrentPrincipal() p: Principal) {
    return this.discussions.markRead(channelId, p);
  }

  @Post('discussions/:id/participants')
  addParticipant(@Param('id', id) channelId: string, @Body({ schema: addParticipantSchema }) body: z.output<typeof addParticipantSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.addParticipant(channelId, body.userId, p, meta);
  }

  @Delete('discussions/:id/participants/:userId')
  @HttpCode(204)
  removeParticipant(@Param('id', id) channelId: string, @Param('userId', id) userId: string, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.removeParticipant(channelId, userId, p, meta);
  }

  @Patch('messages/:id')
  edit(@Param('id', id) messageId: string, @Body({ schema: editMessageSchema }) body: z.output<typeof editMessageSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.edit(messageId, body.body, p, meta);
  }

  @Delete('messages/:id')
  @HttpCode(204)
  remove(@Param('id', id) messageId: string, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.remove(messageId, p, meta);
  }

  @Get('messages/:id/history')
  history(@Param('id', id) messageId: string, @CurrentPrincipal() p: Principal) {
    return this.discussions.history(messageId, p);
  }

  @Post('messages/:id/reactions')
  @HttpCode(200)
  react(@Param('id', id) messageId: string, @Body({ schema: reactionSchema }) body: z.output<typeof reactionSchema>, @CurrentPrincipal() p: Principal) {
    return this.discussions.react(messageId, body.emoji, p);
  }

  @Post('messages/:id/pin')
  @HttpCode(200)
  pin(@Param('id', id) messageId: string, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.pin(messageId, true, p, meta);
  }

  @Delete('messages/:id/pin')
  @HttpCode(200)
  unpin(@Param('id', id) messageId: string, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.discussions.pin(messageId, false, p, meta);
  }
}

// ---------------------------------------------------------------- Corrections

@Controller()
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get('jobs/:id/corrections')
  forJob(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.corrections.listForJob(jobId, p);
  }

  @Post('jobs/:id/correction-files')
  @UseInterceptors(uploadInterceptor())
  upload(@Param('id', id) jobId: string, @UploadedFile() file: StoredUpload | undefined, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.corrections.uploadFile(jobId, file, p, meta);
  }

  @Get('corrections/mine')
  mine(@CurrentPrincipal() p: Principal) {
    return this.corrections.mine(p);
  }

  @Post('corrections')
  create(@Body({ schema: createCorrectionSchema }) body: z.output<typeof createCorrectionSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.corrections.create(body, p, meta);
  }

  @Get('corrections/:id')
  get(@Param('id', id) correctionId: string, @CurrentPrincipal() p: Principal) {
    return this.corrections.get(correctionId, p);
  }

  @Patch('corrections/:id')
  update(@Param('id', id) correctionId: string, @Body({ schema: updateCorrectionSchema }) body: z.output<typeof updateCorrectionSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.corrections.update(correctionId, body, p, meta);
  }

  @Post('corrections/:id/resolve')
  @HttpCode(200)
  resolve(@Param('id', id) correctionId: string, @Body({ schema: resolveCorrectionSchema }) body: z.output<typeof resolveCorrectionSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.corrections.resolve(correctionId, body, p, meta);
  }

  @Post('corrections/:id/reopen')
  @HttpCode(200)
  reopen(@Param('id', id) correctionId: string, @Body({ schema: reasonSchema }) body: z.output<typeof reasonSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.corrections.reopen(correctionId, body.reason, p, meta);
  }
}

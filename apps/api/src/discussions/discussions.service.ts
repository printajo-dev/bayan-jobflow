import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import type { ChannelDto, listMessagesQuerySchema, MessageDto, postMessageSchema } from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService } from '../files/files.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { PrincipalLoader } from '../access/principal.loader.js';
import { ensureChannels, postSystemMessage } from './channels.js';

type PostMessage = z.output<typeof postMessageSchema>;
type ListMessages = z.output<typeof listMessagesQuerySchema>;

interface ChannelRow {
  id: string;
  jobId: string;
  type: 'DEPARTMENT' | 'GENERAL';
  departmentId: string | null;
  department: { id: string; code: string; name: string } | null;
  members: { userId: string; user: { fullName: string } }[];
}

const channelInclude = {
  department: { select: { id: true, code: true, name: true } },
  members: { include: { user: { select: { fullName: true } } } },
} as const;

const messageInclude = {
  author: { select: { id: true, fullName: true } },
  attachments: { include: { file: { select: { id: true, originalName: true, mimeType: true, size: true } } } },
  mentions: { include: { user: { select: { id: true, fullName: true } } } },
  reactions: true,
  pins: { select: { channelId: true } },
  _count: { select: { replies: { where: { deletedAt: null } }, receipts: true } },
} as const;

/**
 * Department discussion channels inside each job.
 *
 * Who can read a channel:
 * - a Department channel: users holding `channel.view` in that department
 *   (department members) or globally (management, administrators);
 * - the General channel: anyone with `channel.view` who can see the job;
 * - plus participants a leader explicitly added (cross-department).
 * The job itself must be visible to the user in every case.
 */
@Injectable()
export class DiscussionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly principals: PrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.realtime.setChannelAuthorizer(async (p, channelId) => {
      try {
        await this.channelFor(channelId, p);
        return true;
      } catch {
        return false;
      }
    });
  }

  // ------------------------------------------------------------ access

  canView(p: Principal, ch: ChannelRow): boolean {
    if (ch.members.some((m) => m.userId === p.userId)) return true;
    if (ch.type === 'GENERAL') return p.has('channel.view');
    return p.hasInDepartment('channel.view', ch.departmentId!);
  }

  canPost(p: Principal, ch: ChannelRow): boolean {
    if (!this.canView(p, ch)) return false;
    if (ch.members.some((m) => m.userId === p.userId)) return p.has('message.post');
    if (ch.type === 'GENERAL') return p.has('message.post');
    return p.hasInDepartment('message.post', ch.departmentId!);
  }

  private hasInChannelDept(p: Principal, ch: ChannelRow, perm: 'message.pin' | 'message.moderate' | 'channel.add_participant'): boolean {
    return ch.type === 'GENERAL' ? p.has(perm) : p.hasInDepartment(perm, ch.departmentId!);
  }

  /** Loads a channel the user may read (404 otherwise). */
  async channelFor(channelId: string, p: Principal, db: Tx = this.prisma): Promise<ChannelRow> {
    const ch = await db.discussionChannel.findUnique({ where: { id: channelId }, include: channelInclude });
    if (!ch) throw new NotFoundException('Channel not found');
    await this.jobs.authorize(ch.jobId, p, undefined, db);
    if (!this.canView(p, ch)) throw new NotFoundException('Channel not found');
    return ch;
  }

  // ------------------------------------------------------------ channels

  ensureChannels(tx: Tx, jobId: string, departmentIds: string[]): Promise<void> {
    return ensureChannels(tx, jobId, departmentIds);
  }

  async listChannels(jobId: string, p: Principal): Promise<ChannelDto[]> {
    await this.jobs.authorize(jobId, p);
    const channels = await this.prisma.discussionChannel.findMany({ where: { jobId }, include: channelInclude, orderBy: { createdAt: 'asc' } });
    const visible = channels.filter((c) => this.canView(p, c));
    const unread = await this.unreadCounts(visible.map((c) => c.id), p.userId);
    return visible
      .map((c) => this.toChannelDto(c, p, unread.get(c.id) ?? 0))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'GENERAL' ? -1 : 1));
  }

  /** An administrator opens a channel for a department that has no stage in the job (e.g. Logistic on a Signage job). */
  async createChannel(jobId: string, departmentId: string, p: Principal, meta: ActionMeta): Promise<ChannelDto> {
    const facts = await this.jobs.authorize(jobId, p);
    if (!p.hasGlobal('channel.add_participant')) throw new ForbiddenException('Only an administrator can open extra department channels');
    const dept = await this.prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept || !dept.isActive) throw new BadRequestException('Unknown department');
    const ch = await this.prisma.$transaction(async (tx) => {
      if (await tx.discussionChannel.findFirst({ where: { jobId, departmentId } })) throw new BadRequestException(`${dept.name} already has a channel in this job`);
      const created = await tx.discussionChannel.create({ data: { jobId, type: 'DEPARTMENT', departmentId }, include: channelInclude });
      await this.audit.record(tx, meta, {
        action: 'discussion.channel_created',
        entityType: 'job',
        entityId: jobId,
        summary: `${dept.name} channel opened in ${facts.jobNumber}`,
      });
      return created;
    });
    return this.toChannelDto(ch, p, 0);
  }

  async addParticipant(channelId: string, userId: string, p: Principal, meta: ActionMeta): Promise<ChannelDto> {
    const ch = await this.channelFor(channelId, p);
    if (!this.hasInChannelDept(p, ch, 'channel.add_participant')) throw new ForbiddenException('Only leaders can add participants');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new BadRequestException('Unknown or disabled user');
    await this.prisma.$transaction(async (tx) => {
      await tx.discussionChannelMember.upsert({
        where: { channelId_userId: { channelId, userId } },
        create: { channelId, userId, addedById: meta.actorId },
        update: {},
      });
      await this.audit.record(tx, meta, {
        action: 'discussion.participant_added',
        entityType: 'job',
        entityId: ch.jobId,
        summary: `${user.fullName} added to the ${this.channelName(ch)} channel`,
      });
    });
    return this.toChannelDto((await this.prisma.discussionChannel.findUniqueOrThrow({ where: { id: channelId }, include: channelInclude }))!, p, 0);
  }

  async removeParticipant(channelId: string, userId: string, p: Principal, meta: ActionMeta): Promise<void> {
    const ch = await this.channelFor(channelId, p);
    if (!this.hasInChannelDept(p, ch, 'channel.add_participant')) throw new ForbiddenException('Only leaders can remove participants');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.discussionChannelMember.deleteMany({ where: { channelId, userId } });
      if (count) {
        await this.audit.record(tx, meta, { action: 'discussion.participant_removed', entityType: 'job', entityId: ch.jobId, summary: `Participant removed from the ${this.channelName(ch)} channel` });
      }
    });
  }

  // ------------------------------------------------------------ messages

  async listMessages(channelId: string, q: ListMessages, p: Principal): Promise<MessageDto[]> {
    const ch = await this.channelFor(channelId, p);
    let ids: string[] | undefined;
    if (q.q) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM discussion_messages
        WHERE channel_id = ${channelId}::uuid AND deleted_at IS NULL
          AND to_tsvector('simple', body) @@ plainto_tsquery('simple', ${q.q})
        ORDER BY created_at DESC LIMIT ${q.limit}`;
      ids = rows.map((r) => r.id);
    }
    const rows = await this.prisma.discussionMessage.findMany({
      where: {
        channelId,
        ...(ids ? { id: { in: ids } } : { parentMessageId: q.parentMessageId ?? null }),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      include: messageInclude,
      orderBy: { createdAt: q.parentMessageId ? 'asc' : 'desc' },
      take: q.limit,
    });
    return rows.map((m) => this.toMessageDto(m, ch, p));
  }

  async post(channelId: string, input: PostMessage, p: Principal, _meta: ActionMeta): Promise<MessageDto> {
    const ch = await this.channelFor(channelId, p);
    if (!this.canPost(p, ch)) throw new ForbiddenException('You cannot post in this channel');
    if (!input.body.trim() && input.fileIds.length === 0) throw new BadRequestException('Write a message or attach a file');
    const message = await this.prisma.$transaction(async (tx) => {
      await this.files.assertOwnUnusedUploads(tx, ch.jobId, input.fileIds, ['DISCUSSION', 'VOICE'], p.userId);
      let parentId: string | null = null;
      let parentAuthor: string | null = null;
      if (input.parentMessageId) {
        const parent = await tx.discussionMessage.findUnique({ where: { id: input.parentMessageId } });
        if (!parent || parent.channelId !== channelId || parent.deletedAt) throw new BadRequestException('The message you reply to does not exist');
        parentId = parent.parentMessageId ?? parent.id; // replies are one level deep
        parentAuthor = parent.authorId;
      }
      const mentions = [...new Set(input.mentionUserIds)];
      if (mentions.length) {
        const users = await tx.user.findMany({ where: { id: { in: mentions }, status: 'ACTIVE' }, select: { id: true } });
        const allowed = await this.usersWhoCanView(tx, ch, users.map((u) => u.id));
        if (allowed.length !== mentions.length) throw new BadRequestException('You can only mention people who can read this channel');
      }
      const links = await tx.jobFile.findMany({ where: { jobId: ch.jobId, fileId: { in: input.fileIds } }, include: { file: { select: { durationSec: true } } } });
      const created = await tx.discussionMessage.create({
        data: {
          channelId,
          jobId: ch.jobId,
          parentMessageId: parentId,
          stageId: input.stageId ?? null,
          authorId: p.userId,
          body: input.body,
          attachments: {
            create: links.map((l) => ({ fileId: l.fileId, isVoice: l.purpose === 'VOICE', durationSec: l.file.durationSec })),
          },
          mentions: { create: mentions.map((userId) => ({ userId })) },
        },
        include: messageInclude,
      });
      // The author has read their own message.
      await tx.discussionReadReceipt.create({ data: { messageId: created.id, userId: p.userId } });
      const base = { jobId: ch.jobId, channelId, messageId: created.id, authorId: p.userId };
      await this.outbox.enqueue(tx, {
        type: 'discussion.message.created',
        aggregateType: 'job',
        aggregateId: ch.jobId,
        payload: { ...base, voice: links.some((l) => l.purpose === 'VOICE') },
        idempotencyKey: `discussion.message.created:${created.id}`,
      });
      if (mentions.length) {
        await this.outbox.enqueue(tx, {
          type: 'discussion.mention.created',
          aggregateType: 'job',
          aggregateId: ch.jobId,
          payload: { ...base, userIds: mentions.filter((u) => u !== p.userId) },
          idempotencyKey: `discussion.mention.created:${created.id}`,
        });
      }
      if (parentId && parentAuthor && parentAuthor !== p.userId) {
        await this.outbox.enqueue(tx, {
          type: 'discussion.message.replied',
          aggregateType: 'job',
          aggregateId: ch.jobId,
          payload: { ...base, parentMessageId: parentId, parentAuthorId: parentAuthor },
          idempotencyKey: `discussion.message.replied:${created.id}`,
        });
      }
      return created;
    });
    const dto = this.toMessageDto(message, ch, p);
    this.realtime.toChannel(channelId, 'message:created', { ...dto, canEdit: false, canDelete: false });
    return dto;
  }

  async edit(messageId: string, body: string, p: Principal, meta: ActionMeta): Promise<MessageDto> {
    const { msg, ch } = await this.messageFor(messageId, p);
    const own = msg.authorId === p.userId && p.has('message.edit_own');
    if (!own && !this.hasInChannelDept(p, ch, 'message.moderate')) throw new ForbiddenException('You cannot edit this message');
    if (msg.kind === 'SYSTEM' || msg.deletedAt) throw new BadRequestException('This message cannot be edited');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.discussionMessageEdit.create({ data: { messageId, previousBody: msg.body, action: 'edit', editedById: p.userId } });
      const m = await tx.discussionMessage.update({ where: { id: messageId }, data: { body, editedAt: new Date() }, include: messageInclude });
      if (!own) {
        await this.audit.record(tx, meta, { action: 'discussion.message_moderated', entityType: 'job', entityId: ch.jobId, summary: `A message in ${this.channelName(ch)} was edited by a moderator` });
      }
      await this.outbox.enqueue(tx, {
        type: 'discussion.message.edited',
        aggregateType: 'job',
        aggregateId: ch.jobId,
        payload: { jobId: ch.jobId, channelId: ch.id, messageId },
        idempotencyKey: `discussion.message.edited:${messageId}:${meta.requestId}`,
      });
      return m;
    });
    const dto = this.toMessageDto(updated, ch, p);
    this.realtime.toChannel(ch.id, 'message:updated', { ...dto, canEdit: false, canDelete: false });
    return dto;
  }

  /** Soft delete: the content is kept in the edit history and hidden from readers. */
  async remove(messageId: string, p: Principal, meta: ActionMeta): Promise<void> {
    const { msg, ch } = await this.messageFor(messageId, p);
    const own = msg.authorId === p.userId && p.has('message.delete_own');
    if (!own && !this.hasInChannelDept(p, ch, 'message.moderate')) throw new ForbiddenException('You cannot delete this message');
    if (msg.kind === 'SYSTEM' || msg.deletedAt) throw new BadRequestException('This message cannot be deleted');
    await this.prisma.$transaction(async (tx) => {
      await tx.discussionMessageEdit.create({ data: { messageId, previousBody: msg.body, action: 'delete', editedById: p.userId } });
      await tx.discussionMessage.update({ where: { id: messageId }, data: { deletedAt: new Date(), deletedById: p.userId } });
      await this.audit.record(tx, meta, {
        action: 'discussion.message_deleted',
        entityType: 'job',
        entityId: ch.jobId,
        summary: `A message in the ${this.channelName(ch)} channel was deleted${own ? ' by its author' : ' by a moderator'}`,
        before: { messageId },
      });
      await this.outbox.enqueue(tx, {
        type: 'discussion.message.deleted',
        aggregateType: 'job',
        aggregateId: ch.jobId,
        payload: { jobId: ch.jobId, channelId: ch.id, messageId },
        idempotencyKey: `discussion.message.deleted:${messageId}`,
      });
    });
    this.realtime.toChannel(ch.id, 'message:deleted', { id: messageId, channelId: ch.id });
  }

  async history(messageId: string, p: Principal) {
    const { ch } = await this.messageFor(messageId, p);
    if (!this.hasInChannelDept(p, ch, 'message.moderate') && !p.hasGlobal('audit.view')) throw new ForbiddenException('Only moderators can see edit history');
    const rows = await this.prisma.discussionMessageEdit.findMany({ where: { messageId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ action: r.action, previousBody: r.previousBody, at: r.createdAt.toISOString(), byUserId: r.editedById }));
  }

  async react(messageId: string, emoji: string, p: Principal): Promise<MessageDto> {
    const { msg, ch } = await this.messageFor(messageId, p);
    if (!this.canPost(p, ch) || msg.deletedAt) throw new ForbiddenException('You cannot react in this channel');
    const key = { messageId_userId_emoji: { messageId, userId: p.userId, emoji } };
    const existing = await this.prisma.discussionReaction.findUnique({ where: key });
    if (existing) await this.prisma.discussionReaction.delete({ where: key });
    else await this.prisma.discussionReaction.create({ data: { messageId, userId: p.userId, emoji } });
    const m = await this.prisma.discussionMessage.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
    const dto = this.toMessageDto(m, ch, p);
    this.realtime.toChannel(ch.id, 'message:updated', { ...dto, canEdit: false, canDelete: false });
    return dto;
  }

  async pin(messageId: string, pinned: boolean, p: Principal, meta: ActionMeta): Promise<MessageDto> {
    const { msg, ch } = await this.messageFor(messageId, p);
    if (!this.hasInChannelDept(p, ch, 'message.pin')) throw new ForbiddenException('Only leaders can pin messages');
    if (msg.deletedAt) throw new BadRequestException('Deleted messages cannot be pinned');
    await this.prisma.$transaction(async (tx) => {
      if (pinned) {
        await tx.discussionPin.upsert({ where: { channelId_messageId: { channelId: ch.id, messageId } }, create: { channelId: ch.id, messageId, pinnedById: p.userId }, update: {} });
      } else {
        await tx.discussionPin.deleteMany({ where: { channelId: ch.id, messageId } });
      }
      await this.outbox.enqueue(tx, {
        type: pinned ? 'discussion.message.pinned' : 'discussion.message.unpinned',
        aggregateType: 'job',
        aggregateId: ch.jobId,
        payload: { jobId: ch.jobId, channelId: ch.id, messageId },
        idempotencyKey: `discussion.message.pin:${messageId}:${meta.requestId}`,
      });
    });
    const m = await this.prisma.discussionMessage.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
    return this.toMessageDto(m, ch, p);
  }

  async pinned(channelId: string, p: Principal): Promise<MessageDto[]> {
    const ch = await this.channelFor(channelId, p);
    const pins = await this.prisma.discussionPin.findMany({ where: { channelId }, include: { message: { include: messageInclude } }, orderBy: { createdAt: 'desc' } });
    return pins.filter((x) => !x.message.deletedAt).map((x) => this.toMessageDto(x.message, ch, p));
  }

  /** Records read receipts for everything in the channel the user has not read yet. */
  async markRead(channelId: string, p: Principal): Promise<{ unread: number }> {
    await this.channelFor(channelId, p);
    await this.prisma.$executeRaw`
      INSERT INTO discussion_read_receipts (message_id, user_id, read_at)
      SELECT m.id, ${p.userId}::uuid, now() FROM discussion_messages m
      WHERE m.channel_id = ${channelId}::uuid AND m.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM discussion_read_receipts r WHERE r.message_id = m.id AND r.user_id = ${p.userId}::uuid)
      ON CONFLICT DO NOTHING`;
    this.realtime.toUser(p.userId, 'channel:read', { channelId });
    return { unread: 0 };
  }

  /** Posts an automatic message to a department channel (or General) and pushes it to open channels. */
  async systemMessage(tx: Tx, jobId: string, departmentId: string | null, body: string, stageId?: string | null): Promise<void> {
    const channelId = await postSystemMessage(tx, jobId, departmentId, body, stageId);
    if (channelId) setTimeout(() => this.realtime.toChannel(channelId, 'message:system', { channelId }), 50);
  }

  // ------------------------------------------------------------ helpers

  private async messageFor(messageId: string, p: Principal) {
    const msg = await this.prisma.discussionMessage.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');
    const ch = await this.channelFor(msg.channelId, p);
    return { msg, ch };
  }

  /** Filters users to those who could read the channel (for mention checks). */
  private async usersWhoCanView(tx: Tx, ch: ChannelRow, userIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of userIds) {
      const p = await this.principals.load(id, tx);
      if (!p) continue;
      try {
        await this.jobs.authorize(ch.jobId, p, undefined, tx);
      } catch {
        continue;
      }
      if (this.canView(p, ch)) out.push(id);
    }
    return out;
  }

  private async unreadCounts(channelIds: string[], userId: string): Promise<Map<string, number>> {
    if (!channelIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ channel_id: string; n: bigint }[]>`
      SELECT m.channel_id, count(*) AS n FROM discussion_messages m
      WHERE m.channel_id = ANY(${channelIds}::uuid[]) AND m.deleted_at IS NULL
        AND (m.author_id IS NULL OR m.author_id <> ${userId}::uuid)
        AND NOT EXISTS (SELECT 1 FROM discussion_read_receipts r WHERE r.message_id = m.id AND r.user_id = ${userId}::uuid)
      GROUP BY m.channel_id`;
    return new Map(rows.map((r) => [r.channel_id, Number(r.n)]));
  }

  private channelName(ch: { type: string; department: { name: string } | null }): string {
    return ch.type === 'GENERAL' ? 'General' : (ch.department?.name ?? 'Department');
  }

  private toChannelDto(c: ChannelRow, p: Principal, unread: number): ChannelDto {
    return {
      id: c.id,
      type: c.type,
      name: this.channelName(c),
      department: c.department,
      unread,
      canPost: this.canPost(p, c),
      canManage: this.hasInChannelDept(p, c, 'channel.add_participant'),
      participants: c.members.map((m) => ({ id: m.userId, fullName: m.user.fullName })),
    };
  }

  private toMessageDto(
    m: {
      id: string;
      channelId: string;
      parentMessageId: string | null;
      kind: 'USER' | 'SYSTEM';
      authorId: string | null;
      author: { id: string; fullName: string } | null;
      body: string;
      editedAt: Date | null;
      deletedAt: Date | null;
      createdAt: Date;
      attachments: { isVoice: boolean; durationSec: number | null; file: { id: string; originalName: string; mimeType: string; size: bigint } }[];
      mentions: { user: { id: string; fullName: string } }[];
      reactions: { emoji: string; userId: string }[];
      pins: { channelId: string }[];
      _count: { replies: number; receipts: number };
    },
    ch: ChannelRow,
    p: Principal,
  ): MessageDto {
    const deleted = m.deletedAt !== null;
    const grouped = new Map<string, { count: number; mine: boolean }>();
    for (const r of m.reactions) {
      const g = grouped.get(r.emoji) ?? { count: 0, mine: false };
      g.count++;
      if (r.userId === p.userId) g.mine = true;
      grouped.set(r.emoji, g);
    }
    const own = m.authorId === p.userId;
    const moderator = this.hasInChannelDept(p, ch, 'message.moderate');
    return {
      id: m.id,
      channelId: m.channelId,
      parentMessageId: m.parentMessageId,
      kind: m.kind,
      author: m.author,
      body: deleted ? '' : m.body,
      deleted,
      edited: m.editedAt !== null,
      createdAt: m.createdAt.toISOString(),
      attachments: deleted
        ? []
        : m.attachments.map((a) => ({
            id: a.file.id,
            originalName: a.file.originalName,
            mimeType: a.file.mimeType,
            size: Number(a.file.size),
            isVoice: a.isVoice,
            durationSec: a.durationSec,
          })),
      mentions: deleted ? [] : m.mentions.map((x) => x.user),
      reactions: [...grouped.entries()].map(([emoji, g]) => ({ emoji, ...g })),
      replyCount: m._count.replies,
      pinned: m.pins.length > 0,
      readBy: m._count.receipts,
      canEdit: !deleted && m.kind === 'USER' && ((own && p.has('message.edit_own')) || moderator),
      canDelete: !deleted && m.kind === 'USER' && ((own && p.has('message.delete_own')) || moderator),
    };
  }
}

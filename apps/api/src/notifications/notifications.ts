import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { NOTIFICATION_TYPES, preferencesSchema, uuidSchema, paginationQuerySchema, type NotificationDto, type NotificationType, type Paginated } from '@jobflow/shared';
import { z as zod } from 'zod';
import { PrismaService } from '../core/prisma.service.js';
import { CurrentPrincipal } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { RealtimeService } from '../realtime/realtime.service.js';

const listQuery = paginationQuerySchema.extend({ unread: zod.enum(['true', 'false']).optional() });

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(userId: string, q: z.output<typeof listQuery>): Promise<Paginated<NotificationDto> & { unread: number }> {
    const where = { userId, ...(q.unread === 'true' ? { readAt: null } : {}) };
    const [total, unread, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const jobs = new Map(
      (await this.prisma.job.findMany({ where: { id: { in: rows.map((r) => r.jobId).filter((x): x is string => !!x) } }, select: { id: true, jobNumber: true } })).map((j) => [j.id, j.jobNumber]),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type as NotificationType,
        title: r.title,
        body: r.body,
        link: r.link,
        jobNumber: r.jobId ? (jobs.get(r.jobId) ?? null) : null,
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
      unread,
    };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (!count && !(await this.prisma.notification.count({ where: { id, userId } }))) throw new NotFoundException('Notification not found');
    this.realtime.toUser(userId, 'notification:read', { id });
  }

  async readAll(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    this.realtime.toUser(userId, 'notification:read', { all: true });
  }

  async preferences(userId: string): Promise<{ disabled: NotificationType[] }> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId, enabled: false } });
    return { disabled: rows.map((r) => r.type as NotificationType).filter((t) => (NOTIFICATION_TYPES as readonly string[]).includes(t)) };
  }

  async setPreferences(userId: string, disabled: NotificationType[]): Promise<{ disabled: NotificationType[] }> {
    await this.prisma.$transaction([
      this.prisma.notificationPreference.deleteMany({ where: { userId } }),
      this.prisma.notificationPreference.createMany({ data: [...new Set(disabled)].map((type) => ({ userId, type, enabled: false })) }),
    ]);
    return this.preferences(userId);
  }
}

/** Every signed-in user manages only their own notifications. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query({ schema: listQuery }) q: z.output<typeof listQuery>, @CurrentPrincipal() p: Principal) {
    return this.notifications.list(p.userId, q);
  }

  @Post('read-all')
  @HttpCode(204)
  readAll(@CurrentPrincipal() p: Principal) {
    return this.notifications.readAll(p.userId);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(@Param('id', { schema: uuidSchema }) id: string, @CurrentPrincipal() p: Principal) {
    return this.notifications.markRead(p.userId, id);
  }

  @Get('preferences')
  prefs(@CurrentPrincipal() p: Principal) {
    return this.notifications.preferences(p.userId);
  }

  @Put('preferences')
  setPrefs(@Body({ schema: preferencesSchema }) body: z.output<typeof preferencesSchema>, @CurrentPrincipal() p: Principal) {
    return this.notifications.setPreferences(p.userId, body.disabled);
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import type { z } from 'zod';
import { listAuditQuerySchema, type AuditLogDto, type Paginated } from '@jobflow/shared';
import { PrismaService } from '../core/prisma.service.js';
import { RequirePermissions } from '../access/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';

@Controller('audit-logs')
@RequirePermissions('audit.view')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query({ schema: listAuditQuerySchema }) q: z.output<typeof listAuditQuerySchema>): Promise<Paginated<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { username: true } } },
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
        actorUsername: r.actor?.username ?? null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        summary: r.summary,
        before: r.before,
        after: r.after,
        ip: r.ip,
        requestId: r.requestId,
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }
}

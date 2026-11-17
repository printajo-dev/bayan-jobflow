import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type {
  createUserSchema,
  listUsersQuerySchema,
  Paginated,
  setUserDepartmentsSchema,
  UpdateUserInput,
  UserDto,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import { hashPassword } from '../auth/password.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SessionService } from '../auth/session.service.js';
import { toUserDto, userDtoInclude } from './user.mapper.js';
import type { Prisma } from '../generated/prisma/client.js';

export const SYSTEM_ADMIN_ROLE = 'system_admin';

type CreateUser = z.output<typeof createUserSchema>;
type ListUsers = z.output<typeof listUsersQuerySchema>;
type DepartmentAssignment = z.output<typeof setUserDepartmentsSchema>['departments'][number];

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(q: ListUsers): Promise<Paginated<UserDto>> {
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.departmentId ? { departments: { some: { departmentId: q.departmentId } } } : {}),
      ...(q.search
        ? {
            OR: [
              { username: { contains: q.search, mode: 'insensitive' } },
              { fullName: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: userDtoInclude,
        orderBy: { fullName: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toUserDto), page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string, db: Tx = this.prisma): Promise<UserDto> {
    const user = await db.user.findUnique({ where: { id }, include: userDtoInclude });
    if (!user) throw new NotFoundException('User not found');
    return toUserDto(user);
  }

  async create(input: CreateUser, meta: ActionMeta): Promise<UserDto> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { username: input.username } })) {
        throw new ConflictException(`Username "${input.username}" is already taken`);
      }
      await this.assertRolesExist(tx, input.roleIds);
      await this.assertDepartmentsExist(tx, input.departments.map((d) => d.departmentId));
      const user = await tx.user.create({
        data: {
          username: input.username,
          fullName: input.fullName,
          email: input.email ?? null,
          passwordHash,
          mustChangePassword: true,
          roles: { create: input.roleIds.map((roleId) => ({ roleId, assignedById: meta.actorId })) },
          departments: { create: input.departments.map((d) => ({ departmentId: d.departmentId, isLeader: d.isLeader })) },
        },
      });
      const dto = await this.get(user.id, tx);
      await this.audit.record(tx, meta, {
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        summary: `Created user ${user.username}`,
        after: dto,
      });
      await this.outbox.enqueue(tx, {
        type: 'user.created',
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { userId: user.id },
        idempotencyKey: `user.created:${user.id}`,
      });
      return dto;
    });
  }

  async update(id: string, input: UpdateUserInput, meta: ActionMeta): Promise<UserDto> {
    const dto = await this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      if (input.status === 'DISABLED' && before.status !== 'DISABLED') {
        if (id === meta.actorId) throw new BadRequestException('You cannot disable your own account');
        await this.assertNotLastAdmin(tx, id);
      }
      await tx.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      if (input.status === 'DISABLED') await this.sessions.revokeAllForUser(tx, id);
      const after = await this.get(id, tx);
      const action =
        input.status && input.status !== before.status
          ? input.status === 'DISABLED' ? 'user.disabled' : 'user.enabled'
          : 'user.updated';
      await this.audit.record(tx, meta, {
        action,
        entityType: 'user',
        entityId: id,
        summary: `${{ 'user.disabled': 'Disabled', 'user.enabled': 'Enabled', 'user.updated': 'Updated' }[action]} user ${after.username}`,
        before,
        after,
      });
      return after;
    });
    // A disabled user's open tabs stop receiving live updates immediately.
    if (input.status === 'DISABLED') this.realtime.disconnectUser(id);
    return dto;
  }

  async setRoles(id: string, roleIds: string[], meta: ActionMeta): Promise<UserDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      await this.assertRolesExist(tx, roleIds);
      const adminRole = await tx.role.findUnique({ where: { key: SYSTEM_ADMIN_ROLE } });
      if (adminRole && before.roles.some((r) => r.id === adminRole.id) && !roleIds.includes(adminRole.id)) {
        await this.assertNotLastAdmin(tx, id);
      }
      await tx.userRole.deleteMany({ where: { userId: id, roleId: { notIn: roleIds } } });
      const existing = new Set(before.roles.map((r) => r.id));
      await tx.userRole.createMany({
        data: roleIds.filter((r) => !existing.has(r)).map((roleId) => ({ userId: id, roleId, assignedById: meta.actorId })),
      });
      const after = await this.get(id, tx);
      await this.audit.record(tx, meta, {
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: id,
        summary: `Roles of ${after.username}: ${after.roles.map((r) => r.name).join(', ') || 'none'}`,
        before: { roles: before.roles },
        after: { roles: after.roles },
      });
      return after;
    });
  }

  async setDepartments(id: string, departments: DepartmentAssignment[], meta: ActionMeta): Promise<UserDto> {
    const ids = departments.map((d) => d.departmentId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A department is listed twice');
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      await this.assertDepartmentsExist(tx, ids);
      await tx.userDepartment.deleteMany({ where: { userId: id } });
      await tx.userDepartment.createMany({
        data: departments.map((d) => ({ userId: id, departmentId: d.departmentId, isLeader: d.isLeader })),
      });
      const after = await this.get(id, tx);
      await this.audit.record(tx, meta, {
        action: 'user.departments_changed',
        entityType: 'user',
        entityId: id,
        summary: `Departments of ${after.username}: ${
          after.departments.map((d) => `${d.name}${d.isLeader ? ' (leader)' : ''}`).join(', ') || 'none'
        }`,
        before: { departments: before.departments },
        after: { departments: after.departments },
      });
      return after;
    });
  }

  /** Admin reset: the user must choose a new password at next sign-in. */
  async resetPassword(id: string, newPassword: string, meta: ActionMeta): Promise<UserDto> {
    const passwordHash = await hashPassword(newPassword);
    const dto = await this.prisma.$transaction(async (tx) => {
      const user = await this.get(id, tx);
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
      const ended = await this.sessions.revokeAllForUser(tx, id);
      await this.audit.record(tx, meta, {
        action: 'user.password_reset',
        entityType: 'user',
        entityId: id,
        summary: `Password reset for ${user.username} by administrator; ${ended} session(s) ended`,
      });
      return this.get(id, tx);
    });
    this.realtime.disconnectUser(id);
    return dto;
  }

  async unlock(id: string, meta: ActionMeta): Promise<UserDto> {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.get(id, tx);
      await tx.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await this.audit.record(tx, meta, {
        action: 'user.unlocked',
        entityType: 'user',
        entityId: id,
        summary: `Unlocked ${user.username}`,
      });
      return this.get(id, tx);
    });
  }

  private async assertRolesExist(tx: Tx, roleIds: string[]): Promise<void> {
    const found = await tx.role.count({ where: { id: { in: roleIds } } });
    if (found !== new Set(roleIds).size) throw new BadRequestException('One or more roles do not exist');
  }

  private async assertDepartmentsExist(tx: Tx, ids: string[]): Promise<void> {
    const found = await tx.department.count({ where: { id: { in: ids }, isActive: true } });
    if (found !== new Set(ids).size) throw new BadRequestException('One or more departments do not exist or are inactive');
  }

  /** There must always be at least one active System Administrator. */
  private async assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
    // Serialise administrator removals: two admins disabling each other at the
    // same moment must not both succeed. The lock is held until commit, and the
    // count below then sees the other transaction's result.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('jobflow.last-admin-guard'))`;
    const others = await tx.user.count({
      where: {
        id: { not: userId },
        status: 'ACTIVE',
        roles: { some: { role: { key: SYSTEM_ADMIN_ROLE } } },
      },
    });
    const isAdmin = await tx.userRole.count({ where: { userId, role: { key: SYSTEM_ADMIN_ROLE } } });
    if (isAdmin > 0 && others === 0) {
      throw new BadRequestException('This is the last active System Administrator; add another administrator first');
    }
  }
}

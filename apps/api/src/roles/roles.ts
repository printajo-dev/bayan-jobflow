import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { z } from 'zod';
import {
  createRoleSchema,
  isPermissionKey,
  PERMISSIONS,
  setRoleDepartmentsSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
  uuidSchema,
  type PermissionKey,
  type RoleDto,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { type ActionMeta, Meta, RequirePermissions } from '../access/decorators.js';
import { SYSTEM_ADMIN_ROLE } from '../users/users.service.js';

const roleInclude = {
  permissions: { select: { permission: { select: { key: true } } } },
  departmentScopes: { select: { departmentId: true } },
  _count: { select: { users: true } },
} as const;

type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: 'GLOBAL' | 'DEPARTMENT';
  isSystem: boolean;
  permissions: { permission: { key: string } }[];
  departmentScopes: { departmentId: string }[];
  _count: { users: number };
};

function toDto(r: RoleRow): RoleDto {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    scope: r.scope,
    isSystem: r.isSystem,
    permissionKeys: r.permissions.map((p) => p.permission.key).filter(isPermissionKey).sort(),
    departmentIds: r.departmentScopes.map((d) => d.departmentId),
    userCount: r._count.users,
  };
}

/** Permissions the System Administrator role must keep so nobody locks themselves out. */
const ADMIN_LOCKOUT_GUARD: PermissionKey[] = ['user.manage', 'role.manage'];

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({ include: roleInclude, orderBy: { name: 'asc' } });
    return rows.map(toDto);
  }

  async get(id: string, db: Tx = this.prisma): Promise<RoleDto> {
    const r = await db.role.findUnique({ where: { id }, include: roleInclude });
    if (!r) throw new NotFoundException('Role not found');
    return toDto(r);
  }

  create(input: z.output<typeof createRoleSchema>, meta: ActionMeta): Promise<RoleDto> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({ data: { ...input, description: input.description ?? null } });
      const dto = await this.get(created.id, tx);
      await this.audit.record(tx, meta, {
        action: 'role.created',
        entityType: 'role',
        entityId: dto.id,
        summary: `Created role ${dto.name}`,
        after: dto,
      });
      return dto;
    });
  }

  update(id: string, input: z.output<typeof updateRoleSchema>, meta: ActionMeta): Promise<RoleDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      await tx.role.update({ where: { id }, data: input });
      const after = await this.get(id, tx);
      await this.audit.record(tx, meta, {
        action: 'role.updated',
        entityType: 'role',
        entityId: id,
        summary: `Updated role ${after.name}`,
        before,
        after,
      });
      return after;
    });
  }

  setPermissions(id: string, keys: PermissionKey[], meta: ActionMeta): Promise<RoleDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      if (before.key === SYSTEM_ADMIN_ROLE) {
        const missing = ADMIN_LOCKOUT_GUARD.filter((k) => !keys.includes(k));
        if (missing.length) {
          throw new BadRequestException(`The System Administrator role must keep: ${missing.join(', ')}`);
        }
      }
      const permissions = await tx.permission.findMany({ where: { key: { in: keys } } });
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: id, permissionId: p.id })) });
      const after = await this.get(id, tx);
      const added = after.permissionKeys.filter((k) => !before.permissionKeys.includes(k));
      const removed = before.permissionKeys.filter((k) => !after.permissionKeys.includes(k));
      await this.audit.record(tx, meta, {
        action: 'role.permissions_changed',
        entityType: 'role',
        entityId: id,
        summary: `Permissions of ${after.name}: +${added.length} −${removed.length}`,
        before: { permissionKeys: before.permissionKeys },
        after: { permissionKeys: after.permissionKeys, added, removed },
      });
      await this.outbox.enqueue(tx, {
        type: 'role.permissions_changed',
        aggregateType: 'role',
        aggregateId: id,
        payload: { roleId: id, added, removed },
        idempotencyKey: `role.permissions_changed:${id}:${meta.requestId}`,
      });
      return after;
    });
  }

  setDepartments(id: string, departmentIds: string[], meta: ActionMeta): Promise<RoleDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      if (before.scope !== 'DEPARTMENT' && departmentIds.length > 0) {
        throw new BadRequestException('Only department-scoped roles can be limited to departments');
      }
      const unique = [...new Set(departmentIds)];
      if ((await tx.department.count({ where: { id: { in: unique } } })) !== unique.length) {
        throw new BadRequestException('One or more departments do not exist');
      }
      await tx.roleDepartmentScope.deleteMany({ where: { roleId: id } });
      await tx.roleDepartmentScope.createMany({ data: unique.map((departmentId) => ({ roleId: id, departmentId })) });
      const after = await this.get(id, tx);
      await this.audit.record(tx, meta, {
        action: 'role.departments_changed',
        entityType: 'role',
        entityId: id,
        summary: `Department scope of ${after.name} changed`,
        before: { departmentIds: before.departmentIds },
        after: { departmentIds: after.departmentIds },
      });
      return after;
    });
  }
}

@Controller('roles')
@RequirePermissions('role.manage')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Get(':id')
  get(@Param('id', { schema: uuidSchema }) id: string) {
    return this.roles.get(id);
  }

  @Post()
  create(@Body({ schema: createRoleSchema }) body: z.output<typeof createRoleSchema>, @Meta() meta: ActionMeta) {
    return this.roles.create(body, meta);
  }

  @Patch(':id')
  update(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: updateRoleSchema }) body: z.output<typeof updateRoleSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.roles.update(id, body, meta);
  }

  @Put(':id/permissions')
  setPermissions(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: setRolePermissionsSchema }) body: z.output<typeof setRolePermissionsSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.roles.setPermissions(id, body.permissionKeys, meta);
  }

  @Put(':id/departments')
  setDepartments(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: setRoleDepartmentsSchema }) body: z.output<typeof setRoleDepartmentsSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.roles.setDepartments(id, body.departmentIds, meta);
  }
}

@Controller('permissions')
export class PermissionsController {
  /** Catalogue of permission keys, for the role editor. */
  @Get()
  @RequirePermissions('role.manage')
  list() {
    return PERMISSIONS;
  }
}

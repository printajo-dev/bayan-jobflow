import { Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  uuidSchema,
  type DepartmentDto,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { type ActionMeta, Meta, RequirePermissions } from '../access/decorators.js';

type CreateDepartment = z.output<typeof createDepartmentSchema>;
type UpdateDepartment = z.output<typeof updateDepartmentSchema>;

function toDto(d: { id: string; code: string; name: string; description: string | null; isActive: boolean }): DepartmentDto {
  return { id: d.id, code: d.code, name: d.name, description: d.description, isActive: d.isActive };
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toDto);
  }

  async get(id: string, db: Tx = this.prisma): Promise<DepartmentDto> {
    const d = await db.department.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Department not found');
    return toDto(d);
  }

  create(input: CreateDepartment, meta: ActionMeta): Promise<DepartmentDto> {
    return this.prisma.$transaction(async (tx) => {
      const d = toDto(await tx.department.create({ data: { ...input, description: input.description ?? null } }));
      await this.audit.record(tx, meta, {
        action: 'department.created',
        entityType: 'department',
        entityId: d.id,
        summary: `Created department ${d.name} (${d.code})`,
        after: d,
      });
      return d;
    });
  }

  update(id: string, input: UpdateDepartment, meta: ActionMeta): Promise<DepartmentDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.get(id, tx);
      const after = toDto(await tx.department.update({ where: { id }, data: input }));
      await this.audit.record(tx, meta, {
        action: 'department.updated',
        entityType: 'department',
        entityId: id,
        summary: `Updated department ${after.name}`,
        before,
        after,
      });
      return after;
    });
  }
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  /** Any signed-in user may list departments (needed for pickers). */
  @Get()
  list(): Promise<DepartmentDto[]> {
    return this.departments.list();
  }

  @Post()
  @RequirePermissions('department.manage')
  create(@Body({ schema: createDepartmentSchema }) body: CreateDepartment, @Meta() meta: ActionMeta) {
    return this.departments.create(body, meta);
  }

  @Patch(':id')
  @RequirePermissions('department.manage')
  update(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: updateDepartmentSchema }) body: UpdateDepartment,
    @Meta() meta: ActionMeta,
  ) {
    return this.departments.update(id, body, meta);
  }
}

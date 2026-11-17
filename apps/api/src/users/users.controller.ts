import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  setUserDepartmentsSchema,
  setUserRolesSchema,
  updateUserSchema,
  uuidSchema,
  type Paginated,
  type UpdateUserInput,
  type UserDto,
} from '@jobflow/shared';
import { type ActionMeta, Meta, RequirePermissions } from '../access/decorators.js';
import { UsersService } from './users.service.js';

@Controller('users')
@RequirePermissions('user.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query({ schema: listUsersQuerySchema }) q: z.output<typeof listUsersQuerySchema>): Promise<Paginated<UserDto>> {
    return this.users.list(q);
  }

  @Get(':id')
  get(@Param('id', { schema: uuidSchema }) id: string): Promise<UserDto> {
    return this.users.get(id);
  }

  @Post()
  create(@Body({ schema: createUserSchema }) body: z.output<typeof createUserSchema>, @Meta() meta: ActionMeta) {
    return this.users.create(body, meta);
  }

  @Patch(':id')
  update(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: updateUserSchema }) body: UpdateUserInput,
    @Meta() meta: ActionMeta,
  ) {
    return this.users.update(id, body, meta);
  }

  @Put(':id/roles')
  setRoles(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: setUserRolesSchema }) body: z.output<typeof setUserRolesSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.users.setRoles(id, body.roleIds, meta);
  }

  @Put(':id/departments')
  setDepartments(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: setUserDepartmentsSchema }) body: z.output<typeof setUserDepartmentsSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.users.setDepartments(id, body.departments, meta);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: resetPasswordSchema }) body: z.output<typeof resetPasswordSchema>,
    @Meta() meta: ActionMeta,
  ) {
    return this.users.resetPassword(id, body.newPassword, meta);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  unlock(@Param('id', { schema: uuidSchema }) id: string, @Meta() meta: ActionMeta) {
    return this.users.unlock(id, meta);
  }
}

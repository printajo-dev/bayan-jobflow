import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionKey } from '@jobflow/shared';
import type { Principal } from './principal.js';

export const IS_PUBLIC = 'jobflow:isPublic';
export const REQUIRED_PERMISSIONS = 'jobflow:requiredPermissions';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'jobflow:allowPasswordChangePending';

/** Route needs no session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Route requires every listed permission (granted globally or in any
 * department). Finer, resource-level checks happen in services.
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Route stays usable while the user must change their password. */
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.principal) throw new Error('CurrentPrincipal used on a public route');
  return req.principal;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { requestId: req.requestId, ip: req.ip ?? null, actorId: req.principal?.userId ?? null };
});

export interface ActionMeta {
  requestId: string;
  ip: string | null;
  actorId: string | null;
}

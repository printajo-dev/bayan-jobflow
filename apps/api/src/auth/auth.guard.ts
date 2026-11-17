import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PermissionKey } from '@jobflow/shared';
import {
  ALLOW_DURING_MAINTENANCE,
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../access/decorators.js';
import { PrincipalLoader } from '../access/principal.loader.js';
import { SessionService, sessionCookieName } from './session.service.js';
import { PrismaService } from '../core/prisma.service.js';
import { SystemService } from '../system/system.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GLOBAL_ONLY = new Set<PermissionKey>(['user.manage', 'role.manage', 'department.manage', 'template.manage', 'settings.manage', 'audit.view', 'outbox.manage']);

/**
 * Global guard. Deny by default: every route needs a valid session unless it
 * is marked @Public(). Also enforces CSRF on unsafe methods, the forced
 * password change, and route-level @RequirePermissions().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalLoader,
    private readonly prisma: PrismaService,
    private readonly system: SystemService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[sessionCookieName()];
    if (!token) throw new UnauthorizedException('Not signed in');

    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException('Session expired. Please sign in again.');

    const principal = await this.principals.load(session.userId);
    if (!principal) {
      // Disabled or deleted while signed in.
      await this.sessions.revokeAllForUser(this.prisma, session.userId);
      throw new UnauthorizedException('Account is disabled');
    }

    if (!SAFE_METHODS.has(req.method) && req.header('x-csrf-token') !== session.csrfToken) {
      throw new ForbiddenException('Missing or invalid CSRF token');
    }

    req.principal = principal;
    req.sessionId = session.sessionId;
    req.csrfToken = session.csrfToken;

    // Maintenance mode: only administrators (settings.manage) keep working.
    if (!principal.hasGlobal('settings.manage') && !this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_MAINTENANCE, targets)) {
      const m = await this.system.maintenance();
      if (m.enabled) {
        throw new ServiceUnavailableException(m.message ? `JobFlow is under maintenance: ${m.message}` : 'JobFlow is under maintenance. Please try again later.');
      }
    }

    if (
      principal.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)
    ) {
      throw new ForbiddenException('You must change your password before continuing');
    }

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    // System-wide administration rights only count when granted globally: a
    // department-scoped role carrying them must not unlock global screens.
    const missing = required.filter((p) => (GLOBAL_ONLY.has(p) ? !principal.hasGlobal(p) : !principal.has(p)));
    if (missing.length > 0) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}

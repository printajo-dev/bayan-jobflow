import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PermissionKey } from '@jobflow/shared';
import {
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../access/decorators.js';
import { PrincipalLoader } from '../access/principal.loader.js';
import { SessionService, sessionCookieName } from './session.service.js';
import { PrismaService } from '../core/prisma.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

    if (
      principal.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)
    ) {
      throw new ForbiddenException('You must change your password before continuing');
    }

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !principal.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}

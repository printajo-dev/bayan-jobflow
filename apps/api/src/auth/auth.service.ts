import { BadRequestException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ChangePasswordInput, CurrentUserDto, LoginInput } from '@jobflow/shared';
import { PrismaService } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { ActionMeta } from '../access/decorators.js';
import { PrincipalLoader } from '../access/principal.loader.js';
import { config } from '../config/config.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { type IssuedSession, SessionService } from './session.service.js';
import { toUserDto, userDtoInclude } from '../users/user.mapper.js';

const INVALID = 'Invalid username or password';

export interface LoginContext extends ActionMeta {
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalLoader,
  ) {}

  /**
   * Counts a failed password atomically (parallel guesses cannot all read the
   * same old count) and locks the account at LOGIN_MAX_FAILURES.
   */
  private async recordFailure(user: { id: string; username: string; status: string }, passwordOk: boolean, ctx: LoginContext): Promise<boolean> {
    const cfg = config();
    return this.prisma.$transaction(async (tx) => {
      let lock = false;
      let failures = 0;
      if (!passwordOk) {
        const rows = await tx.$queryRaw<{ n: number }[]>`
          UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${user.id}::uuid RETURNING failed_login_count AS n`;
        failures = Number(rows[0]?.n ?? 0);
        lock = failures >= cfg.LOGIN_MAX_FAILURES;
        if (lock) {
          await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + cfg.LOGIN_LOCK_MINUTES * 60_000) } });
        }
      }
      await this.audit.record(tx, { ...ctx, actorId: null }, {
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        summary: lock
          ? `Account ${user.username} locked after ${failures} failed attempts`
          : user.status !== 'ACTIVE'
            ? `Login attempt for disabled account ${user.username}`
            : `Failed login for ${user.username}`,
      });
      return lock;
    });
  }

  async login(input: LoginInput, ctx: LoginContext): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { username: input.username } });
    if (!user) {
      await verifyAgainstDummy(input.password);
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, ctx, {
          action: 'auth.login_failed',
          entityType: 'user',
          summary: `Failed login for unknown username "${input.username.slice(0, 50)}"`,
        }),
      );
      throw new UnauthorizedException(INVALID);
    }

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new HttpException(
        { statusCode: 423, error: 'Locked', message: 'Account is temporarily locked after failed attempts. Try again later or ask an administrator to unlock it.' },
        423,
      );
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok || user.status !== 'ACTIVE') {
      await this.recordFailure(user, ok, ctx);
      throw new UnauthorizedException(INVALID);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      });
      const session = await this.sessions.create(tx, user.id, { ip: ctx.ip, userAgent: ctx.userAgent });
      await this.audit.record(tx, { ...ctx, actorId: user.id }, {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.username} signed in`,
      });
      return session;
    });
  }

  async logout(sessionId: string, meta: ActionMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, sessionId);
      if (meta.actorId) {
        await this.audit.record(tx, meta, {
          action: 'auth.logout',
          entityType: 'user',
          entityId: meta.actorId,
          summary: 'Signed out',
        });
      }
    });
  }

  /**
   * Changes the password, ends every session of the user (all devices) and
   * issues a fresh session for this browser.
   */
  async changePassword(userId: string, input: ChangePasswordInput, ctx: LoginContext): Promise<IssuedSession> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      // Wrong guesses count towards the lockout like sign-in attempts; at the
      // limit every session of the account ends (a stolen session cannot keep guessing).
      if (await this.recordFailure(user, false, ctx)) {
        await this.prisma.$transaction((tx) => this.sessions.revokeAllForUser(tx, userId));
        throw new UnauthorizedException('Too many wrong passwords. The account is locked; sign in again later.');
      }
      throw new BadRequestException('Current password is incorrect');
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }
    const passwordHash = await hashPassword(input.newPassword);
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      await this.sessions.revokeAllForUser(tx, userId);
      const session = await this.sessions.create(tx, userId, { ip: ctx.ip, userAgent: ctx.userAgent });
      await this.audit.record(tx, ctx, {
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: userId,
        summary: `${user.username} changed their password; other sessions ended`,
      });
      return session;
    });
  }

  async currentUser(userId: string, csrfToken: string): Promise<CurrentUserDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: userDtoInclude });
    const principal = await this.principals.load(userId);
    if (!principal) throw new UnauthorizedException();
    return { user: toUserDto(user), permissions: principal.allPermissions(), csrfToken };
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CookieOptions } from 'express';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { config } from '../config/config.js';

export interface IssuedSession {
  userId: string;
  token: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  csrfToken: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `__Host-` cookies are pinned to this host, HTTPS and path `/`. */
export function sessionCookieName(): string {
  return config().COOKIE_SECURE ? '__Host-jf_session' : 'jf_session';
}

export function sessionCookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: config().COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    db: Tx,
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const sessionId = hashToken(token);
    const expiresAt = this.nextExpiry(new Date());
    await db.session.create({
      data: {
        id: sessionId,
        userId,
        csrfToken,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { userId, token, sessionId, csrfToken, expiresAt };
  }

  /** Validates a cookie token, sliding the idle expiry. Returns null if invalid. */
  async resolve(token: string): Promise<ActiveSession | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const sessionId = hashToken(token);
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    const now = new Date();
    if (session.expiresAt <= now) {
      await this.prisma.session.deleteMany({ where: { id: sessionId } });
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      // updateMany: if a logout or an administrator ended the session in the
      // meantime, this is a sign-out (401), not a "record not found" error.
      const { count } = await this.prisma.session.updateMany({
        where: { id: sessionId },
        data: { lastSeenAt: now, expiresAt: this.nextExpiry(session.createdAt, now) },
      });
      if (count === 0) return null;
    }
    return { sessionId, userId: session.userId, csrfToken: session.csrfToken };
  }

  /** Is the session still valid? Unlike resolve(), never extends it (used to re-check open sockets). */
  async peek(token: string): Promise<{ userId: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const session = await this.prisma.session.findUnique({ where: { id: hashToken(token) }, select: { userId: true, expiresAt: true } });
    return session && session.expiresAt > new Date() ? { userId: session.userId } : null;
  }

  async revoke(db: Tx, sessionId: string): Promise<void> {
    await db.session.deleteMany({ where: { id: sessionId } });
  }

  async revokeAllForUser(db: Tx, userId: string): Promise<number> {
    const { count } = await db.session.deleteMany({ where: { userId } });
    return count;
  }

  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    return count;
  }

  /** Idle timeout from now, never beyond the absolute lifetime. */
  private nextExpiry(createdAt: Date, now = new Date()): Date {
    const cfg = config();
    const idle = now.getTime() + cfg.SESSION_IDLE_MINUTES * 60_000;
    const absolute = createdAt.getTime() + cfg.SESSION_ABSOLUTE_HOURS * 3_600_000;
    return new Date(Math.min(idle, absolute));
  }
}

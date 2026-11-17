import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Principal } from '../access/principal.js';

export interface RequestMeta {
  requestId: string;
  ip: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    principal?: Principal;
    sessionId?: string;
    csrfToken?: string;
  }
}

/**
 * Assigns a server-generated request id and echoes it. Never taken from the
 * client: the id is part of outbox idempotency keys, and a repeated client
 * value would silently drop later events.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function requestMeta(req: Request): RequestMeta {
  return { requestId: req.requestId, ip: req.ip ?? null };
}

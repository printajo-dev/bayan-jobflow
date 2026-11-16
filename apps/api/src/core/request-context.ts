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

/** Assigns a request id (honouring a sane incoming X-Request-Id) and echoes it. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function requestMeta(req: Request): RequestMeta {
  return { requestId: req.requestId, ip: req.ip ?? null };
}

import { rm } from 'node:fs/promises';
import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config/config.js';

export const API_PREFIX = 'api/v1';

/**
 * Rejects cross-site unsafe requests: if the browser sends an Origin header it
 * must match the Host the request was sent to. Complements SameSite=Strict
 * cookies and the CSRF token.
 */
function sameOriginMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    const expected = req.header('x-forwarded-host') ?? req.header('host');
    if (!host || host !== expected) {
      res.status(403).json({ statusCode: 403, error: 'Forbidden', message: 'Cross-origin request rejected', requestId: req.requestId });
      return;
    }
  }
  next();
}

/** Shared by main.ts and the e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication): void {
  const cfg = config();
  const express = app as NestExpressApplication;
  if (cfg.TRUST_PROXY) express.set('trust proxy', 'loopback, linklocal, uniquelocal');
  express.disable('x-powered-by');
  app.use(
    helmet({
      // The API only returns JSON and files; nothing it serves may load anything.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  // Uploads are written to FILES_ROOT/tmp before validation runs. Whatever
  // happens to the request (rejected input, error, aborted upload), the temp
  // file is removed when the response ends; stored files were already moved.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('close', () => {
      const file = (req as Request & { file?: { path?: string } }).file;
      if (file?.path) void rm(file.path, { force: true }).catch(() => undefined);
    });
    next();
  });
  app.use(cookieParser());
  app.use(sameOriginMiddleware);
  app.setGlobalPrefix(API_PREFIX, { exclude: [] });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();
}

import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

/**
 * One structured line per request. Never logs bodies, cookies or headers, so
 * passwords and session tokens cannot leak into logs.
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.log({
      msg: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.principal?.userId,
    });
  });
  next();
}

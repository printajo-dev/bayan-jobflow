import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorBody } from '@jobflow/shared';
import { Prisma } from '../generated/prisma/client.js';

/**
 * One error shape for every failure: { statusCode, error, message, requestId }.
 * Unexpected errors are logged with the request id and returned as a generic
 * 500 so internals never reach the browser.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const body = this.toBody(exception);
    body.requestId = req.requestId;

    if (body.statusCode >= 500) {
      this.logger.error(
        { msg: 'Unhandled error', requestId: req.requestId, path: req.path },
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const r = response as { message?: string | string[]; error?: string };
        return {
          statusCode: status,
          error: r.error ?? HttpStatus[status] ?? 'Error',
          message: r.message ?? exception.message,
        };
      }
      return { statusCode: status, error: HttpStatus[status] ?? 'Error', message: String(response) };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { statusCode: 409, error: 'Conflict', message: 'A record with the same unique value already exists' };
      }
      if (exception.code === 'P2025') {
        return { statusCode: 404, error: 'Not Found', message: 'Record not found' };
      }
    }
    return { statusCode: 500, error: 'Internal Server Error', message: 'Unexpected error' };
  }
}

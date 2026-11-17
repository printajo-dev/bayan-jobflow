import 'dotenv/config';
import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { config } from './config/config.js';
import { buildOpenApi } from './openapi.js';
import { SwaggerModule } from '@nestjs/swagger';

const cfg = config();
const levels = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
const logger = new ConsoleLogger({
  json: cfg.NODE_ENV === 'production',
  logLevels: levels.slice(0, levels.indexOf(cfg.LOG_LEVEL) + 1),
});

const app = await NestFactory.create(AppModule, { logger });
configureApp(app);
if (cfg.API_DOCS) {
  // Development/admin aid only; the UI needs a relaxed CSP on its own path.
  app.use('/api/v1/docs', (_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    next();
  });
  SwaggerModule.setup('api/v1/docs', app, () => buildOpenApi(app));
  logger.log('API documentation at /api/v1/docs', 'Bootstrap');
}
await app.listen(cfg.PORT, '0.0.0.0');
logger.log(`Bayan JobFlow API listening on port ${cfg.PORT}`, 'Bootstrap');

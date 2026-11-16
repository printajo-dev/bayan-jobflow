import 'dotenv/config';
import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { config } from './config/config.js';

const cfg = config();
const levels = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
const logger = new ConsoleLogger({
  json: cfg.NODE_ENV === 'production',
  logLevels: levels.slice(0, levels.indexOf(cfg.LOG_LEVEL) + 1),
});

const app = await NestFactory.create(AppModule, { logger });
configureApp(app);
await app.listen(cfg.PORT, '0.0.0.0');
logger.log(`Bayan JobFlow API listening on port ${cfg.PORT}`, 'Bootstrap');

import 'dotenv/config';
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { API_PREFIX, configureApp } from '../bootstrap.js';
import { buildOpenApi } from '../openapi.js';

/** Writes the OpenAPI document: node dist/cli/openapi.js <output.json> */
const app = await NestFactory.create(AppModule, { logger: ['error'] });
configureApp(app);
await app.init();
const doc = buildOpenApi(app);
const out = process.argv[2] ?? 'openapi.json';
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${out} (${Object.keys(doc.paths).length} paths under /${API_PREFIX})`);
await app.close();

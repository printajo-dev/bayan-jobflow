import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/core/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';
import { DEMO_PASSWORD } from '../src/cli/seed.js';

export { DEMO_PASSWORD };
export const API = '/api/v1';

export async function createTestApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

export interface SignedIn {
  agent: TestAgent;
  csrf: string;
  userId: string;
}

export async function signIn(app: INestApplication, username: string, password = DEMO_PASSWORD): Promise<SignedIn> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post(`${API}/auth/login`).send({ username, password });
  if (res.status !== 200) throw new Error(`Sign-in as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken, userId: res.body.user.id };
}

let counter = 0;

/** Creates an admin directly in the database so tests do not depend on each other. */
export async function createAdmin(prisma: PrismaService, password = 'Admin-Password-2026'): Promise<{ username: string; password: string }> {
  const username = `admin.${Date.now()}.${counter++}`;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
  await prisma.user.create({
    data: {
      username,
      fullName: 'Test Admin',
      passwordHash: await hashPassword(password),
      roles: { create: [{ roleId: role.id }] },
    },
  });
  return { username, password };
}

export function uniqueName(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}${(counter++).toString(36)}`;
}

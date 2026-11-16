import { execSync } from 'node:child_process';
import pg from 'pg';
import { createPrismaClient } from '../src/core/prisma.service.js';
import { seedDemoUsers, seedReferenceData } from '../src/cli/seed.js';
import { E2E_DATABASE_URL } from './env.js';

/**
 * Creates a fresh database for the e2e run, applies the real migrations and
 * seeds reference data plus fictional demo users.
 */
export default async function setup(): Promise<void> {
  const url = new URL(E2E_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL } });
  const prisma = createPrismaClient(E2E_DATABASE_URL);
  await seedReferenceData(prisma);
  await seedDemoUsers(prisma);
  await prisma.$disconnect();
}

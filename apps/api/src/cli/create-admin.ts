import 'dotenv/config';
import { createInterface } from 'node:readline';
import { passwordSchema, usernameSchema } from '@jobflow/shared';
import { createPrismaClient } from '../core/prisma.service.js';
import { hashPassword } from '../auth/password.js';
import { seedReferenceData } from './seed.js';

/**
 * Creates a System Administrator. Interactive by default:
 *   docker compose run --rm api node dist/cli/create-admin.js
 * Non-interactive (scripts): --username, --full-name and the password in the
 * JOBFLOW_ADMIN_PASSWORD environment variable (never on the command line, where
 * it would be visible in the process list and shell history).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) =>
        write(s.startsWith(question) ? s : '');
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const prisma = createPrismaClient();
try {
  await seedReferenceData(prisma);

  const username = usernameSchema.parse(arg('username') ?? (await ask('Admin username: ')));
  const fullName = (arg('full-name') ?? (await ask('Full name: '))).trim() || username;
  let password = process.env['JOBFLOW_ADMIN_PASSWORD'];
  if (!password) {
    password = await ask('Password (min 12 characters): ', true);
    const again = await ask('Repeat password: ', true);
    if (password !== again) throw new Error('Passwords do not match');
  }
  passwordSchema.parse(password);

  if (await prisma.user.findUnique({ where: { username } })) {
    throw new Error(`User "${username}" already exists`);
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
  const mgmt = await prisma.department.findUniqueOrThrow({ where: { code: 'MANAGEMENT' } });
  const user = await prisma.user.create({
    data: {
      username,
      fullName,
      passwordHash: await hashPassword(password),
      roles: { create: [{ roleId: role.id }] },
      departments: { create: [{ departmentId: mgmt.id, isLeader: true }] },
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
      summary: `System Administrator ${username} created from the command line`,
    },
  });
  console.log(`System Administrator "${username}" created.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

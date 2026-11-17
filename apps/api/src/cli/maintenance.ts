import 'dotenv/config';
import { createPrismaClient } from '../core/prisma.service.js';
import { readMaintenance, writeMaintenance } from '../system/system.js';

/**
 * Turns maintenance mode on or off from the server (used by the update and
 * restore scripts):
 *   docker compose exec api node dist/cli/maintenance.js on "Updating to v1.2"
 *   docker compose exec api node dist/cli/maintenance.js off
 *   docker compose exec api node dist/cli/maintenance.js status
 */
const [cmd, ...rest] = process.argv.slice(2);
const prisma = createPrismaClient();
try {
  if (cmd === 'on' || cmd === 'off') {
    const message = rest.join(' ').trim() || null;
    await prisma.$transaction((tx) =>
      writeMaintenance(tx, cmd === 'on', message, null, {
        ip: null,
        requestId: null,
      }),
    );
  } else if (cmd !== 'status') {
    console.error('Usage: maintenance.js on [message] | off | status');
    process.exitCode = 2;
  }
  const m = await readMaintenance(prisma);
  console.log(
    m.enabled
      ? `Maintenance mode is ON${m.message ? `: ${m.message}` : ''} (since ${m.since})`
      : 'Maintenance mode is OFF',
  );
} finally {
  await prisma.$disconnect();
}

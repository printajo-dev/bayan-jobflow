import 'dotenv/config';
import { config } from './config/config.js';
import { createPrismaClient } from './core/prisma.service.js';
import { OutboxRelay } from './outbox/outbox.relay.js';

/**
 * Background worker: relays outbox events to their handlers. Handlers for
 * notifications, realtime and automation are registered here as later phases
 * add them. Stops cleanly on SIGTERM/SIGINT (Docker stop).
 */
const cfg = config();
const prisma = createPrismaClient();
const log = (msg: string) => console.log(JSON.stringify({ level: 'log', context: 'Worker', msg, time: new Date().toISOString() }));
const relay = new OutboxRelay(prisma, {
  maxAttempts: cfg.OUTBOX_MAX_ATTEMPTS,
  logger: { log, error: (msg: string) => console.error(JSON.stringify({ level: 'error', context: 'Worker', msg })) },
});

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

log('Outbox worker started');
let lastStuckCheck = 0;
while (!stopping) {
  try {
    if (Date.now() - lastStuckCheck > 60_000) {
      await relay.releaseStuck();
      lastStuckCheck = Date.now();
    }
    const n = await relay.runOnce();
    if (n === 0) await new Promise((r) => setTimeout(r, cfg.OUTBOX_POLL_MS));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', context: 'Worker', msg: String(err) }));
    await new Promise((r) => setTimeout(r, cfg.OUTBOX_POLL_MS * 5));
  }
}
await prisma.$disconnect();
log('Outbox worker stopped');

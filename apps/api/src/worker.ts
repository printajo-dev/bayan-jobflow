import 'dotenv/config';
import { Emitter } from '@socket.io/redis-emitter';
import { createClient } from 'redis';
import { config } from './config/config.js';
import { createPrismaClient } from './core/prisma.service.js';
import { OutboxRelay } from './outbox/outbox.relay.js';
import { Notifier, type Push } from './notifications/notifier.js';

/**
 * Background worker:
 * - relays outbox events to consumers (notifications today; automation later),
 * - sends due-soon / overdue task reminders every 15 minutes,
 * - pushes live notifications through Redis when it is available.
 * PostgreSQL is the queue (FOR UPDATE SKIP LOCKED, retries, dead letters), so
 * nothing is lost while Redis is down. Stops cleanly on SIGTERM/SIGINT.
 */
const cfg = config();
const prisma = createPrismaClient();
const log = (level: 'log' | 'error' | 'warn', msg: string) =>
  (level === 'error' ? console.error : console.log)(JSON.stringify({ level, context: 'Worker', msg, time: new Date().toISOString() }));

let push: Push | null = null;
const redisUrl = process.env['REDIS_URL'];
if (redisUrl) {
  try {
    const client = createClient({ url: redisUrl, socket: { reconnectStrategy: (n) => Math.min(n * 500, 10_000) } });
    client.on('error', (e) => log('warn', `Redis: ${e.message}`));
    await client.connect();
    const emitter = new Emitter(client);
    push = { toUser: (userId, event, payload) => void emitter.to(`user:${userId}`).emit(event, payload) };
  } catch (e) {
    log('warn', `Live notifications disabled (Redis unavailable): ${(e as Error).message}`);
  }
}

const notifier = new Notifier(prisma, push);
const relay = new OutboxRelay(prisma, { maxAttempts: cfg.OUTBOX_MAX_ATTEMPTS, logger: { log: (m: string) => log('log', m), error: (m: string) => log('error', m) } });
for (const type of Notifier.EVENTS) relay.on(type, (e) => notifier.handle(e));

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

log('log', 'Worker started');
let lastStuckCheck = 0;
let lastReminder = 0;
while (!stopping) {
  try {
    if (Date.now() - lastStuckCheck > 60_000) {
      await relay.releaseStuck();
      lastStuckCheck = Date.now();
    }
    if (Date.now() - lastReminder > 15 * 60_000) {
      const n = await notifier.taskReminders();
      if (n) log('log', `Task reminders checked (${n} due or overdue)`);
      lastReminder = Date.now();
    }
    const n = await relay.runOnce();
    if (n === 0) await new Promise((r) => setTimeout(r, cfg.OUTBOX_POLL_MS));
  } catch (err) {
    log('error', String(err));
    await new Promise((r) => setTimeout(r, cfg.OUTBOX_POLL_MS * 5));
  }
}
await prisma.$disconnect();
log('log', 'Worker stopped');

import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '../src/core/prisma.service.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { E2E_DATABASE_URL } from './env.js';

describe('Transactional outbox', () => {
  const prisma = createPrismaClient(E2E_DATABASE_URL);
  const outbox = new OutboxService();

  beforeEach(async () => {
    await prisma.outboxEvent.updateMany({ where: { status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'PROCESSED' } });
  });
  afterAll(async () => prisma.$disconnect());

  it('does not enqueue the same logical event twice', async () => {
    const aggregateId = randomUUID();
    const msg = { type: 'test.event', aggregateType: 'test', aggregateId, payload: {}, idempotencyKey: `test:${aggregateId}` };
    await prisma.$transaction((tx) => outbox.enqueue(tx, msg));
    await prisma.$transaction((tx) => outbox.enqueue(tx, msg));
    expect(await prisma.outboxEvent.count({ where: { aggregateId } })).toBe(1);
  });

  it('rolls the event back with the business transaction', async () => {
    const aggregateId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, { type: 'test.event', aggregateType: 'test', aggregateId, payload: {}, idempotencyKey: `rb:${aggregateId}` });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await prisma.outboxEvent.count({ where: { aggregateId } })).toBe(0);
  });

  it('delivers events to handlers and marks them processed', async () => {
    const aggregateId = randomUUID();
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, { type: 'test.deliver', aggregateType: 'test', aggregateId, payload: { n: 1 }, idempotencyKey: `d:${aggregateId}` }),
    );
    const seen: unknown[] = [];
    const relay = new OutboxRelay(prisma, { maxAttempts: 3 }).on('test.deliver', async (e) => {
      seen.push(e.payload);
    });
    await relay.runOnce();
    expect(seen).toEqual([{ n: 1 }]);
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId } });
    expect(row.status).toBe('PROCESSED');
    // Nothing left to deliver: running again does not repeat the side effect.
    await relay.runOnce();
    expect(seen).toHaveLength(1);
  });

  it('retries failures with backoff and dead-letters after the maximum attempts', async () => {
    const aggregateId = randomUUID();
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, { type: 'test.fail', aggregateType: 'test', aggregateId, payload: {}, idempotencyKey: `f:${aggregateId}` }),
    );
    const relay = new OutboxRelay(prisma, { maxAttempts: 2 }).on('test.fail', async () => {
      throw new Error('handler down');
    });
    await relay.runOnce();
    let row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'handler down' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.outboxEvent.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    await relay.runOnce();
    row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId } });
    expect(row).toMatchObject({ status: 'DEAD', attempts: 2 });
  });
});

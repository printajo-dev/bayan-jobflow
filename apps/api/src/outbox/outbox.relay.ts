import type { PrismaClient } from '../generated/prisma/client.js';

export interface OutboxEventRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

export type OutboxHandler = (event: OutboxEventRow) => Promise<void>;

export interface RelayOptions {
  batchSize?: number;
  maxAttempts: number;
  logger?: Pick<Console, 'log' | 'error'>;
}

/** Exponential backoff: 2s, 4s, 8s … capped at 10 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 10 * 60 * 1000);
}

/**
 * Claims a batch of due events with FOR UPDATE SKIP LOCKED (safe with several
 * workers), runs the handlers registered for each type, and marks the event
 * PROCESSED, FAILED (retry later) or DEAD (needs an administrator).
 *
 * Handlers must be idempotent: an event can be delivered more than once if the
 * worker stops between running a handler and marking the event processed.
 */
export class OutboxRelay {
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: RelayOptions,
  ) {}

  on(type: string, handler: OutboxHandler): this {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    return this;
  }

  /** Processes one batch; returns how many events were claimed. */
  async runOnce(): Promise<number> {
    const batchSize = this.options.batchSize ?? 20;
    const claimed = await this.prisma.$queryRaw<OutboxEventRow[]>`
      UPDATE workflow_outbox_events SET status = 'PROCESSING', attempts = attempts + 1, next_attempt_at = now()
      WHERE id IN (
        SELECT id FROM workflow_outbox_events
        WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, aggregate_type, aggregate_id, payload, attempts`;

    for (const event of claimed) {
      try {
        for (const handler of this.handlers.get(event.type) ?? []) await handler(event);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
        });
      } catch (err) {
        const dead = event.attempts >= this.options.maxAttempts;
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: dead ? 'DEAD' : 'FAILED',
            lastError: message.slice(0, 2000),
            nextAttemptAt: new Date(Date.now() + backoffMs(event.attempts)),
          },
        });
        this.options.logger?.error(`Outbox event ${event.id} (${event.type}) failed: ${message}`);
      }
    }
    return claimed.length;
  }

  /**
   * Events left in PROCESSING by a worker that crashed are returned to the
   * queue after the given age.
   */
  async releaseStuck(olderThanMs = 5 * 60 * 1000): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE workflow_outbox_events SET status = 'FAILED', next_attempt_at = now()
      WHERE status = 'PROCESSING'
        AND next_attempt_at < now() - make_interval(secs => ${olderThanMs / 1000})`;
  }
}

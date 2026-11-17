import { Injectable } from '@nestjs/common';
import type { Tx } from '../core/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface OutboxMessage {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /**
   * Stable key for this logical event. Writing the same key twice is a no-op,
   * so retried requests cannot enqueue duplicate side effects.
   */
  idempotencyKey: string;
}

/** Writes events inside the caller's transaction (transactional outbox). */
@Injectable()
export class OutboxService {
  async enqueue(tx: Tx, message: OutboxMessage): Promise<void> {
    await tx.outboxEvent.upsert({
      where: { idempotencyKey: message.idempotencyKey },
      create: {
        type: message.type,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        payload: message.payload as Prisma.InputJsonValue,
        idempotencyKey: message.idempotencyKey,
      },
      update: {},
    });
  }
}

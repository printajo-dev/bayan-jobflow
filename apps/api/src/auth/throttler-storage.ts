import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { createClient } from 'redis';

/**
 * Sign-in rate limits shared by every API instance (counters in Redis), so
 * running several instances does not multiply the allowance. Without Redis
 * (tests, development) the counters are kept in memory. If Redis is briefly
 * unavailable the request is allowed: the per-account lockout in PostgreSQL
 * still applies.
 */
export class SharedThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly logger = new Logger('Throttler');
  private readonly memory = new ThrottlerStorageService();
  private readonly redis: ReturnType<typeof createClient> | null;

  constructor(url = process.env['REDIS_URL']) {
    this.redis = url
      ? createClient({
          url,
          socket: { reconnectStrategy: (n) => Math.min(n * 500, 10_000) },
        })
      : null;
    this.redis?.on('error', (e: Error) =>
      this.logger.warn(`Redis: ${e.message}`),
    );
    this.redis
      ?.connect()
      .catch((e: Error) =>
        this.logger.warn(
          `Redis unavailable, using local counters: ${e.message}`,
        ),
      );
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.redis?.isReady)
      return this.memory.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    try {
      const hitsKey = `throttle:${throttlerName}:${key}`;
      const blockKey = `${hitsKey}:blocked`;
      const blockedFor = await this.redis.pTTL(blockKey);
      if (blockedFor > 0)
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockedFor / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockedFor / 1000),
        };
      const [hits, , pttl] = (await this.redis
        .multi()
        .incr(hitsKey)
        .pExpire(hitsKey, ttl, 'NX')
        .pTTL(hitsKey)
        .exec()) as unknown as [number, unknown, number];
      if (hits > limit) {
        await this.redis.set(blockKey, '1', {
          PX: blockDuration > 0 ? blockDuration : ttl,
        });
        return {
          totalHits: hits,
          timeToExpire: Math.ceil(pttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(
            (blockDuration > 0 ? blockDuration : ttl) / 1000,
          ),
        };
      }
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (e) {
      this.logger.warn(
        `Rate limit check failed, allowing request: ${(e as Error).message}`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis?.isOpen) await this.redis.quit().catch(() => undefined);
    this.memory.onApplicationShutdown?.();
  }
}

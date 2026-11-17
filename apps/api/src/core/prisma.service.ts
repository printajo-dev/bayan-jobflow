import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config/config.js';

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/** Worker and CLI tools: a small pool is plenty. */
export function createPrismaClient(url = config().DATABASE_URL, max = 5): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    // Per API instance; PostgreSQL allows 100 connections in total.
    super({ adapter: new PrismaPg({ connectionString: config().DATABASE_URL, max: config().DB_POOL_MAX }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}

import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../access/decorators.js';
import { PrismaService } from '../core/prisma.service.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. */
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the database answers. Used by Docker health checks. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
  }
}

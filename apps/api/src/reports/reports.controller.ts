import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { reportQuerySchema } from '@jobflow/shared';
import { CurrentPrincipal, RequirePermissions } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ReportsService } from './reports.service.js';

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@CurrentPrincipal() p: Principal) {
    return this.reports.dashboard(p);
  }

  @Get('reports')
  @RequirePermissions('report.view')
  list(@CurrentPrincipal() p: Principal) {
    return this.reports.list(p);
  }

  @Get('reports/:key')
  @RequirePermissions('report.view')
  async run(
    @Param('key', { schema: z.string().regex(/^[a-z-]{1,40}$/) }) key: string,
    @Query({ schema: reportQuerySchema }) q: z.output<typeof reportQuerySchema>,
    @CurrentPrincipal() p: Principal,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (q.format !== 'json' && !p.has('report.export'))
      throw new ForbiddenException('You cannot export reports');
    const r = await this.reports.run(key, q, p);
    if (q.format === 'json') return r;
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const name = `${r.key}_${r.from}_${r.to}`;
    if (q.format === 'csv') {
      return new StreamableFile(Buffer.from(this.reports.toCsv(r), 'utf8'), {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="${name}.csv"`,
      });
    }
    return new StreamableFile(await this.reports.toXlsx(r), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${name}.xlsx"`,
    });
  }
}

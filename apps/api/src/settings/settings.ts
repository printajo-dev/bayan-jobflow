import { Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { jobNumberSettingsSchema, type JobNumberSettings } from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { type ActionMeta, Meta, RequirePermissions } from '../access/decorators.js';

const JOB_NUMBER_KEY = 'jobNumber';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async jobNumber(db: Tx = this.prisma): Promise<JobNumberSettings> {
    const row = await db.systemSetting.findUnique({ where: { key: JOB_NUMBER_KEY } });
    const parsed = jobNumberSettingsSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : { pattern: null, example: null };
  }

  /** Throws a readable message when the number does not match the configured format. */
  async checkJobNumberFormat(jobNumber: string, db: Tx = this.prisma): Promise<string | null> {
    const s = await this.jobNumber(db);
    if (!s.pattern) return null;
    return new RegExp(`^(?:${s.pattern})$`).test(jobNumber)
      ? null
      : `Job Number does not match the ERP invoice format${s.example ? ` (example: ${s.example})` : ''}`;
  }

  setJobNumber(input: JobNumberSettings, meta: ActionMeta): Promise<JobNumberSettings> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.jobNumber(tx);
      const value = { pattern: input.pattern || null, example: input.example ?? null };
      await tx.systemSetting.upsert({
        where: { key: JOB_NUMBER_KEY },
        create: { key: JOB_NUMBER_KEY, value, updatedById: meta.actorId },
        update: { value, updatedById: meta.actorId },
      });
      await this.audit.record(tx, meta, {
        action: 'settings.job_number_changed',
        entityType: 'settings',
        summary: value.pattern ? `Job Number format set to ${value.pattern}` : 'Job Number format check turned off',
        before,
        after: value,
      });
      return value;
    });
  }
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Any signed-in user: the job form shows the expected format. */
  @Get('job-number')
  get() {
    return this.settings.jobNumber();
  }

  @Put('job-number')
  @RequirePermissions('settings.manage')
  set(@Body({ schema: jobNumberSettingsSchema }) body: JobNumberSettings, @Meta() meta: ActionMeta) {
    return this.settings.setJobNumber(body, meta);
  }
}

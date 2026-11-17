import { Injectable } from '@nestjs/common';
import { briefSchemas, GATES, type GateKey, type GateResultDto, type ServiceTypeCode } from '@jobflow/shared';
import type { Tx } from '../core/prisma.service.js';

export interface GateContext {
  tx: Tx;
  jobId: string;
  serviceTypeCode: ServiceTypeCode;
  stageId: string;
}

type Evaluator = (ctx: GateContext) => Promise<{ passed: boolean; detail?: string }>;

/** Lists brief problems for the brief.complete gate and the job page. */
export function briefProblems(code: ServiceTypeCode, brief: unknown): string[] {
  const result = briefSchemas(code).complete.safeParse(brief);
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

/**
 * Registry of gate evaluators keyed by gate key. Templates refer to gates by
 * key; the engine runs every gate of a stage (plus its required checklist)
 * before the stage may complete. Modules added in later phases register their
 * evaluators here.
 */
@Injectable()
export class GateRegistry {
  private readonly evaluators = new Map<GateKey, Evaluator>([
    [
      'brief.complete',
      async ({ tx, jobId, serviceTypeCode }) => {
        const brief = await tx.jobBrief.findUnique({ where: { jobId } });
        const problems = briefProblems(serviceTypeCode, brief ? briefToInput(brief) : {});
        return problems.length ? { passed: false, detail: problems.join('; ') } : { passed: true };
      },
    ],
    [
      'brief.attachments',
      async ({ tx, jobId }) => {
        const n = await tx.jobFile.count({ where: { jobId, purpose: 'BRIEF', removedAt: null, file: { deletedAt: null } } });
        return n > 0 ? { passed: true } : { passed: false, detail: 'Attach at least one drawing or specification' };
      },
    ],
    [
      'tasks.complete',
      async ({ tx, stageId }) => {
        const open = await tx.task.findMany({ where: { stageId, required: true, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, select: { title: true } });
        return open.length ? { passed: false, detail: `Open tasks: ${open.map((t) => t.title).join(', ')}` } : { passed: true };
      },
    ],
    [
      'corrections.closed',
      async ({ tx, jobId, stageId }) => {
        const stage = await tx.departmentStage.findUniqueOrThrow({ where: { id: stageId } });
        const open = await tx.correctionItem.findMany({
          where: { jobId, departmentId: stage.departmentId, blocking: true, status: { not: 'RESOLVED' } },
          select: { title: true },
        });
        return open.length ? { passed: false, detail: `Open corrections: ${open.map((c) => c.title).join(', ')}` } : { passed: true };
      },
    ],
    [
      'design.customer_approval',
      async ({ tx, jobId }) => {
        const latest = await tx.artworkVersion.findFirst({ where: { jobId }, orderBy: { versionNo: 'desc' }, include: { _count: { select: { approvals: true } } } });
        if (!latest) return { passed: false, detail: 'No artwork version uploaded yet' };
        return latest._count.approvals > 0 ? { passed: true } : { passed: false, detail: `Artwork version ${latest.versionNo} has no recorded customer approval` };
      },
    ],
  ]);

  async evaluate(gateKeys: string[], ctx: GateContext): Promise<GateResultDto[]> {
    const results: GateResultDto[] = [];
    for (const key of gateKeys) {
      const meta = GATES.find((g) => g.key === key);
      const evaluator = this.evaluators.get(key as GateKey);
      if (!meta || !evaluator) {
        results.push({ key: key as GateKey, label: meta?.label ?? key, passed: false, detail: 'This check is not available yet' });
        continue;
      }
      const r = await evaluator(ctx);
      results.push({ key: meta.key, label: meta.label, ...r });
    }
    return results;
  }
}

/** Converts a job_briefs row to the shape of the brief schemas. */
export function briefToInput(b: {
  scope: string | null;
  requirements: string | null;
  notes: string | null;
  targetDate: Date | null;
  details: unknown;
}): Record<string, unknown> {
  return {
    scope: b.scope,
    requirements: b.requirements,
    notes: b.notes,
    targetDate: b.targetDate ? b.targetDate.toISOString().slice(0, 10) : null,
    details: b.details ?? {},
  };
}

import type { Tx } from '../core/prisma.service.js';

/** Creates the department channels of a job plus its General channel (idempotent). */
export async function ensureChannels(tx: Tx, jobId: string, departmentIds: string[]): Promise<void> {
  for (const departmentId of new Set(departmentIds)) {
    const exists = await tx.discussionChannel.findFirst({ where: { jobId, departmentId } });
    if (!exists) await tx.discussionChannel.create({ data: { jobId, type: 'DEPARTMENT', departmentId } });
  }
  const general = await tx.discussionChannel.findFirst({ where: { jobId, type: 'GENERAL' } });
  if (!general) await tx.discussionChannel.create({ data: { jobId, type: 'GENERAL' } });
}

/**
 * Posts an automatic message (stage changes, approvals, corrections, QC
 * results…) to the department's channel, or to General if it has none.
 * Returns the channel id so callers can push a live update after commit.
 */
export async function postSystemMessage(tx: Tx, jobId: string, departmentId: string | null, body: string, stageId?: string | null): Promise<string | null> {
  const ch =
    (departmentId ? await tx.discussionChannel.findFirst({ where: { jobId, departmentId } }) : null) ??
    (await tx.discussionChannel.findFirst({ where: { jobId, type: 'GENERAL' } }));
  if (!ch) return null;
  await tx.discussionMessage.create({ data: { channelId: ch.id, jobId, kind: 'SYSTEM', body: body.slice(0, 10000), stageId: stageId ?? null } });
  return ch.id;
}

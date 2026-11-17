import type { GateKey, PermissionKey } from '@jobflow/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface StageDef {
  key: string;
  name: string;
  description: string | null;
  departmentId: string;
  gateKeys: string[];
  checklist: { label: string; required: boolean }[];
}

export interface TemplateDef {
  stages: StageDef[];
  returnRules: { fromKey: string; toKey: string }[];
}

type Upgrade =
  | { id: string; kind: 'grants'; role: string; add: PermissionKey[] }
  | { id: string; kind: 'template'; template: string; fromVersionNo: number; notes: string; transform: (def: TemplateDef, depts: Map<string, string>) => TemplateDef };

const addGates = (s: StageDef, gates: GateKey[]) => ({ ...s, gateKeys: [...new Set([...s.gateKeys, ...gates])] });
const dropChecklist = (s: StageDef, labels: string[]) => ({ ...s, checklist: s.checklist.filter((c) => !labels.includes(c.label)) });

/** Phase 3: tasks, corrections and the customer-approval check replace interim checklist ticks. */
function phase3(def: TemplateDef): TemplateDef {
  return {
    ...def,
    stages: def.stages.map((s) => {
      let out = addGates(s, ['tasks.complete', 'corrections.closed']);
      if (s.key === 'design') {
        out = addGates(out, ['design.customer_approval']);
        out = dropChecklist(out, [
          'Final artwork version uploaded',
          'Customer approval recorded against the exact artwork version',
          'Artwork / technical drawings finalised',
          'Required approval evidence recorded',
        ]);
      }
      return out;
    }),
  };
}

/**
 * Changes that later releases make to seeded data. Each runs once (tracked in
 * system_settings). Template upgrades publish a new version only when the
 * published version is still the one the upgrade was written for; if an
 * administrator has already changed the template, the upgrade is skipped and
 * logged so they can apply it by hand. Running jobs keep their version.
 */
export const UPGRADES: Upgrade[] = [
  { id: '2026-11-p3-admin-discussions', kind: 'grants', role: 'system_admin', add: ['channel.add_participant', 'message.pin', 'message.moderate'] },
  {
    id: '2026-11-p3-vb-template',
    kind: 'template',
    template: 'VB',
    fromVersionNo: 1,
    notes: 'Phase 3: tasks, blocking corrections and recorded customer approval are now checked automatically.',
    transform: (d) => phase3(d),
  },
  {
    id: '2026-11-p3-sg-template',
    kind: 'template',
    template: 'SG',
    fromVersionNo: 1,
    notes: 'Phase 3: tasks, blocking corrections and recorded customer approval are now checked automatically.',
    transform: (d) => phase3(d),
  },
];

const KEY = 'seed.upgrades';

export async function applyUpgrades(prisma: PrismaClient, upgrades: Upgrade[] = UPGRADES, log: (m: string) => void = () => {}): Promise<void> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const state = (row?.value as { applied?: string[]; skipped?: string[] } | null) ?? {};
  const applied = new Set(state.applied ?? []);
  const skipped = new Set(state.skipped ?? []);
  const departments = new Map((await prisma.department.findMany()).map((d) => [d.code, d.id]));

  for (const u of upgrades) {
    if (applied.has(u.id) || skipped.has(u.id)) continue;
    if (u.kind === 'grants') {
      const role = await prisma.role.findUnique({ where: { key: u.role } });
      if (role) {
        const perms = await prisma.permission.findMany({ where: { key: { in: u.add } } });
        await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })), skipDuplicates: true });
      }
      applied.add(u.id);
      log(`Upgrade ${u.id}: granted ${u.add.join(', ')} to ${u.role}`);
      continue;
    }
    const template = await prisma.workflowTemplate.findUnique({ where: { code: u.template } });
    const published = template ? await prisma.workflowTemplateVersion.findFirst({ where: { templateId: template.id, status: 'PUBLISHED' } }) : null;
    const draft = template ? await prisma.workflowTemplateVersion.findFirst({ where: { templateId: template.id, status: 'DRAFT' } }) : null;
    if (!template || !published || published.versionNo !== u.fromVersionNo || draft) {
      skipped.add(u.id);
      log(`Upgrade ${u.id}: skipped (template ${u.template} was changed by an administrator; apply by hand if wanted)`);
      continue;
    }
    const def = await loadDefinition(prisma, published.id);
    await publishDefinition(prisma, template.id, u.transform(def, departments), u.notes);
    applied.add(u.id);
    log(`Upgrade ${u.id}: published a new version of ${template.name}`);
  }
  const value = { applied: [...applied], skipped: [...skipped] } as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export async function loadDefinition(prisma: PrismaClient, versionId: string): Promise<TemplateDef> {
  const v = await prisma.workflowTemplateVersion.findUniqueOrThrow({
    where: { id: versionId },
    include: {
      stages: { orderBy: { sequence: 'asc' }, include: { checklist: { orderBy: { sequence: 'asc' } } } },
      transitions: { include: { fromStage: true, toStage: true } },
    },
  });
  return {
    stages: v.stages.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      departmentId: s.departmentId,
      gateKeys: s.gateKeys,
      checklist: s.checklist.map((c) => ({ label: c.label, required: c.required })),
    })),
    returnRules: v.transitions.map((t) => ({ fromKey: t.fromStage.key, toKey: t.toStage.key })),
  };
}

async function publishDefinition(prisma: PrismaClient, templateId: string, def: TemplateDef, notes: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const last = await tx.workflowTemplateVersion.findFirst({ where: { templateId }, orderBy: { versionNo: 'desc' } });
    const version = await tx.workflowTemplateVersion.create({ data: { templateId, versionNo: (last?.versionNo ?? 0) + 1, notes } });
    const ids = new Map<string, string>();
    for (const [i, s] of def.stages.entries()) {
      const stage = await tx.workflowTemplateStage.create({
        data: {
          versionId: version.id,
          sequence: i + 1,
          key: s.key,
          name: s.name,
          description: s.description,
          departmentId: s.departmentId,
          gateKeys: s.gateKeys,
          checklist: { create: s.checklist.map((c, j) => ({ sequence: j + 1, label: c.label, required: c.required })) },
        },
      });
      ids.set(s.key, stage.id);
    }
    for (const r of def.returnRules) {
      if (ids.has(r.fromKey) && ids.has(r.toKey)) {
        await tx.workflowTemplateTransition.create({ data: { versionId: version.id, fromStageId: ids.get(r.fromKey)!, toStageId: ids.get(r.toKey)! } });
      }
    }
    await tx.workflowTemplateVersion.updateMany({ where: { templateId, status: 'PUBLISHED' }, data: { status: 'RETIRED' } });
    await tx.workflowTemplateVersion.update({ where: { id: version.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  });
}

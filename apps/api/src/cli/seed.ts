import 'dotenv/config';
import { PERMISSIONS, SEED_DEPARTMENTS } from '@jobflow/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../core/prisma.service.js';
import { hashPassword } from '../auth/password.js';
import { SEED_ROLES } from './seed-data.js';
import { seedWorkflows } from './seed-workflows.js';
import { applyUpgrades } from './seed-upgrades.js';

/**
 * Reference data. Safe to run on every deploy:
 * - permissions are upserted (descriptions refreshed);
 * - departments and roles are only created when missing, so names and grants
 *   an administrator changed are never overwritten.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, area: p.area, description: p.description },
      update: { area: p.area, description: p.description },
    });
  }

  for (const d of SEED_DEPARTMENTS) {
    await prisma.department.upsert({ where: { code: d.code }, create: { ...d }, update: {} });
  }

  const departments = new Map((await prisma.department.findMany()).map((d) => [d.code, d.id]));
  const permissions = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));

  for (const r of SEED_ROLES) {
    if (await prisma.role.findUnique({ where: { key: r.key } })) continue;
    await prisma.role.create({
      data: {
        key: r.key,
        name: r.name,
        description: r.description,
        scope: r.scope,
        isSystem: true,
        permissions: { create: [...new Set(r.permissions)].map((k) => ({ permissionId: permissions.get(k)! })) },
        departmentScopes: r.department ? { create: [{ departmentId: departments.get(r.department)! }] } : undefined,
      },
    });
  }

  for (const t of [
    { code: 'RTA', name: 'RTA (Roads and Transport Authority)', description: 'Vehicle advertising permits' },
    { code: 'DM', name: 'Dubai Municipality', description: 'Outdoor signage permits' },
    { code: 'TRAKHEES', name: 'Trakhees', description: 'Permits within Trakhees jurisdiction' },
    { code: 'CIVIL_DEFENCE', name: 'Civil Defence', description: 'Safety approvals for illuminated signage' },
  ]) {
    await prisma.authorityType.upsert({ where: { code: t.code }, create: t, update: {} });
  }

  await seedWorkflows(prisma);
  await seedQcChecklists(prisma);
  await applyUpgrades(prisma, undefined, (m) => console.log(m));
}

const QC_CHECKLISTS: Record<'VB' | 'SG', { name: string; items: { label: string; evidence?: boolean }[] }> = {
  VB: {
    name: 'Vehicle branding QC',
    items: [
      { label: 'Graphics match the approved artwork version' },
      { label: 'No bubbles, wrinkles or lifting' },
      { label: 'Edges, seams and cut-outs trimmed and sealed' },
      { label: 'Colours match the approved proof' },
      { label: 'Vehicle clean and undamaged' },
      { label: 'Completion photos of every side', evidence: true },
    ],
  },
  SG: {
    name: 'Signage QC',
    items: [
      { label: 'Dimensions and position match the drawings' },
      { label: 'Fixings secure and level' },
      { label: 'Electrical / LED working and safe' },
      { label: 'Finish free of scratches and defects' },
      { label: 'Site left clean' },
      { label: 'Completion photos', evidence: true },
    ],
  },
};

/** Creates the first QC checklist per service type when none exists. */
async function seedQcChecklists(prisma: PrismaClient): Promise<void> {
  for (const code of ['VB', 'SG'] as const) {
    const st = await prisma.serviceType.findUnique({ where: { code } });
    if (!st || (await prisma.qcChecklistTemplate.count({ where: { serviceTypeId: st.id } }))) continue;
    const def = QC_CHECKLISTS[code];
    await prisma.qcChecklistTemplate.create({
      data: {
        serviceTypeId: st.id,
        name: def.name,
        version: 1,
        items: { create: def.items.map((i, n) => ({ sequence: n + 1, label: i.label, required: true, requiresEvidence: !!i.evidence })) },
      },
    });
  }
}

export const DEMO_PASSWORD = 'Demo-Password-2026';

/**
 * Fictional users (all named demo.*) for demos and acceptance tests. Do not
 * run on the production server; the install guide only runs plain `seed`.
 */
export async function seedDemoUsers(prisma: PrismaClient): Promise<void> {
  const roles = new Map((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  const departments = new Map((await prisma.department.findMany()).map((d) => [d.code, d.id]));
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const demo: { username: string; fullName: string; role: string; dept: string; leader: boolean }[] = [
    { username: 'demo.management', fullName: 'Mona Manager', role: 'management', dept: 'MANAGEMENT', leader: false },
  ];
  for (const code of ['SALES', 'DESIGN', 'PRO', 'LOGISTIC', 'PRODUCTION', 'INSTALLATION', 'QUALITY']) {
    const lower = code.toLowerCase();
    demo.push({ username: `demo.${lower}.lead`, fullName: `${code[0]}${lower.slice(1)} Leader`, role: `${lower}_leader`, dept: code, leader: true });
    demo.push({ username: `demo.${lower}`, fullName: `${code[0]}${lower.slice(1)} Employee`, role: `${lower}_member`, dept: code, leader: false });
  }

  for (const u of demo) {
    if (await prisma.user.findUnique({ where: { username: u.username } })) continue;
    await prisma.user.create({
      data: {
        username: u.username,
        fullName: u.fullName,
        passwordHash,
        roles: { create: [{ roleId: roles.get(u.role)! }] },
        departments: { create: [{ departmentId: departments.get(u.dept)!, isLeader: u.leader }] },
      },
    });
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const prisma = createPrismaClient();
  try {
    await seedReferenceData(prisma);
    console.log('Reference data seeded (permissions, departments, roles, service types, workflow templates).');
    if (process.argv.includes('--demo')) {
      await seedDemoUsers(prisma);
      console.log(`Demo users seeded. Password for all demo users: ${DEMO_PASSWORD}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

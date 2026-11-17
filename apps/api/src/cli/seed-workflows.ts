import type { GateKey, SeedDepartmentCode } from '@jobflow/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

interface SeedStage {
  key: string;
  name: string;
  department: SeedDepartmentCode;
  description: string;
  gateKeys: GateKey[];
  checklist: string[];
}

interface SeedTemplate {
  code: string;
  name: string;
  serviceType: { code: 'VB' | 'SG'; name: string };
  notes: string;
  stages: SeedStage[];
  returnRules: [string, string][];
}

/**
 * Version 1 of the two confirmed workflows (spec section 6). Gates whose
 * modules arrive in later phases (artwork approval, authority approvals,
 * schedules, production, QC, delivery) are represented by required checklist
 * items until then; each later phase publishes a new version that adds the
 * data-driven gate. Jobs keep the version they started with.
 */
export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    code: 'VB',
    name: 'Vehicle Branding',
    serviceType: { code: 'VB', name: 'Vehicle Branding' },
    notes: 'Confirmed workflow v1. Department evidence is confirmed with checklists until the design, PRO, logistics, production, QC and delivery modules are released.',
    stages: [
      { key: 'job_brief', name: 'Job Brief', department: 'SALES', description: 'Job Number and complete operational brief. No customer information required.', gateKeys: ['brief.complete'], checklist: [] },
      {
        key: 'design',
        name: 'Design',
        department: 'DESIGN',
        description: 'Artwork versions, corrections and recorded customer approval against the exact artwork version.',
        gateKeys: [],
        checklist: ['Final artwork version uploaded', 'Customer approval recorded against the exact artwork version'],
      },
      {
        key: 'government_approval',
        name: 'Government Approval',
        department: 'PRO',
        description: 'Required authority applications (including RTA) approved, or marked Not Required with a reason.',
        gateKeys: [],
        checklist: ['Every required authority approval is Approved or marked Not Required with a reason'],
      },
      {
        key: 'vehicle_schedule',
        name: 'Vehicle Schedule',
        department: 'LOGISTIC',
        description: 'Vehicle availability and schedule confirmed.',
        gateKeys: [],
        checklist: ['Vehicle availability confirmed', 'Schedule date and location confirmed'],
      },
      {
        key: 'print',
        name: 'Print',
        department: 'PRODUCTION',
        description: 'Approved artwork printed; production details and completion recorded.',
        gateKeys: [],
        checklist: ['Approved artwork version printed', 'Production details recorded (material, machine, quantity)'],
      },
      {
        key: 'wrap',
        name: 'Wrap',
        department: 'INSTALLATION',
        description: 'Vehicle branding installed; team and completion evidence recorded.',
        gateKeys: [],
        checklist: ['Vehicle branding installed', 'Installation team and completion photos recorded'],
      },
      {
        key: 'qc_inspection',
        name: 'QC Inspection',
        department: 'QUALITY',
        description: 'Inspection checklist passed. A failure returns the job to the responsible stage.',
        gateKeys: [],
        checklist: ['QC inspection checklist passed'],
      },
      {
        key: 'delivery',
        name: 'Delivery',
        department: 'LOGISTIC',
        description: 'Handover/delivery recorded; the job then closes.',
        gateKeys: [],
        checklist: ['Delivery and handover recorded with recipient and evidence'],
      },
    ],
    returnRules: [
      ['government_approval', 'design'],
      ['qc_inspection', 'design'],
      ['qc_inspection', 'print'],
      ['qc_inspection', 'wrap'],
    ],
  },
  {
    code: 'SG',
    name: 'Signage',
    serviceType: { code: 'SG', name: 'Signage' },
    notes: 'Confirmed workflow v1. No Logistic, PRO or Delivery stage; the job closes after QC passes.',
    stages: [
      {
        key: 'job_brief',
        name: 'Job Brief',
        department: 'SALES',
        description: 'Scope, drawings, dimensions, specifications, site details and attachments.',
        gateKeys: ['brief.complete', 'brief.attachments'],
        checklist: [],
      },
      {
        key: 'design',
        name: 'Design',
        department: 'DESIGN',
        description: 'Artwork/technical drawings, revisions and required approval evidence.',
        gateKeys: [],
        checklist: ['Artwork / technical drawings finalised', 'Required approval evidence recorded'],
      },
      {
        key: 'production',
        name: 'Production',
        department: 'PRODUCTION',
        description: 'Fabrication, printing, cutting and assembly records and completion evidence.',
        gateKeys: [],
        checklist: ['Fabrication / printing / assembly completed', 'Production completion evidence recorded'],
      },
      {
        key: 'installation',
        name: 'Installation',
        department: 'INSTALLATION',
        description: 'Installation schedule, assigned technicians and site completion evidence.',
        gateKeys: [],
        checklist: ['Installation completed on site', 'Site completion evidence recorded'],
      },
      {
        key: 'qc_inspection',
        name: 'QC Inspection',
        department: 'QUALITY',
        description: 'QC checklist passed; the job closes immediately after.',
        gateKeys: [],
        checklist: ['QC inspection checklist passed'],
      },
    ],
    returnRules: [
      ['qc_inspection', 'design'],
      ['qc_inspection', 'production'],
      ['qc_inspection', 'installation'],
    ],
  },
];

/** Creates service types and publishes template v1 where a template does not exist yet. */
export async function seedWorkflows(prisma: PrismaClient): Promise<void> {
  const departments = new Map((await prisma.department.findMany()).map((d) => [d.code, d.id]));
  for (const t of SEED_TEMPLATES) {
    const serviceType = await prisma.serviceType.upsert({
      where: { code: t.serviceType.code },
      create: t.serviceType,
      update: {},
    });
    if (await prisma.workflowTemplate.findUnique({ where: { code: t.code } })) continue;
    await prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.create({ data: { code: t.code, name: t.name, serviceTypeId: serviceType.id } });
      const version = await tx.workflowTemplateVersion.create({ data: { templateId: template.id, versionNo: 1, notes: t.notes } });
      const ids = new Map<string, string>();
      for (const [i, s] of t.stages.entries()) {
        const stage = await tx.workflowTemplateStage.create({
          data: {
            versionId: version.id,
            sequence: i + 1,
            key: s.key,
            name: s.name,
            description: s.description,
            departmentId: departments.get(s.department)!,
            gateKeys: s.gateKeys,
            checklist: { create: s.checklist.map((label, j) => ({ sequence: j + 1, label, required: true })) },
          },
        });
        ids.set(s.key, stage.id);
      }
      for (const [from, to] of t.returnRules) {
        await tx.workflowTemplateTransition.create({ data: { versionId: version.id, fromStageId: ids.get(from)!, toStageId: ids.get(to)! } });
      }
      await tx.workflowTemplateVersion.update({ where: { id: version.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
    });
  }
}

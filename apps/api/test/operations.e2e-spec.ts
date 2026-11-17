import type { INestApplication } from '@nestjs/common';
import type { AuthorityDto, OperationsDto, WorkflowDto } from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { Actors, COMPLETE_SG_BRIEF, COMPLETE_VB_BRIEF, PDF } from './workflow-helpers.js';

describe('Phase 4: PRO approvals, vehicle schedule, production, installation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;
  let rta: string;
  let dm: string;
  const ids = async (u: string) => (await prisma.user.findUniqueOrThrow({ where: { username: u } })).id;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: { username: 'admin.helper', fullName: 'Helper Admin', passwordHash: await hashPassword('Demo-Password-2026'), roles: { create: [{ roleId: role.id }] } },
      update: {},
    });
    as = new Actors(app);
    const types = (await as.get('demo.pro.lead', '/authority-types')).body as { id: string; code: string }[];
    rta = types.find((t) => t.code === 'RTA')!.id;
    dm = types.find((t) => t.code === 'DM')!.id;
  });
  afterAll(async () => app.close());

  /** A Vehicle Branding job advanced to Government Approval. */
  async function atGovernmentApproval(): Promise<{ jobId: string; wf: WorkflowDto }> {
    const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
    await as.completeCurrent(job.id);
    const wf = await as.completeCurrent(job.id);
    expect(as.current(wf).key).toBe('government_approval');
    return { jobId: job.id, wf };
  }

  describe('authority approvals (AT6, AT8)', () => {
    it('only PRO (and view roles) can see authority records; others are refused even through the API', async () => {
      const { jobId } = await atGovernmentApproval();
      expect((await as.get('demo.pro', `/jobs/${jobId}/authority`)).status).toBe(200);
      expect((await as.get('demo.management', `/jobs/${jobId}/authority`)).status).toBe(200);
      for (const u of ['demo.design.lead', 'demo.sales', 'demo.production.lead']) {
        expect((await as.get(u, `/jobs/${jobId}/authority`)).status).toBe(403);
        expect((await as.post(u, `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta })).status).toBe(403);
      }
      const created = (await as.post('demo.pro', `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta })).body as AuthorityDto;
      const appId = created.applications[0]!.id;
      expect((await as.patch('demo.design.lead', `/authority-applications/${appId}`, { status: 'SUBMITTED' })).status).toBe(403);
      expect((await as.patch('demo.management', `/authority-applications/${appId}`, { referenceNumber: 'X' })).status).toBe(403);
    });

    it('blocks Government Approval (and so Print and Wrap) until every required approval is granted, with evidence', async () => {
      const { jobId, wf } = await atGovernmentApproval();
      const gov = as.current(wf);
      let r = await as.post('demo.pro.lead', `/jobs/${jobId}/stages/${gov.id}/complete`);
      expect(r.status).toBe(422);
      expect(r.body.message.join(' ')).toMatch(/authority applications/);

      let auth = (await as.post('demo.pro', `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta, comments: 'Full wrap, 2 vans' })).body as AuthorityDto;
      const appId = auth.applications[0]!.id;
      expect((await as.post('demo.pro', `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta })).status).toBe(409);

      auth = (await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'SUBMITTED', referenceNumber: 'RTA-2026-7781', expectedResponseDate: '2030-02-01', fees: 450 })).body;
      expect(auth.applications[0]).toMatchObject({ status: 'SUBMITTED', referenceNumber: 'RTA-2026-7781', fees: 450 });
      expect(auth.applications[0]!.submissions).toHaveLength(1);
      expect((await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'REJECTED' })).status).toBe(400);
      auth = (await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'REJECTED', rejectionReason: 'Logo exceeds 30% of the door' })).body;
      expect(auth.applications[0]!.submissions[0]).toMatchObject({ outcome: 'REJECTED', outcomeNotes: 'Logo exceeds 30% of the door' });
      expect(await prisma.outboxEvent.count({ where: { aggregateId: jobId, type: 'authority.decision' } })).toBe(1);

      // Resubmission keeps the first submission and its rejection.
      auth = (await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'SUBMITTED', referenceNumber: 'RTA-2026-7781-B' })).body;
      expect(auth.applications[0]!.submissions.map((s) => [s.submissionNo, s.outcome])).toEqual([
        [1, 'REJECTED'],
        [2, 'PENDING'],
      ]);
      expect((await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'EXPIRED' })).status).toBe(409);
      expect((await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'APPROVED' })).status).toBe(400);

      const fileId = await as.upload('demo.pro', jobId, 'authority', 'rta-permit.pdf');
      await as.post('demo.pro', `/authority-applications/${appId}/documents`, { fileId, kind: 'APPROVAL' }).then((x) => expect(x.status).toBe(201));
      const receipt = await as.upload('demo.pro', jobId, 'authority', 'receipt.pdf');
      await as.post('demo.pro', `/authority-applications/${appId}/payments`, { amount: 450, paidAt: new Date().toISOString(), reference: 'EPAY-1', receiptFileId: receipt }).then((x) => expect(x.status).toBe(201));
      auth = (await as.patch('demo.pro', `/authority-applications/${appId}`, { status: 'APPROVED', validUntil: '2031-02-01' })).body;
      expect(auth.applications[0]).toMatchObject({ status: 'APPROVED', paymentStatus: 'PAID' });
      expect(auth.cleared).toBe(true);
      expect(auth.applications[0]!.history.map((h) => h.to)).toEqual(['PENDING_PREPARATION', 'SUBMITTED', 'REJECTED', 'SUBMITTED', 'APPROVED']);
      // PRO documents are visible to PRO, not to Design.
      expect((await as.get('demo.pro.lead', `/files/${fileId}/download`)).status).toBe(200);
      expect((await as.get('demo.design.lead', `/files/${fileId}/download`)).status).toBe(404);

      // A second required authority keeps the stage blocked until it is cleared too.
      await as.post('demo.pro', `/jobs/${jobId}/authority-applications`, { authorityTypeId: dm });
      expect((await as.post('demo.pro.lead', `/jobs/${jobId}/stages/${gov.id}/complete`)).status).toBe(422);
      const wfNow = await as.workflow(jobId);
      expect(wfNow.stages.find((s) => s.key === 'print')?.status).toBe('PENDING');
    });

    it('only the PRO Leader or an administrator can mark an approval Not Required, with a reason that is audited', async () => {
      const { jobId, wf } = await atGovernmentApproval();
      const auth = (await as.post('demo.pro', `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta })).body as AuthorityDto;
      const appId = auth.applications[0]!.id;
      expect((await as.post('demo.pro', `/authority-applications/${appId}/not-required`, { reason: 'Not needed' })).status).toBe(403);
      expect((await as.post('demo.pro.lead', `/authority-applications/${appId}/not-required`, { reason: '' })).status).toBe(400);
      const ok = await as.post('demo.pro.lead', `/authority-applications/${appId}/not-required`, { reason: 'Company-owned vehicles, no advertising permit needed' });
      expect(ok.body.applications[0]).toMatchObject({ status: 'NOT_REQUIRED', notRequiredReason: 'Company-owned vehicles, no advertising permit needed', notRequiredBy: 'Pro Leader' });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: jobId, action: 'authority.not_required' } });
      expect(audit.summary).toMatch(/Company-owned vehicles/);
      const done = await as.post('demo.pro.lead', `/jobs/${jobId}/stages/${as.current(wf).id}/complete`);
      expect(done.status).toBe(200);
      expect(as.current(done.body).key).toBe('vehicle_schedule');

      // An administrator can do the same on another job.
      const other = await atGovernmentApproval();
      const a2 = (await as.post('demo.pro', `/jobs/${other.jobId}/authority-applications`, { authorityTypeId: rta })).body as AuthorityDto;
      expect((await as.post('admin.helper', `/authority-applications/${a2.applications[0]!.id}/not-required`, { reason: 'Exempt fleet' })).status).toBe(200);
    });
  });

  describe('vehicle schedule (Logistic)', () => {
    it('requires a recorded confirmation of availability; rescheduling needs a reason and re-confirmation', async () => {
      const { jobId } = await atGovernmentApproval();
      let wf = await as.completeCurrent(jobId); // clears PRO via Not Required
      const stage = as.current(wf);
      expect(stage.key).toBe('vehicle_schedule');
      expect((await as.post('demo.design.lead', `/jobs/${jobId}/vehicle-schedules`, { vehicleRef: 'x', plannedStart: new Date().toISOString(), location: 'y' })).status).toBe(403);
      const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
      let ops = (await as.post('demo.logistic', `/jobs/${jobId}/vehicle-schedules`, { vehicleRef: 'Toyota Hiace D 12345', plannedStart: start, location: 'Bay 2' })).body as OperationsDto;
      const id = ops.schedules[0]!.id;
      expect(ops.schedules[0]!.status).toBe('PROPOSED');
      expect((await as.post('demo.logistic.lead', `/jobs/${jobId}/stages/${stage.id}/complete`)).status).toBe(422);
      expect((await as.patch('demo.logistic', `/vehicle-schedules/${id}`, { status: 'CONFIRMED' })).status).toBe(400);
      ops = (await as.patch('demo.logistic', `/vehicle-schedules/${id}`, { status: 'CONFIRMED', confirmationNote: 'Confirmed with fleet manager Khalid' })).body;
      expect(ops.schedules[0]).toMatchObject({ status: 'CONFIRMED', confirmedBy: 'Logistic Employee' });

      const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
      expect((await as.patch('demo.logistic', `/vehicle-schedules/${id}`, { plannedStart: later })).status).toBe(400);
      ops = (await as.patch('demo.logistic', `/vehicle-schedules/${id}`, { plannedStart: later, reason: 'Vehicle in service' })).body;
      expect(ops.schedules[0]!.status).toBe('RESCHEDULED');
      expect((await as.post('demo.logistic.lead', `/jobs/${jobId}/stages/${stage.id}/complete`)).status).toBe(422);
      ops = (await as.patch('demo.logistic', `/vehicle-schedules/${id}`, { status: 'CONFIRMED', confirmationNote: 'Re-confirmed' })).body;
      expect(ops.schedules[0]!.history.map((h) => h.action)).toEqual(['proposed', 'confirmed', 'rescheduled', 'confirmed']);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: jobId, type: 'vehicle.schedule.changed' } })).toBe(3);
      wf = (await as.post('demo.logistic.lead', `/jobs/${jobId}/stages/${stage.id}/complete`)).body;
      expect(as.current(wf).key).toBe('print');
    });
  });

  describe('production and installation', () => {
    it('prints only the approved artwork, needs completion evidence, and blocks Print until production is complete', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      let wf = await as.workflow(job.id);
      for (let i = 0; i < 4; i++) wf = await as.completeCurrent(job.id);
      const print = as.current(wf);
      expect(print.key).toBe('print');

      // A newer, unapproved artwork version cannot be printed.
      const d = await as.as('demo.design.lead');
      await d.agent.post(`${API}/jobs/${job.id}/artwork-versions`).set('X-CSRF-Token', d.csrf).attach('file', PDF, 'late-change.pdf').expect(201);
      expect((await as.post('demo.production.lead', `/jobs/${job.id}/production-orders`, { stageId: print.id, title: 'Print' })).status).toBe(409);
      await as.approveArtwork(job.id);

      expect((await as.post('demo.installation.lead', `/jobs/${job.id}/production-orders`, { stageId: print.id, title: 'Print' })).status).toBe(403);
      const machine = (await as.post('demo.production.lead', '/machines', { code: `HP-${Date.now() % 10000}`, name: 'HP Latex 800', kind: 'Printer' })).body;
      const operator = await ids('demo.production');
      let ops = (await as.post('demo.production.lead', `/jobs/${job.id}/production-orders`, {
        stageId: print.id,
        title: 'Print side panels',
        material: 'Avery MPI 1105',
        quantity: 4,
        dimensions: '5.2m x 1.9m',
        machineId: machine.id,
        operatorId: operator,
      })).body as OperationsDto;
      const order = ops.productionOrders[0]!;
      expect(order).toMatchObject({ artworkVersionNo: 3, machine: { name: 'HP Latex 800' }, operator: { id: operator }, status: 'PLANNED' });
      expect((await as.post('demo.production.lead', `/jobs/${job.id}/stages/${print.id}/complete`)).status).toBe(422);
      await as.patch('demo.installation.lead', `/production-orders/${order.id}`, { status: 'IN_PROGRESS' }).then((r) => expect(r.status).toBe(403));
      ops = (await as.patch('demo.production.lead', `/production-orders/${order.id}`, { status: 'IN_PROGRESS' })).body;
      expect(ops.productionOrders[0]!.actualStart).toBeTruthy();
      expect((await as.patch('demo.production.lead', `/production-orders/${order.id}`, { status: 'COMPLETED' })).status).toBe(409);
      const photo = await as.upload('demo.production.lead', job.id, 'production', 'printed.pdf');
      await as.post('demo.production.lead', `/production-orders/${order.id}/logs`, { note: 'All panels printed, 0.5 m waste', quantityDone: 4, fileIds: [photo] });
      ops = (await as.patch('demo.production.lead', `/production-orders/${order.id}`, { status: 'COMPLETED', wastageNotes: '0.5 m' })).body;
      expect(ops.productionOrders[0]).toMatchObject({ status: 'COMPLETED' });
      expect(ops.productionOrders[0]!.logs.map((l) => l.note)).toEqual(['Status: in progress', 'All panels printed, 0.5 m waste', 'Status: completed']);
      await expect(prisma.operationLog.deleteMany({ where: { productionOrderId: order.id } })).rejects.toThrow();
      wf = (await as.post('demo.production.lead', `/jobs/${job.id}/stages/${print.id}/complete`)).body;
      expect(as.current(wf).key).toBe('wrap');
    });

    it('records installation teams, materials and completion photos; technicians can log their own work', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const s = await as.as('demo.sales');
      await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'spec.pdf').expect(201);
      let wf = await as.workflow(job.id);
      for (let i = 0; i < 3; i++) wf = await as.completeCurrent(job.id);
      const inst = as.current(wf);
      expect(inst.key).toBe('installation');
      const tech = await ids('demo.installation');
      expect((await as.post('demo.installation.lead', `/jobs/${job.id}/installation-orders`, { stageId: inst.id, target: 'Mall unit 12', technicianIds: [await ids('demo.design')] })).status).toBe(400);
      let ops = (await as.post('demo.installation.lead', `/jobs/${job.id}/installation-orders`, {
        stageId: inst.id,
        target: 'Mall unit 12 shop front',
        address: 'City Mall, ground floor',
        safetyNotes: 'Work at height — harness required',
        scheduledStart: new Date().toISOString(),
        teamLeaderId: await ids('demo.installation.lead'),
        technicianIds: [tech],
        materials: [{ item: 'Anchor bolts', quantity: 12, unit: 'pcs' }],
      })).body as OperationsDto;
      const order = ops.installationOrders[0]!;
      expect(order).toMatchObject({ technicians: [{ id: tech }], materials: [{ item: 'Anchor bolts', quantity: 12, unit: 'pcs' }] });
      ops = (await as.patch('demo.installation.lead', `/installation-orders/${order.id}`, { status: 'BLOCKED', reason: 'Mall access permit pending' })).body;
      expect(ops.installationOrders[0]!.status).toBe('BLOCKED');
      const photo = await as.upload('demo.installation.lead', job.id, 'installation', 'site-done.pdf');
      // The assigned technician logs progress (but cannot change the order).
      const techLog = await as.post('demo.installation', `/installation-orders/${order.id}/logs`, { note: 'Letters mounted and wired' });
      expect(techLog.status).toBe(201);
      await as.post('demo.installation.lead', `/installation-orders/${order.id}/logs`, { note: 'Completion photos', fileIds: [photo] });
      ops = (await as.patch('demo.installation.lead', `/installation-orders/${order.id}`, { status: 'COMPLETED' })).body;
      expect(ops.installationOrders[0]).toMatchObject({ status: 'COMPLETED' });
      expect(ops.installationOrders[0]!.finishedAt).toBeTruthy();
      wf = (await as.post('demo.installation.lead', `/jobs/${job.id}/stages/${inst.id}/complete`)).body;
      expect(wf.stages.find((x) => x.id === inst.id)?.status).toBe('COMPLETED');
      // Signage has no vehicle schedule.
      expect((await as.post('demo.logistic.lead', `/jobs/${job.id}/vehicle-schedules`, { vehicleRef: 'x', plannedStart: new Date().toISOString(), location: 'y' })).status).toBe(404);
    });
  });
});

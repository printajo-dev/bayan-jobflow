import type { INestApplication } from '@nestjs/common';
import type { CorrectionDto, DeliveriesDto, QualityDto, WorkflowDto } from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { Actors, COMPLETE_SG_BRIEF, COMPLETE_VB_BRIEF, PDF } from './workflow-helpers.js';

describe('Phase 5: QC inspections, rework, delivery and closure', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: { username: 'admin.helper', fullName: 'Helper Admin', passwordHash: await hashPassword('Demo-Password-2026'), roles: { create: [{ roleId: role.id }] } },
      update: {},
    });
    as = new Actors(app);
  });
  afterAll(async () => app.close());

  async function vbAtQc(): Promise<{ jobId: string; wf: WorkflowDto }> {
    const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
    let wf = await as.workflow(job.id);
    while (as.current(wf).key !== 'qc_inspection') wf = await as.completeCurrent(job.id);
    return { jobId: job.id, wf };
  }

  it('only the Quality Team inspects; other departments cannot see or change QC', async () => {
    const { jobId, wf } = await vbAtQc();
    const stageId = as.current(wf).id;
    expect((await as.get('demo.logistic', `/jobs/${jobId}/qc`)).status).toBe(403);
    expect((await as.get('demo.management', `/jobs/${jobId}/qc`)).status).toBe(200);
    expect((await as.post('demo.production.lead', `/jobs/${jobId}/qc-inspections`, { stageId })).status).toBe(403);
    const started = await as.post('demo.quality', `/jobs/${jobId}/qc-inspections`, { stageId });
    expect(started.status).toBe(201);
    expect((await as.post('demo.quality', `/jobs/${jobId}/qc-inspections`, { stageId })).status).toBe(409);
    const ins = (started.body as QualityDto).inspections[0]!;
    expect(ins.results.map((r) => r.label)).toContain('Graphics match the approved artwork version');
    expect((await as.post('demo.installation.lead', `/qc-inspections/${ins.id}/approve`)).status).toBe(403);
  });

  it('refuses to pass an incomplete checklist (unchecked, N/A without comment, missing evidence)', async () => {
    const { jobId, wf } = await vbAtQc();
    const started = (await as.post('demo.quality.lead', `/jobs/${jobId}/qc-inspections`, { stageId: as.current(wf).id })).body as QualityDto;
    const ins = started.inspections[0]!;
    let r = await as.post('demo.quality.lead', `/qc-inspections/${ins.id}/approve`);
    expect(r.status).toBe(400);
    expect(r.body.message.join(' ')).toMatch(/is not checked/);
    const results = ins.results.map((x, i) => ({ itemId: x.itemId, result: i === 0 ? 'NA' : 'PASS', fileIds: [] }));
    await as.patch('demo.quality.lead', `/qc-inspections/${ins.id}/results`, { results });
    r = await as.post('demo.quality.lead', `/qc-inspections/${ins.id}/approve`);
    expect(r.body.message.join(' ')).toMatch(/N\/A without a comment/);
    expect(r.body.message.join(' ')).toMatch(/needs an evidence photo/);
  });

  it('AT16: a failed inspection blocks progression, creates rework for the responsible department and keeps its record', async () => {
    const { jobId, wf } = await vbAtQc();
    const qcStage = as.current(wf);
    const q = (await as.post('demo.quality.lead', `/jobs/${jobId}/qc-inspections`, { stageId: qcStage.id })).body as QualityDto;
    expect(q.returnTargets.map((t) => t.key).sort((a, b) => a.localeCompare(b))).toEqual(['design', 'print', 'wrap']);
    const ins = q.inspections[0]!;
    await as.patch('demo.quality.lead', `/qc-inspections/${ins.id}/results`, {
      results: ins.results.map((x, i) => ({ itemId: x.itemId, result: i === 1 ? 'FAIL' : 'PASS', comment: i === 1 ? 'Bubbles on rear door' : null })),
    });
    expect((await as.post('demo.quality.lead', `/qc-inspections/${ins.id}/fail`, { defects: 'x', responsibleStageKey: 'delivery' })).status).toBe(400);
    const tech = (await prisma.user.findUniqueOrThrow({ where: { username: 'demo.installation' } })).id;
    const failed = await as.post('demo.quality.lead', `/qc-inspections/${ins.id}/fail`, { defects: 'Bubbles on the rear door panel', responsibleStageKey: 'wrap', assignedToId: tech });
    expect(failed.status).toBe(200);
    const after = failed.body as QualityDto;
    expect(after.inspections[0]).toMatchObject({ status: 'FAILED', defects: 'Bubbles on the rear door panel' });
    await expect(prisma.qcInspection.update({ where: { id: ins.id }, data: { status: 'PASSED' } })).rejects.toThrow();

    let flow = await as.workflow(jobId);
    expect(as.current(flow)).toMatchObject({ key: 'wrap', occurrenceNo: 2 });
    expect(flow.stages.find((s) => s.key === 'delivery')?.status).toBe('PENDING');
    expect(flow.stages.filter((s) => s.key === 'print')).toHaveLength(1);
    const corrections = (await as.get('demo.installation.lead', `/jobs/${jobId}/corrections`)).body as CorrectionDto[];
    const rework = corrections.find((c) => c.id === after.inspections[0]!.correctionId)!;
    expect(rework).toMatchObject({ blocking: true, status: 'ASSIGNED', department: { code: 'INSTALLATION' }, assignedTo: { id: tech } });

    // Rework: new installation evidence, but the blocking correction must be resolved first.
    await as.completeInstallation(jobId, as.current(flow).id);
    const blocked = await as.post('demo.installation.lead', `/jobs/${jobId}/stages/${as.current(flow).id}/complete`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.message.join(' ')).toMatch(/QC rework/);
    await as.post('demo.installation', `/corrections/${rework.id}/resolve`, { notes: 'Panel re-applied' });
    flow = (await as.post('demo.installation.lead', `/jobs/${jobId}/stages/${as.current(flow).id}/complete`)).body;
    expect(as.current(flow)).toMatchObject({ key: 'qc_inspection', occurrenceNo: 2 });

    // Re-inspection is a new record; the failed one stays.
    await as.passQc(jobId, as.current(flow).id);
    const qcAll = (await as.get('demo.quality.lead', `/jobs/${jobId}/qc`)).body as QualityDto;
    expect(qcAll.inspections.map((i) => [i.stage.occurrenceNo, i.status])).toEqual([
      [2, 'PASSED'],
      [1, 'FAILED'],
    ]);
    flow = await as.workflow(jobId);
    expect(as.current(flow).key).toBe('delivery');
  });

  it('AT17: Vehicle Branding closes only after QC passes and Logistic records the delivery with evidence', async () => {
    const { jobId, wf } = await vbAtQc();
    await as.passQc(jobId, as.current(wf).id);
    let flow = await as.workflow(jobId);
    const delivery = as.current(flow);
    expect(delivery.key).toBe('delivery');
    expect((await as.get('demo.sales', `/jobs/${jobId}`)).body.status).toBe('OPEN');

    expect((await as.post('demo.design.lead', `/jobs/${jobId}/delivery-records`, { stageId: delivery.id, plannedAt: new Date().toISOString() })).status).toBe(403);
    const planned = (await as.post('demo.logistic', `/jobs/${jobId}/delivery-records`, { stageId: delivery.id, plannedAt: new Date().toISOString(), notes: 'Customer collects at 10:00' })).body as DeliveriesDto;
    const rec = planned.deliveries[0]!;
    expect((await as.post('demo.logistic', `/delivery-records/${rec.id}/complete`, { actualAt: new Date().toISOString(), recipientName: 'Khalid', fileIds: [] })).status).toBe(400);
    expect((await as.post('demo.logistic.lead', `/jobs/${jobId}/stages/${delivery.id}/complete`)).status).toBe(422);
    const s = await as.as('demo.logistic');
    const ev = await s.agent.post(`${API}/jobs/${jobId}/delivery-files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'signed-handover.pdf');
    const done = await as.post('demo.logistic', `/delivery-records/${rec.id}/complete`, { actualAt: new Date().toISOString(), recipientName: 'Khalid (fleet manager)', handoverNotes: 'Keys handed over', fileIds: [ev.body.id] });
    expect(done.status).toBe(200);
    expect((done.body as DeliveriesDto).deliveries[0]).toMatchObject({ status: 'COMPLETED', recipientName: 'Khalid (fleet manager)', completedBy: 'Logistic Employee' });
    flow = await as.workflow(jobId);
    expect(flow.status).toBe('COMPLETED');
    const job = (await as.get('demo.sales', `/jobs/${jobId}`)).body;
    expect(job.status).toBe('CLOSED');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: jobId, type: 'job.closed' } })).toBe(1);
  });

  it('AT18: Signage closes immediately after a QC pass and has no delivery', async () => {
    const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
    const s = await as.as('demo.sales');
    await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'drawing.pdf').expect(201);
    let wf = await as.workflow(job.id);
    while (as.current(wf).key !== 'qc_inspection') wf = await as.completeCurrent(job.id);
    expect((await as.get('demo.logistic.lead', `/jobs/${job.id}/delivery-records`)).status).toBe(404);
    await as.passQc(job.id, as.current(wf).id);
    wf = await as.workflow(job.id);
    expect(wf.status).toBe('COMPLETED');
    expect(wf.stages.some((x) => x.key === 'delivery')).toBe(false);
    expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.status).toBe('CLOSED');
  });

  it('administrators keep versioned QC checklists; running inspections keep their copy', async () => {
    const before = (await as.get('admin.helper', '/qc-checklist-templates')).body as { serviceType: { code: string }; version: number }[];
    const sgV = before.find((t) => t.serviceType.code === 'SG')!.version;
    expect((await as.post('demo.quality.lead', '/qc-checklist-templates/SG', { name: 'x', items: [{ label: 'y' }] })).status).toBe(403);
    const saved = await as.post('admin.helper', '/qc-checklist-templates/SG', {
      name: 'Signage QC',
      items: [
        { label: 'Dimensions and position match the drawings' },
        { label: 'Illumination even at night', requiresEvidence: true },
      ],
    });
    expect(saved.status).toBe(201);
    expect(saved.body.find((t: { serviceType: { code: string } }) => t.serviceType.code === 'SG').version).toBe(sgV + 1);
  });
});

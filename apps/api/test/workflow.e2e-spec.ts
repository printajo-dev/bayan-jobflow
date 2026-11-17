import type { INestApplication } from '@nestjs/common';
import type { WorkflowDto } from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { Actors, COMPLETE_SG_BRIEF, COMPLETE_VB_BRIEF, jobNumber, PDF } from './workflow-helpers.js';

const keys = (wf: WorkflowDto) => wf.stages.filter((s) => s.occurrenceNo === 1).map((s) => s.key);

describe('Jobs and workflow engine (Phase 2 acceptance)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    // A dedicated admin the helpers can use to read any workflow.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: { username: 'admin.helper', fullName: 'Helper Admin', passwordHash: await hashPassword('Demo-Password-2026'), roles: { create: [{ roleId: role.id }] } },
      update: {},
    });
    as = new Actors(app);
  });
  afterAll(async () => app.close());

  describe('AT1/AT2: job creation by Sales', () => {
    it('creates a Vehicle Branding job with a manual Job Number and no customer information', async () => {
      const number = jobNumber();
      const res = await as.post('demo.sales', '/jobs', { jobNumber: number.toLowerCase(), serviceType: 'VB', title: 'Van fleet', brief: COMPLETE_VB_BRIEF });
      expect(res.status).toBe(201);
      expect(res.body.jobNumber).toBe(number);
      expect(res.body.brief).not.toHaveProperty('customer');
      expect(res.body.briefProblems).toEqual([]);
      expect(res.body.templateVersion.templateName).toBe('Vehicle Branding');

      // Same number in a different case is a duplicate.
      const dup = await as.post('demo.sales', '/jobs', { jobNumber: number.toLowerCase(), serviceType: 'SG', title: 'Dup', brief: {} });
      expect(dup.status).toBe(409);
      expect(dup.body.message).toContain(number);
    });

    it('rejects customer fields in the Vehicle Branding brief', async () => {
      const res = await as.post('demo.sales', '/jobs', {
        jobNumber: jobNumber(),
        serviceType: 'VB',
        title: 'x',
        brief: { ...COMPLETE_VB_BRIEF, customerName: 'ACME LLC' },
      });
      expect(res.status).toBe(400);
    });

    it('creates a Signage job and attaches drawings', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const s = await as.as('demo.sales');
      const up = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'shopfront-drawing.pdf');
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ originalName: 'shopfront-drawing.pdf', mimeType: 'application/pdf', purpose: 'BRIEF' });
      expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      const detail = await as.get('demo.sales', `/jobs/${job.id}`);
      expect(detail.body.files).toHaveLength(1);
    });

    it('does not let users without job.create create jobs', async () => {
      const res = await as.post('demo.design', '/jobs', { jobNumber: jobNumber(), serviceType: 'VB', title: 'x' });
      expect(res.status).toBe(403);
    });

    it('enforces the configured ERP invoice format when one is set', async () => {
      const admin = await as.as('admin.helper');
      await admin.agent.put(`${API}/settings/job-number`).set('X-CSRF-Token', admin.csrf).send({ pattern: 'INV-[A-Z0-9-]+', example: 'INV-10023' }).expect(200);
      const bad = await as.post('demo.sales', '/jobs', { jobNumber: 'PO-77', serviceType: 'VB', title: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain('INV-10023');
      await admin.agent.put(`${API}/settings/job-number`).set('X-CSRF-Token', admin.csrf).send({ pattern: null }).expect(200);
    });
  });

  describe('AT3/AT4: workflow instantiation', () => {
    it('Vehicle Branding gets exactly its eight stages in order', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const wf = await as.workflow(job.id);
      expect(keys(wf)).toEqual(['job_brief', 'design', 'government_approval', 'vehicle_schedule', 'print', 'wrap', 'qc_inspection', 'delivery']);
      expect(wf.stages.map((s) => s.department.code)).toEqual(['SALES', 'DESIGN', 'PRO', 'LOGISTIC', 'PRODUCTION', 'INSTALLATION', 'QUALITY', 'LOGISTIC']);
      expect(wf.stages[0]!.status).toBe('ACTIVE');
      expect(wf.stages.slice(1).every((s) => s.status === 'PENDING')).toBe(true);
    });

    it('Signage gets Job Brief, Design, Production, Installation and QC only', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const wf = await as.workflow(job.id);
      expect(keys(wf)).toEqual(['job_brief', 'design', 'production', 'installation', 'qc_inspection']);
      expect(wf.stages.some((s) => s.department.code === 'LOGISTIC' || s.key === 'delivery')).toBe(false);
    });
  });

  describe('AT5 and stage permissions', () => {
    it('Design is owned by the Design Team; PRO cannot complete it and Government Approval comes after it', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      let wf = await as.completeCurrent(job.id); // job brief
      const design = as.current(wf);
      expect(design).toMatchObject({ key: 'design', department: { code: 'DESIGN' } });

      const pro = await as.post('demo.pro.lead', `/jobs/${job.id}/stages/${design.id}/complete`);
      expect(pro.status).toBe(403);
      const proView = await as.get('demo.pro.lead', `/jobs/${job.id}/workflow`);
      expect(proView.body.stages.find((s: { id: string }) => s.id === design.id).allowedActions).toEqual([]);

      wf = await as.completeCurrent(job.id);
      expect(as.current(wf)).toMatchObject({ key: 'government_approval', department: { code: 'PRO' } });
    });

    it('department employees can tick the checklist but only leaders complete the stage', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      const wf = await as.completeCurrent(job.id);
      const gov = as.current(wf);
      expect(gov.key).toBe('government_approval');
      const tick = await as.post('demo.pro', `/jobs/${job.id}/stages/${gov.id}/checklist/${gov.checklist[0]!.id}`, { checked: true });
      expect(tick.status).toBe(200);
      const done = await as.post('demo.pro', `/jobs/${job.id}/stages/${gov.id}/complete`);
      expect(done.status).toBe(403);
    });

    it('blocks completion until gates pass and explains why', async () => {
      const job = await as.createJob('VB', { details: { vehicles: [] } });
      const wf = await as.workflow(job.id);
      const brief = as.current(wf);
      expect(brief.gates.find((g) => g.key === 'brief.complete')?.passed).toBe(false);
      const res = await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${brief.id}/complete`);
      expect(res.status).toBe(422);
      expect(res.body.message.join(' ')).toMatch(/at least one vehicle/i);

      await as.patch('demo.sales', `/jobs/${job.id}/brief`, COMPLETE_VB_BRIEF).then((r) => expect(r.status).toBe(200));
      const next = await as.completeCurrent(job.id);
      const design = as.current(next);
      const blocked = await as.post('demo.design.lead', `/jobs/${job.id}/stages/${design.id}/complete`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.message.join(' ')).toMatch(/Customer approval recorded|No artwork version/);
    });
  });

  describe('closure rules', () => {
    it('Vehicle Branding runs through all eight stages and closes only after Delivery', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      let wf = await as.workflow(job.id);
      for (let i = 0; i < 7; i++) wf = await as.completeCurrent(job.id);
      expect(as.current(wf).key).toBe('delivery');
      expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.status).toBe('OPEN');
      wf = await as.completeCurrent(job.id);
      expect(wf.status).toBe('COMPLETED');
      const detail = (await as.get('demo.sales', `/jobs/${job.id}`)).body;
      expect(detail.status).toBe('CLOSED');
      expect(detail.closedAt).toBeTruthy();
    });

    it('Signage needs its drawings attached and closes right after QC passes', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const wf = await as.workflow(job.id);
      const brief = as.current(wf);
      const blocked = await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${brief.id}/complete`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.message.join(' ')).toMatch(/drawing or specification/);

      const s = await as.as('demo.sales');
      await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'spec.pdf').expect(201);
      let last = await as.completeCurrent(job.id);
      for (let i = 0; i < 4; i++) last = await as.completeCurrent(job.id);
      expect(last.status).toBe('COMPLETED');
      expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.status).toBe('CLOSED');
    });
  });

  describe('rework re-runs only the reopened stage', () => {
    it('PRO returns the job to Design; after Design it goes straight back to Government Approval', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      let wf = await as.completeCurrent(job.id);
      const gov = as.current(wf);
      expect(gov.returnTargets).toEqual([{ key: 'design', name: 'Design' }]);

      const ret = await as.post('demo.pro.lead', `/jobs/${job.id}/stages/${gov.id}/return`, { targetStageKey: 'design', reason: 'RTA rejected: logo too large' });
      expect(ret.status).toBe(200);
      wf = ret.body;
      const designs = wf.stages.filter((s) => s.key === 'design');
      expect(designs.map((s) => [s.occurrenceNo, s.status])).toEqual([
        [1, 'COMPLETED'],
        [2, 'ACTIVE'],
      ]);
      expect(designs[1]).toMatchObject({ returnReason: 'RTA rejected: logo too large', returnedFrom: { key: 'government_approval' } });
      expect(wf.stages.find((s) => s.id === gov.id)?.status).toBe('RETURNED');
      // The Design checklist starts fresh: a new approval is needed.
      expect(designs[1]!.checklist.every((c) => c.checkedAt === null)).toBe(true);

      wf = await as.completeCurrent(job.id);
      expect(as.current(wf)).toMatchObject({ key: 'government_approval', occurrenceNo: 2 });
      expect(wf.stages.find((s) => s.key === 'vehicle_schedule')?.status).toBe('PENDING');
    });

    it('a QC failure returns to Print only; Wrap is not re-run', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      let wf = await as.workflow(job.id);
      for (let i = 0; i < 6; i++) wf = await as.completeCurrent(job.id);
      const qc = as.current(wf);
      expect(qc.key).toBe('qc_inspection');
      expect(qc.returnTargets.map((t) => t.key).sort((a, b) => a.localeCompare(b))).toEqual(['design', 'print', 'wrap']);
      wf = (await as.post('demo.quality.lead', `/jobs/${job.id}/stages/${qc.id}/return`, { targetStageKey: 'print', reason: 'Colour mismatch on panel 3' })).body;
      expect(as.current(wf)).toMatchObject({ key: 'print', occurrenceNo: 2 });
      wf = await as.completeCurrent(job.id);
      expect(as.current(wf)).toMatchObject({ key: 'qc_inspection', occurrenceNo: 2 });
      expect(wf.stages.filter((s) => s.key === 'wrap')).toHaveLength(1);
      // Delivery is still locked until QC passes.
      expect(wf.stages.find((s) => s.key === 'delivery')?.status).toBe('PENDING');
    });

    it('rejects a return to a stage the template does not allow', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      const wf = await as.completeCurrent(job.id);
      const gov = as.current(wf);
      const res = await as.post('demo.pro.lead', `/jobs/${job.id}/stages/${gov.id}/return`, { targetStageKey: 'job_brief', reason: 'not allowed' });
      expect(res.status).toBe(409);
    });
  });

  describe('AT20: no duplicate stages from retries', () => {
    it('two simultaneous completions of the same stage create only one next stage', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const wf = await as.workflow(job.id);
      const brief = as.current(wf);
      const leader = await as.as('demo.sales.lead');
      const [a, b] = await Promise.all([
        leader.agent.post(`${API}/jobs/${job.id}/stages/${brief.id}/complete`).set('X-CSRF-Token', leader.csrf),
        leader.agent.post(`${API}/jobs/${job.id}/stages/${brief.id}/complete`).set('X-CSRF-Token', leader.csrf),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const after = await as.workflow(job.id);
      expect(after.stages.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
      expect(after.stages).toHaveLength(8);
      const events = await prisma.outboxEvent.count({ where: { aggregateId: job.id, type: 'workflow.stage.completed' } });
      expect(events).toBe(1);
    });
  });

  describe('AT19: template versioning', () => {
    it('publishing a new version does not change active jobs, and published versions are immutable', async () => {
      const oldJob = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const admin = await as.as('admin.helper');
      const templates = (await admin.agent.get(`${API}/workflow-templates`)).body as { id: string; code: string; versions: { id: string; status: string }[] }[];
      const sg = templates.find((t) => t.code === 'SG')!;
      const v1 = sg.versions.find((v) => v.status === 'PUBLISHED')!;

      const draft = await admin.agent.post(`${API}/workflow-templates/${sg.id}/versions`).set('X-CSRF-Token', admin.csrf).send({});
      expect(draft.status).toBe(201);
      const stages = draft.body.stages.map((s: { key: string; name: string; description: string | null; department: { id: string }; gateKeys: string[]; checklist: unknown[] }) => ({
        key: s.key,
        name: s.name,
        description: s.description,
        departmentId: s.department.id,
        gateKeys: s.gateKeys,
        checklist: s.checklist,
      }));
      const quality = stages.find((s: { key: string }) => s.key === 'qc_inspection').departmentId;
      stages.splice(4, 0, { key: 'site_survey_signoff', name: 'Site sign-off', departmentId: quality, gateKeys: [], checklist: [{ label: 'Customer site sign-off', required: true }] });
      const saved = await admin.agent
        .put(`${API}/workflow-template-versions/${draft.body.id}`)
        .set('X-CSRF-Token', admin.csrf)
        .send({ notes: 'Adds site sign-off', stages, returnRules: draft.body.returnRules });
      expect(saved.status).toBe(200);
      expect(saved.body.stages).toHaveLength(6);

      // A published version cannot be edited through the API…
      const edit = await admin.agent.put(`${API}/workflow-template-versions/${v1.id}`).set('X-CSRF-Token', admin.csrf).send({ stages, returnRules: [] });
      expect(edit.status).toBe(409);
      // …or directly in the database.
      await expect(prisma.workflowTemplateStage.updateMany({ where: { versionId: v1.id }, data: { name: 'Hacked' } })).rejects.toThrow();

      await admin.agent.post(`${API}/workflow-template-versions/${draft.body.id}/publish`).set('X-CSRF-Token', admin.csrf).expect(200);
      expect((await as.workflow(oldJob.id)).stages).toHaveLength(5);
      const newJob = await as.createJob('SG', COMPLETE_SG_BRIEF);
      expect(newJob.templateVersion.versionNo).toBe(draft.body.versionNo);
      expect(keys(await as.workflow(newJob.id))).toContain('site_survey_signoff');

      const v1Now = await admin.agent.get(`${API}/workflow-template-versions/${v1.id}`);
      expect(v1Now.body.status).toBe('RETIRED');
    });

    it('rejects invalid drafts and only lets template managers edit templates', async () => {
      const admin = await as.as('admin.helper');
      const templates = (await admin.agent.get(`${API}/workflow-templates`)).body as { id: string; code: string }[];
      const vb = templates.find((t) => t.code === 'VB')!;
      const draft = (await admin.agent.post(`${API}/workflow-templates/${vb.id}/versions`).set('X-CSRF-Token', admin.csrf).send({})).body;
      const dept = draft.stages[0].department.id;
      const forward = await admin.agent
        .put(`${API}/workflow-template-versions/${draft.id}`)
        .set('X-CSRF-Token', admin.csrf)
        .send({ stages: [{ key: 'a', name: 'A', departmentId: dept }, { key: 'b', name: 'B', departmentId: dept }], returnRules: [{ fromKey: 'a', toKey: 'b' }] });
      expect(forward.status).toBe(400);
      const futureGate = await admin.agent
        .put(`${API}/workflow-template-versions/${draft.id}`)
        .set('X-CSRF-Token', admin.csrf)
        .send({ stages: [{ key: 'a', name: 'A', departmentId: dept, gateKeys: ['quality.passed'] }] });
      expect(futureGate.status).toBe(400);
      await admin.agent.delete(`${API}/workflow-template-versions/${draft.id}`).set('X-CSRF-Token', admin.csrf).expect(204);
      expect((await as.get('demo.sales.lead', '/workflow-templates')).status).toBe(403);
    });
  });

  describe('job visibility and IDOR protection', () => {
    it('PRO and Logistic cannot see Signage jobs; Design, Sales and Management can', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      for (const u of ['demo.pro.lead', 'demo.logistic']) {
        expect((await as.get(u, `/jobs/${job.id}`)).status).toBe(404);
        expect((await as.get(u, `/jobs/${job.id}/workflow`)).status).toBe(404);
        const list = await as.get(u, `/jobs?search=${job.jobNumber}`);
        expect(list.body.items).toHaveLength(0);
      }
      for (const u of ['demo.design', 'demo.sales', 'demo.management']) {
        expect((await as.get(u, `/jobs/${job.id}`)).status).toBe(200);
      }
    });

    it('management can view but has no actions', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const detail = (await as.get('demo.management', `/jobs/${job.id}`)).body;
      expect(detail.allowedActions).toEqual([]);
      const wf = (await as.get('demo.management', `/jobs/${job.id}/workflow`)).body as WorkflowDto;
      expect(wf.stages.every((s) => s.allowedActions.length === 0)).toBe(true);
      expect((await as.post('demo.management', `/jobs/${job.id}/stages/${wf.stages[0]!.id}/complete`)).status).toBe(403);
    });

    it('files cannot be downloaded by guessing ids, and only permitted types are accepted', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const s = await as.as('demo.sales');
      const up = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'drawing.pdf');
      expect(up.status).toBe(201);

      const ok = await s.agent.get(`${API}/files/${up.body.id}/download`);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-disposition']).toMatch(/^attachment/);
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      const inline = await s.agent.get(`${API}/files/${up.body.id}/download?inline=1`);
      expect(inline.headers['content-disposition']).toMatch(/^inline/);
      expect(inline.headers['content-security-policy']).toContain('sandbox');

      expect((await as.get('demo.pro.lead', `/files/${up.body.id}/download`)).status).toBe(404);
      expect((await as.get('demo.sales', `/files/0197a3c4-0000-7000-8000-000000000000/download`)).status).toBe(404);
      expect(await prisma.fileAccessLog.count({ where: { fileId: up.body.id } })).toBe(2);

      const html = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', Buffer.from('<script>alert(1)</script>'), 'x.html');
      expect(html.status).toBe(400);
      const disguised = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'photo.png');
      expect(disguised.status).toBe(400);
      const exe = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', Buffer.from('MZ\x90\x00\x03'), 'tool.pdf');
      expect(exe.status).toBe(400);
      const big = await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', Buffer.alloc(3 * 1024 * 1024, 0x20), 'big.txt');
      expect(big.status).toBe(413);
      // Rejected uploads leave nothing behind in storage.
      expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.files).toHaveLength(1);

      // Design can see the job but may not change the brief attachments.
      const design = await as.as('demo.design');
      expect((await design.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', design.csrf).attach('file', PDF, 'd.pdf')).status).toBe(403);
    });
  });

  describe('leader and administrator actions', () => {
    it('hold and resume with a reason', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const wf = await as.workflow(job.id);
      const stage = as.current(wf);
      const held = await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${stage.id}/hold`, { reason: 'Waiting for vehicle photos' });
      expect(as.current(held.body)).toMatchObject({ status: 'ON_HOLD', holdReason: 'Waiting for vehicle photos' });
      expect((await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${stage.id}/complete`)).status).toBe(409);
      const resumed = await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${stage.id}/resume`);
      expect(as.current(resumed.body).status).toBe('ACTIVE');
    });

    it('administrator reopens the last stage of a closed job; it closes again afterwards', async () => {
      const job = await as.createJob('SG', COMPLETE_SG_BRIEF);
      const s = await as.as('demo.sales');
      await s.agent.post(`${API}/jobs/${job.id}/files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'spec.pdf').expect(201);
      let wf = await as.workflow(job.id);
      // Signage may be on template v2 by now (see the versioning test): run to the end.
      for (let i = 0; i < 10 && wf.status !== 'COMPLETED'; i++) wf = await as.completeCurrent(job.id);
      expect(wf.status).toBe('COMPLETED');
      const qc = wf.stages.find((x) => x.key === 'qc_inspection')!;
      expect((await as.post('demo.quality.lead', `/jobs/${job.id}/stages/${qc.id}/reopen`, { reason: 'Quality wants another look' })).status).toBe(403);
      const reopened = await as.post('admin.helper', `/jobs/${job.id}/stages/${qc.id}/reopen`, { reason: 'Customer reported a loose letter' });
      expect(reopened.status).toBe(200);
      expect(as.current(reopened.body)).toMatchObject({ key: 'qc_inspection', occurrenceNo: 2 });
      expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.status).toBe('OPEN');
      wf = await as.completeCurrent(job.id);
      expect(wf.status).toBe('COMPLETED');
    });

    it('administrator can complete with a recorded exception', async () => {
      const job = await as.createJob('VB', { details: { vehicles: [] } });
      const wf = await as.workflow(job.id);
      const stage = as.current(wf);
      const res = await as.post('admin.helper', `/jobs/${job.id}/stages/${stage.id}/complete-with-exception`, { reason: 'Brief captured on paper; to be typed later' });
      expect(res.status).toBe(200);
      expect(res.body.stages[0]).toMatchObject({ status: 'COMPLETED', exceptionReason: 'Brief captured on paper; to be typed later' });
      expect((await as.post('demo.sales.lead', `/jobs/${job.id}/stages/${res.body.stages[1].id}/complete-with-exception`, { reason: 'nope' })).status).toBe(403);
    });

    it('Job Number corrections need permission and a reason, and are in the history', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const newNumber = jobNumber('ERP');
      expect((await as.post('demo.sales', `/jobs/${job.id}/job-number`, { jobNumber: newNumber, reason: 'Typo in invoice number' })).status).toBe(403);
      const ok = await as.post('demo.sales.lead', `/jobs/${job.id}/job-number`, { jobNumber: newNumber, reason: 'Typo in invoice number' });
      expect(ok.status).toBe(200);
      expect(ok.body.jobNumber).toBe(newNumber);
      const activity = await as.get('demo.design', `/jobs/${job.id}/activity`);
      expect(activity.body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['job.created', 'job.number_changed']));
    });

    it('cancelling a job stops its workflow', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      expect((await as.post('demo.sales', `/jobs/${job.id}/cancel`, { reason: 'Customer withdrew' })).status).toBe(403);
      const res = await as.post('demo.sales.lead', `/jobs/${job.id}/cancel`, { reason: 'Customer withdrew' });
      expect(res.body.status).toBe('CANCELLED');
      const wf = await as.workflow(job.id);
      expect(wf.status).toBe('CANCELLED');
      expect(wf.stages.every((s) => s.status === 'CANCELLED')).toBe(true);
    });
  });

  it('lists jobs with filters and pagination', async () => {
    const res = await as.get('demo.sales', '/jobs?serviceType=VB&status=OPEN&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    expect(res.body.items.every((j: { serviceType: { code: string }; status: string }) => j.serviceType.code === 'VB' && j.status === 'OPEN')).toBe(true);
    const design = (await as.get('demo.sales', '/departments')).body.find((d: { code: string }) => d.code === 'DESIGN');
    const atDesign = await as.get('demo.sales', `/jobs?departmentId=${design.id}`);
    expect(atDesign.body.items.every((j: { currentStage: { key: string } | null }) => j.currentStage?.key === 'design')).toBe(true);
  });
});

import type { INestApplication } from '@nestjs/common';
import type { JobDetailDto, StageDto, WorkflowDto } from '@jobflow/shared';
import { API, signIn, type SignedIn } from './helpers.js';

/** Leader account per department code (from the demo seed). */
export const LEADER: Record<string, string> = {
  SALES: 'demo.sales.lead',
  DESIGN: 'demo.design.lead',
  PRO: 'demo.pro.lead',
  LOGISTIC: 'demo.logistic.lead',
  PRODUCTION: 'demo.production.lead',
  INSTALLATION: 'demo.installation.lead',
  QUALITY: 'demo.quality.lead',
};

let n = 0;
export function jobNumber(prefix = 'INV'): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${(n++).toString(36).toUpperCase()}`;
}

export const COMPLETE_VB_BRIEF = {
  scope: 'Full wrap of two delivery vans with company livery',
  requirements: 'Matt laminate',
  details: {
    vehicles: [
      { description: 'Toyota Hiace', year: '2024', plateOrChassis: 'D 12345', colour: 'White' },
      { description: 'Nissan Urvan', plateOrChassis: 'D 67890' },
    ],
    coverage: 'FULL_WRAP',
  },
};

export const COMPLETE_SG_BRIEF = {
  scope: 'Illuminated shop front sign',
  details: { siteName: 'Mall unit 12', siteAddress: 'Al Barsha', dimensions: '6.0m x 1.2m', specifications: '3D acrylic letters with LED', quantity: 1 },
};

/** Minimal valid PDF bytes (enough for content sniffing). */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export class Actors {
  private cache = new Map<string, SignedIn>();
  constructor(private readonly app: INestApplication) {}

  async as(username: string): Promise<SignedIn> {
    let s = this.cache.get(username);
    if (!s) {
      s = await signIn(this.app, username);
      this.cache.set(username, s);
    }
    return s;
  }

  async post(username: string, path: string, body: object = {}) {
    const s = await this.as(username);
    return s.agent.post(`${API}${path}`).set('X-CSRF-Token', s.csrf).send(body);
  }

  async patch(username: string, path: string, body: object) {
    const s = await this.as(username);
    return s.agent.patch(`${API}${path}`).set('X-CSRF-Token', s.csrf).send(body);
  }

  async get(username: string, path: string) {
    return (await this.as(username)).agent.get(`${API}${path}`);
  }

  async createJob(serviceType: 'VB' | 'SG', brief: object, overrides: object = {}): Promise<JobDetailDto> {
    const res = await this.post('demo.sales', '/jobs', { jobNumber: jobNumber(), serviceType, title: `${serviceType} test job`, brief, ...overrides });
    if (res.status !== 201) throw new Error(`create job failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async workflow(jobId: string, username = 'admin.helper'): Promise<WorkflowDto> {
    const res = await this.get(username, `/jobs/${jobId}/workflow`);
    if (res.status !== 200) throw new Error(`workflow ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  current(wf: WorkflowDto): StageDto {
    const s = wf.stages.find((x) => x.status === 'ACTIVE' || x.status === 'ON_HOLD');
    if (!s) throw new Error('no current stage');
    return s;
  }

  /** Design uploads a new artwork version and Sales records the customer's approval of it. */
  async approveArtwork(jobId: string, versionLabel = 'artwork.pdf'): Promise<string> {
    const d = await this.as('demo.design.lead');
    const up = await d.agent.post(`${API}/jobs/${jobId}/artwork-versions`).set('X-CSRF-Token', d.csrf).field('notes', 'Proof').attach('file', PDF, versionLabel);
    if (up.status !== 201) throw new Error(`artwork upload failed ${up.status} ${JSON.stringify(up.body)}`);
    const versionId = up.body.versions[0].id as string;
    const ok = await this.post('demo.sales', `/artwork-versions/${versionId}/approval-records`, {
      approverName: 'Fleet manager',
      approverRole: 'Customer',
      method: 'EMAIL',
      approvedAt: new Date().toISOString(),
    });
    if (ok.status !== 201) throw new Error(`approval failed ${ok.status} ${JSON.stringify(ok.body)}`);
    return versionId;
  }

  async upload(user: string, jobId: string, kind: 'authority' | 'production' | 'installation' | 'schedule', name = 'evidence.pdf'): Promise<string> {
    const s = await this.as(user);
    const r = await s.agent.post(`${API}/jobs/${jobId}/operation-files?kind=${kind}`).set('X-CSRF-Token', s.csrf).attach('file', PDF, name);
    if (r.status !== 201) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
  }

  /** PRO Leader opens an RTA application and marks it Not Required (fast path). */
  async clearAuthorities(jobId: string): Promise<void> {
    const types = (await this.get('demo.pro.lead', '/authority-types')).body as { id: string; code: string }[];
    const rta = types.find((t) => t.code === 'RTA')!;
    let auth = (await this.get('demo.pro.lead', `/jobs/${jobId}/authority`)).body;
    if (!auth.applications.length) auth = (await this.post('demo.pro.lead', `/jobs/${jobId}/authority-applications`, { authorityTypeId: rta.id })).body;
    for (const a of auth.applications) {
      if (a.status !== 'APPROVED' && a.status !== 'NOT_REQUIRED') {
        const r = await this.post('demo.pro.lead', `/authority-applications/${a.id}/not-required`, { reason: 'No livery permit needed for this vehicle class' });
        if (r.status !== 200) throw new Error(`not required failed ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
  }

  async confirmSchedule(jobId: string): Promise<void> {
    const r = await this.post('demo.logistic.lead', `/jobs/${jobId}/vehicle-schedules`, { vehicleRef: 'All vehicles', plannedStart: new Date(Date.now() + 86_400_000).toISOString(), location: 'Workshop bay 2' });
    if (r.status !== 201) throw new Error(`schedule failed ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.schedules.at(-1).id;
    const c = await this.patch('demo.logistic.lead', `/vehicle-schedules/${id}`, { status: 'CONFIRMED', confirmationNote: 'Customer fleet manager confirmed by phone' });
    if (c.status !== 200) throw new Error(`confirm failed ${c.status} ${JSON.stringify(c.body)}`);
  }

  async completeProduction(jobId: string, stageId: string): Promise<void> {
    const lead = 'demo.production.lead';
    const r = await this.post(lead, `/jobs/${jobId}/production-orders`, { stageId, title: 'Print and laminate', material: 'Cast vinyl', quantity: 2 });
    if (r.status !== 201) throw new Error(`production failed ${r.status} ${JSON.stringify(r.body)}`);
    const order = r.body.productionOrders.filter((o: { stage: { id: string } }) => o.stage.id === stageId).at(-1);
    const fileId = await this.upload(lead, jobId, 'production', 'print-done.pdf');
    await this.post(lead, `/production-orders/${order.id}/logs`, { note: 'Printed and laminated', quantityDone: 2, fileIds: [fileId] });
    const c = await this.patch(lead, `/production-orders/${order.id}`, { status: 'COMPLETED' });
    if (c.status !== 200) throw new Error(`production complete failed ${c.status} ${JSON.stringify(c.body)}`);
  }

  async completeInstallation(jobId: string, stageId: string): Promise<void> {
    const lead = 'demo.installation.lead';
    const r = await this.post(lead, `/jobs/${jobId}/installation-orders`, { stageId, target: 'All vehicles / site', scheduledStart: new Date().toISOString() });
    if (r.status !== 201) throw new Error(`installation failed ${r.status} ${JSON.stringify(r.body)}`);
    const order = r.body.installationOrders.filter((o: { stage: { id: string } }) => o.stage.id === stageId).at(-1);
    const fileId = await this.upload(lead, jobId, 'installation', 'installed.pdf');
    await this.post(lead, `/installation-orders/${order.id}/logs`, { note: 'Installed, photos attached', fileIds: [fileId] });
    const c = await this.patch(lead, `/installation-orders/${order.id}`, { status: 'COMPLETED' });
    if (c.status !== 200) throw new Error(`installation complete failed ${c.status} ${JSON.stringify(c.body)}`);
  }

  /** Ticks every checklist item of the current stage and completes it as the department leader. */
  async completeCurrent(jobId: string): Promise<WorkflowDto> {
    const wf = await this.workflow(jobId);
    const stage = this.current(wf);
    const leader = LEADER[stage.department.code]!;
    const failing = (key: string) => stage.gates.some((g) => g.key === key && !g.passed);
    if (failing('design.customer_approval')) await this.approveArtwork(jobId);
    if (failing('authority.all_cleared')) await this.clearAuthorities(jobId);
    if (failing('logistics.schedule_confirmed')) await this.confirmSchedule(jobId);
    if (failing('production.completed')) await this.completeProduction(jobId, stage.id);
    if (failing('installation.completed')) await this.completeInstallation(jobId, stage.id);
    for (const item of stage.checklist.filter((c) => !c.checkedAt)) {
      const r = await this.post(leader, `/jobs/${jobId}/stages/${stage.id}/checklist/${item.id}`, { checked: true });
      if (r.status !== 200) throw new Error(`check failed ${r.status} ${JSON.stringify(r.body)}`);
    }
    const res = await this.post(leader, `/jobs/${jobId}/stages/${stage.id}/complete`);
    if (res.status !== 200) throw new Error(`complete ${stage.key} failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

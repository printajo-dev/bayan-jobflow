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

  /** Ticks every checklist item of the current stage and completes it as the department leader. */
  async completeCurrent(jobId: string): Promise<WorkflowDto> {
    const wf = await this.workflow(jobId);
    const stage = this.current(wf);
    const leader = LEADER[stage.department.code]!;
    for (const item of stage.checklist.filter((c) => !c.checkedAt)) {
      const r = await this.post(leader, `/jobs/${jobId}/stages/${stage.id}/checklist/${item.id}`, { checked: true });
      if (r.status !== 200) throw new Error(`check failed ${r.status} ${JSON.stringify(r.body)}`);
    }
    const res = await this.post(leader, `/jobs/${jobId}/stages/${stage.id}/complete`);
    if (res.status !== 200) throw new Error(`complete ${stage.key} failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { REPORTS, type DashboardDto, type ReportDto } from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import {
  Actors,
  COMPLETE_SG_BRIEF,
  COMPLETE_VB_BRIEF,
  PDF,
} from './workflow-helpers.js';

describe('Phase 6: dashboards and reports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const role = await prisma.role.findUniqueOrThrow({
      where: { key: 'system_admin' },
    });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: {
        username: 'admin.helper',
        fullName: 'Helper Admin',
        passwordHash: await hashPassword('Demo-Password-2026'),
        roles: { create: [{ roleId: role.id }] },
      },
      update: {},
    });
    as = new Actors(app);
    // One closed Signage job and one Vehicle Branding job in progress.
    const sg = await as.createJob('SG', COMPLETE_SG_BRIEF);
    const s = await as.as('demo.sales');
    await s.agent
      .post(`${API}/jobs/${sg.id}/files`)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', PDF, 'drawing.pdf')
      .expect(201);
    let wf = await as.workflow(sg.id);
    while (wf.status !== 'COMPLETED') wf = await as.completeCurrent(sg.id);
    const vb = await as.createJob('VB', COMPLETE_VB_BRIEF);
    wf = await as.workflow(vb.id);
    while (as.current(wf).key !== 'print') wf = await as.completeCurrent(vb.id);
  });
  afterAll(async () => app.close());

  it('AT19: dashboards are role-aware', async () => {
    const mgmt = (await as.get('demo.management', '/dashboard'))
      .body as DashboardDto;
    expect(mgmt.overview).not.toBeNull();
    expect(mgmt.overview!.activeJobs).toBeGreaterThan(0);
    expect(mgmt.overview!.completedLast30).toBeGreaterThan(0);
    expect(mgmt.queues.length).toBeGreaterThan(5);

    const prod = (await as.get('demo.production', '/dashboard'))
      .body as DashboardDto;
    expect(prod.overview).toBeNull();
    expect(prod.queues.map((q) => q.department.code)).toEqual(['PRODUCTION']);
    expect(prod.queues[0]!.jobs.some((j) => j.stageName.length > 0)).toBe(true);
    expect(prod.queues[0]!.extras.map((e) => e.label)).toContain(
      'Orders in progress',
    );
  });

  it('runs every report for management, in JSON, CSV and XLSX', async () => {
    for (const r of REPORTS) {
      const res = await as.get(
        'demo.management',
        `/reports/${r.key}?from=2020-01-01`,
      );
      expect(res.status, r.key).toBe(200);
      const body = res.body as ReportDto;
      expect(body.columns.length).toBeGreaterThan(0);
      for (const row of body.rows)
        for (const c of body.columns)
          expect(c.key in row, `${r.key}.${c.key}`).toBe(true);
    }
    const active = (await as.get('demo.management', '/reports/active-jobs'))
      .body as ReportDto;
    expect(active.rows.some((r) => r['stage'] === 'Print')).toBe(true);
    const closures = (
      await as.get('demo.management', '/reports/closures?from=2020-01-01')
    ).body as ReportDto;
    expect(
      closures.rows.some(
        (r) => r['service'] === 'Signage' && r['hoursQcToClose'] === 0,
      ),
    ).toBe(true);

    const s = await as.as('demo.management');
    const csv = await s.agent
      .get(`${API}/reports/active-jobs?format=csv`)
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(
      /attachment; filename="active-jobs_/,
    );
    expect(csv.text.split('\r\n')[0]).toContain('Job Number,Title,Service');
    const xlsx = await s.agent
      .get(`${API}/reports/quality?format=xlsx`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((xlsx.body as Buffer).buffer as ArrayBuffer);
    expect(wb.worksheets[0]!.getRow(4).getCell(1).value).toBe('Service');
  });

  it('limits report scope: members see their department only, no employee figures, no export', async () => {
    const list = (await as.get('demo.production', '/reports')).body as {
      key: string;
      canExport: boolean;
    }[];
    expect(list.map((r) => r.key)).toEqual(['department-workload']);
    expect(
      (await as.get('demo.production', '/reports/active-jobs')).status,
    ).toBe(403);
    expect(
      (await as.get('demo.production', '/reports/employee-workload')).status,
    ).toBe(403);
    expect(
      (
        await as.get(
          'demo.production',
          '/reports/department-workload?format=csv',
        )
      ).status,
    ).toBe(403);
    const dept = (
      await as.get('demo.production', '/reports/department-workload')
    ).body as ReportDto;
    expect(dept.rows.map((r) => r['department'])).toEqual(['Production Team']);

    const lead = (
      await as.get('demo.production.lead', '/reports/employee-workload')
    ).body as ReportDto;
    expect(new Set(lead.rows.map((r) => r['department']))).toEqual(
      new Set(['Production Team']),
    );
    expect(
      (await as.get('demo.production.lead', '/reports/unknown-report')).status,
    ).toBe(404);
  });

  it('neutralises spreadsheet formulas in CSV exports', async () => {
    const job = await prisma.job.findFirstOrThrow({
      where: { status: 'OPEN' },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { title: '=HYPERLINK("http://x")' },
    });
    const s = await as.as('demo.management');
    const csv = await s.agent
      .get(`${API}/reports/active-jobs?format=csv`)
      .expect(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

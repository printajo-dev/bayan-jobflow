import {
  officeDate,
  officeDayStart,
  officeTimeZone,
  officeToday,
} from '../core/dates.js';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  REPORTS,
  type DashboardDto,
  type ReportDto,
  type ReportKey,
} from '@jobflow/shared';
import { PrismaService } from '../core/prisma.service.js';
import type { Principal } from '../access/principal.js';
import { visibleJobsWhere } from '../jobs/job-access.js';

type Row = Record<string, string | number | null>;
const num = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);
const round1 = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
/** Resolves every counter of a dashboard card concurrently. */
const settle = (items: { label: string; value: Promise<number> | number }[]) =>
  Promise.all(
    items.map(async (i) => ({ label: i.label, value: await i.value })),
  );

/**
 * Dashboards and management reports. Figures come straight from the
 * operational tables (PostgreSQL is the source of truth). Company-wide
 * reports need report.view granted globally (Management, administrators);
 * department figures are limited to the user's own departments; per-employee
 * figures are limited to department leaders.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ dashboard

  async dashboard(p: Principal): Promise<DashboardDto> {
    // Office calendar (Asia/Dubai), not UTC.
    const today = officeToday();
    const todayStr = officeDate();
    const OPEN = [
      'TODO',
      'ASSIGNED',
      'IN_PROGRESS',
      'WAITING',
      'BLOCKED',
    ] as const;
    const [openTasks, overdueTasks, openCorrections, unread] =
      await Promise.all([
        this.prisma.task.count({
          where: {
            status: { in: [...OPEN] },
            assignments: { some: { userId: p.userId, removedAt: null } },
            job: { status: 'OPEN' },
          },
        }),
        this.prisma.task.count({
          where: {
            status: { in: [...OPEN] },
            dueDate: { lt: today },
            assignments: { some: { userId: p.userId, removedAt: null } },
            job: { status: 'OPEN' },
          },
        }),
        this.prisma.correctionItem.count({
          where: {
            assignedToId: p.userId,
            status: { not: 'RESOLVED' },
            job: { status: 'OPEN' },
          },
        }),
        this.prisma.notification.count({
          where: { userId: p.userId, readAt: null },
        }),
      ]);

    const global = p.hasGlobal('report.view') || p.hasGlobal('job.view');
    const deptIds = global
      ? (
          await this.prisma.department.findMany({
            where: { isActive: true, code: { not: 'MANAGEMENT' } },
          })
        ).map((d) => d.id)
      : p.departments.map((d) => d.id);
    const departments = await this.prisma.department.findMany({
      where: { id: { in: deptIds } },
      orderBy: { name: 'asc' },
    });
    const visible = visibleJobsWhere(p);

    // A fixed number of queries whatever the number of departments.
    const ids = departments.map((d) => d.id);
    const [stages, taskCounts, corrCounts, extras] = await Promise.all([
      this.prisma.departmentStage.findMany({
        where: {
          departmentId: { in: ids },
          status: { in: ['ACTIVE', 'ON_HOLD'] },
          workflow: { job: { AND: [visible, { status: 'OPEN' }] } },
        },
        include: {
          templateStage: { select: { name: true } },
          workflow: { include: { job: { include: { serviceType: true } } } },
        },
        orderBy: { activatedAt: 'asc' },
        take: 100 * Math.max(1, ids.length),
      }),
      this.prisma.$queryRaw<
        {
          department_id: string;
          open: number;
          unassigned: number;
          overdue: number;
        }[]
      >`
        SELECT t.department_id,
               count(*)::int AS open,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.removed_at IS NULL))::int AS unassigned,
               count(*) FILTER (WHERE t.due_date < ${todayStr}::date)::int AS overdue
        FROM tasks t JOIN jobs j ON j.id = t.job_id
        WHERE j.status = 'OPEN'
          AND t.status IN ('TODO', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'BLOCKED')
          AND t.department_id = ANY(${ids}::uuid[])
        GROUP BY t.department_id`,
      this.prisma.correctionItem.groupBy({
        by: ['departmentId'],
        where: {
          departmentId: { in: ids },
          status: { not: 'RESOLVED' },
          job: { status: 'OPEN' },
        },
        _count: { _all: true },
      }),
      this.allExtras(departments.map((d) => d.code)),
    ]);

    const queues: DashboardDto['queues'] = departments.map((d) => {
      const tc = taskCounts.find((x) => x.department_id === d.id);
      return {
        department: { id: d.id, code: d.code, name: d.name },
        jobs: stages
          .filter((s) => s.departmentId === d.id)
          .slice(0, 100)
          .map((s) => {
            const j = s.workflow.job;
            return {
              jobId: j.id,
              jobNumber: j.jobNumber,
              title: j.title,
              serviceType: j.serviceType.name,
              stageName: s.templateStage.name,
              stageStatus: s.status,
              occurrenceNo: s.occurrenceNo,
              daysInStage: s.activatedAt
                ? Math.floor(
                    (Date.now() - s.activatedAt.getTime()) / 86_400_000,
                  )
                : 0,
              internalDeadline: s.internalDeadline
                ? dateOnly(s.internalDeadline)
                : null,
              customerCommitmentDate: j.customerCommitmentDate
                ? dateOnly(j.customerCommitmentDate)
                : null,
              overdue:
                (!!s.internalDeadline && s.internalDeadline < today) ||
                (!!j.customerCommitmentDate &&
                  j.customerCommitmentDate < today),
              priority: j.priority,
            };
          }),
        openTasks: tc?.open ?? 0,
        unassignedTasks: tc?.unassigned ?? 0,
        overdueTasks: tc?.overdue ?? 0,
        openCorrections:
          corrCounts.find((c) => c.departmentId === d.id)?._count._all ?? 0,
        extras: extras.get(d.code) ?? [],
      };
    });
    return {
      me: {
        openTasks,
        overdueTasks,
        openCorrections,
        unreadNotifications: unread,
      },
      queues,
      overview: p.hasGlobal('report.view') ? await this.overview(today) : null,
    };
  }

  /** Counters for every department on the dashboard, run concurrently; Design's are shared with Sales. */
  private async allExtras(
    codes: string[],
  ): Promise<Map<string, { label: string; value: number }[]>> {
    let design: Promise<{ label: string; value: number }[]> | null = null;
    const designOnce = () => (design ??= this.extras('DESIGN'));
    const entries = await Promise.all(
      codes.map(
        async (code): Promise<[string, { label: string; value: number }[]]> => {
          if (code === 'DESIGN') return [code, await designOnce()];
          if (code === 'SALES')
            return [
              code,
              [
                {
                  label: 'Artwork waiting for approval to be recorded',
                  value: (await designOnce())[1]!.value,
                },
              ],
            ];
          return [code, await this.extras(code)];
        },
      ),
    );
    return new Map(entries);
  }

  /** Department-specific counters (design approvals waiting, PRO pending, schedules, QC queue…). */
  private async extras(
    code: string,
  ): Promise<{ label: string; value: number }[]> {
    const in14 = new Date(Date.now() + 14 * 86_400_000);
    switch (code) {
      case 'DESIGN': {
        const roundsP = this.prisma.correctionRound.count({
          where: { resolvedAt: null, job: { status: 'OPEN' } },
        });
        const waitingP = this.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM artwork_versions v
          WHERE v.version_no = (SELECT max(version_no) FROM artwork_versions x WHERE x.job_id = v.job_id)
            AND NOT EXISTS (SELECT 1 FROM approval_records a WHERE a.artwork_version_id = v.id)
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = v.job_id AND j.status = 'OPEN')`;
        const [rounds, waiting] = await Promise.all([roundsP, waitingP]);
        return [
          { label: 'Open correction rounds', value: rounds },
          {
            label: 'Latest artwork awaiting customer approval',
            value: num(waiting[0]?.n),
          },
        ];
      }
      case 'SALES':
        return [
          {
            label: 'Artwork waiting for approval to be recorded',
            value: (await this.extras('DESIGN'))[1]!.value,
          },
        ];
      case 'PRO':
        return settle([
          {
            label: 'Applications pending',
            value: this.prisma.authorityApplication.count({
              where: {
                status: {
                  in: [
                    'PENDING_PREPARATION',
                    'READY_TO_SUBMIT',
                    'SUBMITTED',
                    'UNDER_REVIEW',
                    'MORE_INFO_REQUIRED',
                  ],
                },
                job: { status: 'OPEN' },
              },
            }),
          },
          {
            label: 'Rejected, to resubmit',
            value: this.prisma.authorityApplication.count({
              where: { status: 'REJECTED', job: { status: 'OPEN' } },
            }),
          },
          {
            label: 'Response overdue',
            value: this.prisma.authorityApplication.count({
              where: {
                status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
                expectedResponseDate: { lt: new Date() },
                job: { status: 'OPEN' },
              },
            }),
          },
        ]);
      case 'LOGISTIC':
        return settle([
          {
            label: 'Schedules awaiting confirmation',
            value: this.prisma.vehicleSchedule.count({
              where: {
                status: { in: ['PROPOSED', 'RESCHEDULED'] },
                job: { status: 'OPEN' },
              },
            }),
          },
          {
            label: 'Confirmed in the next 14 days',
            value: this.prisma.vehicleSchedule.count({
              where: {
                status: 'CONFIRMED',
                plannedStart: { gte: new Date(), lte: in14 },
              },
            }),
          },
          {
            label: 'Deliveries planned',
            value: this.prisma.deliveryRecord.count({
              where: { status: 'PLANNED', job: { status: 'OPEN' } },
            }),
          },
        ]);
      case 'PRODUCTION':
        return settle([
          {
            label: 'Orders in progress',
            value: this.prisma.productionOrder.count({
              where: { status: 'IN_PROGRESS' },
            }),
          },
          {
            label: 'Orders planned',
            value: this.prisma.productionOrder.count({
              where: { status: 'PLANNED', job: { status: 'OPEN' } },
            }),
          },
          {
            label: 'On hold',
            value: this.prisma.productionOrder.count({
              where: { status: 'ON_HOLD' },
            }),
          },
        ]);
      case 'INSTALLATION':
        return settle([
          {
            label: 'Installations in the next 14 days',
            value: this.prisma.installationOrder.count({
              where: {
                status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
                scheduledStart: { lte: in14 },
              },
            }),
          },
          {
            label: 'Blocked or partial',
            value: this.prisma.installationOrder.count({
              where: { status: { in: ['BLOCKED', 'PARTIAL'] } },
            }),
          },
        ]);
      case 'QUALITY':
        return settle([
          {
            label: 'Waiting for inspection',
            value: this.prisma.departmentStage.count({
              where: {
                status: 'ACTIVE',
                templateStage: { key: 'qc_inspection' },
              },
            }),
          },
          {
            label: 'Failed in the last 30 days',
            value: this.prisma.qcInspection.count({
              where: {
                status: 'FAILED',
                inspectedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
              },
            }),
          },
        ]);
      default:
        return [];
    }
  }

  private async overview(
    today: Date,
  ): Promise<NonNullable<DashboardDto['overview']>> {
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const since90 = new Date(Date.now() - 90 * 86_400_000);
    const [
      activeJobs,
      completedLast30,
      onHold,
      rework,
      overdueTasks,
      cycle,
      byStage,
    ] = await Promise.all([
      this.prisma.job.count({ where: { status: 'OPEN' } }),
      this.prisma.job.count({
        where: { status: 'CLOSED', closedAt: { gte: since30 } },
      }),
      this.prisma.departmentStage.count({ where: { status: 'ON_HOLD' } }),
      this.prisma.departmentStage.count({
        where: { occurrenceNo: { gt: 1 }, createdAt: { gte: since30 } },
      }),
      this.prisma.task.count({
        where: {
          status: {
            in: ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'BLOCKED'],
          },
          dueDate: { lt: today },
          job: { status: 'OPEN' },
        },
      }),
      this.prisma.$queryRaw<
        { d: number | null }[]
      >`SELECT avg(extract(epoch FROM closed_at - created_at) / 86400) AS d FROM jobs WHERE status = 'CLOSED' AND closed_at >= ${since90}`,
      this.prisma.$queryRaw<
        {
          service: string;
          stage: string;
          sequence: number;
          n: bigint;
          avg_days: number;
        }[]
      >`
        SELECT st.name AS service, ts.name AS stage, ts.sequence, count(*) AS n,
               avg(extract(epoch FROM now() - ds.activated_at) / 86400) AS avg_days
        FROM department_stages ds
        JOIN workflow_template_stages ts ON ts.id = ds.template_stage_id
        JOIN job_workflows w ON w.id = ds.job_workflow_id
        JOIN jobs j ON j.id = w.job_id
        JOIN service_types st ON st.id = j.service_type_id
        WHERE ds.status IN ('ACTIVE', 'ON_HOLD') AND j.status = 'OPEN'
        GROUP BY st.name, ts.name, ts.sequence
        ORDER BY st.name, ts.sequence`,
    ]);
    return {
      activeJobs,
      completedLast30,
      avgCycleDays: round1(cycle[0]?.d),
      onHold,
      reworkRoundsLast30: rework,
      overdueTasks,
      byStage: byStage.map((r) => ({
        service: r.service,
        stage: r.stage,
        sequence: r.sequence,
        count: num(r.n),
        avgDays: round1(r.avg_days) ?? 0,
      })),
    };
  }

  // ------------------------------------------------------------ reports

  list(p: Principal) {
    return REPORTS.filter((r) => this.allowed(p, r.scope)).map((r) => ({
      key: r.key,
      title: r.title,
      canExport: p.has('report.export'),
    }));
  }

  private allowed(
    p: Principal,
    scope: 'global' | 'department' | 'leader',
  ): boolean {
    if (p.hasGlobal('report.view')) return true;
    if (scope === 'global') return false;
    if (scope === 'department') return p.has('report.view');
    return p.departments.some((d) => d.isLeader);
  }

  async run(
    key: string,
    q: { from?: string; to?: string; group: 'week' | 'month' },
    p: Principal,
  ): Promise<ReportDto> {
    const def = REPORTS.find((r) => r.key === key);
    if (!def) throw new NotFoundException('Unknown report');
    if (!p.has('report.view') || !this.allowed(p, def.scope))
      throw new ForbiddenException('You cannot see this report');
    // Period bounds are office calendar days.
    const toDay = q.to ?? officeDate();
    const to = new Date(officeDayStart(toDay).getTime() + 86_400_000 - 1);
    const fromDay =
      q.from ?? officeDate(new Date(to.getTime() - 90 * 86_400_000));
    const from = officeDayStart(fromDay);
    const base = {
      key: def.key as ReportKey,
      title: def.title,
      from: fromDay,
      to: toDay,
      generatedAt: new Date().toISOString(),
    };
    const global = p.hasGlobal('report.view');
    const myDepts = global
      ? (await this.prisma.department.findMany({ select: { id: true } })).map(
          (d) => d.id,
        )
      : def.scope === 'leader'
        ? p.departments.filter((d) => d.isLeader).map((d) => d.id)
        : p.departments.map((d) => d.id);

    // Run in the office time zone: current_date, date_trunc, ::date and the
    // displayed times then follow Dubai, whatever the server's default.
    return this.prisma.$transaction(
      async (db): Promise<ReportDto> => {
        await db.$queryRaw`SELECT set_config('TimeZone', ${officeTimeZone()}, true)`;
        switch (def.key) {
          case 'active-jobs': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT j.job_number AS "jobNumber", j.title, st.name AS service, ts.name AS stage, d.name AS department,
                     ds.status AS "stageStatus", ds.occurrence_no AS round,
                     round((extract(epoch FROM now() - ds.activated_at) / 86400)::numeric, 1)::float AS "daysInStage",
                     j.priority::text AS priority, to_char(j.customer_commitment_date, 'YYYY-MM-DD') AS "customerDate"
              FROM jobs j
              JOIN service_types st ON st.id = j.service_type_id
              JOIN job_workflows w ON w.job_id = j.id
              JOIN department_stages ds ON ds.job_workflow_id = w.id AND ds.status IN ('ACTIVE', 'ON_HOLD')
              JOIN workflow_template_stages ts ON ts.id = ds.template_stage_id
              JOIN departments d ON d.id = ds.department_id
              WHERE j.status = 'OPEN'
              ORDER BY st.name, ts.sequence, ds.activated_at`;
            return {
              ...base,
              columns: [
                { key: 'jobNumber', label: 'Job Number' },
                { key: 'title', label: 'Title' },
                { key: 'service', label: 'Service' },
                { key: 'stage', label: 'Current stage' },
                { key: 'department', label: 'Department' },
                { key: 'stageStatus', label: 'Status' },
                { key: 'round', label: 'Round', numeric: true },
                { key: 'daysInStage', label: 'Days in stage', numeric: true },
                { key: 'priority', label: 'Priority' },
                { key: 'customerDate', label: 'Customer date' },
              ],
              rows,
              notes: [
                'All open jobs and the stage they are in now. Round > 1 means the stage is being redone.',
              ],
            };
          }
          case 'throughput': {
            const unit = q.group === 'week' ? 'week' : 'month';
            const rows = await db.$queryRaw<Row[]>`
              SELECT to_char(date_trunc(${unit}, j.closed_at), 'YYYY-MM-DD') AS period, st.name AS service, count(*)::int AS completed,
                     round(avg(extract(epoch FROM j.closed_at - j.created_at) / 86400)::numeric, 1)::float AS "avgCycleDays",
                     round(max(extract(epoch FROM j.closed_at - j.created_at) / 86400)::numeric, 1)::float AS "maxCycleDays"
              FROM jobs j JOIN service_types st ON st.id = j.service_type_id
              WHERE j.status = 'CLOSED' AND j.closed_at BETWEEN ${from} AND ${to}
              GROUP BY 1, 2 ORDER BY 1, 2`;
            return {
              ...base,
              columns: [
                {
                  key: 'period',
                  label: q.group === 'week' ? 'Week starting' : 'Month',
                },
                { key: 'service', label: 'Service' },
                { key: 'completed', label: 'Jobs completed', numeric: true },
                {
                  key: 'avgCycleDays',
                  label: 'Average cycle (days)',
                  numeric: true,
                },
                {
                  key: 'maxCycleDays',
                  label: 'Longest cycle (days)',
                  numeric: true,
                },
              ],
              rows,
              notes: ['Cycle time = job creation to job closure.'],
            };
          }
          case 'department-workload': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT d.name AS department,
                (SELECT count(*)::int FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.department_id = d.id AND j.status = 'OPEN' AND t.status IN ('TODO','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED')) AS "openTasks",
                (SELECT count(*)::int FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.department_id = d.id AND j.status = 'OPEN' AND t.status IN ('TODO','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED')
                   AND NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.removed_at IS NULL)) AS "unassigned",
                (SELECT count(*)::int FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.department_id = d.id AND j.status = 'OPEN' AND t.status IN ('TODO','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED') AND t.due_date < current_date) AS "overdue",
                (SELECT count(*)::int FROM tasks t JOIN jobs j ON j.id = t.job_id WHERE t.department_id = d.id AND j.status = 'OPEN' AND t.status = 'BLOCKED') AS "blocked",
                (SELECT count(*)::int FROM tasks t WHERE t.department_id = d.id AND t.status = 'COMPLETED' AND t.completed_at BETWEEN ${from} AND ${to}) AS "completedInPeriod",
                (SELECT count(*)::int FROM department_stages s JOIN job_workflows w ON w.id = s.job_workflow_id JOIN jobs j ON j.id = w.job_id WHERE s.department_id = d.id AND s.status = 'ACTIVE' AND j.status = 'OPEN') AS "activeStages",
                (SELECT count(*)::int FROM department_stages s WHERE s.department_id = d.id AND s.status = 'ON_HOLD') AS "onHold",
                (SELECT count(*)::int FROM correction_items c JOIN jobs j ON j.id = c.job_id WHERE c.department_id = d.id AND c.status <> 'RESOLVED' AND j.status = 'OPEN') AS "openCorrections"
              FROM departments d WHERE d.id = ANY(${myDepts}::uuid[]) AND d.is_active ORDER BY d.name`;
            return {
              ...base,
              columns: [
                { key: 'department', label: 'Department' },
                {
                  key: 'activeStages',
                  label: 'Jobs at this department',
                  numeric: true,
                },
                { key: 'onHold', label: 'On hold', numeric: true },
                { key: 'openTasks', label: 'Open tasks', numeric: true },
                { key: 'unassigned', label: 'Unassigned', numeric: true },
                { key: 'overdue', label: 'Overdue', numeric: true },
                { key: 'blocked', label: 'Blocked', numeric: true },
                {
                  key: 'completedInPeriod',
                  label: 'Completed in period',
                  numeric: true,
                },
                {
                  key: 'openCorrections',
                  label: 'Open corrections',
                  numeric: true,
                },
              ],
              rows,
              notes: global ? [] : ['Limited to your departments.'],
            };
          }
          case 'employee-workload': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT u.full_name AS employee, d.name AS department,
                count(*) FILTER (WHERE t.status IN ('TODO','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED') AND j.status = 'OPEN')::int AS "openTasks",
                count(*) FILTER (WHERE t.status IN ('TODO','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED') AND j.status = 'OPEN' AND t.due_date < current_date)::int AS overdue,
                count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.completed_at BETWEEN ${from} AND ${to})::int AS "completedInPeriod",
                count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.completed_at BETWEEN ${from} AND ${to} AND t.due_date IS NOT NULL AND t.completed_at::date <= t.due_date)::int AS "completedOnTime"
              FROM user_departments ud
              JOIN users u ON u.id = ud.user_id AND u.status = 'ACTIVE'
              JOIN departments d ON d.id = ud.department_id
              LEFT JOIN task_assignments a ON a.user_id = u.id AND a.removed_at IS NULL
              LEFT JOIN tasks t ON t.id = a.task_id AND t.department_id = d.id
              LEFT JOIN jobs j ON j.id = t.job_id
              WHERE d.id = ANY(${myDepts}::uuid[])
              GROUP BY u.full_name, d.name ORDER BY d.name, u.full_name`;
            return {
              ...base,
              columns: [
                { key: 'employee', label: 'Employee' },
                { key: 'department', label: 'Department' },
                { key: 'openTasks', label: 'Open tasks', numeric: true },
                { key: 'overdue', label: 'Overdue', numeric: true },
                {
                  key: 'completedInPeriod',
                  label: 'Completed in period',
                  numeric: true,
                },
                {
                  key: 'completedOnTime',
                  label: 'Completed by due date',
                  numeric: true,
                },
              ],
              rows,
              notes: global ? [] : ['Limited to the departments you lead.'],
            };
          }
          case 'design': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT j.job_number AS "jobNumber", st.name AS service,
                (SELECT count(*)::int FROM artwork_versions v WHERE v.job_id = j.id) AS versions,
                (SELECT count(*)::int FROM correction_rounds r WHERE r.job_id = j.id) AS "correctionRounds",
                (SELECT count(*)::int FROM department_stages s JOIN workflow_template_stages ts ON ts.id = s.template_stage_id JOIN job_workflows w ON w.id = s.job_workflow_id WHERE w.job_id = j.id AND ts.key = 'design' AND s.occurrence_no > 1) AS "designReworkRounds",
                round((extract(epoch FROM (SELECT min(a.created_at) FROM approval_records a WHERE a.job_id = j.id) -
                  (SELECT min(s.activated_at) FROM department_stages s JOIN workflow_template_stages ts ON ts.id = s.template_stage_id JOIN job_workflows w ON w.id = s.job_workflow_id WHERE w.job_id = j.id AND ts.key = 'design')) / 86400)::numeric, 1)::float AS "daysToFirstApproval"
              FROM jobs j JOIN service_types st ON st.id = j.service_type_id
              WHERE j.created_at BETWEEN ${from} AND ${to}
                AND EXISTS (SELECT 1 FROM artwork_versions v WHERE v.job_id = j.id)
              ORDER BY j.created_at`;
            return {
              ...base,
              columns: [
                { key: 'jobNumber', label: 'Job Number' },
                { key: 'service', label: 'Service' },
                { key: 'versions', label: 'Artwork versions', numeric: true },
                {
                  key: 'correctionRounds',
                  label: 'Correction rounds',
                  numeric: true,
                },
                {
                  key: 'designReworkRounds',
                  label: 'Design returned (rounds)',
                  numeric: true,
                },
                {
                  key: 'daysToFirstApproval',
                  label: 'Days from design start to first approval',
                  numeric: true,
                },
              ],
              rows,
              notes: ['Jobs created in the period that have artwork.'],
            };
          }
          case 'authority': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT t.name AS authority,
                count(DISTINCT a.id)::int AS applications,
                count(DISTINCT a.id) FILTER (WHERE a.status = 'APPROVED')::int AS approved,
                count(DISTINCT a.id) FILTER (WHERE a.status = 'NOT_REQUIRED')::int AS "notRequired",
                count(DISTINCT a.id) FILTER (WHERE a.status IN ('PENDING_PREPARATION','READY_TO_SUBMIT','SUBMITTED','UNDER_REVIEW','MORE_INFO_REQUIRED','REJECTED'))::int AS pending,
                count(s.id)::int AS submissions,
                count(s.id) FILTER (WHERE s.outcome = 'REJECTED')::int AS rejections,
                CASE WHEN count(s.id) FILTER (WHERE s.outcome <> 'PENDING') > 0
                  THEN round(100.0 * count(s.id) FILTER (WHERE s.outcome = 'REJECTED') / count(s.id) FILTER (WHERE s.outcome <> 'PENDING'), 1)::float END AS "rejectionRatePct",
                round(avg(extract(epoch FROM s.outcome_at - s.submitted_at) / 86400) FILTER (WHERE s.outcome_at IS NOT NULL)::numeric, 1)::float AS "avgTurnaroundDays"
              FROM authority_types t
              LEFT JOIN authority_applications a ON a.authority_type_id = t.id AND a.created_at BETWEEN ${from} AND ${to}
              LEFT JOIN authority_submissions s ON s.application_id = a.id
              GROUP BY t.name ORDER BY t.name`;
            return {
              ...base,
              columns: [
                { key: 'authority', label: 'Authority' },
                { key: 'applications', label: 'Applications', numeric: true },
                { key: 'approved', label: 'Approved', numeric: true },
                { key: 'notRequired', label: 'Not required', numeric: true },
                { key: 'pending', label: 'Pending', numeric: true },
                { key: 'submissions', label: 'Submissions', numeric: true },
                { key: 'rejections', label: 'Rejections', numeric: true },
                {
                  key: 'rejectionRatePct',
                  label: 'Rejection rate %',
                  numeric: true,
                },
                {
                  key: 'avgTurnaroundDays',
                  label: 'Average turnaround (days)',
                  numeric: true,
                },
              ],
              rows,
              notes: ['Turnaround = submission to authority decision.'],
            };
          }
          case 'operations': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT 'Production' AS kind, status::text AS status, count(*)::int AS orders,
                     round(avg(extract(epoch FROM actual_finish - actual_start) / 3600) FILTER (WHERE actual_finish IS NOT NULL)::numeric, 1)::float AS "avgHours"
              FROM production_orders WHERE created_at BETWEEN ${from} AND ${to} GROUP BY status
              UNION ALL
              SELECT 'Installation', status::text, count(*)::int,
                     round(avg(extract(epoch FROM finished_at - started_at) / 3600) FILTER (WHERE finished_at IS NOT NULL)::numeric, 1)::float
              FROM installation_orders WHERE created_at BETWEEN ${from} AND ${to} GROUP BY status
              ORDER BY 1, 2`;
            return {
              ...base,
              columns: [
                { key: 'kind', label: 'Work' },
                { key: 'status', label: 'Status' },
                { key: 'orders', label: 'Orders', numeric: true },
                {
                  key: 'avgHours',
                  label: 'Average duration (hours)',
                  numeric: true,
                },
              ],
              rows,
              notes: [
                'Orders created in the period; duration from actual start to finish.',
              ],
            };
          }
          case 'quality': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT st.name AS service,
                count(*) FILTER (WHERE q.status <> 'DRAFT')::int AS inspections,
                count(*) FILTER (WHERE q.status = 'PASSED')::int AS passed,
                count(*) FILTER (WHERE q.status = 'FAILED')::int AS failed,
                CASE WHEN count(*) FILTER (WHERE q.status <> 'DRAFT') > 0 THEN round(100.0 * count(*) FILTER (WHERE q.status = 'PASSED') / count(*) FILTER (WHERE q.status <> 'DRAFT'), 1)::float END AS "passRatePct",
                count(DISTINCT q.job_id) FILTER (WHERE q.status = 'FAILED')::int AS "jobsWithRework"
              FROM qc_inspections q JOIN jobs j ON j.id = q.job_id JOIN service_types st ON st.id = j.service_type_id
              WHERE q.inspected_at BETWEEN ${from} AND ${to}
              GROUP BY st.name ORDER BY st.name`;
            const defects = await db.$queryRaw<Row[]>`
              SELECT r.label AS item, count(*)::int AS failures
              FROM qc_checklist_results r JOIN qc_inspections q ON q.id = r.inspection_id
              WHERE r.result = 'FAIL' AND q.inspected_at BETWEEN ${from} AND ${to}
              GROUP BY r.label ORDER BY 2 DESC LIMIT 10`;
            return {
              ...base,
              columns: [
                { key: 'service', label: 'Service' },
                { key: 'inspections', label: 'Inspections', numeric: true },
                { key: 'passed', label: 'Passed', numeric: true },
                { key: 'failed', label: 'Failed', numeric: true },
                { key: 'passRatePct', label: 'Pass rate %', numeric: true },
                {
                  key: 'jobsWithRework',
                  label: 'Jobs with QC rework',
                  numeric: true,
                },
              ],
              rows,
              notes: defects.length
                ? [
                    `Most frequent defects: ${defects.map((d) => `${String(d['item'])} (${String(d['failures'])})`).join('; ')}`,
                  ]
                : [],
            };
          }
          case 'schedule-delivery': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT j.job_number AS "jobNumber",
                (SELECT count(*)::int FROM vehicle_schedule_history h JOIN vehicle_schedules s ON s.id = h.schedule_id WHERE s.job_id = j.id AND h.action = 'rescheduled') AS reschedules,
                (SELECT to_char(min(s.planned_start), 'YYYY-MM-DD HH24:MI') FROM vehicle_schedules s WHERE s.job_id = j.id AND s.status IN ('CONFIRMED','COMPLETED')) AS "confirmedSchedule",
                to_char(d.planned_at, 'YYYY-MM-DD HH24:MI') AS "deliveryPlanned",
                to_char(d.actual_at, 'YYYY-MM-DD HH24:MI') AS "deliveredAt",
                CASE WHEN d.actual_at IS NULL THEN NULL WHEN d.actual_at <= d.planned_at + interval '1 day' THEN 'On time' ELSE 'Late' END AS "onTime",
                d.status::text AS "deliveryStatus"
              FROM jobs j
              JOIN service_types st ON st.id = j.service_type_id AND st.code = 'VB'
              LEFT JOIN LATERAL (SELECT * FROM delivery_records r WHERE r.job_id = j.id ORDER BY r.created_at DESC LIMIT 1) d ON true
              WHERE j.created_at BETWEEN ${from} AND ${to}
              ORDER BY j.created_at`;
            return {
              ...base,
              columns: [
                { key: 'jobNumber', label: 'Job Number' },
                { key: 'reschedules', label: 'Reschedules', numeric: true },
                { key: 'confirmedSchedule', label: 'Confirmed schedule' },
                { key: 'deliveryPlanned', label: 'Delivery planned' },
                { key: 'deliveredAt', label: 'Delivered' },
                { key: 'onTime', label: 'On time (within 1 day)' },
                { key: 'deliveryStatus', label: 'Delivery status' },
              ],
              rows,
              notes: ['Vehicle Branding jobs created in the period.'],
            };
          }
          case 'closures': {
            const rows = await db.$queryRaw<Row[]>`
              SELECT j.job_number AS "jobNumber", st.name AS service, to_char(j.closed_at, 'YYYY-MM-DD HH24:MI') AS "closedAt",
                to_char((SELECT max(q.inspected_at) FROM qc_inspections q WHERE q.job_id = j.id AND q.status = 'PASSED'), 'YYYY-MM-DD HH24:MI') AS "qcPassedAt",
                round((extract(epoch FROM j.closed_at - (SELECT max(q.inspected_at) FROM qc_inspections q WHERE q.job_id = j.id AND q.status = 'PASSED')) / 3600)::numeric, 1)::float AS "hoursQcToClose",
                (SELECT count(*)::int FROM qc_inspections q WHERE q.job_id = j.id AND q.status = 'FAILED') AS "qcFailures"
              FROM jobs j JOIN service_types st ON st.id = j.service_type_id
              WHERE j.status = 'CLOSED' AND j.closed_at BETWEEN ${from} AND ${to}
              ORDER BY j.closed_at`;
            return {
              ...base,
              columns: [
                { key: 'jobNumber', label: 'Job Number' },
                { key: 'service', label: 'Service' },
                { key: 'qcPassedAt', label: 'QC passed' },
                { key: 'closedAt', label: 'Closed' },
                {
                  key: 'hoursQcToClose',
                  label: 'Hours from QC pass to closure',
                  numeric: true,
                },
                { key: 'qcFailures', label: 'QC failures', numeric: true },
              ],
              rows,
              notes: [
                'Signage closes at the QC pass (0 hours); Vehicle Branding closes after delivery.',
              ],
            };
          }
        }
        throw new NotFoundException('Unknown report');
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  toCsv(r: ReportDto): string {
    const esc = (v: string | number | null | undefined) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Neutralise spreadsheet formulas in exported text.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      r.columns.map((c) => esc(c.label)).join(','),
      ...r.rows.map((row) => r.columns.map((c) => esc(row[c.key])).join(',')),
    ];
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  async toXlsx(r: ReportDto): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Bayan JobFlow';
    const ws = wb.addWorksheet(
      r.title.replace(/[*?:\\/[\]]/g, '-').slice(0, 31),
    );
    ws.addRow([r.title]).font = { bold: true, size: 13 };
    ws.addRow([`Period ${r.from} to ${r.to} · generated ${r.generatedAt}`]);
    ws.addRow([]);
    const header = ws.addRow(r.columns.map((c) => c.label));
    header.font = { bold: true };
    for (const row of r.rows) {
      ws.addRow(
        r.columns.map((c) => {
          const v = row[c.key];
          if (typeof v === 'string' && /^[=+\-@]/.test(v)) return `'${v}`;
          return v ?? null;
        }),
      );
    }
    for (const note of r.notes) ws.addRow([note]);
    ws.columns.forEach((col, i) => {
      col.width = Math.min(
        40,
        Math.max(12, (r.columns[i]?.label.length ?? 10) + 4),
      );
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

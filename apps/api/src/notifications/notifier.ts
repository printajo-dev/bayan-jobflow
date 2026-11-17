import { officeDate, officeToday } from '../core/dates.js';
import type { NotificationType } from '@jobflow/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { OutboxEventRow } from '../outbox/outbox.relay.js';

export interface Push {
  toUser(userId: string, event: string, payload: unknown): void;
}

interface Draft {
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  tab?: string;
}

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Turns workflow events into in-app notifications. Runs in the worker as an
 * outbox consumer, so notifications never decide workflow progression.
 * Idempotent: (user, event key) is unique, so a retried event cannot notify
 * twice. Users can switch off notification types in their preferences.
 */
export class Notifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly push: Push | null,
  ) {}

  /** Event types this consumer handles. */
  static readonly EVENTS = [
    'workflow.stage.activated',
    'workflow.stage.returned',
    'workflow.stage.reopened',
    'task.assigned',
    'discussion.mention.created',
    'discussion.message.replied',
    'artwork.approved',
    'design.round.opened',
    'correction.created',
    'correction.assigned',
    'correction.resolved',
    'correction.reopened',
    'job.closed',
    'authority.decision',
    'vehicle.schedule.changed',
    'qc.result',
    'delivery.completed',
  ];

  async handle(event: OutboxEventRow): Promise<void> {
    const p = (event.payload ?? {}) as P;
    const jobId = str(p['jobId']) ?? event.aggregate_id;
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, jobNumber: true, createdById: true },
    });
    if (!job) return;
    const drafts = await this.draft(event.type, p, job);
    for (const d of drafts) await this.deliver(event.id, job, d);
  }

  private async draft(
    type: string,
    p: P,
    job: { jobNumber: string; createdById: string | null },
  ): Promise<Draft[]> {
    const n = job.jobNumber;
    const stageName = async () => {
      const s = str(p['stageId'])
        ? await this.prisma.departmentStage.findUnique({
            where: { id: str(p['stageId'])! },
            include: { templateStage: true },
          })
        : null;
      return s?.templateStage.name ?? 'A stage';
    };
    switch (type) {
      case 'workflow.stage.activated':
        return [
          {
            userIds: await this.leaders(str(p['departmentId'])),
            type: 'stage.activated',
            title: `${n}: ${await stageName()} is ready for your department`,
            tab: 'workflow',
          },
        ];
      case 'workflow.stage.returned':
      case 'workflow.stage.reopened':
        return [
          {
            userIds: await this.leaders(str(p['departmentId'])),
            type: 'stage.returned',
            title: `${n}: ${await stageName()} ${type.endsWith('reopened') ? 'was reopened' : 'was returned to your department'}`,
            body: str(p['reason']),
            tab: 'workflow',
          },
        ];
      case 'task.assigned': {
        const task = await this.prisma.task.findUnique({
          where: { id: String(p['taskId']) },
        });
        return [
          {
            userIds: (p['userIds'] as string[]) ?? [],
            type: 'task.assigned',
            title: `${n}: you were assigned "${task?.title ?? 'a task'}"`,
            body: task?.dueDate
              ? `Due ${task.dueDate.toISOString().slice(0, 10)}`
              : null,
            tab: 'tasks',
          },
        ];
      }
      case 'discussion.mention.created':
        return [
          {
            userIds: (p['userIds'] as string[]) ?? [],
            type: 'mention',
            title: `${n}: ${await this.name(str(p['authorId']))} mentioned you`,
            body: await this.excerpt(str(p['messageId'])),
            tab: 'discussions',
          },
        ];
      case 'discussion.message.replied':
        return [
          {
            userIds: [str(p['parentAuthorId'])].filter((x): x is string => !!x),
            type: 'reply',
            title: `${n}: ${await this.name(str(p['authorId']))} replied to your message`,
            body: await this.excerpt(str(p['messageId'])),
            tab: 'discussions',
          },
        ];
      case 'artwork.approved': {
        const dept = await this.departmentOfStage(String(p['jobId']), 'design');
        return [
          {
            userIds: await this.leaders(dept),
            type: 'approval.recorded',
            title: `${n}: customer approved artwork version ${String(p['versionNo'])}`,
            tab: 'design',
          },
        ];
      }
      case 'design.round.opened': {
        const designer = str(p['assignedDesignerId']);
        const ids = designer
          ? [designer]
          : await this.leaders(
              await this.departmentOfStage(String(p['jobId']), 'design'),
            );
        return [
          {
            userIds: ids,
            type: 'correction.assigned',
            title: `${n}: design correction round ${String(p['roundNo'])} opened`,
            tab: 'design',
          },
        ];
      }
      case 'correction.created': {
        if (str(p['assignedToId'])) return [];
        const c = await this.correction(p);
        return [
          {
            userIds: await this.leaders(str(p['departmentId'])),
            type: 'correction.assigned',
            title: `${n}: new correction "${c?.title ?? ''}" for your department`,
            tab: 'corrections',
          },
        ];
      }
      case 'correction.assigned': {
        const c = await this.correction(p);
        return [
          {
            userIds: [str(p['assignedToId'])].filter((x): x is string => !!x),
            type: 'correction.assigned',
            title: `${n}: correction "${c?.title ?? ''}" assigned to you`,
            tab: 'corrections',
          },
        ];
      }
      case 'correction.resolved': {
        const c = await this.correction(p);
        return [
          {
            userIds: [str(p['requestedById'])].filter((x): x is string => !!x),
            type: 'correction.resolved',
            title: `${n}: correction "${c?.title ?? ''}" was resolved`,
            tab: 'corrections',
          },
        ];
      }
      case 'correction.reopened': {
        const c = await this.correction(p);
        const ids = str(p['assignedToId'])
          ? [str(p['assignedToId'])!]
          : await this.leaders(str(p['departmentId']));
        return [
          {
            userIds: ids,
            type: 'correction.reopened',
            title: `${n}: correction "${c?.title ?? ''}" was reopened`,
            tab: 'corrections',
          },
        ];
      }
      case 'job.closed':
        return [
          {
            userIds: [job.createdById].filter((x): x is string => !!x),
            type: 'job.closed',
            title: `${n} is closed`,
            tab: 'workflow',
          },
        ];
      case 'authority.decision':
        return [
          {
            userIds: [
              ...(await this.leaders(
                await this.departmentOfStage(
                  String(p['jobId']),
                  'government_approval',
                ),
              )),
              ...(await this.leaders(
                await this.departmentOfStage(String(p['jobId']), 'design'),
              )),
            ],
            type: 'authority.decision',
            title: `${n}: ${str(p['authority']) ?? 'Authority'} ${(str(p['status']) ?? '').toLowerCase().replace('_', ' ')}`,
            body: str(p['note']),
            tab: 'pro',
          },
        ];
      case 'vehicle.schedule.changed':
        return [
          {
            userIds: [
              ...(await this.leaders(
                await this.departmentOfStage(String(p['jobId']), 'design'),
              )),
              ...(await this.leaders(
                await this.departmentOfStage(String(p['jobId']), 'print'),
              )),
              ...(await this.leaders(
                await this.departmentOfStage(String(p['jobId']), 'wrap'),
              )),
            ],
            type: 'schedule.changed',
            title: `${n}: vehicle schedule ${(str(p['status']) ?? 'changed').toLowerCase()}`,
            body: str(p['when']),
            tab: 'operations',
          },
        ];
      case 'qc.result':
        return [
          {
            userIds: [
              ...(await this.leaders(str(p['responsibleDepartmentId']))),
              ...(job.createdById ? [job.createdById] : []),
            ],
            type: 'qc.result',
            title: `${n}: QC inspection ${String(p['result']).toLowerCase()}`,
            body: str(p['summary']),
            tab: 'qc',
          },
        ];
      case 'delivery.completed':
        return [
          {
            userIds: [job.createdById].filter((x): x is string => !!x),
            type: 'delivery.completed',
            title: `${n}: delivery completed`,
            tab: 'delivery',
          },
        ];
      default:
        return [];
    }
  }

  /** Creates the notification rows (skipping users who turned the type off) and pushes them live. */
  async deliver(
    eventKey: string,
    job: { id: string; jobNumber: string },
    d: Draft,
  ): Promise<void> {
    const ids = [...new Set(d.userIds)];
    if (!ids.length) return;
    const active = await this.prisma.user.findMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      select: { id: true },
    });
    const off = new Set(
      (
        await this.prisma.notificationPreference.findMany({
          where: { userId: { in: ids }, type: d.type, enabled: false },
        })
      ).map((x) => x.userId),
    );
    const recipients = active.map((u) => u.id).filter((u) => !off.has(u));
    if (!recipients.length) return;
    const link = `/jobs/${job.id}${d.tab ? `?tab=${d.tab}` : ''}`;
    const created = await this.prisma.notification.createManyAndReturn({
      data: recipients.map((userId) => ({
        userId,
        eventKey,
        type: d.type,
        title: d.title.slice(0, 300),
        body: d.body?.slice(0, 1000) ?? null,
        link,
        jobId: job.id,
      })),
      skipDuplicates: true,
      select: { userId: true },
    });
    // Live push only for rows inserted now: a retried event or a repeated
    // reminder run must not pop the same alert again.
    for (const { userId } of created)
      this.push?.toUser(userId, 'notification:new', {
        type: d.type,
        title: d.title,
        link,
      });
  }

  /** Due-soon and overdue task reminders; one per task per day. */
  async taskReminders(now = new Date()): Promise<number> {
    const day = officeDate(now);
    const today = officeToday(now);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const tasks = await this.prisma.task.findMany({
      where: {
        status: {
          in: ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'BLOCKED'],
        },
        dueDate: { not: null, lte: tomorrow },
        job: { status: 'OPEN' },
      },
      include: {
        job: { select: { id: true, jobNumber: true } },
        assignments: { where: { removedAt: null } },
      },
    });
    const keyOf = (t: (typeof tasks)[number]) =>
      `${t.dueDate! < today ? 'task.overdue' : 'task.due_soon'}:${t.id}:${day}`;
    // The worker runs this every 15 minutes: skip tasks already reminded today
    // in one query instead of re-processing each of them.
    const done = new Set(
      (
        await this.prisma.notification.findMany({
          where: { eventKey: { in: tasks.map(keyOf) } },
          select: { eventKey: true },
          distinct: ['eventKey'],
        })
      ).map((x) => x.eventKey),
    );
    const leadersOf = new Map<string, Promise<string[]>>();
    let n = 0;
    for (const t of tasks) {
      if (done.has(keyOf(t))) continue;
      const overdue = t.dueDate! < today;
      const deptKey = t.departmentId ?? '';
      if (!t.assignments.length && !leadersOf.has(deptKey))
        leadersOf.set(deptKey, this.leaders(t.departmentId));
      const users = t.assignments.length
        ? t.assignments.map((a) => a.userId)
        : await leadersOf.get(deptKey)!;
      await this.deliver(keyOf(t), t.job, {
        userIds: users,
        type: overdue ? 'task.overdue' : 'task.due_soon',
        title: `${t.job.jobNumber}: "${t.title}" ${overdue ? 'is overdue' : 'is due ' + (t.dueDate!.getTime() === today.getTime() ? 'today' : 'tomorrow')}`,
        tab: 'tasks',
      });
      n++;
    }
    return n;
  }

  private async leaders(departmentId: string | null): Promise<string[]> {
    if (!departmentId) return [];
    const rows = await this.prisma.userDepartment.findMany({
      where: { departmentId, isLeader: true, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private async departmentOfStage(
    jobId: string,
    key: string,
  ): Promise<string | null> {
    const wf = await this.prisma.jobWorkflow.findUnique({
      where: { jobId },
      include: { templateVersion: { include: { stages: { where: { key } } } } },
    });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  private async name(userId: string | null): Promise<string> {
    if (!userId) return 'Someone';
    return (
      (
        await this.prisma.user.findUnique({
          where: { id: userId },
          select: { fullName: true },
        })
      )?.fullName ?? 'Someone'
    );
  }

  private async excerpt(messageId: string | null): Promise<string | null> {
    if (!messageId) return null;
    const m = await this.prisma.discussionMessage.findUnique({
      where: { id: messageId },
      select: { body: true, deletedAt: true },
    });
    // The worker runs after the request; the message may have been deleted since.
    if (!m || m.deletedAt) return 'Message deleted';
    return m.body ? m.body.slice(0, 200) : 'Voice note or attachment';
  }

  private correction(p: P) {
    return this.prisma.correctionItem.findUnique({
      where: { id: String(p['correctionId']) },
      select: { title: true },
    });
  }
}

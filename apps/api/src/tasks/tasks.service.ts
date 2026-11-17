import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { z } from 'zod';
import type {
  createTaskSchema,
  listTasksQuerySchema,
  Paginated,
  TaskDto,
  TaskStatus,
  updateTaskSchema,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { visibleJobsWhere } from '../jobs/job-access.js';
import type { Prisma } from '../generated/prisma/client.js';

type CreateTask = z.output<typeof createTaskSchema>;
type UpdateTask = z.output<typeof updateTaskSchema>;
type ListTasks = z.output<typeof listTasksQuerySchema>;

const OPEN: TaskStatus[] = [
  'TODO',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
];
const toDate = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00.000Z`) : null;
const fromDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const today = () =>
  new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

const taskInclude = {
  job: { select: { id: true, jobNumber: true, title: true, status: true } },
  stage: {
    select: {
      id: true,
      occurrenceNo: true,
      status: true,
      templateStage: { select: { key: true, name: true } },
    },
  },
  department: { select: { id: true, code: true, name: true } },
  assignments: {
    where: { removedAt: null },
    include: { user: { select: { id: true, fullName: true } } },
  },
  dependencies: {
    include: { dependsOn: { select: { id: true, title: true, status: true } } },
  },
  checklist: { orderBy: { sequence: 'asc' } },
  comments: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { fullName: true } } },
  },
} as const;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

/**
 * Department tasks. Leaders create tasks, assign employees manually and set
 * deadlines; assignees update their own tasks. Who did what is recorded in
 * the job's history.
 */
/** Department members with task.view see their department's tasks; anyone sees tasks assigned to them. */
function canSeeTask(
  p: Principal,
  t: {
    departmentId: string;
    assignments: { userId: string; removedAt?: Date | null }[];
  },
): boolean {
  return (
    p.hasInDepartment('task.view', t.departmentId) ||
    t.assignments.some((a) => a.userId === p.userId && !a.removedAt)
  );
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
  ) {}

  async listForJob(jobId: string, p: Principal): Promise<TaskDto[]> {
    await this.jobs.authorize(jobId, p);
    const rows = await this.prisma.task.findMany({
      where: { jobId },
      include: taskInclude,
      orderBy: [{ createdAt: 'asc' }],
    });
    // Each department's tasks (and their comments) only for that department, plus tasks assigned to me.
    return this.withNames(
      rows.filter((t) => canSeeTask(p, t)),
      p,
    );
  }

  async list(q: ListTasks, p: Principal): Promise<Paginated<TaskDto>> {
    const and: Prisma.TaskWhereInput[] = [{ job: visibleJobsWhere(p) }];
    if (q.mine === 'true')
      and.push({
        assignments: { some: { userId: p.userId, removedAt: null } },
      });
    if (q.departmentId) {
      if (!p.hasInDepartment('task.view', q.departmentId))
        throw new ForbiddenException('You cannot see this department’s tasks');
      and.push({ departmentId: q.departmentId });
    }
    if (q.mine !== 'true' && !q.departmentId) {
      // Without a filter: tasks of departments where the user may view tasks.
      if (!p.hasGlobal('task.view'))
        and.push({ departmentId: { in: p.departmentsWith('task.view') } });
    }
    if (q.unassigned === 'true')
      and.push({ assignments: { none: { removedAt: null } } });
    if (q.status === 'open') and.push({ status: { in: OPEN } });
    if (q.status === 'overdue')
      and.push({ status: { in: OPEN }, dueDate: { lt: today() } });
    if (q.status === 'completed') and.push({ status: 'COMPLETED' });
    and.push({
      job: {
        status:
          q.status === 'all' || q.status === 'completed' ? undefined : 'OPEN',
      },
    });
    const where = { AND: and };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: [
          { dueDate: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      items: await this.withNames(rows, p),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  async create(
    jobId: string,
    input: CreateTask,
    p: Principal,
    meta: ActionMeta,
  ): Promise<TaskDto> {
    input = { ...input, assigneeIds: [...new Set(input.assigneeIds)] };
    const facts = await this.jobs.authorize(jobId, p);
    if (facts.status !== 'OPEN')
      throw new ConflictException('Tasks can only be added to open jobs');
    const id = await this.prisma.$transaction(async (tx) => {
      const stage = await tx.departmentStage.findUnique({
        where: { id: input.stageId },
        include: { workflow: true, templateStage: true },
      });
      if (!stage || stage.workflow.jobId !== jobId)
        throw new NotFoundException('Stage not found');
      if (!p.hasInDepartment('task.create', stage.departmentId))
        throw new ForbiddenException(
          'Only the department leader can add tasks to this stage',
        );
      if (['COMPLETED', 'RETURNED', 'CANCELLED'].includes(stage.status))
        throw new ConflictException('This stage is no longer open');
      await this.assertAssignable(tx, stage.departmentId, input.assigneeIds);
      if (
        input.assigneeIds.length &&
        !p.hasInDepartment('task.assign', stage.departmentId)
      )
        throw new ForbiddenException('You cannot assign employees');
      if (input.dependsOnIds.length) {
        const deps = await tx.task.count({
          where: { id: { in: input.dependsOnIds }, jobId },
        });
        if (deps !== new Set(input.dependsOnIds).size)
          throw new BadRequestException(
            'Dependencies must be tasks of the same job',
          );
      }
      if (input.startDate && input.dueDate && input.dueDate < input.startDate)
        throw new BadRequestException('The due date is before the start date');
      const task = await tx.task.create({
        data: {
          jobId,
          stageId: stage.id,
          departmentId: stage.departmentId,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority,
          required: input.required,
          startDate: toDate(input.startDate),
          dueDate: toDate(input.dueDate),
          status: input.assigneeIds.length ? 'ASSIGNED' : 'TODO',
          createdById: p.userId,
          assignments: {
            create: input.assigneeIds.map((userId) => ({
              userId,
              assignedById: p.userId,
            })),
          },
          dependencies: {
            create: [...new Set(input.dependsOnIds)].map((dependsOnTaskId) => ({
              dependsOnTaskId,
            })),
          },
          checklist: {
            create: input.checklist.map((label, i) => ({
              sequence: i + 1,
              label,
            })),
          },
        },
      });
      await this.audit.record(tx, meta, {
        action: 'task.created',
        entityType: 'job',
        entityId: jobId,
        summary: `Task "${task.title}" added to ${stage.templateStage.name}${input.dueDate ? `, due ${input.dueDate}` : ''}`,
        after: { taskId: task.id, assignees: input.assigneeIds },
      });
      if (input.assigneeIds.length)
        await this.assignedEvent(tx, task.id, jobId, input.assigneeIds, meta);
      return task.id;
    });
    return this.get(id, p);
  }

  async get(id: string, p: Principal): Promise<TaskDto> {
    const t = await this.prisma.task.findUnique({
      where: { id },
      include: taskInclude,
    });
    if (!t) throw new NotFoundException('Task not found');
    await this.jobs.authorize(t.jobId, p);
    if (!canSeeTask(p, t)) throw new NotFoundException('Task not found');
    return (await this.withNames([t], p))[0]!;
  }

  async update(
    id: string,
    input: UpdateTask,
    p: Principal,
    meta: ActionMeta,
  ): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.load(tx, id, p);
      const leader = p.hasInDepartment('task.update_any', t.departmentId);
      const assignee =
        t.assignments.some((a) => a.userId === p.userId) &&
        p.hasInDepartment('task.update_own', t.departmentId);
      const fieldChanges = [
        'title',
        'description',
        'priority',
        'startDate',
        'dueDate',
        'required',
      ].some((k) => (input as Record<string, unknown>)[k] !== undefined);
      if (fieldChanges && !leader)
        throw new ForbiddenException(
          'Only the department leader can change task details',
        );
      if (
        input.dueDate !== undefined &&
        !p.hasInDepartment('task.set_deadline', t.departmentId)
      )
        throw new ForbiddenException('You cannot set deadlines');
      if (input.status !== undefined && !leader && !assignee)
        throw new ForbiddenException(
          'Only the assignee or the leader can change the status',
        );
      if (t.job.status !== 'OPEN')
        throw new ConflictException('The job is not open');

      const data: Prisma.TaskUncheckedUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.startDate !== undefined)
        data.startDate = toDate(input.startDate);
      if (input.dueDate !== undefined) data.dueDate = toDate(input.dueDate);
      if (input.required !== undefined) data.required = input.required;

      let action = 'task.updated';
      let summary = `Task "${t.title}" updated`;
      if (input.status !== undefined && input.status !== t.status) {
        const next = input.status;
        if (next === 'CANCELLED') {
          if (!leader)
            throw new ForbiddenException('Only the leader can cancel a task');
          if (!input.reason)
            throw new BadRequestException('Give a reason for cancelling');
          action = 'task.cancelled';
          summary = `Task "${t.title}" cancelled: ${input.reason}`;
        } else if (t.status === 'COMPLETED' || t.status === 'CANCELLED') {
          if (!leader)
            throw new ForbiddenException('Only the leader can reopen a task');
          if (!input.reason)
            throw new BadRequestException('Give a reason for reopening');
          data.completedAt = null;
          data.completedById = null;
          action = 'task.reopened';
          summary = `Task "${t.title}" reopened: ${input.reason}`;
        } else if (next === 'COMPLETED') {
          const open = t.dependencies.filter(
            (d) =>
              d.dependsOn.status !== 'COMPLETED' &&
              d.dependsOn.status !== 'CANCELLED',
          );
          if (open.length)
            throw new ConflictException(
              `Finish first: ${open.map((d) => d.dependsOn.title).join(', ')}`,
            );
          const unchecked = t.checklist.filter((c) => !c.doneAt);
          if (unchecked.length)
            throw new ConflictException(
              `Tick the task checklist first: ${unchecked.map((c) => c.label).join(', ')}`,
            );
          data.completedAt = new Date();
          data.completedById = p.userId;
          action = 'task.completed';
          summary = `Task "${t.title}" completed`;
        } else {
          summary = `Task "${t.title}" moved to ${next.replace('_', ' ').toLowerCase()}`;
        }
        data.status = next;
      }
      await tx.task.update({ where: { id }, data });
      await this.audit.record(tx, meta, {
        action,
        entityType: 'job',
        entityId: t.jobId,
        summary,
        before: { status: t.status, dueDate: fromDate(t.dueDate) },
        after: {
          taskId: id,
          status: input.status ?? t.status,
          dueDate: input.dueDate ?? fromDate(t.dueDate),
        },
      });
      await this.outbox.enqueue(tx, {
        type: action,
        aggregateType: 'job',
        aggregateId: t.jobId,
        payload: { taskId: id, jobId: t.jobId },
        idempotencyKey: `${action}:${id}:${meta.requestId}`,
      });
    });
    return this.get(id, p);
  }

  async setAssignees(
    id: string,
    userIds: string[],
    p: Principal,
    meta: ActionMeta,
  ): Promise<TaskDto> {
    userIds = [...new Set(userIds)];
    await this.prisma.$transaction(async (tx) => {
      const t = await this.load(tx, id, p);
      if (!p.hasInDepartment('task.assign', t.departmentId))
        throw new ForbiddenException(
          'Only the department leader can assign employees',
        );
      if (t.status === 'COMPLETED' || t.status === 'CANCELLED')
        throw new ConflictException('This task is closed');
      await this.assertAssignable(tx, t.departmentId, userIds);
      const current = t.assignments.map((a) => a.userId);
      const added = userIds.filter((u) => !current.includes(u));
      const removed = current.filter((u) => !userIds.includes(u));
      if (removed.length) {
        await tx.taskAssignment.updateMany({
          where: { taskId: id, userId: { in: removed }, removedAt: null },
          data: { removedAt: new Date(), removedById: p.userId },
        });
      }
      if (added.length)
        await tx.taskAssignment.createMany({
          data: added.map((userId) => ({
            taskId: id,
            userId,
            assignedById: p.userId,
          })),
        });
      if (t.status === 'TODO' && userIds.length)
        await tx.task.update({ where: { id }, data: { status: 'ASSIGNED' } });
      if (t.status === 'ASSIGNED' && !userIds.length)
        await tx.task.update({ where: { id }, data: { status: 'TODO' } });
      const names = await tx.user.findMany({
        where: { id: { in: [...added, ...removed] } },
        select: { id: true, fullName: true },
      });
      const name = (u: string) => names.find((n) => n.id === u)?.fullName ?? u;
      await this.audit.record(tx, meta, {
        action: 'task.assigned',
        entityType: 'job',
        entityId: t.jobId,
        summary: `Task "${t.title}": ${[added.length ? `assigned ${added.map(name).join(', ')}` : '', removed.length ? `unassigned ${removed.map(name).join(', ')}` : ''].filter(Boolean).join('; ') || 'no change'}`,
        after: { taskId: id, added, removed },
      });
      if (added.length) await this.assignedEvent(tx, id, t.jobId, added, meta);
    });
    return this.get(id, p);
  }

  async comment(
    id: string,
    body: string,
    p: Principal,
    meta: ActionMeta,
  ): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.load(tx, id, p);
      const assignee = t.assignments.some((a) => a.userId === p.userId);
      if (!assignee && !p.hasInDepartment('task.view', t.departmentId))
        throw new ForbiddenException('You cannot comment on this task');
      await tx.taskComment.create({
        data: { taskId: id, authorId: p.userId, body },
      });
      await this.outbox.enqueue(tx, {
        type: 'task.commented',
        aggregateType: 'job',
        aggregateId: t.jobId,
        payload: { taskId: id, jobId: t.jobId },
        idempotencyKey: `task.commented:${id}:${meta.requestId}`,
      });
    });
    return this.get(id, p);
  }

  async toggleChecklist(
    id: string,
    itemId: string,
    done: boolean,
    p: Principal,
  ): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.load(tx, id, p);
      const assignee =
        t.assignments.some((a) => a.userId === p.userId) &&
        p.hasInDepartment('task.update_own', t.departmentId);
      if (!assignee && !p.hasInDepartment('task.update_any', t.departmentId))
        throw new ForbiddenException(
          'Only the assignee or the leader can tick this checklist',
        );
      const item = t.checklist.find((c) => c.id === itemId);
      if (!item) throw new NotFoundException('Checklist item not found');
      await tx.taskChecklistItem.update({
        where: { id: itemId },
        data: done
          ? { doneAt: new Date(), doneById: p.userId }
          : { doneAt: null, doneById: null },
      });
    });
    return this.get(id, p);
  }

  /** Department internal deadline for a stage (separate from the customer date and task deadlines). */
  async setStageDeadline(
    jobId: string,
    stageId: string,
    date: string | null,
    p: Principal,
    meta: ActionMeta,
  ): Promise<void> {
    await this.jobs.authorize(jobId, p);
    await this.prisma.$transaction(async (tx) => {
      const stage = await tx.departmentStage.findUnique({
        where: { id: stageId },
        include: { workflow: true, templateStage: true },
      });
      if (!stage || stage.workflow.jobId !== jobId)
        throw new NotFoundException('Stage not found');
      if (!p.hasInDepartment('task.set_deadline', stage.departmentId))
        throw new ForbiddenException(
          'Only the department leader can set this deadline',
        );
      if (['COMPLETED', 'RETURNED', 'CANCELLED'].includes(stage.status))
        throw new ConflictException('This stage is closed');
      await tx.departmentStage.update({
        where: { id: stageId },
        data: { internalDeadline: toDate(date) },
      });
      await this.audit.record(tx, meta, {
        action: 'stage.deadline_set',
        entityType: 'job',
        entityId: jobId,
        summary: `${stage.templateStage.name} internal deadline ${date ? `set to ${date}` : 'cleared'} (customer date unchanged)`,
        before: { internalDeadline: fromDate(stage.internalDeadline) },
        after: { internalDeadline: date },
      });
    });
  }

  // ------------------------------------------------------------ helpers

  /** Loads a task for a change: locked, visible to the caller, and on an open job. */
  private async load(tx: Tx, id: string, p: Principal): Promise<TaskRow> {
    await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.task.findUnique({ where: { id }, include: taskInclude });
    if (!t) throw new NotFoundException('Task not found');
    const facts = await this.jobs.authorize(t.jobId, p, undefined, tx);
    if (!canSeeTask(p, t)) throw new NotFoundException('Task not found');
    if (facts.status !== 'OPEN')
      throw new ConflictException('The job is not open');
    return t;
  }

  private async assertAssignable(
    tx: Tx,
    departmentId: string,
    userIds: string[],
  ): Promise<void> {
    if (!userIds.length) return;
    const ok = await tx.userDepartment.count({
      where: {
        departmentId,
        userId: { in: userIds },
        user: { status: 'ACTIVE' },
      },
    });
    if (ok !== new Set(userIds).size)
      throw new BadRequestException(
        'Tasks can only be assigned to active members of the department',
      );
  }

  private async assignedEvent(
    tx: Tx,
    taskId: string,
    jobId: string,
    userIds: string[],
    meta: ActionMeta,
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      type: 'task.assigned',
      aggregateType: 'job',
      aggregateId: jobId,
      payload: { taskId, jobId, userIds, assignedById: meta.actorId },
      idempotencyKey: `task.assigned:${taskId}:${userIds.sort().join(',')}:${meta.requestId}`,
    });
  }

  private async withNames(rows: TaskRow[], p: Principal): Promise<TaskDto[]> {
    const ids = [
      ...new Set(
        rows
          .flatMap((t) => [
            t.createdById,
            t.completedById,
            ...t.checklist.map((c) => c.doneById),
          ])
          .filter((x): x is string => !!x),
      ),
    ];
    const users = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, fullName: true },
        })
      ).map((u) => [u.id, u.fullName]),
    );
    const now = today();
    return rows.map((t) => {
      const leader = p.hasInDepartment('task.update_any', t.departmentId);
      const assignee =
        t.assignments.some((a) => a.userId === p.userId) &&
        p.hasInDepartment('task.update_own', t.departmentId);
      const open = OPEN.includes(t.status);
      const actions: TaskDto['allowedActions'] = [];
      if (t.job.status === 'OPEN') {
        if (leader) actions.push('edit', 'cancel');
        if (open && p.hasInDepartment('task.assign', t.departmentId))
          actions.push('assign');
        if (leader || (assignee && open)) actions.push('updateStatus');
        if (assignee || p.hasInDepartment('task.view', t.departmentId))
          actions.push('comment');
      }
      return {
        id: t.id,
        jobId: t.job.id,
        jobNumber: t.job.jobNumber,
        jobTitle: t.job.title,
        stage: {
          id: t.stage.id,
          key: t.stage.templateStage.key,
          name: t.stage.templateStage.name,
          occurrenceNo: t.stage.occurrenceNo,
        },
        department: t.department,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: t.status,
        required: t.required,
        startDate: fromDate(t.startDate),
        dueDate: fromDate(t.dueDate),
        overdue: open && !!t.dueDate && t.dueDate < now,
        assignees: t.assignments.map((a) => a.user),
        dependsOn: t.dependencies.map((d) => d.dependsOn),
        checklist: t.checklist.map((c) => ({
          id: c.id,
          label: c.label,
          done: !!c.doneAt,
          doneBy: c.doneById ? (users.get(c.doneById) ?? null) : null,
        })),
        comments: t.comments.map((c) => ({
          id: c.id,
          author: c.author?.fullName ?? 'system',
          body: c.body,
          createdAt: c.createdAt.toISOString(),
        })),
        createdBy: t.createdById ? (users.get(t.createdById) ?? null) : null,
        completedAt: t.completedAt?.toISOString() ?? null,
        completedBy: t.completedById
          ? (users.get(t.completedById) ?? null)
          : null,
        createdAt: t.createdAt.toISOString(),
        allowedActions: actions,
      };
    });
  }
}

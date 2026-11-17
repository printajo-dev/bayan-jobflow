import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type {
  createInstallationOrderSchema,
  createProductionOrderSchema,
  createScheduleSchema,
  InstallationOrderDto,
  machineSchema,
  MachineDto,
  operationLogSchema,
  OperationsDto,
  ProductionOrderDto,
  updateInstallationOrderSchema,
  updateProductionOrderSchema,
  updateScheduleSchema,
  VehicleScheduleDto,
} from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';
import { postSystemMessage } from '../discussions/channels.js';
import type { Prisma } from '../generated/prisma/client.js';

type CreateSchedule = z.output<typeof createScheduleSchema>;
type UpdateSchedule = z.output<typeof updateScheduleSchema>;
type CreateProduction = z.output<typeof createProductionOrderSchema>;
type UpdateProduction = z.output<typeof updateProductionOrderSchema>;
type CreateInstallation = z.output<typeof createInstallationOrderSchema>;
type UpdateInstallation = z.output<typeof updateInstallationOrderSchema>;
type Log = z.output<typeof operationLogSchema>;

/** Template stage keys handled by each kind of order. */
export const PRODUCTION_STAGE_KEYS = ['print', 'production'];
export const INSTALLATION_STAGE_KEYS = ['wrap', 'installation'];

const dt = (v: string | null | undefined) => (v ? new Date(v) : null);
const iso = (d: Date | null) => d?.toISOString() ?? null;

const stageSelect = { id: true, occurrenceNo: true, status: true, departmentId: true, templateStage: { select: { key: true, name: true } } } as const;
const logInclude = { orderBy: { createdAt: 'asc' } } as const;
const productionInclude = { stage: { select: stageSelect }, machine: true, operator: { select: { id: true, fullName: true } }, logs: logInclude } as const;
const installationInclude = {
  stage: { select: stageSelect },
  teamLeader: { select: { id: true, fullName: true } },
  assignments: { include: { user: { select: { id: true, fullName: true } } } },
  materials: true,
  logs: logInclude,
} as const;
type ProductionRow = Prisma.ProductionOrderGetPayload<{ include: typeof productionInclude }>;
type InstallationRow = Prisma.InstallationOrderGetPayload<{ include: typeof installationInclude }>;

/**
 * Vehicle scheduling (Logistic), production (print / fabrication) and
 * installation (wrap / signage install). Orders belong to one occurrence of
 * the stage, so rework creates fresh orders while earlier ones stay in the
 * history. The stage checks (logistics.schedule_confirmed,
 * production.completed, installation.completed) read these records.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
  ) {}

  // ------------------------------------------------------------ overview

  async get(jobId: string, p: Principal): Promise<OperationsDto> {
    const facts = await this.jobs.authorize(jobId, p);
    const open = facts.status === 'OPEN';
    const stages = await this.prisma.departmentStage.findMany({ where: { workflow: { jobId } }, select: stageSelect, orderBy: { createdAt: 'asc' } });
    const live = stages.filter((s) => ['PENDING', 'ACTIVE', 'ON_HOLD'].includes(s.status));
    const prodStages = live.filter((s) => PRODUCTION_STAGE_KEYS.includes(s.templateStage.key));
    const instStages = live.filter((s) => INSTALLATION_STAGE_KEYS.includes(s.templateStage.key));
    const scheduleDept = await this.stageDepartment(this.prisma, jobId, 'vehicle_schedule');

    const [schedules, production, installation, machines] = await Promise.all([
      p.has('vehicle_schedule.view') ? this.prisma.vehicleSchedule.findMany({ where: { jobId }, include: { history: { orderBy: { createdAt: 'asc' } } }, orderBy: { plannedStart: 'asc' } }) : [],
      p.has('production.view') ? this.prisma.productionOrder.findMany({ where: { jobId }, include: productionInclude, orderBy: { createdAt: 'asc' } }) : [],
      p.has('installation.view') ? this.prisma.installationOrder.findMany({ where: { jobId }, include: installationInclude, orderBy: { createdAt: 'asc' } }) : [],
      this.prisma.machine.findMany({ orderBy: { name: 'asc' } }),
    ]);
    const actions: OperationsDto['allowedActions'] = [];
    if (open && scheduleDept && p.hasInDepartment('vehicle_schedule.manage', scheduleDept)) actions.push('schedule');
    if (open && prodStages.some((s) => p.hasInDepartment('production.manage', s.departmentId))) actions.push('production');
    if (open && instStages.some((s) => p.hasInDepartment('installation.manage', s.departmentId))) actions.push('installation');
    return {
      schedules: await this.scheduleDtos(schedules),
      productionOrders: await this.productionDtos(production),
      installationOrders: await this.installationDtos(installation),
      machines: machines.map(toMachine),
      stages: {
        production: prodStages.map((s) => ({ id: s.id, name: s.templateStage.name, occurrenceNo: s.occurrenceNo })),
        installation: instStages.map((s) => ({ id: s.id, name: s.templateStage.name, occurrenceNo: s.occurrenceNo })),
      },
      allowedActions: actions,
    };
  }

  /** Uploaded evidence for schedules, production, installation or PRO documents. */
  async authorizeUpload(jobId: string, kind: 'authority' | 'production' | 'installation' | 'schedule', p: Principal): Promise<void> {
    const facts = await this.jobs.authorize(jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    const perm = ({ authority: 'authority.manage', production: 'production.manage', installation: 'installation.manage', schedule: 'vehicle_schedule.manage' } as const)[kind];
    if (!p.has(perm)) throw new ForbiddenException('You cannot upload these files');
  }

  // ------------------------------------------------------------ vehicle schedules

  async createSchedule(jobId: string, input: CreateSchedule, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const dept = await this.requireManage(jobId, p, 'vehicle_schedule');
    if (input.plannedEnd && input.plannedEnd < input.plannedStart) throw new BadRequestException('The end is before the start');
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.vehicleSchedule.create({
        data: { jobId, vehicleRef: input.vehicleRef, plannedStart: new Date(input.plannedStart), plannedEnd: dt(input.plannedEnd), location: input.location, notes: input.notes ?? null, createdById: p.userId },
      });
      await tx.vehicleScheduleHistory.create({ data: { scheduleId: s.id, action: 'proposed', snapshot: snapshot(s), actorId: p.userId } });
      await this.audit.record(tx, meta, { action: 'schedule.created', entityType: 'job', entityId: jobId, summary: `Vehicle schedule proposed for ${input.vehicleRef} at ${input.location}, ${input.plannedStart}` });
      await postSystemMessage(tx, jobId, dept, `Vehicle schedule proposed: ${input.vehicleRef}, ${input.location}, ${fmt(input.plannedStart)}. Waiting for confirmation of vehicle availability.`);
    });
    return this.get(jobId, p);
  }

  async updateSchedule(id: string, input: UpdateSchedule, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const s = await this.prisma.vehicleSchedule.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found');
    const dept = await this.requireManage(s.jobId, p, 'vehicle_schedule');
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.VehicleScheduleUncheckedUpdateInput = {};
      const timeChanged = (input.plannedStart && input.plannedStart !== s.plannedStart.toISOString()) || (input.plannedEnd !== undefined && input.plannedEnd !== iso(s.plannedEnd));
      if (input.vehicleRef !== undefined) data.vehicleRef = input.vehicleRef;
      if (input.plannedStart !== undefined) data.plannedStart = new Date(input.plannedStart);
      if (input.plannedEnd !== undefined) data.plannedEnd = dt(input.plannedEnd);
      if (input.location !== undefined) data.location = input.location;
      if (input.notes !== undefined) data.notes = input.notes;
      let action = 'updated';
      let next = input.status;
      if (s.status === 'CANCELLED' || s.status === 'COMPLETED') throw new ConflictException('This schedule is closed');
      // A confirmed schedule whose time changes goes back to "rescheduled" until availability is confirmed again.
      if (timeChanged && s.status === 'CONFIRMED' && next !== 'CANCELLED') {
        if (!input.reason) throw new BadRequestException('Give a reason for rescheduling');
        next = next === 'CONFIRMED' ? 'CONFIRMED' : 'RESCHEDULED';
      }
      if (next && next !== s.status) {
        if (next === 'CONFIRMED') {
          if (!input.confirmationNote) throw new BadRequestException('Record who confirmed the vehicle is available');
          data.confirmationNote = input.confirmationNote;
          data.confirmedById = p.userId;
          data.confirmedAt = new Date();
        } else {
          data.confirmedAt = null;
          data.confirmedById = null;
        }
        if (next === 'CANCELLED' && !input.reason) throw new BadRequestException('Give a reason for cancelling');
        data.status = next;
        action = next.toLowerCase();
      }
      const updated = await tx.vehicleSchedule.update({ where: { id }, data });
      await tx.vehicleScheduleHistory.create({ data: { scheduleId: id, action, snapshot: snapshot(updated), actorId: p.userId, reason: input.reason ?? input.confirmationNote ?? null } });
      await this.audit.record(tx, meta, {
        action: `schedule.${action}`,
        entityType: 'job',
        entityId: s.jobId,
        summary: `Vehicle schedule ${action}: ${updated.vehicleRef}, ${updated.location}, ${fmt(updated.plannedStart.toISOString())}${input.reason ? ` (${input.reason})` : ''}`,
        before: snapshot(s),
        after: snapshot(updated),
      });
      if (['confirmed', 'rescheduled', 'cancelled'].includes(action)) {
        await this.outbox.enqueue(tx, {
          type: 'vehicle.schedule.changed',
          aggregateType: 'job',
          aggregateId: s.jobId,
          payload: { jobId: s.jobId, scheduleId: id, status: updated.status, when: fmt(updated.plannedStart.toISOString()) },
          idempotencyKey: `vehicle.schedule.changed:${id}:${meta.requestId}`,
        });
        await postSystemMessage(tx, s.jobId, dept, `Vehicle schedule ${action}: ${updated.vehicleRef} on ${fmt(updated.plannedStart.toISOString())} at ${updated.location}.`);
        await postSystemMessage(tx, s.jobId, null, `Vehicle schedule ${action}: ${updated.vehicleRef} on ${fmt(updated.plannedStart.toISOString())} at ${updated.location}.`);
      }
    });
    return this.get(s.jobId, p);
  }

  // ------------------------------------------------------------ production

  async createProduction(jobId: string, input: CreateProduction, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    await this.jobs.authorize(jobId, p);
    await this.prisma.$transaction(async (tx) => {
      const stage = await this.orderStage(tx, jobId, input.stageId, PRODUCTION_STAGE_KEYS);
      if (!p.hasInDepartment('production.manage', stage.departmentId)) throw new ForbiddenException('Only the Production Team can plan production');
      let versionId: string | null = input.artworkVersionId ?? null;
      if (stage.templateStage.key === 'print') {
        // Vehicle Branding prints only the approved artwork version.
        const latest = await tx.artworkVersion.findFirst({ where: { jobId }, orderBy: { versionNo: 'desc' }, include: { _count: { select: { approvals: true } } } });
        if (!latest || latest._count.approvals === 0) throw new ConflictException('There is no customer-approved artwork version to print');
        if (versionId && versionId !== latest.id) throw new ConflictException(`Print the latest approved artwork (version ${latest.versionNo})`);
        versionId = latest.id;
      } else if (versionId) {
        const v = await tx.artworkVersion.findUnique({ where: { id: versionId } });
        if (!v || v.jobId !== jobId) throw new BadRequestException('Artwork version not found');
      }
      await this.checkMachineOperator(tx, input.machineId, input.operatorId, stage.departmentId);
      const o = await tx.productionOrder.create({
        data: {
          jobId,
          stageId: stage.id,
          title: input.title,
          activity: input.activity,
          artworkVersionId: versionId,
          material: input.material ?? null,
          quantity: input.quantity ?? null,
          dimensions: input.dimensions ?? null,
          machineId: input.machineId ?? null,
          operatorId: input.operatorId ?? null,
          plannedStart: dt(input.plannedStart),
          plannedFinish: dt(input.plannedFinish),
          notes: input.notes ?? null,
          createdById: p.userId,
        },
      });
      await this.audit.record(tx, meta, { action: 'production.order_created', entityType: 'job', entityId: jobId, summary: `Production order "${o.title}" planned (${o.activity.toLowerCase()})`, after: { orderId: o.id } });
    });
    return this.get(jobId, p);
  }

  async updateProduction(id: string, input: UpdateProduction, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const o = await this.prisma.productionOrder.findUnique({ where: { id }, include: { stage: { select: stageSelect }, logs: true } });
    if (!o) throw new NotFoundException('Production order not found');
    const facts = await this.jobs.authorize(o.jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    if (!p.hasInDepartment('production.manage', o.stage.departmentId)) throw new ForbiddenException('Only the Production Team can update production');
    if (o.status === 'COMPLETED' || o.status === 'CANCELLED') throw new ConflictException('This production order is closed');
    await this.prisma.$transaction(async (tx) => {
      await this.checkMachineOperator(tx, input.machineId, input.operatorId, o.stage.departmentId);
      const data: Prisma.ProductionOrderUncheckedUpdateInput = {};
      for (const k of ['title', 'material', 'quantity', 'dimensions', 'machineId', 'operatorId', 'wastageNotes', 'notes'] as const) {
        if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
      }
      for (const k of ['plannedStart', 'plannedFinish', 'actualStart', 'actualFinish'] as const) if (input[k] !== undefined) data[k] = dt(input[k]);
      if (input.status && input.status !== o.status) {
        if (input.status === 'IN_PROGRESS' && !o.actualStart && !input.actualStart) data.actualStart = new Date();
        if (input.status === 'COMPLETED') {
          if (!o.logs.some((l) => l.fileIds.length > 0)) throw new ConflictException('Add a log with completion evidence (photo or document) first');
          if (!o.actualFinish && !input.actualFinish) data.actualFinish = new Date();
        }
        if ((input.status === 'CANCELLED' || input.status === 'ON_HOLD') && !input.reason) throw new BadRequestException('Give a reason');
        data.status = input.status;
      }
      await tx.productionOrder.update({ where: { id }, data });
      if (input.status && input.status !== o.status) {
        await tx.operationLog.create({ data: { productionOrderId: id, note: `Status: ${input.status.toLowerCase().replace('_', ' ')}${input.reason ? ` — ${input.reason}` : ''}`, status: input.status, actorId: p.userId } });
      }
      await this.audit.record(tx, meta, {
        action: input.status === 'COMPLETED' ? 'production.completed' : 'production.updated',
        entityType: 'job',
        entityId: o.jobId,
        summary: `Production "${o.title}" ${input.status && input.status !== o.status ? `→ ${input.status.toLowerCase().replace('_', ' ')}` : 'updated'}`,
      });
      if (input.status === 'COMPLETED') await postSystemMessage(tx, o.jobId, o.stage.departmentId, `Production completed: ${o.title}.`, o.stageId);
    });
    return this.get(o.jobId, p);
  }

  async logProduction(id: string, input: Log, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const o = await this.prisma.productionOrder.findUnique({ where: { id }, include: { stage: { select: stageSelect } } });
    if (!o) throw new NotFoundException('Production order not found');
    await this.jobs.authorize(o.jobId, p);
    if (!p.hasInDepartment('production.manage', o.stage.departmentId)) throw new ForbiddenException('Only the Production Team can log production');
    await this.prisma.$transaction(async (tx) => {
      await this.assertFiles(tx, o.jobId, input.fileIds, p.userId);
      await tx.operationLog.create({ data: { productionOrderId: id, note: input.note, quantityDone: input.quantityDone ?? null, fileIds: input.fileIds, actorId: p.userId } });
      await this.audit.record(tx, meta, { action: 'production.logged', entityType: 'job', entityId: o.jobId, summary: `Production log on "${o.title}": ${input.note.slice(0, 200)}` });
    });
    return this.get(o.jobId, p);
  }

  // ------------------------------------------------------------ installation

  async createInstallation(jobId: string, input: CreateInstallation, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    await this.jobs.authorize(jobId, p);
    await this.prisma.$transaction(async (tx) => {
      const stage = await this.orderStage(tx, jobId, input.stageId, INSTALLATION_STAGE_KEYS);
      if (!p.hasInDepartment('installation.manage', stage.departmentId)) throw new ForbiddenException('Only the Installation Team can plan installation');
      await this.checkTechnicians(tx, [...input.technicianIds, ...(input.teamLeaderId ? [input.teamLeaderId] : [])], stage.departmentId);
      const o = await tx.installationOrder.create({
        data: {
          jobId,
          stageId: stage.id,
          target: input.target,
          address: input.address ?? null,
          accessNotes: input.accessNotes ?? null,
          safetyNotes: input.safetyNotes ?? null,
          instructions: input.instructions ?? null,
          scheduledStart: dt(input.scheduledStart),
          scheduledEnd: dt(input.scheduledEnd),
          teamLeaderId: input.teamLeaderId ?? null,
          createdById: p.userId,
          assignments: { create: [...new Set(input.technicianIds)].map((userId) => ({ userId })) },
          materials: { create: input.materials.map((m) => ({ item: m.item, quantity: m.quantity, unit: m.unit ?? null })) },
        },
      });
      await this.audit.record(tx, meta, { action: 'installation.order_created', entityType: 'job', entityId: jobId, summary: `Installation planned: ${o.target}${o.scheduledStart ? `, ${fmt(o.scheduledStart.toISOString())}` : ''}`, after: { orderId: o.id } });
    });
    return this.get(jobId, p);
  }

  async updateInstallation(id: string, input: UpdateInstallation, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const o = await this.prisma.installationOrder.findUnique({ where: { id }, include: { stage: { select: stageSelect }, logs: true } });
    if (!o) throw new NotFoundException('Installation order not found');
    const facts = await this.jobs.authorize(o.jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    if (!p.hasInDepartment('installation.manage', o.stage.departmentId)) throw new ForbiddenException('Only the Installation Team can update installation');
    if (o.status === 'COMPLETED' || o.status === 'CANCELLED') throw new ConflictException('This installation order is closed');
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.InstallationOrderUncheckedUpdateInput = {};
      for (const k of ['target', 'address', 'accessNotes', 'safetyNotes', 'instructions', 'teamLeaderId', 'issues'] as const) {
        if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
      }
      if (input.scheduledStart !== undefined) data.scheduledStart = dt(input.scheduledStart);
      if (input.scheduledEnd !== undefined) data.scheduledEnd = dt(input.scheduledEnd);
      if (input.technicianIds) {
        await this.checkTechnicians(tx, input.technicianIds, o.stage.departmentId);
        await tx.installationAssignment.deleteMany({ where: { orderId: id, userId: { notIn: input.technicianIds } } });
        await tx.installationAssignment.createMany({ data: input.technicianIds.map((userId) => ({ orderId: id, userId })), skipDuplicates: true });
      }
      if (input.teamLeaderId) await this.checkTechnicians(tx, [input.teamLeaderId], o.stage.departmentId);
      if (input.status && input.status !== o.status) {
        if (input.status === 'IN_PROGRESS' && !o.startedAt) data.startedAt = new Date();
        if (input.status === 'COMPLETED') {
          if (!o.logs.some((l) => l.fileIds.length > 0)) throw new ConflictException('Add completion photos in a log first');
          data.finishedAt = new Date();
        }
        if (['BLOCKED', 'PARTIAL', 'CANCELLED'].includes(input.status) && !input.reason && !input.issues) throw new BadRequestException('Describe the issue');
        data.status = input.status;
      }
      await tx.installationOrder.update({ where: { id }, data });
      if (input.status && input.status !== o.status) {
        await tx.operationLog.create({ data: { installationOrderId: id, note: `Status: ${input.status.toLowerCase().replace('_', ' ')}${input.reason ? ` — ${input.reason}` : ''}`, status: input.status, actorId: p.userId } });
      }
      await this.audit.record(tx, meta, {
        action: input.status === 'COMPLETED' ? 'installation.completed' : 'installation.updated',
        entityType: 'job',
        entityId: o.jobId,
        summary: `Installation "${o.target}" ${input.status && input.status !== o.status ? `→ ${input.status.toLowerCase().replace('_', ' ')}` : 'updated'}${input.reason ? ` (${input.reason})` : ''}`,
      });
      if (input.status === 'COMPLETED') await postSystemMessage(tx, o.jobId, o.stage.departmentId, `Installation completed: ${o.target}.`, o.stageId);
    });
    return this.get(o.jobId, p);
  }

  async logInstallation(id: string, input: Log, p: Principal, meta: ActionMeta): Promise<OperationsDto> {
    const o = await this.prisma.installationOrder.findUnique({ where: { id }, include: { stage: { select: stageSelect }, assignments: true } });
    if (!o) throw new NotFoundException('Installation order not found');
    await this.jobs.authorize(o.jobId, p);
    const technician = o.assignments.some((a) => a.userId === p.userId) || o.teamLeaderId === p.userId;
    if (!p.hasInDepartment('installation.manage', o.stage.departmentId) && !technician) throw new ForbiddenException('Only the installation team can log progress');
    await this.prisma.$transaction(async (tx) => {
      await this.assertFiles(tx, o.jobId, input.fileIds, p.userId);
      await tx.operationLog.create({ data: { installationOrderId: id, note: input.note, quantityDone: input.quantityDone ?? null, fileIds: input.fileIds, actorId: p.userId } });
      await this.audit.record(tx, meta, { action: 'installation.logged', entityType: 'job', entityId: o.jobId, summary: `Installation log on "${o.target}": ${input.note.slice(0, 200)}` });
    });
    return this.get(o.jobId, p);
  }

  // ------------------------------------------------------------ machines

  async machines(): Promise<MachineDto[]> {
    return (await this.prisma.machine.findMany({ orderBy: { name: 'asc' } })).map(toMachine);
  }

  async saveMachine(id: string | null, input: z.output<typeof machineSchema>, p: Principal, meta: ActionMeta): Promise<MachineDto> {
    if (!p.has('production.manage') && !p.hasGlobal('settings.manage')) throw new ForbiddenException('Only Production or an administrator can manage machines');
    return this.prisma.$transaction(async (tx) => {
      const m = id
        ? await tx.machine.update({ where: { id }, data: { name: input.name, kind: input.kind ?? null, isActive: input.isActive } })
        : await tx.machine.create({ data: { code: input.code, name: input.name, kind: input.kind ?? null, isActive: input.isActive } });
      await this.audit.record(tx, meta, { action: id ? 'machine.updated' : 'machine.created', entityType: 'settings', summary: `Machine ${m.name} ${id ? 'updated' : 'added'}` });
      return toMachine(m);
    });
  }

  // ------------------------------------------------------------ helpers

  private async stageDepartment(db: Tx, jobId: string, key: string): Promise<string | null> {
    const wf = await db.jobWorkflow.findUnique({ where: { jobId }, include: { templateVersion: { include: { stages: { where: { key } } } } } });
    return wf?.templateVersion.stages[0]?.departmentId ?? null;
  }

  private async requireManage(jobId: string, p: Principal, kind: 'vehicle_schedule'): Promise<string> {
    const facts = await this.jobs.authorize(jobId, p);
    if (facts.status !== 'OPEN') throw new ConflictException('The job is not open');
    const dept = await this.stageDepartment(this.prisma, jobId, kind);
    if (!dept) throw new BadRequestException('This job has no vehicle schedule stage');
    if (!p.hasInDepartment('vehicle_schedule.manage', dept)) throw new ForbiddenException('Only the Logistic Team can manage vehicle schedules');
    return dept;
  }

  private async orderStage(tx: Tx, jobId: string, stageId: string, keys: string[]) {
    const stage = await tx.departmentStage.findUnique({ where: { id: stageId }, select: { ...stageSelect, workflow: { select: { jobId: true } } } });
    if (!stage || stage.workflow.jobId !== jobId || !keys.includes(stage.templateStage.key)) throw new BadRequestException('Choose a production or installation stage of this job');
    if (!['PENDING', 'ACTIVE', 'ON_HOLD'].includes(stage.status)) throw new ConflictException('That stage is already closed');
    return stage;
  }

  private async checkMachineOperator(tx: Tx, machineId: string | null | undefined, operatorId: string | null | undefined, departmentId: string) {
    if (machineId && !(await tx.machine.count({ where: { id: machineId, isActive: true } }))) throw new BadRequestException('Unknown or inactive machine');
    if (operatorId) await this.checkTechnicians(tx, [operatorId], departmentId);
  }

  private async checkTechnicians(tx: Tx, userIds: string[], departmentId: string) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const n = await tx.userDepartment.count({ where: { departmentId, userId: { in: ids }, user: { status: 'ACTIVE' } } });
    if (n !== ids.length) throw new BadRequestException('People must be active members of the department');
  }

  private async assertFiles(tx: Tx, jobId: string, fileIds: string[], userId: string) {
    if (!fileIds.length) return;
    const n = await tx.jobFile.count({ where: { jobId, fileId: { in: fileIds }, purpose: 'OPERATIONS', addedById: userId, removedAt: null } });
    if (n !== new Set(fileIds).size) throw new BadRequestException('Upload the evidence files first');
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  }

  private async files(ids: string[]) {
    const list = [...new Set(ids)];
    return new Map((await this.prisma.file.findMany({ where: { id: { in: list } }, select: { id: true, originalName: true, mimeType: true } })).map((f) => [f.id, f]));
  }

  private async scheduleDtos(rows: (Prisma.VehicleScheduleGetPayload<{ include: { history: true } }>)[]): Promise<VehicleScheduleDto[]> {
    const users = await this.names(rows.flatMap((r) => [r.confirmedById, ...r.history.map((h) => h.actorId)]));
    return rows.map((r) => ({
      id: r.id,
      vehicleRef: r.vehicleRef,
      plannedStart: r.plannedStart.toISOString(),
      plannedEnd: iso(r.plannedEnd),
      location: r.location,
      notes: r.notes,
      status: r.status,
      confirmationNote: r.confirmationNote,
      confirmedBy: r.confirmedById ? (users.get(r.confirmedById) ?? null) : null,
      confirmedAt: iso(r.confirmedAt),
      history: r.history.map((h) => ({ action: h.action, actor: h.actorId ? (users.get(h.actorId) ?? null) : null, reason: h.reason, at: h.createdAt.toISOString(), snapshot: h.snapshot })),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async logDtos(logs: { id: string; note: string; quantityDone: number | null; status: string | null; actorId: string | null; fileIds: string[]; createdAt: Date }[]) {
    const users = await this.names(logs.map((l) => l.actorId));
    const files = await this.files(logs.flatMap((l) => l.fileIds));
    return logs.map((l) => ({
      id: l.id,
      note: l.note,
      quantityDone: l.quantityDone,
      status: l.status,
      actor: l.actorId ? (users.get(l.actorId) ?? null) : null,
      files: l.fileIds.map((id) => files.get(id)).filter((f): f is { id: string; originalName: string; mimeType: string } => !!f),
      createdAt: l.createdAt.toISOString(),
    }));
  }

  private async productionDtos(rows: ProductionRow[]): Promise<ProductionOrderDto[]> {
    const versions = new Map(
      (await this.prisma.artworkVersion.findMany({ where: { id: { in: rows.map((r) => r.artworkVersionId).filter((x): x is string => !!x) } }, select: { id: true, versionNo: true } })).map((v) => [v.id, v.versionNo]),
    );
    const out: ProductionOrderDto[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        stage: { id: r.stage.id, key: r.stage.templateStage.key, name: r.stage.templateStage.name, occurrenceNo: r.stage.occurrenceNo },
        title: r.title,
        activity: r.activity,
        artworkVersionNo: r.artworkVersionId ? (versions.get(r.artworkVersionId) ?? null) : null,
        material: r.material,
        quantity: r.quantity,
        dimensions: r.dimensions,
        machine: r.machine ? toMachine(r.machine) : null,
        operator: r.operator,
        plannedStart: iso(r.plannedStart),
        plannedFinish: iso(r.plannedFinish),
        actualStart: iso(r.actualStart),
        actualFinish: iso(r.actualFinish),
        status: r.status,
        wastageNotes: r.wastageNotes,
        notes: r.notes,
        logs: await this.logDtos(r.logs),
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }

  private async installationDtos(rows: InstallationRow[]): Promise<InstallationOrderDto[]> {
    const out: InstallationOrderDto[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        stage: { id: r.stage.id, key: r.stage.templateStage.key, name: r.stage.templateStage.name, occurrenceNo: r.stage.occurrenceNo },
        target: r.target,
        address: r.address,
        accessNotes: r.accessNotes,
        safetyNotes: r.safetyNotes,
        instructions: r.instructions,
        scheduledStart: iso(r.scheduledStart),
        scheduledEnd: iso(r.scheduledEnd),
        startedAt: iso(r.startedAt),
        finishedAt: iso(r.finishedAt),
        teamLeader: r.teamLeader,
        technicians: r.assignments.map((a) => a.user),
        materials: r.materials.map((m) => ({ item: m.item, quantity: Number(m.quantity), unit: m.unit })),
        status: r.status,
        issues: r.issues,
        logs: await this.logDtos(r.logs),
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }
}

function toMachine(m: { id: string; code: string; name: string; kind: string | null; isActive: boolean }): MachineDto {
  return { id: m.id, code: m.code, name: m.name, kind: m.kind, isActive: m.isActive };
}

function snapshot(s: { vehicleRef: string; plannedStart: Date; plannedEnd: Date | null; location: string; status: string }) {
  return { vehicleRef: s.vehicleRef, plannedStart: s.plannedStart.toISOString(), plannedEnd: iso(s.plannedEnd), location: s.location, status: s.status };
}

function fmt(isoString: string): string {
  return new Date(isoString).toLocaleString('en-GB', { timeZone: process.env['TZ'] ?? 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

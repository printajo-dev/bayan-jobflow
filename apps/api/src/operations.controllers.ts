import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import {
  authorityDocumentSchema,
  authorityPaymentSchema,
  authorityTypeSchema,
  createAuthorityApplicationSchema,
  createInstallationOrderSchema,
  createProductionOrderSchema,
  createScheduleSchema,
  machineSchema,
  operationLogSchema,
  reasonSchema,
  updateAuthorityApplicationSchema,
  updateInstallationOrderSchema,
  updateProductionOrderSchema,
  updateScheduleSchema,
  uuidSchema,
} from '@jobflow/shared';
import { type ActionMeta, CurrentPrincipal, Meta, RequirePermissions } from './access/decorators.js';
import type { Principal } from './access/principal.js';
import { uploadInterceptor } from './files/upload.js';
import { FilesService, type StoredUpload } from './files/files.service.js';
import { AuthorityService } from './authority/authority.service.js';
import { OperationsService } from './operations/operations.service.js';

const id = { schema: uuidSchema };
type Out<T extends z.ZodType> = z.output<T>;

@Controller()
export class AuthorityController {
  constructor(private readonly authority: AuthorityService) {}

  @Get('authority-types')
  types() {
    return this.authority.types();
  }

  @Post('authority-types')
  @RequirePermissions('settings.manage')
  createType(@Body({ schema: authorityTypeSchema }) body: Out<typeof authorityTypeSchema>, @Meta() meta: ActionMeta) {
    return this.authority.saveType(null, body, meta);
  }

  @Patch('authority-types/:id')
  @RequirePermissions('settings.manage')
  updateType(@Param('id', id) typeId: string, @Body({ schema: authorityTypeSchema }) body: Out<typeof authorityTypeSchema>, @Meta() meta: ActionMeta) {
    return this.authority.saveType(typeId, body, meta);
  }

  @Get('authority-applications/open')
  open(@CurrentPrincipal() p: Principal) {
    return this.authority.openApplications(p);
  }

  @Get('jobs/:id/authority')
  get(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.authority.get(jobId, p);
  }

  @Post('jobs/:id/authority-applications')
  create(@Param('id', id) jobId: string, @Body({ schema: createAuthorityApplicationSchema }) body: Out<typeof createAuthorityApplicationSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.authority.create(jobId, body.authorityTypeId, body.comments ?? null, p, meta);
  }

  @Patch('authority-applications/:id')
  update(@Param('id', id) appId: string, @Body({ schema: updateAuthorityApplicationSchema }) body: Out<typeof updateAuthorityApplicationSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.authority.update(appId, body, p, meta);
  }

  @Post('authority-applications/:id/not-required')
  @HttpCode(200)
  notRequired(@Param('id', id) appId: string, @Body({ schema: reasonSchema }) body: Out<typeof reasonSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.authority.markNotRequired(appId, body.reason, p, meta);
  }

  @Post('authority-applications/:id/documents')
  document(@Param('id', id) appId: string, @Body({ schema: authorityDocumentSchema }) body: Out<typeof authorityDocumentSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.authority.addDocument(appId, body.fileId, body.kind, p, meta);
  }

  @Post('authority-applications/:id/payments')
  payment(@Param('id', id) appId: string, @Body({ schema: authorityPaymentSchema }) body: Out<typeof authorityPaymentSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.authority.addPayment(appId, body, p, meta);
  }
}

@Controller()
export class OperationsController {
  constructor(
    private readonly ops: OperationsService,
    private readonly files: FilesService,
  ) {}

  @Get('jobs/:id/operations')
  get(@Param('id', id) jobId: string, @CurrentPrincipal() p: Principal) {
    return this.ops.get(jobId, p);
  }

  /** Evidence and documents for PRO, schedules, production and installation. */
  @Post('jobs/:id/operation-files')
  @UseInterceptors(uploadInterceptor())
  async upload(
    @Param('id', id) jobId: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Query('kind', { schema: z.enum(['authority', 'production', 'installation', 'schedule']) }) kind: 'authority' | 'production' | 'installation' | 'schedule',
    @CurrentPrincipal() p: Principal,
    @Meta() meta: ActionMeta,
  ) {
    try {
      await this.ops.authorizeUpload(jobId, kind, p);
    } catch (e) {
      await this.files.discard(file);
      throw e;
    }
    return this.files.store(jobId, file, kind === 'authority' ? 'AUTHORITY' : 'OPERATIONS', meta);
  }

  @Post('jobs/:id/vehicle-schedules')
  createSchedule(@Param('id', id) jobId: string, @Body({ schema: createScheduleSchema }) body: Out<typeof createScheduleSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.createSchedule(jobId, body, p, meta);
  }

  @Patch('vehicle-schedules/:id')
  updateSchedule(@Param('id', id) scheduleId: string, @Body({ schema: updateScheduleSchema }) body: Out<typeof updateScheduleSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.updateSchedule(scheduleId, body, p, meta);
  }

  @Post('jobs/:id/production-orders')
  createProduction(@Param('id', id) jobId: string, @Body({ schema: createProductionOrderSchema }) body: Out<typeof createProductionOrderSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.createProduction(jobId, body, p, meta);
  }

  @Patch('production-orders/:id')
  updateProduction(@Param('id', id) orderId: string, @Body({ schema: updateProductionOrderSchema }) body: Out<typeof updateProductionOrderSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.updateProduction(orderId, body, p, meta);
  }

  @Post('production-orders/:id/logs')
  logProduction(@Param('id', id) orderId: string, @Body({ schema: operationLogSchema }) body: Out<typeof operationLogSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.logProduction(orderId, body, p, meta);
  }

  @Post('jobs/:id/installation-orders')
  createInstallation(@Param('id', id) jobId: string, @Body({ schema: createInstallationOrderSchema }) body: Out<typeof createInstallationOrderSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.createInstallation(jobId, body, p, meta);
  }

  @Patch('installation-orders/:id')
  updateInstallation(@Param('id', id) orderId: string, @Body({ schema: updateInstallationOrderSchema }) body: Out<typeof updateInstallationOrderSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.updateInstallation(orderId, body, p, meta);
  }

  @Post('installation-orders/:id/logs')
  logInstallation(@Param('id', id) orderId: string, @Body({ schema: operationLogSchema }) body: Out<typeof operationLogSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.logInstallation(orderId, body, p, meta);
  }

  @Get('machines')
  machines() {
    return this.ops.machines();
  }

  @Post('machines')
  createMachine(@Body({ schema: machineSchema }) body: Out<typeof machineSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.saveMachine(null, body, p, meta);
  }

  @Patch('machines/:id')
  updateMachine(@Param('id', id) machineId: string, @Body({ schema: machineSchema }) body: Out<typeof machineSchema>, @CurrentPrincipal() p: Principal, @Meta() meta: ActionMeta) {
    return this.ops.saveMachine(machineId, body, p, meta);
  }
}

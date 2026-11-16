import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './core/prisma.service.js';
import { HttpExceptionFilter } from './core/http-exception.filter.js';
import { requestIdMiddleware } from './core/request-context.js';
import { requestLoggerMiddleware } from './core/request-logger.js';
import { AuditService } from './audit/audit.service.js';
import { AuditController } from './audit/audit.controller.js';
import { OutboxService } from './outbox/outbox.service.js';
import { PrincipalLoader } from './access/principal.loader.js';
import { SessionService } from './auth/session.service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { UsersService } from './users/users.service.js';
import { UsersController } from './users/users.controller.js';
import { DepartmentsController, DepartmentsService } from './departments/departments.js';
import { PermissionsController, RolesController, RolesService } from './roles/roles.js';
import { HealthController } from './health/health.controller.js';

/**
 * Phase 1 wires every module into one Nest module; the services keep their
 * own folders so later phases can split them into feature modules without
 * changing callers.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    DepartmentsController,
    RolesController,
    PermissionsController,
    AuditController,
  ],
  providers: [
    AuditService,
    OutboxService,
    PrincipalLoader,
    SessionService,
    AuthService,
    UsersService,
    DepartmentsService,
    RolesService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware, requestLoggerMiddleware).forRoutes('*path');
  }
}

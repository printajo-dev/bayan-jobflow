import type { PermissionKey } from './permissions.js';
import type { RoleScope, UserStatus } from './schemas.js';

/** Response shapes shared by the API and the web app. */

export interface DepartmentDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface RoleSummaryDto {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
}

export interface RoleDto extends RoleSummaryDto {
  description: string | null;
  isSystem: boolean;
  permissionKeys: PermissionKey[];
  departmentIds: string[];
  userCount: number;
}

export interface UserDepartmentDto {
  departmentId: string;
  code: string;
  name: string;
  isLeader: boolean;
}

export interface UserDto {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: RoleSummaryDto[];
  departments: UserDepartmentDto[];
}

export interface CurrentUserDto {
  user: UserDto;
  /** Permission keys granted by any role, regardless of department scope. */
  permissions: PermissionKey[];
  csrfToken: string;
}

export interface AuditLogDto {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
}

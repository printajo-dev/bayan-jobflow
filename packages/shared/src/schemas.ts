import { z } from 'zod';
import { PERMISSION_KEYS, type PermissionKey } from './permissions.js';

export const PASSWORD_MIN_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128, 'Password must be at most 128 characters');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9._-]+$/, 'Use lowercase letters, digits, dot, dash or underscore');

export const uuidSchema = z.uuid();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// Auth
export const loginSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(50),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// Users
export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const createUserSchema = z.strictObject({
  username: usernameSchema,
  fullName: z.string().trim().min(1).max(120),
  email: z.email().max(200).optional().nullable(),
  password: passwordSchema,
  roleIds: z.array(uuidSchema).max(50).default([]),
  departments: z
    .array(z.strictObject({ departmentId: uuidSchema, isLeader: z.boolean().default(false) }))
    .max(50)
    .default([]),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: z.email().max(200).optional().nullable(),
  status: z.enum(USER_STATUSES).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserRolesSchema = z.strictObject({ roleIds: z.array(uuidSchema).max(50) });
export const setUserDepartmentsSchema = z.strictObject({
  departments: z
    .array(z.strictObject({ departmentId: uuidSchema, isLeader: z.boolean().default(false) }))
    .max(50),
});
export const resetPasswordSchema = z.strictObject({ newPassword: passwordSchema });

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(USER_STATUSES).optional(),
  departmentId: uuidSchema.optional(),
});

// Departments
export const departmentCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(20)
  .regex(/^[A-Z0-9_]+$/, 'Use capital letters, digits or underscore');

export const createDepartmentSchema = z.strictObject({
  code: departmentCodeSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
});
export const updateDepartmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

// Roles
export const ROLE_SCOPES = ['GLOBAL', 'DEPARTMENT'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

const permissionKeySchema = z.custom<PermissionKey>(
  (v) => typeof v === 'string' && (PERMISSION_KEYS as readonly string[]).includes(v),
  'Unknown permission',
);

export const createRoleSchema = z.strictObject({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, digits or underscore'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  scope: z.enum(ROLE_SCOPES),
});
export const updateRoleSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
});
export const setRolePermissionsSchema = z.strictObject({
  permissionKeys: z.array(permissionKeySchema).max(500),
});
export const setRoleDepartmentsSchema = z.strictObject({
  departmentIds: z.array(uuidSchema).max(50),
});

// Audit
export const listAuditQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(50).optional(),
  entityId: uuidSchema.optional(),
  actorId: uuidSchema.optional(),
  action: z.string().trim().max(100).optional(),
});

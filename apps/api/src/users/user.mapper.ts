import type { UserDto } from '@jobflow/shared';

export const userDtoInclude = {
  roles: { include: { role: { select: { id: true, key: true, name: true, scope: true } } } },
  departments: { include: { department: { select: { code: true, name: true } } } },
} as const;

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { role: { id: string; key: string; name: string; scope: 'GLOBAL' | 'DEPARTMENT' } }[];
  departments: { departmentId: string; isLeader: boolean; department: { code: string; name: string } }[];
}

/** Never exposes the password hash or login counters. */
export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    status: u.status,
    mustChangePassword: u.mustChangePassword,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    roles: u.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name)),
    departments: u.departments
      .map((d) => ({ departmentId: d.departmentId, code: d.department.code, name: d.department.name, isLeader: d.isLeader }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

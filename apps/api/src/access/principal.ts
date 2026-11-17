import { isPermissionKey, type PermissionKey } from '@jobflow/shared';

export interface PrincipalDepartment {
  id: string;
  code: string;
  isLeader: boolean;
}

/**
 * The authenticated user's effective access, computed once per request.
 *
 * - GLOBAL roles grant their permissions everywhere.
 * - DEPARTMENT roles grant their permissions only inside the departments the
 *   user belongs to, narrowed further by the role's department scopes when the
 *   role has any.
 */
export class Principal {
  constructor(
    readonly userId: string,
    readonly username: string,
    readonly mustChangePassword: boolean,
    readonly departments: readonly PrincipalDepartment[],
    private readonly globalPermissions: ReadonlySet<PermissionKey>,
    private readonly departmentPermissions: ReadonlyMap<string, ReadonlySet<PermissionKey>>,
  ) {}

  /** True if the permission is granted anywhere (global or any department). */
  has(permission: PermissionKey): boolean {
    if (this.globalPermissions.has(permission)) return true;
    for (const set of this.departmentPermissions.values()) {
      if (set.has(permission)) return true;
    }
    return false;
  }

  hasGlobal(permission: PermissionKey): boolean {
    return this.globalPermissions.has(permission);
  }

  /** True if the permission applies to work owned by this department. */
  hasInDepartment(permission: PermissionKey, departmentId: string): boolean {
    return (
      this.globalPermissions.has(permission) ||
      (this.departmentPermissions.get(departmentId)?.has(permission) ?? false)
    );
  }

  /** Departments in which this permission applies (excluding global grants). */
  departmentsWith(permission: PermissionKey): string[] {
    return [...this.departmentPermissions.entries()].filter(([, set]) => set.has(permission)).map(([id]) => id);
  }

  isMemberOf(departmentId: string): boolean {
    return this.departments.some((d) => d.id === departmentId);
  }

  isLeaderOf(departmentId: string): boolean {
    return this.departments.some((d) => d.id === departmentId && d.isLeader);
  }

  /** All permission keys granted anywhere; used by the UI to show/hide actions. */
  allPermissions(): PermissionKey[] {
    const all = new Set<PermissionKey>(this.globalPermissions);
    for (const set of this.departmentPermissions.values()) for (const p of set) all.add(p);
    return [...all].sort();
  }
}

export interface PrincipalSource {
  id: string;
  username: string;
  mustChangePassword: boolean;
  departments: { departmentId: string; isLeader: boolean; department: { code: string; isActive: boolean } }[];
  roles: {
    role: {
      scope: 'GLOBAL' | 'DEPARTMENT';
      permissions: { permission: { key: string } }[];
      departmentScopes: { departmentId: string }[];
    };
  }[];
}

export function buildPrincipal(src: PrincipalSource): Principal {
  const departments = src.departments
    .filter((d) => d.department.isActive)
    .map((d) => ({ id: d.departmentId, code: d.department.code, isLeader: d.isLeader }));
  const memberIds = departments.map((d) => d.id);

  const global = new Set<PermissionKey>();
  const perDept = new Map<string, Set<PermissionKey>>();

  for (const { role } of src.roles) {
    const keys = role.permissions.map((p) => p.permission.key).filter(isPermissionKey);
    if (role.scope === 'GLOBAL') {
      keys.forEach((k) => global.add(k));
      continue;
    }
    const scoped = role.departmentScopes.map((s) => s.departmentId);
    const applies = scoped.length === 0 ? memberIds : memberIds.filter((id) => scoped.includes(id));
    for (const deptId of applies) {
      const set = perDept.get(deptId) ?? new Set<PermissionKey>();
      keys.forEach((k) => set.add(k));
      perDept.set(deptId, set);
    }
  }

  return new Principal(src.id, src.username, src.mustChangePassword, departments, global, perDept);
}

import { buildPrincipal, type PrincipalSource } from './principal.js';

const DESIGN = '00000000-0000-7000-8000-000000000001';
const PRO = '00000000-0000-7000-8000-000000000002';

function role(scope: 'GLOBAL' | 'DEPARTMENT', keys: string[], scopes: string[] = []) {
  return {
    role: {
      scope,
      permissions: keys.map((key) => ({ permission: { key } })),
      departmentScopes: scopes.map((departmentId) => ({ departmentId })),
    },
  };
}

function user(partial: Partial<PrincipalSource>): PrincipalSource {
  return { id: 'u1', username: 'u1', mustChangePassword: false, departments: [], roles: [], ...partial };
}

const designMember = { departmentId: DESIGN, isLeader: false, department: { code: 'DESIGN', isActive: true } };
const proLeader = { departmentId: PRO, isLeader: true, department: { code: 'PRO', isActive: true } };

describe('buildPrincipal', () => {
  it('denies everything by default', () => {
    const p = buildPrincipal(user({}));
    expect(p.has('job.view')).toBe(false);
    expect(p.allPermissions()).toEqual([]);
  });

  it('applies GLOBAL roles to every department', () => {
    const p = buildPrincipal(user({ roles: [role('GLOBAL', ['job.view'])] }));
    expect(p.hasInDepartment('job.view', DESIGN)).toBe(true);
    expect(p.hasGlobal('job.view')).toBe(true);
  });

  it('applies DEPARTMENT roles only inside the user’s departments', () => {
    const p = buildPrincipal(user({ departments: [designMember], roles: [role('DEPARTMENT', ['artwork.upload'])] }));
    expect(p.hasInDepartment('artwork.upload', DESIGN)).toBe(true);
    expect(p.hasInDepartment('artwork.upload', PRO)).toBe(false);
    expect(p.hasGlobal('artwork.upload')).toBe(false);
  });

  it('narrows DEPARTMENT roles to their department scopes', () => {
    const p = buildPrincipal(
      user({ departments: [designMember, proLeader], roles: [role('DEPARTMENT', ['authority.manage'], [PRO])] }),
    );
    expect(p.hasInDepartment('authority.manage', PRO)).toBe(true);
    expect(p.hasInDepartment('authority.manage', DESIGN)).toBe(false);
  });

  it('grants nothing when a scoped role does not match any membership', () => {
    const p = buildPrincipal(user({ departments: [designMember], roles: [role('DEPARTMENT', ['authority.manage'], [PRO])] }));
    expect(p.has('authority.manage')).toBe(false);
  });

  it('ignores inactive departments and unknown permission keys', () => {
    const inactive = { ...designMember, department: { code: 'DESIGN', isActive: false } };
    const p = buildPrincipal(user({ departments: [inactive], roles: [role('DEPARTMENT', ['artwork.upload', 'bogus.key'])] }));
    expect(p.has('artwork.upload')).toBe(false);
    expect(p.isMemberOf(DESIGN)).toBe(false);
  });

  it('knows department leadership', () => {
    const p = buildPrincipal(user({ departments: [designMember, proLeader] }));
    expect(p.isLeaderOf(PRO)).toBe(true);
    expect(p.isLeaderOf(DESIGN)).toBe(false);
  });
});

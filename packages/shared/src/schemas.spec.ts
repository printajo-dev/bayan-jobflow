import { describe, expect, it } from 'vitest';
import { createUserSchema, loginSchema, setRolePermissionsSchema } from './schemas.js';
import { PERMISSION_KEYS } from './permissions.js';

describe('shared schemas', () => {
  it('normalises usernames to lowercase on login', () => {
    expect(loginSchema.parse({ username: '  Ahmed ', password: 'x' }).username).toBe('ahmed');
  });

  it('rejects unknown properties on login', () => {
    expect(loginSchema.safeParse({ username: 'a', password: 'b', admin: true }).success).toBe(false);
  });

  it('enforces the password policy when creating users', () => {
    const result = createUserSchema.safeParse({ username: 'sales.one', fullName: 'Sales One', password: 'short' });
    expect(result.success).toBe(false);
  });

  it('only accepts known permission keys', () => {
    expect(setRolePermissionsSchema.safeParse({ permissionKeys: ['job.view'] }).success).toBe(true);
    expect(setRolePermissionsSchema.safeParse({ permissionKeys: ['root.everything'] }).success).toBe(false);
  });

  it('has unique permission keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });
});

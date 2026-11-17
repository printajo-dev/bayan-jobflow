import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { buildPrincipal, type Principal } from './principal.js';

export const principalInclude = {
  departments: { include: { department: { select: { code: true, isActive: true } } } },
  roles: {
    include: {
      role: {
        select: {
          scope: true,
          permissions: { select: { permission: { select: { key: true } } } },
          departmentScopes: { select: { departmentId: true } },
        },
      },
    },
  },
} as const;

@Injectable()
export class PrincipalLoader {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns null when the user does not exist or is disabled. */
  async load(userId: string, db: Tx = this.prisma): Promise<Principal | null> {
    const user = await db.user.findUnique({ where: { id: userId }, include: principalInclude });
    if (!user || user.status !== 'ACTIVE') return null;
    return buildPrincipal(user);
  }
}

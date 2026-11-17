import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './core/prisma.service.js';

export interface DirectoryEntry {
  id: string;
  fullName: string;
  departments: { id: string; code: string; isLeader: boolean }[];
}

/**
 * Minimal staff directory (names and departments of active users) for
 * assignment, mention and participant pickers. Any signed-in user may read
 * it; every assignment or mention is still validated by the server.
 */
@Controller('directory')
export class DirectoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(): Promise<DirectoryEntry[]> {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true, departments: { select: { departmentId: true, isLeader: true, department: { select: { code: true } } } } },
      orderBy: { fullName: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      departments: u.departments.map((d) => ({ id: d.departmentId, code: d.department.code, isLeader: d.isLeader })),
    }));
  }
}

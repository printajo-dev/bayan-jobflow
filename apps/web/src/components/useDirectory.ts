import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client';

export interface DirectoryEntry {
  id: string;
  fullName: string;
  departments: { id: string; code: string; isLeader: boolean }[];
}

export function useDirectory() {
  return useQuery({ queryKey: ['directory'], queryFn: () => get<DirectoryEntry[]>('/directory'), staleTime: 5 * 60_000 });
}

export function membersOf(dir: DirectoryEntry[] | undefined, departmentId: string | null | undefined): DirectoryEntry[] {
  if (!dir) return [];
  return departmentId ? dir.filter((u) => u.departments.some((d) => d.id === departmentId)) : dir;
}

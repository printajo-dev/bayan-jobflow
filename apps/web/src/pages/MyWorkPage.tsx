import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SegmentedControl, Stack, Title } from '@mantine/core';
import type { CorrectionDto, Paginated, TaskDto } from '@jobflow/shared';
import { get } from '../api/client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { TaskCard } from './jobs/TasksPanel';
import { CorrectionCard } from './jobs/CorrectionsPanel';

/** The signed-in user's assigned tasks and corrections across all jobs. */
export function MyWorkPage() {
  const [filter, setFilter] = useState('open');
  const tasks = useQuery({ queryKey: ['tasks', 'mine', filter], queryFn: () => get<Paginated<TaskDto>>(`/tasks?mine=true&status=${filter}&pageSize=100`) });
  const corrections = useQuery({ queryKey: ['corrections', 'mine'], queryFn: () => get<CorrectionDto[]>('/corrections/mine') });
  return (
    <Stack>
      <Title order={2}>My work</Title>
      <SegmentedControl
        w={360}
        value={filter}
        onChange={setFilter}
        data={[
          { value: 'open', label: 'Open' },
          { value: 'overdue', label: 'Overdue' },
          { value: 'completed', label: 'Completed' },
        ]}
      />
      <Title order={4}>Tasks</Title>
      {tasks.isPending ? (
        <LoadingState />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} />
      ) : tasks.data.items.length === 0 ? (
        <EmptyState>No tasks here.</EmptyState>
      ) : (
        tasks.data.items.map((t) => <TaskCard key={t.id} task={t} showJob />)
      )}
      <Title order={4}>Corrections assigned to me</Title>
      {corrections.isPending ? (
        <LoadingState />
      ) : corrections.isError ? (
        <ErrorState error={corrections.error} />
      ) : corrections.data.length === 0 ? (
        <EmptyState>No open corrections.</EmptyState>
      ) : (
        corrections.data.map((c) => <CorrectionCard key={c.id} correction={c} showJob />)
      )}
    </Stack>
  );
}

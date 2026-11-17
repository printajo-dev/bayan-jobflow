import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { JOB_PRIORITIES, TASK_STATUSES, type JobPriority, type StageDto, type TaskDto, type TaskStatus, type WorkflowDto } from '@jobflow/shared';
import { get, patch, post, put } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate, formatDateTime, PRIORITY } from '../../components/format';
import { membersOf, useDirectory } from '../../components/useDirectory';

export const TASK_STATUS: Record<TaskStatus, { label: string; color: string }> = {
  TODO: { label: 'To do', color: 'gray' },
  ASSIGNED: { label: 'Assigned', color: 'blue' },
  IN_PROGRESS: { label: 'In progress', color: 'cyan' },
  WAITING: { label: 'Waiting', color: 'yellow' },
  BLOCKED: { label: 'Blocked', color: 'orange' },
  COMPLETED: { label: 'Completed', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
};

export function TasksPanel({ jobId }: { jobId: string }) {
  const tasks = useQuery({ queryKey: ['jobs', jobId, 'tasks'], queryFn: () => get<TaskDto[]>(`/jobs/${jobId}/tasks`) });
  const wf = useQuery({ queryKey: ['jobs', jobId, 'workflow'], queryFn: () => get<WorkflowDto>(`/jobs/${jobId}/workflow`) });
  const [creating, setCreating] = useState(false);
  const creatable = (wf.data?.stages ?? []).filter((s) => s.allowedActions.includes('createTask'));

  if (tasks.isPending) return <LoadingState />;
  if (tasks.isError) return <ErrorState error={tasks.error} />;
  const byStage = new Map<string, TaskDto[]>();
  for (const t of tasks.data) {
    const key = `${t.stage.name}${t.stage.occurrenceNo > 1 ? ` (round ${t.stage.occurrenceNo})` : ''}`;
    byStage.set(key, [...(byStage.get(key) ?? []), t]);
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Department leaders add tasks and assign employees. Required tasks must be finished before the stage can be completed.
        </Text>
        {creatable.length > 0 && <Button size="xs" onClick={() => setCreating(true)}>Add task</Button>}
      </Group>
      {tasks.data.length === 0 && <EmptyState>No tasks yet.</EmptyState>}
      {[...byStage.entries()].map(([stage, list]) => (
        <Stack key={stage} gap="xs">
          <Title order={5}>{stage}</Title>
          {list.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </Stack>
      ))}
      {creating && <CreateTaskModal jobId={jobId} stages={creatable} tasks={tasks.data} onClose={() => setCreating(false)} />}
    </Stack>
  );
}

export function TaskCard({ task: t, showJob }: { task: TaskDto; showJob?: boolean }) {
  const qc = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [comment, setComment] = useState('');
  const [open, setOpen] = useState(false);
  const can = (a: TaskDto['allowedActions'][number]) => t.allowedActions.includes(a);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['jobs', t.jobId, 'tasks'] });
    void qc.invalidateQueries({ queryKey: ['jobs', t.jobId, 'workflow'] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) });
  const setStatus = useMutation({
    mutationFn: (status: TaskStatus) => {
      const needsReason = status === 'CANCELLED' || t.status === 'COMPLETED' || t.status === 'CANCELLED';
      const reason = needsReason ? window.prompt(status === 'CANCELLED' ? 'Why is the task cancelled?' : 'Why is the task reopened?') : undefined;
      if (needsReason && !reason) return Promise.reject(new Error('A reason is required'));
      return patch<TaskDto>(`/tasks/${t.id}`, { status, ...(reason ? { reason } : {}) });
    },
    onSuccess: refresh,
    onError,
  });
  const check = useMutation({ mutationFn: ({ id, done }: { id: string; done: boolean }) => post<TaskDto>(`/tasks/${t.id}/checklist/${id}`, { done }), onSuccess: refresh, onError });
  const addComment = useMutation({
    mutationFn: () => post<TaskDto>(`/tasks/${t.id}/comments`, { body: comment }),
    onSuccess: () => {
      setComment('');
      refresh();
    },
    onError,
  });
  const statusOptions = TASK_STATUSES.filter((s) => (can('edit') ? true : s !== 'CANCELLED')).map((s) => ({ value: s, label: TASK_STATUS[s].label }));

  return (
    <Card withBorder padding="sm">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Group gap={6}>
              <Text fw={600} style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
                {t.title}
              </Text>
              {t.required && (
                <Badge size="xs" variant="outline">
                  Required
                </Badge>
              )}
              <Badge size="xs" variant="light" color={PRIORITY[t.priority].color}>
                {PRIORITY[t.priority].label}
              </Badge>
              {t.overdue && (
                <Badge size="xs" color="red">
                  Overdue
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {showJob && `${t.jobNumber} · ${t.stage.name} · `}
              {t.assignees.length ? t.assignees.map((a) => a.fullName).join(', ') : 'Unassigned'}
              {t.dueDate ? ` · due ${formatDate(t.dueDate)}` : ''}
              {t.dependsOn.length ? ` · after ${t.dependsOn.map((d) => d.title).join(', ')}` : ''}
            </Text>
          </div>
          <Group gap={6} wrap="nowrap">
            {can('assign') && (
              <Button size="compact-xs" variant="subtle" onClick={() => setAssigning(true)}>
                Assign
              </Button>
            )}
            {can('updateStatus') ? (
              <Select
                size="xs"
                w={140}
                aria-label="Task status"
                data={statusOptions}
                value={t.status}
                onChange={(v) => v && v !== t.status && setStatus.mutate(v as TaskStatus)}
                allowDeselect={false}
              />
            ) : (
              <Badge color={TASK_STATUS[t.status].color}>{TASK_STATUS[t.status].label}</Badge>
            )}
          </Group>
        </Group>
        {open && (
          <Stack gap={6}>
            {t.description && (
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {t.description}
              </Text>
            )}
            {t.checklist.map((c) => (
              <Checkbox
                key={c.id}
                size="xs"
                label={`${c.label}${c.doneBy ? ` — ${c.doneBy}` : ''}`}
                checked={c.done}
                disabled={!can('updateStatus')}
                onChange={(e) => check.mutate({ id: c.id, done: e.currentTarget.checked })}
              />
            ))}
            {t.comments.map((c) => (
              <Text key={c.id} size="xs">
                <b>{c.author}</b> ({formatDateTime(c.createdAt)}): {c.body}
              </Text>
            ))}
            {can('comment') && (
              <Group gap="xs">
                <TextInput size="xs" style={{ flex: 1 }} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.currentTarget.value)} aria-label="Task comment" />
                <Button size="xs" disabled={!comment.trim()} loading={addComment.isPending} onClick={() => addComment.mutate()}>
                  Comment
                </Button>
              </Group>
            )}
            <Text size="xs" c="dimmed">
              Created by {t.createdBy ?? '—'} {formatDateTime(t.createdAt)}
              {t.completedAt ? ` · completed by ${t.completedBy} ${formatDateTime(t.completedAt)}` : ''}
            </Text>
          </Stack>
        )}
      </Stack>
      {assigning && <AssignModal task={t} onClose={() => setAssigning(false)} onDone={refresh} />}
    </Card>
  );
}

function AssignModal({ task, onClose, onDone }: { task: TaskDto; onClose: () => void; onDone: () => void }) {
  const dir = useDirectory();
  const [userIds, setUserIds] = useState(task.assignees.map((a) => a.id));
  const save = useMutation({
    mutationFn: () => put<TaskDto>(`/tasks/${task.id}/assignments`, { userIds }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={`Assign "${task.title}"`}>
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <MultiSelect
          label={`Members of ${task.department.name}`}
          data={membersOf(dir.data, task.department.id).map((u) => ({ value: u.id, label: u.fullName }))}
          value={userIds}
          onChange={setUserIds}
          searchable
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CreateTaskModal({ jobId, stages, tasks, onClose }: { jobId: string; stages: StageDto[]; tasks: TaskDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [form, setForm] = useState<{
    stageId: string | null;
    title: string;
    description: string;
    priority: JobPriority;
    startDate: string;
    dueDate: string;
    required: boolean;
    assigneeIds: string[];
    dependsOnIds: string[];
    checklist: string[];
  }>({
    stageId: stages[0]?.id ?? null,
    title: '',
    description: '',
    priority: 'NORMAL' as JobPriority,
    startDate: '',
    dueDate: '',
    required: true,
    assigneeIds: [] as string[],
    dependsOnIds: [] as string[],
    checklist: [] as string[],
  });
  const stage = stages.find((s) => s.id === form.stageId);
  const create = useMutation({
    mutationFn: () =>
      post<TaskDto>(`/jobs/${jobId}/tasks`, {
        ...form,
        description: form.description || null,
        startDate: form.startDate || null,
        dueDate: form.dueDate || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
      notifications.show({ color: 'green', message: 'Task added' });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Add task" size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Stack>
          {create.isError && <Alert color="red">{errorMessage(create.error)}</Alert>}
          <Select label="Stage" data={stages.map((s) => ({ value: s.id, label: `${s.name} (${s.department.name})` }))} value={form.stageId} onChange={(v) => setForm({ ...form, stageId: v, assigneeIds: [] })} allowDeselect={false} />
          <TextInput label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} />
          <Textarea label="Description" autosize minRows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
          <MultiSelect
            label="Assign to"
            description="Manual assignment by the department leader"
            data={membersOf(dir.data, stage?.department.id).map((u) => ({ value: u.id, label: u.fullName }))}
            value={form.assigneeIds}
            onChange={(v) => setForm({ ...form, assigneeIds: v })}
            searchable
          />
          <SimpleGrid cols={3}>
            <Select label="Priority" data={JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }))} value={form.priority} onChange={(v) => setForm({ ...form, priority: (v as JobPriority) ?? 'NORMAL' })} allowDeselect={false} />
            <TextInput label="Start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.currentTarget.value })} />
            <TextInput label="Due (employee deadline)" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.currentTarget.value })} />
          </SimpleGrid>
          <MultiSelect
            label="Must wait for"
            data={tasks.filter((t) => t.status !== 'CANCELLED').map((t) => ({ value: t.id, label: t.title }))}
            value={form.dependsOnIds}
            onChange={(v) => setForm({ ...form, dependsOnIds: v })}
          />
          <TagsInput label="Checklist" description="Press Enter after each item" value={form.checklist} onChange={(v) => setForm({ ...form, checklist: v })} />
          <Switch label="Required to complete the stage" checked={form.required} onChange={(e) => setForm({ ...form, required: e.currentTarget.checked })} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add task
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

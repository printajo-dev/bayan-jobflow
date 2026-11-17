import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Modal, Select, Stack, Switch, Text, Textarea, TextInput, Timeline } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { JOB_PRIORITIES, type ChannelDto, type CorrectionDto, type CorrectionStatus, type JobPriority, type MessageDto, type WorkflowDto } from '@jobflow/shared';
import { API_BASE, get, patch, post, uploadWithProgress } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate, formatDateTime, PRIORITY } from '../../components/format';
import { membersOf, useDirectory } from '../../components/useDirectory';

export const CORRECTION_STATUS: Record<CorrectionStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'red' },
  ASSIGNED: { label: 'Assigned', color: 'blue' },
  IN_PROGRESS: { label: 'In progress', color: 'cyan' },
  WAITING_INFO: { label: 'Waiting for information', color: 'yellow' },
  RESOLVED: { label: 'Resolved', color: 'green' },
  REOPENED: { label: 'Reopened', color: 'orange' },
};

export function CorrectionsPanel({ jobId }: { jobId: string }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['jobs', jobId, 'corrections'], queryFn: () => get<CorrectionDto[]>(`/jobs/${jobId}/corrections`) });
  const [creating, setCreating] = useState(false);
  if (list.isPending) return <LoadingState />;
  if (list.isError) return <ErrorState error={list.error} />;
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Formal corrections are tracked until resolved. Blocking corrections stop the department’s stage from completing.
        </Text>
        {can('correction.create') && (
          <Button size="xs" onClick={() => setCreating(true)}>
            New correction
          </Button>
        )}
      </Group>
      {list.data.length === 0 ? <EmptyState>No corrections.</EmptyState> : list.data.map((c) => <CorrectionCard key={c.id} correction={c} />)}
      {creating && <CreateCorrectionModal jobId={jobId} onClose={() => setCreating(false)} />}
    </Stack>
  );
}

export function CorrectionCard({ correction: c, showJob }: { correction: CorrectionDto; showJob?: boolean }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [dialog, setDialog] = useState<'resolve' | 'reopen' | null>(null);
  const [history, setHistory] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['jobs', c.jobId] });
    void qc.invalidateQueries({ queryKey: ['corrections'] });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) });
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => patch(`/corrections/${c.id}`, body), onSuccess: refresh, onError });
  const can = (a: CorrectionDto['allowedActions'][number]) => c.allowedActions.includes(a);

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text fw={600}>{c.title}</Text>
            <Badge color={CORRECTION_STATUS[c.status].color}>{CORRECTION_STATUS[c.status].label}</Badge>
            {c.blocking && c.status !== 'RESOLVED' && (
              <Badge size="xs" color="red" variant="outline">
                Blocks stage
              </Badge>
            )}
            <Badge size="xs" variant="light" color={PRIORITY[c.priority].color}>
              {PRIORITY[c.priority].label}
            </Badge>
          </Group>
          <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
            {c.description}
          </Text>
          <Text size="xs" c="dimmed">
            {showJob && `${c.jobNumber} · `}
            {c.department.name}
            {c.stage ? ` · ${c.stage.name}${c.stage.occurrenceNo > 1 ? ` round ${c.stage.occurrenceNo}` : ''}` : ''} · requested by {c.requestedBy ?? '—'} {formatDateTime(c.createdAt)} · deadline {formatDate(c.deadline)}
            {c.sourceMessageId && ' · from a discussion message'}
          </Text>
          {c.files.map((f) => (
            <Text key={f.id} size="xs">
              📎 <Anchor href={`${API_BASE}/files/${f.id}/download`} size="xs">{f.originalName}</Anchor> ({f.kind === 'RESOLUTION' ? 'resolution evidence' : 'attachment'})
            </Text>
          ))}
          {c.resolutionNotes && (
            <Text size="sm" c="green.8">
              Resolved by {c.resolvedBy} {formatDateTime(c.resolvedAt)}: {c.resolutionNotes}
            </Text>
          )}
        </div>
        <Stack gap={4} align="flex-end">
          {can('assign') ? (
            <Select
              size="xs"
              w={180}
              placeholder="Assign to"
              aria-label="Assign correction"
              data={membersOf(dir.data, c.department.id).map((u) => ({ value: u.id, label: u.fullName }))}
              value={c.assignedTo?.id ?? null}
              onChange={(v) => update.mutate({ assignedToId: v })}
            />
          ) : (
            <Text size="xs">{c.assignedTo ? `Assigned to ${c.assignedTo.fullName}` : 'Not assigned'}</Text>
          )}
          {can('update') && (
            <Select
              size="xs"
              w={180}
              aria-label="Correction status"
              data={(['ASSIGNED', 'IN_PROGRESS', 'WAITING_INFO'] as const).map((s) => ({ value: s, label: CORRECTION_STATUS[s].label }))}
              value={['ASSIGNED', 'IN_PROGRESS', 'WAITING_INFO'].includes(c.status) ? c.status : null}
              placeholder="Set status"
              onChange={(v) => v && update.mutate({ status: v })}
            />
          )}
          <Group gap={4}>
            {can('resolve') && (
              <Button size="compact-xs" color="green" onClick={() => setDialog('resolve')}>
                Resolve
              </Button>
            )}
            {can('reopen') && (
              <Button size="compact-xs" color="orange" variant="light" onClick={() => setDialog('reopen')}>
                Reopen
              </Button>
            )}
            <Button size="compact-xs" variant="subtle" onClick={() => setHistory(!history)}>
              History
            </Button>
          </Group>
        </Stack>
      </Group>
      {history && (
        <Timeline mt="sm" bulletSize={12} lineWidth={1}>
          {c.history.map((h, i) => (
            <Timeline.Item key={i} title={<Text size="xs">{CORRECTION_STATUS[h.to].label}</Text>}>
              <Text size="xs" c="dimmed">
                {formatDateTime(h.at)} · {h.actor ?? 'system'}
                {h.reason ? ` · ${h.reason}` : ''}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
      {dialog && <ResolveReopenModal correction={c} mode={dialog} onClose={() => setDialog(null)} onDone={refresh} />}
    </Card>
  );
}

function ResolveReopenModal({ correction: c, mode, onClose, onDone }: { correction: CorrectionDto; mode: 'resolve' | 'reopen'; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const run = useMutation({
    mutationFn: async () => {
      if (mode === 'reopen') return post(`/corrections/${c.id}/reopen`, { reason: text });
      const fileIds: string[] = [];
      for (const f of files) fileIds.push((await uploadWithProgress<{ id: string }>(`/jobs/${c.jobId}/correction-files`, f, f.name)).id);
      return post(`/corrections/${c.id}/resolve`, { notes: text, fileIds });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={`${mode === 'resolve' ? 'Resolve' : 'Reopen'}: ${c.title}`}>
      <Stack>
        {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
        <Textarea label={mode === 'resolve' ? 'What was done?' : 'Why is it reopened?'} required autosize minRows={3} value={text} onChange={(e) => setText(e.currentTarget.value)} />
        {mode === 'resolve' && (
          <FileButton multiple onChange={setFiles}>
            {(props) => (
              <Button variant="default" {...props}>
                {files.length ? `${files.length} evidence file(s)` : 'Attach evidence (corrected artwork, photo…)'}
              </Button>
            )}
          </FileButton>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={text.trim().length < (mode === 'reopen' ? 3 : 1)} loading={run.isPending} onClick={() => run.mutate()}>
            {mode === 'resolve' ? 'Resolve' : 'Reopen'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function CreateCorrectionModal({ jobId, source, onClose }: { jobId: string; source?: { message: MessageDto; channel: ChannelDto }; onClose: () => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const wf = useQuery({ queryKey: ['jobs', jobId, 'workflow'], queryFn: () => get<WorkflowDto>(`/jobs/${jobId}/workflow`) });
  const departments = [...new Map((wf.data?.stages ?? []).map((s) => [s.department.id, s.department])).values()];
  const [form, setForm] = useState({
    departmentId: source?.channel.department?.id ?? null,
    title: source ? source.message.body.slice(0, 80) : '',
    description: source?.message.body ?? '',
    assignedToId: null as string | null,
    priority: 'NORMAL' as JobPriority,
    deadline: '',
    blocking: true,
  });
  const [files, setFiles] = useState<File[]>([]);
  const create = useMutation({
    mutationFn: async () => {
      const fileIds: string[] = [];
      for (const f of files) fileIds.push((await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/correction-files`, f, f.name)).id);
      return post<CorrectionDto>('/corrections', {
        jobId,
        departmentId: form.departmentId,
        title: form.title,
        description: form.description,
        assignedToId: form.assignedToId,
        priority: form.priority,
        deadline: form.deadline || null,
        blocking: form.blocking,
        sourceMessageId: source?.message.id ?? null,
        channelId: source?.channel.id ?? null,
        fileIds,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
      notifications.show({ color: 'green', message: 'Correction created' });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={source ? 'Turn message into a correction' : 'New correction'} size="lg">
      <Stack>
        {create.isError && <Alert color="red">{errorMessage(create.error)}</Alert>}
        <Select label="Department responsible" required data={departments.map((d) => ({ value: d.id, label: d.name }))} value={form.departmentId} onChange={(v) => setForm({ ...form, departmentId: v, assignedToId: null })} />
        <TextInput label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} />
        <Textarea label="Description" required autosize minRows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
        <Group grow>
          <Select
            label="Assign to (leaders only)"
            clearable
            data={membersOf(dir.data, form.departmentId).map((u) => ({ value: u.id, label: u.fullName }))}
            value={form.assignedToId}
            onChange={(v) => setForm({ ...form, assignedToId: v })}
          />
          <Select label="Priority" data={JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }))} value={form.priority} onChange={(v) => setForm({ ...form, priority: (v as JobPriority) ?? 'NORMAL' })} allowDeselect={false} />
          <TextInput label="Deadline" type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.currentTarget.value })} />
        </Group>
        <Switch label="Blocks the department’s stage until resolved" checked={form.blocking} onChange={(e) => setForm({ ...form, blocking: e.currentTarget.checked })} />
        <FileButton multiple onChange={setFiles}>{(props) => <Button variant="default" {...props}>{files.length ? `${files.length} file(s)` : 'Attach files'}</Button>}</FileButton>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!form.departmentId || !form.title.trim() || !form.description.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create correction
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

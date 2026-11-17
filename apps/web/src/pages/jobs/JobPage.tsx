import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Modal,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  JOB_PRIORITIES,
  type AuditLogDto,
  type JobDetailDto,
  type JobFileDto,
  type JobPriority,
  type Paginated,
  type WorkflowDto,
} from '@jobflow/shared';
import { API_BASE, del, get, patch, post, toQuery, upload } from '../../api/client';
import { BriefForm, briefFromDto, briefToPayload } from '../../components/BriefForm';
import { WorkflowTimeline } from '../../components/WorkflowTimeline';
import { useAuth } from '../../auth/AuthContext';
import { TasksPanel } from './TasksPanel';
import { DesignPanel } from './DesignPanel';
import { DiscussionsPanel } from './DiscussionsPanel';
import { CorrectionsPanel } from './CorrectionsPanel';
import { ProPanel } from './ProPanel';
import { OperationsPanel } from './OperationsPanel';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { COVERAGE, formatDate, formatDateTime, formatSize, JOB_STATUS, PRIORITY } from '../../components/format';

export function JobPage() {
  const { id = '' } = useParams();
  const job = useQuery({ queryKey: ['jobs', id], queryFn: () => get<JobDetailDto>(`/jobs/${id}`) });
  const [dialog, setDialog] = useState<'edit' | 'number' | 'cancel' | null>(null);
  const [params, setParams] = useSearchParams();
  const { can: canDo } = useAuth();

  if (job.isPending) return <LoadingState />;
  if (job.isError) return <ErrorState error={job.error} />;
  const j = job.data;
  const can = (a: JobDetailDto['allowedActions'][number]) => j.allowedActions.includes(a);

  return (
    <Stack>
      <Anchor component={Link} to="/jobs" size="sm">
        ← All jobs
      </Anchor>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Title order={2} ff="monospace">
              {j.jobNumber}
            </Title>
            <Badge color={JOB_STATUS[j.status].color}>{JOB_STATUS[j.status].label}</Badge>
            <Badge variant="light" color={PRIORITY[j.priority].color}>
              {PRIORITY[j.priority].label}
            </Badge>
          </Group>
          <Text size="lg">{j.title}</Text>
          <Text size="sm" c="dimmed">
            {j.serviceType.name}
            {j.currentStage && (
              <>
                {' · '}now at <b>{j.currentStage.name}</b> ({j.currentStage.departmentName}
                {j.currentStage.status === 'ON_HOLD' ? ', on hold' : ''})
              </>
            )}
            {' · '}customer date {formatDate(j.customerCommitmentDate)}
          </Text>
          {j.status === 'CANCELLED' && (
            <Text size="sm" c="red">
              Cancelled: {j.cancelReason}
            </Text>
          )}
        </div>
        <Group gap="xs">
          {can('edit') && (
            <Button variant="default" size="xs" onClick={() => setDialog('edit')}>
              Edit details
            </Button>
          )}
          {can('changeNumber') && (
            <Button variant="default" size="xs" onClick={() => setDialog('number')}>
              Correct Job Number
            </Button>
          )}
          {can('cancel') && (
            <Button variant="light" color="red" size="xs" onClick={() => setDialog('cancel')}>
              Cancel job
            </Button>
          )}
        </Group>
      </Group>

      <Tabs value={params.get('tab') ?? 'workflow'} onChange={(v) => setParams(v ? { tab: v } : {}, { replace: true })} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="workflow">Workflow</Tabs.Tab>
          <Tabs.Tab value="overview">Brief</Tabs.Tab>
          {canDo('task.view') && <Tabs.Tab value="tasks">Tasks</Tabs.Tab>}
          {(canDo('artwork.view') || canDo('customer_approval.record')) && <Tabs.Tab value="design">Design & approvals</Tabs.Tab>}
          {canDo('channel.view') && <Tabs.Tab value="discussions">Discussions</Tabs.Tab>}
          {j.stageKeys.includes('government_approval') && canDo('authority.view') && <Tabs.Tab value="pro">PRO approvals</Tabs.Tab>}
          {(canDo('production.view') || canDo('installation.view') || canDo('vehicle_schedule.view')) && <Tabs.Tab value="operations">Operations</Tabs.Tab>}
          <Tabs.Tab value="corrections">Corrections</Tabs.Tab>
          <Tabs.Tab value="files">Files ({j.files.length})</Tabs.Tab>
          <Tabs.Tab value="activity">Activity</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="tasks" pt="md">
          <TasksPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="design" pt="md">
          <DesignPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="discussions" pt="md">
          <DiscussionsPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="pro" pt="md">
          <ProPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="operations" pt="md">
          <OperationsPanel jobId={j.id} showSchedule={j.stageKeys.includes('vehicle_schedule')} />
        </Tabs.Panel>
        <Tabs.Panel value="corrections" pt="md">
          <CorrectionsPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="workflow" pt="md">
          <WorkflowPanel jobId={j.id} />
        </Tabs.Panel>
        <Tabs.Panel value="overview" pt="md">
          <BriefPanel job={j} />
        </Tabs.Panel>
        <Tabs.Panel value="files" pt="md">
          <FilesPanel job={j} />
        </Tabs.Panel>
        <Tabs.Panel value="activity" pt="md">
          <ActivityPanel jobId={j.id} />
        </Tabs.Panel>
      </Tabs>

      {dialog === 'edit' && <EditDetailsDialog job={j} onClose={() => setDialog(null)} />}
      {dialog === 'number' && <JobNumberDialog job={j} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <CancelDialog job={j} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

function WorkflowPanel({ jobId }: { jobId: string }) {
  const wf = useQuery({ queryKey: ['jobs', jobId, 'workflow'], queryFn: () => get<WorkflowDto>(`/jobs/${jobId}/workflow`) });
  if (wf.isPending) return <LoadingState />;
  if (wf.isError) return <ErrorState error={wf.error} />;
  return <WorkflowTimeline jobId={jobId} workflow={wf.data} />;
}

function useJobUpdated(jobId: string) {
  const qc = useQueryClient();
  return (j: JobDetailDto, message: string) => {
    qc.setQueryData(['jobs', jobId], j);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId, 'workflow'] });
    void qc.invalidateQueries({ queryKey: ['jobs', jobId, 'activity'] });
    notifications.show({ color: 'green', message });
  };
}

function BriefPanel({ job }: { job: JobDetailDto }) {
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState(() => briefFromDto(job.brief as Record<string, unknown>));
  const updated = useJobUpdated(job.id);
  const save = useMutation({
    mutationFn: () => patch<JobDetailDto>(`/jobs/${job.id}/brief`, briefToPayload(job.serviceType.code, state)),
    onSuccess: (j) => {
      updated(j, 'Brief saved');
      setEditing(false);
    },
  });
  const b = briefFromDto(job.brief as Record<string, unknown>);

  if (editing) {
    return (
      <Card withBorder>
        <Stack>
          {save.isError && <Alert color="red" style={{ whiteSpace: 'pre-line' }}>{errorMessage(save.error)}</Alert>}
          <BriefForm code={job.serviceType.code} value={state} onChange={setState} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save brief
            </Button>
          </Group>
        </Stack>
      </Card>
    );
  }

  const row = (label: string, value: React.ReactNode) => (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {value || '—'}
      </Text>
    </div>
  );

  return (
    <Stack>
      {job.briefProblems.length > 0 && job.status === 'OPEN' && (
        <Alert color="yellow" title="The brief is not complete yet">
          <List size="sm">
            {job.briefProblems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={4}>Job brief</Title>
            {job.allowedActions.includes('editBrief') && (
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setState(b);
                  setEditing(true);
                }}
              >
                Edit brief
              </Button>
            )}
          </Group>
          {row('Scope of work', b.scope)}
          {job.serviceType.code === 'VB' ? (
            <>
              <div>
                <Text size="xs" c="dimmed">
                  Vehicles
                </Text>
                {b.vehicles.filter((v) => v.description).length === 0 ? (
                  <Text size="sm">—</Text>
                ) : (
                  <Table withTableBorder mt={4}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Make / model</Table.Th>
                        <Table.Th>Year</Table.Th>
                        <Table.Th>Plate or chassis</Table.Th>
                        <Table.Th>Colour</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {b.vehicles
                        .filter((v) => v.description)
                        .map((v, i) => (
                          <Table.Tr key={i}>
                            <Table.Td>{v.description}</Table.Td>
                            <Table.Td>{v.year || '—'}</Table.Td>
                            <Table.Td>{v.plateOrChassis || '—'}</Table.Td>
                            <Table.Td>{v.colour || '—'}</Table.Td>
                          </Table.Tr>
                        ))}
                    </Table.Tbody>
                  </Table>
                )}
              </div>
              {row('Coverage', b.coverage ? COVERAGE[b.coverage] : null)}
            </>
          ) : (
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {row('Site name', b.siteName)}
              {row('Site address', b.siteAddress)}
              {row('Site access notes', b.siteAccessNotes)}
              {row('Quantity', b.quantity)}
              {row('Dimensions', b.dimensions)}
              {row('Specifications', b.specifications)}
            </SimpleGrid>
          )}
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {row('Requirements', b.requirements)}
            {row('Target date', formatDate(b.targetDate || null))}
          </SimpleGrid>
          {row('Notes', b.notes)}
          <Text size="xs" c="dimmed">
            Created {formatDateTime(job.createdAt)}
            {job.createdBy ? ` by ${job.createdBy}` : ''} · {job.templateVersion.templateName} template v{job.templateVersion.versionNo}
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}

function FilesPanel({ job }: { job: JobDetailDto }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['jobs', job.id] });
  };
  const add = useMutation({
    mutationFn: (file: File) => upload<JobFileDto>(`/jobs/${job.id}/files`, file),
    onSuccess: (f) => {
      notifications.show({ color: 'green', message: `${f.originalName} uploaded` });
      refresh();
    },
    onError: (e) => notifications.show({ color: 'red', title: 'Upload failed', message: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (f: JobFileDto) => del(`/jobs/${job.id}/files/${f.id}`),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'File removed from the job (kept in history)' });
      refresh();
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  const previewable = (m: string) => m === 'application/pdf' || m.startsWith('image/');

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Brief drawings, specifications and reference files.
        </Text>
        {job.allowedActions.includes('uploadFile') && (
          <>
            <input
              ref={input}
              type="file"
              hidden
              aria-label="Choose file"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) add.mutate(f);
                e.currentTarget.value = '';
              }}
            />
            <Button size="xs" loading={add.isPending} onClick={() => input.current?.click()}>
              Upload file
            </Button>
          </>
        )}
      </Group>
      {job.files.length === 0 ? (
        <EmptyState>No files attached.</EmptyState>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>File</Table.Th>
              <Table.Th>Size</Table.Th>
              <Table.Th>Uploaded</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {job.files.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>
                  <Anchor href={`${API_BASE}/files/${f.id}/download`}>{f.originalName}</Anchor>
                </Table.Td>
                <Table.Td>{formatSize(f.size)}</Table.Td>
                <Table.Td>
                  <Text size="sm">
                    {formatDateTime(f.createdAt)}
                    {f.uploadedBy ? ` · ${f.uploadedBy}` : ''}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    {previewable(f.mimeType) && (
                      <Button component="a" href={`${API_BASE}/files/${f.id}/download?inline=1`} target="_blank" rel="noopener" size="compact-xs" variant="subtle">
                        Preview
                      </Button>
                    )}
                    {job.allowedActions.includes('removeFile') && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() => {
                          if (window.confirm(`Remove ${f.originalName} from this job?`)) remove.mutate(f);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function ActivityPanel({ jobId }: { jobId: string }) {
  const [page, setPage] = useState(1);
  const activity = useQuery({
    queryKey: ['jobs', jobId, 'activity', page],
    queryFn: () => get<Paginated<AuditLogDto>>(`/jobs/${jobId}/activity${toQuery({ page, pageSize: 30 })}`),
    placeholderData: keepPreviousData,
  });
  if (activity.isPending) return <LoadingState />;
  if (activity.isError) return <ErrorState error={activity.error} />;
  if (activity.data.items.length === 0) return <EmptyState>No activity yet.</EmptyState>;
  return (
    <Stack>
      <Table striped>
        <Table.Tbody>
          {activity.data.items.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td w={170}>
                <Text size="sm">{formatDateTime(a.createdAt)}</Text>
              </Table.Td>
              <Table.Td w={170}>
                <Text size="sm">{a.actorUsername ?? 'system'}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{a.summary}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {activity.data.total > 30 && <Pagination total={Math.ceil(activity.data.total / 30)} value={page} onChange={setPage} />}
    </Stack>
  );
}

function EditDetailsDialog({ job, onClose }: { job: JobDetailDto; onClose: () => void }) {
  const updated = useJobUpdated(job.id);
  const [title, setTitle] = useState(job.title);
  const [priority, setPriority] = useState<JobPriority>(job.priority);
  const [commitment, setCommitment] = useState(job.customerCommitmentDate ?? '');
  const save = useMutation({
    mutationFn: () => patch<JobDetailDto>(`/jobs/${job.id}`, { title, priority, customerCommitmentDate: commitment || null }),
    onSuccess: (j) => {
      updated(j, 'Job details saved');
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Edit job details">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Select label="Priority" data={JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }))} value={priority} onChange={(v) => setPriority((v as JobPriority) ?? 'NORMAL')} allowDeselect={false} />
        <TextInput label="Customer commitment date" type="date" value={commitment} onChange={(e) => setCommitment(e.currentTarget.value)} />
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

function JobNumberDialog({ job, onClose }: { job: JobDetailDto; onClose: () => void }) {
  const updated = useJobUpdated(job.id);
  const [jobNumber, setJobNumber] = useState(job.jobNumber);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => post<JobDetailDto>(`/jobs/${job.id}/job-number`, { jobNumber, reason }),
    onSuccess: (j) => {
      updated(j, `Job Number changed to ${j.jobNumber}`);
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Correct Job Number">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Text size="sm">Use this only to fix a wrong ERP invoice number. The old number stays in the history.</Text>
        <TextInput label="New Job Number" styles={{ input: { fontFamily: "monospace" } }} value={jobNumber} onChange={(e) => setJobNumber(e.currentTarget.value.toUpperCase())} />
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Change Job Number
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CancelDialog({ job, onClose }: { job: JobDetailDto; onClose: () => void }) {
  const updated = useJobUpdated(job.id);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => post<JobDetailDto>(`/jobs/${job.id}/cancel`, { reason }),
    onSuccess: (j) => {
      updated(j, 'Job cancelled');
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={`Cancel job ${job.jobNumber}`}>
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Text size="sm">The workflow stops. The job and its history are kept.</Text>
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Keep job
          </Button>
          <Button color="red" loading={save.isPending} onClick={() => save.mutate()}>
            Cancel job
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

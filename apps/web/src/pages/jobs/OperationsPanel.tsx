import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Modal, MultiSelect, NumberInput, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  INSTALLATION_STATUSES,
  PRODUCTION_ACTIVITIES,
  PRODUCTION_STATUSES,
  type InstallationOrderDto,
  type OperationLogDto,
  type OperationsDto,
  type ProductionOrderDto,
  type VehicleScheduleDto,
} from '@jobflow/shared';
import { API_BASE, get, patch, post, uploadWithProgress } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDateTime } from '../../components/format';
import { useDirectory } from '../../components/useDirectory';

const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);
const statusColor = (s: string) => ({ COMPLETED: 'green', CONFIRMED: 'green', CANCELLED: 'gray', BLOCKED: 'red', ON_HOLD: 'orange', RESCHEDULED: 'orange', PARTIAL: 'yellow', IN_PROGRESS: 'blue' })[s] ?? 'gray';

export function OperationsPanel({ jobId, showSchedule }: { jobId: string; showSchedule: boolean }) {
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ['jobs', jobId, 'operations'], queryFn: () => get<OperationsDto>(`/jobs/${jobId}/operations`) });
  const done = (d: OperationsDto) => {
    qc.setQueryData(['jobs', jobId, 'operations'], d);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId, 'workflow'] });
  };
  const [dialog, setDialog] = useState<'schedule' | 'production' | 'installation' | null>(null);
  if (ops.isPending) return <LoadingState />;
  if (ops.isError) return <ErrorState error={ops.error} />;
  const d = ops.data;
  const can = (a: OperationsDto['allowedActions'][number]) => d.allowedActions.includes(a);
  return (
    <Stack>
      {showSchedule && (
        <>
          <Group justify="space-between">
            <Title order={4}>Vehicle schedule</Title>
            {can('schedule') && <Button size="xs" onClick={() => setDialog('schedule')}>Propose schedule</Button>}
          </Group>
          {d.schedules.length === 0 ? <EmptyState>No schedule yet.</EmptyState> : d.schedules.map((s) => <ScheduleCard key={s.id} s={s} manage={can('schedule')} onDone={done} />)}
        </>
      )}
      <Group justify="space-between">
        <Title order={4}>Production</Title>
        {can('production') && <Button size="xs" onClick={() => setDialog('production')}>Plan production</Button>}
      </Group>
      {d.productionOrders.length === 0 ? <EmptyState>No production orders yet.</EmptyState> : d.productionOrders.map((o) => <ProductionCard key={o.id} jobId={jobId} o={o} ops={d} manage={can('production')} onDone={done} />)}
      <Group justify="space-between">
        <Title order={4}>Installation</Title>
        {can('installation') && <Button size="xs" onClick={() => setDialog('installation')}>Plan installation</Button>}
      </Group>
      {d.installationOrders.length === 0 ? <EmptyState>No installation planned yet.</EmptyState> : d.installationOrders.map((o) => <InstallationCard key={o.id} jobId={jobId} o={o} manage={can('installation')} onDone={done} />)}
      {dialog === 'schedule' && <ScheduleDialog jobId={jobId} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'production' && <ProductionDialog jobId={jobId} ops={d} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'installation' && <InstallationDialog jobId={jobId} ops={d} onClose={() => setDialog(null)} onDone={done} />}
    </Stack>
  );
}

function Logs({ logs }: { logs: OperationLogDto[] }) {
  if (!logs.length) return null;
  return (
    <Stack gap={2} mt="xs">
      {logs.map((l) => (
        <Text key={l.id} size="xs">
          <b>{formatDateTime(l.createdAt)}</b> {l.actor ?? ''}: {l.note}
          {l.quantityDone != null ? ` (qty ${l.quantityDone})` : ''}
          {l.files.map((f) => (
            <span key={f.id}>
              {' · '}
              <Anchor href={`${API_BASE}/files/${f.id}/download${f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf' ? '?inline=1' : ''}`} target="_blank" rel="noopener" size="xs">
                {f.originalName}
              </Anchor>
            </span>
          ))}
        </Text>
      ))}
    </Stack>
  );
}

function LogForm({ jobId, kind, path, onDone }: { jobId: string; kind: 'production' | 'installation'; path: string; onDone: (d: OperationsDto) => void }) {
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<number | string>('');
  const [files, setFiles] = useState<File[]>([]);
  const save = useMutation({
    mutationFn: async () => {
      const fileIds: string[] = [];
      for (const f of files) fileIds.push((await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/operation-files?kind=${kind}`, f, f.name)).id);
      return post<OperationsDto>(path, { note, quantityDone: qty === '' ? null : Number(qty), fileIds });
    },
    onSuccess: (d) => {
      setNote('');
      setQty('');
      setFiles([]);
      onDone(d);
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  return (
    <Group gap="xs" mt="xs" align="flex-end">
      <TextInput size="xs" style={{ flex: 1 }} placeholder="Progress note" value={note} onChange={(e) => setNote(e.currentTarget.value)} aria-label="Progress note" />
      {kind === 'production' && <NumberInput size="xs" w={90} placeholder="Qty" value={qty} onChange={setQty} aria-label="Quantity done" />}
      <FileButton multiple onChange={setFiles} accept="image/*,application/pdf">
        {(props) => (
          <Button size="xs" variant="default" {...props}>
            {files.length ? `${files.length} photo(s)` : 'Photos / evidence'}
          </Button>
        )}
      </FileButton>
      <Button size="xs" disabled={!note.trim()} loading={save.isPending} onClick={() => save.mutate()}>
        Add log
      </Button>
    </Group>
  );
}

function StatusSelect({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <Select
      size="xs"
      w={150}
      aria-label="Status"
      data={options.map((s) => ({ value: s, label: s.toLowerCase().replace('_', ' ') }))}
      value={value}
      onChange={(v) => v && v !== value && onChange(v)}
      allowDeselect={false}
    />
  );
}

function ScheduleCard({ s, manage, onDone }: { s: VehicleScheduleDto; manage: boolean; onDone: (d: OperationsDto) => void }) {
  const [editing, setEditing] = useState(false);
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<OperationsDto>(`/vehicle-schedules/${s.id}`, body),
    onSuccess: onDone,
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  const closed = s.status === 'CANCELLED' || s.status === 'COMPLETED';
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between">
        <div>
          <Group gap={6}>
            <Text fw={600}>{s.vehicleRef}</Text>
            <Badge color={statusColor(s.status)}>{s.status.toLowerCase()}</Badge>
          </Group>
          <Text size="sm">
            {formatDateTime(s.plannedStart)}
            {s.plannedEnd ? ` – ${formatDateTime(s.plannedEnd)}` : ''} · {s.location}
          </Text>
          {s.confirmedBy && (
            <Text size="xs" c="green.8">
              Availability confirmed by {s.confirmedBy} {formatDateTime(s.confirmedAt)}: {s.confirmationNote}
            </Text>
          )}
          {s.notes && <Text size="xs" c="dimmed">{s.notes}</Text>}
        </div>
        {manage && !closed && (
          <Group gap={4}>
            {s.status !== 'CONFIRMED' && (
              <Button
                size="xs"
                color="green"
                onClick={() => {
                  const note = window.prompt('Who confirmed the vehicle will be available (name, how)?');
                  if (note) run.mutate({ status: 'CONFIRMED', confirmationNote: note });
                }}
              >
                Confirm availability
              </Button>
            )}
            <Button size="xs" variant="default" onClick={() => setEditing(true)}>
              Reschedule
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => {
                const reason = window.prompt('Why is the schedule cancelled?');
                if (reason) run.mutate({ status: 'CANCELLED', reason });
              }}
            >
              Cancel
            </Button>
            {s.status === 'CONFIRMED' && (
              <Button size="xs" variant="subtle" onClick={() => run.mutate({ status: 'COMPLETED' })}>
                Mark done
              </Button>
            )}
          </Group>
        )}
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        History: {s.history.map((h) => `${h.action} (${h.actor ?? '—'}, ${formatDateTime(h.at)}${h.reason ? `: ${h.reason}` : ''})`).join(' → ')}
      </Text>
      {editing && <ScheduleDialog schedule={s} onClose={() => setEditing(false)} onDone={onDone} />}
    </Card>
  );
}

function ScheduleDialog({ jobId, schedule, onClose, onDone }: { jobId?: string; schedule?: VehicleScheduleDto; onClose: () => void; onDone: (d: OperationsDto) => void }) {
  const [f, setF] = useState({ vehicleRef: schedule?.vehicleRef ?? '', plannedStart: local(schedule?.plannedStart ?? null), plannedEnd: local(schedule?.plannedEnd ?? null), location: schedule?.location ?? '', notes: schedule?.notes ?? '', reason: '' });
  const save = useMutation({
    mutationFn: () =>
      schedule
        ? patch<OperationsDto>(`/vehicle-schedules/${schedule.id}`, { vehicleRef: f.vehicleRef, plannedStart: toIso(f.plannedStart), plannedEnd: toIso(f.plannedEnd), location: f.location, notes: f.notes || null, reason: f.reason || undefined })
        : post<OperationsDto>(`/jobs/${jobId}/vehicle-schedules`, { vehicleRef: f.vehicleRef, plannedStart: toIso(f.plannedStart), plannedEnd: toIso(f.plannedEnd), location: f.location, notes: f.notes || null }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={schedule ? 'Reschedule' : 'Propose vehicle schedule'}>
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <TextInput label="Vehicle(s)" required value={f.vehicleRef} onChange={(e) => setF({ ...f, vehicleRef: e.currentTarget.value })} />
        <SimpleGrid cols={2}>
          <TextInput label="From" type="datetime-local" required value={f.plannedStart} onChange={(e) => setF({ ...f, plannedStart: e.currentTarget.value })} />
          <TextInput label="To" type="datetime-local" value={f.plannedEnd} onChange={(e) => setF({ ...f, plannedEnd: e.currentTarget.value })} />
        </SimpleGrid>
        <TextInput label="Location" required value={f.location} onChange={(e) => setF({ ...f, location: e.currentTarget.value })} />
        <Textarea label="Coordination notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.currentTarget.value })} />
        {schedule && <Textarea label="Reason for the change" required={schedule.status === 'CONFIRMED'} value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })} />}
        <Text size="xs" c="dimmed">A schedule only counts once vehicle availability is confirmed and recorded.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ProductionCard({ jobId, o, manage, onDone }: { jobId: string; o: ProductionOrderDto; ops: OperationsDto; manage: boolean; onDone: (d: OperationsDto) => void }) {
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<OperationsDto>(`/production-orders/${o.id}`, body),
    onSuccess: onDone,
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  const closed = o.status === 'COMPLETED' || o.status === 'CANCELLED';
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap={6}>
            <Text fw={600}>{o.title}</Text>
            <Badge color={statusColor(o.status)}>{o.status.toLowerCase().replace('_', ' ')}</Badge>
            <Badge variant="outline" size="xs">
              {o.stage.name}
              {o.stage.occurrenceNo > 1 ? ` round ${o.stage.occurrenceNo}` : ''}
            </Badge>
          </Group>
          <Text size="sm">
            {o.activity.toLowerCase()} · {o.material ?? 'material —'} · qty {o.quantity ?? '—'} · {o.dimensions ?? ''}
            {o.artworkVersionNo ? ` · artwork v${o.artworkVersionNo}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            Machine {o.machine?.name ?? '—'} · operator {o.operator?.fullName ?? '—'} · planned {formatDateTime(o.plannedStart)} → {formatDateTime(o.plannedFinish)} · actual {formatDateTime(o.actualStart)} →{' '}
            {formatDateTime(o.actualFinish)}
            {o.wastageNotes ? ` · waste: ${o.wastageNotes}` : ''}
          </Text>
        </div>
        {manage && !closed && (
          <StatusSelect
            value={o.status}
            options={PRODUCTION_STATUSES}
            onChange={(v) => {
              const reason = v === 'CANCELLED' || v === 'ON_HOLD' ? window.prompt('Reason') : undefined;
              if ((v === 'CANCELLED' || v === 'ON_HOLD') && !reason) return;
              run.mutate({ status: v, ...(reason ? { reason } : {}) });
            }}
          />
        )}
      </Group>
      <Logs logs={o.logs} />
      {manage && !closed && <LogForm jobId={jobId} kind="production" path={`/production-orders/${o.id}/logs`} onDone={onDone} />}
    </Card>
  );
}

function ProductionDialog({ jobId, ops, onClose, onDone }: { jobId: string; ops: OperationsDto; onClose: () => void; onDone: (d: OperationsDto) => void }) {
  const dir = useDirectory();
  const [f, setF] = useState({ stageId: (ops.stages.production[0]?.id ?? null) as string | null, title: '', activity: 'PRINTING', material: '', quantity: '' as number | string, dimensions: '', machineId: null as string | null, operatorId: null as string | null, plannedStart: '', plannedFinish: '' });
  const save = useMutation({
    mutationFn: () =>
      post<OperationsDto>(`/jobs/${jobId}/production-orders`, {
        stageId: f.stageId,
        title: f.title,
        activity: f.activity,
        material: f.material || null,
        quantity: f.quantity === '' ? null : Number(f.quantity),
        dimensions: f.dimensions || null,
        machineId: f.machineId,
        operatorId: f.operatorId,
        plannedStart: toIso(f.plannedStart),
        plannedFinish: toIso(f.plannedFinish),
      }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  const production = (dir.data ?? []).filter((u) => u.departments.some((d) => d.code === 'PRODUCTION'));
  return (
    <Modal opened onClose={onClose} title="Plan production" size="lg">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <SimpleGrid cols={2}>
          <Select label="Stage" data={ops.stages.production.map((s) => ({ value: s.id, label: `${s.name}${s.occurrenceNo > 1 ? ` round ${s.occurrenceNo}` : ''}` }))} value={f.stageId} onChange={(v) => setF({ ...f, stageId: v })} allowDeselect={false} />
          <Select label="Activity" data={PRODUCTION_ACTIVITIES.map((a) => ({ value: a, label: a.toLowerCase() }))} value={f.activity} onChange={(v) => setF({ ...f, activity: v ?? 'PRINTING' })} allowDeselect={false} />
        </SimpleGrid>
        <TextInput label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.currentTarget.value })} />
        <SimpleGrid cols={3}>
          <TextInput label="Material / media" value={f.material} onChange={(e) => setF({ ...f, material: e.currentTarget.value })} />
          <NumberInput label="Quantity" min={1} value={f.quantity} onChange={(v) => setF({ ...f, quantity: v })} />
          <TextInput label="Dimensions" value={f.dimensions} onChange={(e) => setF({ ...f, dimensions: e.currentTarget.value })} />
        </SimpleGrid>
        <SimpleGrid cols={2}>
          <Select label="Machine / printer" clearable data={ops.machines.filter((m) => m.isActive).map((m) => ({ value: m.id, label: m.name }))} value={f.machineId} onChange={(v) => setF({ ...f, machineId: v })} />
          <Select label="Operator" clearable data={production.map((u) => ({ value: u.id, label: u.fullName }))} value={f.operatorId} onChange={(v) => setF({ ...f, operatorId: v })} />
          <TextInput label="Planned start" type="datetime-local" value={f.plannedStart} onChange={(e) => setF({ ...f, plannedStart: e.currentTarget.value })} />
          <TextInput label="Planned finish" type="datetime-local" value={f.plannedFinish} onChange={(e) => setF({ ...f, plannedFinish: e.currentTarget.value })} />
        </SimpleGrid>
        <Text size="xs" c="dimmed">Vehicle Branding prints always use the latest customer-approved artwork version.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!f.title.trim() || !f.stageId} loading={save.isPending} onClick={() => save.mutate()}>Plan</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function InstallationCard({ jobId, o, manage, onDone }: { jobId: string; o: InstallationOrderDto; manage: boolean; onDone: (d: OperationsDto) => void }) {
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<OperationsDto>(`/installation-orders/${o.id}`, body),
    onSuccess: onDone,
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  const closed = o.status === 'COMPLETED' || o.status === 'CANCELLED';
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap={6}>
            <Text fw={600}>{o.target}</Text>
            <Badge color={statusColor(o.status)}>{o.status.toLowerCase().replace('_', ' ')}</Badge>
            <Badge variant="outline" size="xs">
              {o.stage.name}
              {o.stage.occurrenceNo > 1 ? ` round ${o.stage.occurrenceNo}` : ''}
            </Badge>
          </Group>
          <Text size="sm">
            {formatDateTime(o.scheduledStart)} → {formatDateTime(o.scheduledEnd)}
            {o.address ? ` · ${o.address}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            Leader {o.teamLeader?.fullName ?? '—'} · technicians {o.technicians.map((t) => t.fullName).join(', ') || '—'}
            {o.materials.length ? ` · materials: ${o.materials.map((m) => `${m.quantity} ${m.unit ?? ''} ${m.item}`).join(', ')}` : ''}
          </Text>
          {o.safetyNotes && <Text size="xs" c="orange.8">Safety: {o.safetyNotes}</Text>}
          {o.accessNotes && <Text size="xs">Access: {o.accessNotes}</Text>}
          {o.instructions && <Text size="xs">Instructions: {o.instructions}</Text>}
          {o.issues && <Text size="xs" c="red">Issues: {o.issues}</Text>}
        </div>
        {manage && !closed && (
          <StatusSelect
            value={o.status}
            options={INSTALLATION_STATUSES}
            onChange={(v) => {
              const reason = ['BLOCKED', 'PARTIAL', 'CANCELLED'].includes(v) ? window.prompt('Describe the issue') : undefined;
              if (['BLOCKED', 'PARTIAL', 'CANCELLED'].includes(v) && !reason) return;
              run.mutate({ status: v, ...(reason ? { reason, issues: reason } : {}) });
            }}
          />
        )}
      </Group>
      <Logs logs={o.logs} />
      {!closed && <LogForm jobId={jobId} kind="installation" path={`/installation-orders/${o.id}/logs`} onDone={onDone} />}
    </Card>
  );
}

function InstallationDialog({ jobId, ops, onClose, onDone }: { jobId: string; ops: OperationsDto; onClose: () => void; onDone: (d: OperationsDto) => void }) {
  const dir = useDirectory();
  const team = (dir.data ?? []).filter((u) => u.departments.some((d) => d.code === 'INSTALLATION'));
  const [f, setF] = useState({ stageId: (ops.stages.installation[0]?.id ?? null) as string | null, target: '', address: '', accessNotes: '', safetyNotes: '', instructions: '', scheduledStart: '', scheduledEnd: '', teamLeaderId: null as string | null, technicianIds: [] as string[], materials: '' });
  const save = useMutation({
    mutationFn: () =>
      post<OperationsDto>(`/jobs/${jobId}/installation-orders`, {
        stageId: f.stageId,
        target: f.target,
        address: f.address || null,
        accessNotes: f.accessNotes || null,
        safetyNotes: f.safetyNotes || null,
        instructions: f.instructions || null,
        scheduledStart: toIso(f.scheduledStart),
        scheduledEnd: toIso(f.scheduledEnd),
        teamLeaderId: f.teamLeaderId,
        technicianIds: f.technicianIds,
        // One material per line: "12 pcs Anchor bolts"
        materials: f.materials
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const m = /^(\d+(?:\.\d+)?)\s+(\S+)\s+(.+)$/.exec(l);
            return m ? { quantity: Number(m[1]), unit: m[2], item: m[3] } : { quantity: 1, unit: null, item: l };
          }),
      }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Plan installation" size="lg">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Select label="Stage" data={ops.stages.installation.map((s) => ({ value: s.id, label: `${s.name}${s.occurrenceNo > 1 ? ` round ${s.occurrenceNo}` : ''}` }))} value={f.stageId} onChange={(v) => setF({ ...f, stageId: v })} allowDeselect={false} />
        <TextInput label="Vehicle or site" required value={f.target} onChange={(e) => setF({ ...f, target: e.currentTarget.value })} />
        <TextInput label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.currentTarget.value })} />
        <SimpleGrid cols={2}>
          <TextInput label="Start" type="datetime-local" value={f.scheduledStart} onChange={(e) => setF({ ...f, scheduledStart: e.currentTarget.value })} />
          <TextInput label="End" type="datetime-local" value={f.scheduledEnd} onChange={(e) => setF({ ...f, scheduledEnd: e.currentTarget.value })} />
          <Select label="Team leader" clearable data={team.map((u) => ({ value: u.id, label: u.fullName }))} value={f.teamLeaderId} onChange={(v) => setF({ ...f, teamLeaderId: v })} />
          <MultiSelect label="Technicians" data={team.map((u) => ({ value: u.id, label: u.fullName }))} value={f.technicianIds} onChange={(v) => setF({ ...f, technicianIds: v })} />
        </SimpleGrid>
        <Textarea label="Access notes" value={f.accessNotes} onChange={(e) => setF({ ...f, accessNotes: e.currentTarget.value })} />
        <Textarea label="Safety / site instructions" value={f.safetyNotes} onChange={(e) => setF({ ...f, safetyNotes: e.currentTarget.value })} />
        <Textarea label="Work instructions" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.currentTarget.value })} />
        <Textarea label="Materials and tools (one per line, e.g. 12 pcs anchor bolts)" value={f.materials} onChange={(e) => setF({ ...f, materials: e.currentTarget.value })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!f.target.trim() || !f.stageId} loading={save.isPending} onClick={() => save.mutate()}>Plan</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

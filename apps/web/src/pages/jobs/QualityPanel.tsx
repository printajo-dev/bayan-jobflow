import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Modal, SegmentedControl, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DeliveriesDto, QcInspectionDto, QcResult, QualityDto } from '@jobflow/shared';
import { API_BASE, get, patch, post, uploadWithProgress } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDateTime } from '../../components/format';
import { membersOf, useDirectory } from '../../components/useDirectory';

const QC_COLOR = { DRAFT: 'yellow', PASSED: 'green', FAILED: 'red' } as const;

export function QualityPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['jobs', jobId, 'qc'], queryFn: () => get<QualityDto>(`/jobs/${jobId}/qc`) });
  const done = (d: QualityDto) => {
    qc.setQueryData(['jobs', jobId, 'qc'], d);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
  };
  const start = useMutation({
    mutationFn: () => post<QualityDto>(`/jobs/${jobId}/qc-inspections`, { stageId: data.data?.activeStage?.id }),
    onSuccess: done,
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  if (data.isPending) return <LoadingState />;
  if (data.isError) return <ErrorState error={data.error} />;
  const d = data.data;
  const draft = d.inspections.find((i) => i.status === 'DRAFT');
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {d.activeStage ? `${d.activeStage.name}${d.activeStage.occurrenceNo > 1 ? ` (round ${d.activeStage.occurrenceNo})` : ''} is waiting for an inspection.` : 'QC is not the current stage.'}
        </Text>
        {d.activeStage && !draft && d.allowedActions.includes('inspect') && (
          <Button size="xs" loading={start.isPending} onClick={() => start.mutate()}>
            Start inspection
          </Button>
        )}
      </Group>
      {d.inspections.length === 0 ? (
        <EmptyState>No inspections yet.</EmptyState>
      ) : (
        d.inspections.map((i) => (i.status === 'DRAFT' && d.allowedActions.includes('inspect') ? <DraftInspection key={i.id} jobId={jobId} ins={i} quality={d} onDone={done} /> : <InspectionView key={i.id} ins={i} />))
      )}
    </Stack>
  );
}

function InspectionView({ ins }: { ins: QcInspectionDto }) {
  return (
    <Card withBorder>
      <Group gap={6}>
        <Text fw={600}>
          Inspection — {ins.stage.name}
          {ins.stage.occurrenceNo > 1 ? ` round ${ins.stage.occurrenceNo}` : ''}
        </Text>
        <Badge color={QC_COLOR[ins.status]}>{ins.status.toLowerCase()}</Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {ins.templateName} · {ins.inspector ?? '—'} · {formatDateTime(ins.inspectedAt ?? ins.createdAt)}
      </Text>
      {ins.defects && <Alert color="red" mt="xs" title={`Defects — rework by ${ins.responsibleStage}`}>{ins.defects}</Alert>}
      {ins.notes && <Text size="sm" mt="xs">{ins.notes}</Text>}
      <Table mt="xs">
        <Table.Tbody>
          {ins.results.map((r) => (
            <Table.Tr key={r.itemId}>
              <Table.Td>{r.label}</Table.Td>
              <Table.Td w={80}>
                <Badge size="sm" color={r.result === 'PASS' ? 'green' : r.result === 'FAIL' ? 'red' : 'gray'}>{r.result ?? '—'}</Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{r.comment}</Text>
                {r.files.map((f) => (
                  <Anchor key={f.id} size="xs" href={`${API_BASE}/files/${f.id}/download?inline=1`} target="_blank" rel="noopener" mr="xs">
                    {f.originalName}
                  </Anchor>
                ))}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

function DraftInspection({ jobId, ins, quality, onDone }: { jobId: string; ins: QcInspectionDto; quality: QualityDto; onDone: (d: QualityDto) => void }) {
  const [rows, setRows] = useState(ins.results.map((r) => ({ itemId: r.itemId, result: r.result as QcResult | null, comment: r.comment ?? '', fileIds: r.files.map((f) => f.id), names: r.files.map((f) => f.originalName) })));
  const [notes, setNotes] = useState(ins.notes ?? '');
  const [failing, setFailing] = useState(false);
  const onError = (e: unknown) => notifications.show({ color: 'red', title: 'Not saved', message: <span style={{ whiteSpace: 'pre-line' }}>{errorMessage(e)}</span> });
  const save = useMutation({
    mutationFn: () => patch<QualityDto>(`/qc-inspections/${ins.id}/results`, { results: rows.map(({ itemId, result, comment, fileIds }) => ({ itemId, result, comment: comment || null, fileIds })), notes: notes || null }),
    onSuccess: (d) => {
      onDone(d);
      notifications.show({ color: 'green', message: 'Inspection saved' });
    },
    onError,
  });
  const approve = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return post<QualityDto>(`/qc-inspections/${ins.id}/approve`);
    },
    onSuccess: (d) => {
      onDone(d);
      notifications.show({ color: 'green', message: 'QC passed' });
    },
    onError,
  });
  // Functional update: an upload finishing later must not overwrite edits made meanwhile.
  const set = (i: number, patch: (row: (typeof rows)[number]) => Partial<(typeof rows)[number]>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch(r) } : r)));
  const canDecide = quality.allowedActions.includes('decide');
  return (
    <Card withBorder>
      <Title order={5}>Inspection in progress — {ins.templateName}</Title>
      <Stack gap="xs" mt="sm">
        {ins.results.map((r, i) => (
          <Group key={r.itemId} align="flex-start" wrap="nowrap">
            <Text size="sm" style={{ flex: 1 }}>
              {r.label}
              {r.required && <Text span c="red"> *</Text>}
              {r.requiresEvidence && <Text span size="xs" c="dimmed"> (photo required)</Text>}
            </Text>
            <SegmentedControl
              size="xs"
              value={rows[i]!.result ?? ''}
              onChange={(v) => set(i, () => ({ result: (v || null) as QcResult | null }))}
              data={[
                { value: 'PASS', label: 'Pass' },
                { value: 'FAIL', label: 'Fail' },
                { value: 'NA', label: 'N/A' },
              ]}
              aria-label={`Result for ${r.label}`}
            />
            <TextInput size="xs" w={200} placeholder="Comment" value={rows[i]!.comment} onChange={(e) => {
                const comment = e.currentTarget.value;
                set(i, () => ({ comment }));
              }} aria-label={`Comment for ${r.label}`} />
            <FileButton
              accept="image/*,application/pdf"
              onChange={async (f) => {
                if (!f) return;
                try {
                  const up = await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/qc-files`, f, f.name);
                  set(i, (row) => ({ fileIds: [...row.fileIds, up.id], names: [...row.names, f.name] }));
                } catch (e) {
                  onError(e);
                }
              }}
            >
              {(props) => (
                <Button size="xs" variant="default" {...props}>
                  {rows[i]!.fileIds.length ? `📷 ${rows[i]!.fileIds.length}` : 'Photo'}
                </Button>
              )}
            </FileButton>
          </Group>
        ))}
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          {canDecide && (
            <>
              <Button color="red" variant="light" onClick={() => setFailing(true)}>
                Fail inspection
              </Button>
              <Button color="green" loading={approve.isPending} onClick={() => approve.mutate()}>
                Pass inspection
              </Button>
            </>
          )}
        </Group>
      </Stack>
      {failing && <FailModal ins={ins} quality={quality} rows={rows} onClose={() => setFailing(false)} onDone={onDone} beforeFail={() => save.mutateAsync()} />}
    </Card>
  );
}

function FailModal({ ins, quality, rows, onClose, onDone, beforeFail }: { ins: QcInspectionDto; quality: QualityDto; rows: { result: QcResult | null; comment: string }[]; onClose: () => void; onDone: (d: QualityDto) => void; beforeFail: () => Promise<unknown> }) {
  const dir = useDirectory();
  const failedItems = ins.results.flatMap((r, i) => (rows[i]?.result === 'FAIL' ? [`${r.label}${rows[i]?.comment ? `: ${rows[i]!.comment}` : ''}`] : []));
  const [defects, setDefects] = useState(failedItems.join('\n'));
  const [target, setTarget] = useState<string | null>(quality.returnTargets[0]?.key ?? null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const dept = quality.returnTargets.find((t) => t.key === target)?.departmentId;
  const run = useMutation({
    mutationFn: async () => {
      await beforeFail();
      return post<QualityDto>(`/qc-inspections/${ins.id}/fail`, { defects, responsibleStageKey: target, assignedToId: assignee });
    },
    onSuccess: (d) => {
      onDone(d);
      notifications.show({ color: 'orange', message: 'QC failed — rework sent to the responsible department' });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Fail inspection">
      <Stack>
        {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
        <Text size="sm">The job returns to the chosen stage only. A blocking correction is created for that department, and QC must inspect again after the rework.</Text>
        <Textarea label="Defects" required autosize minRows={3} value={defects} onChange={(e) => setDefects(e.currentTarget.value)} />
        <Select label="Rework by" data={quality.returnTargets.map((t) => ({ value: t.key, label: t.name }))} value={target} onChange={(v) => { setTarget(v); setAssignee(null); }} allowDeselect={false} />
        <Select label="Assign correction to (optional)" clearable data={membersOf(dir.data, dept).map((u) => ({ value: u.id, label: u.fullName }))} value={assignee} onChange={setAssignee} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="red" disabled={defects.trim().length < 3 || !target} loading={run.isPending} onClick={() => run.mutate()}>Fail and send back</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function DeliveryPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['jobs', jobId, 'delivery'], queryFn: () => get<DeliveriesDto>(`/jobs/${jobId}/delivery-records`) });
  const [planning, setPlanning] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const done = (d: DeliveriesDto) => {
    qc.setQueryData(['jobs', jobId, 'delivery'], d);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
  };
  if (data.isPending) return <LoadingState />;
  if (data.isError) return <ErrorState error={data.error} />;
  const d = data.data;
  const manage = d.allowedActions.includes('manage');
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">The job closes when the handover is recorded with the recipient and evidence (after QC has passed).</Text>
        {manage && d.activeStage && <Button size="xs" onClick={() => setPlanning(true)}>Plan delivery</Button>}
      </Group>
      {d.deliveries.length === 0 ? (
        <EmptyState>No delivery planned.</EmptyState>
      ) : (
        d.deliveries.map((r) => (
          <Card withBorder key={r.id} padding="sm">
            <Group justify="space-between">
              <div>
                <Group gap={6}>
                  <Text fw={600}>Delivery {formatDateTime(r.plannedAt)}</Text>
                  <Badge color={r.status === 'COMPLETED' ? 'green' : r.status === 'CANCELLED' ? 'gray' : 'blue'}>{r.status.toLowerCase()}</Badge>
                </Group>
                {r.notes && <Text size="sm">{r.notes}</Text>}
                {r.status === 'COMPLETED' && (
                  <Text size="sm" c="green.8">
                    Handed over to {r.recipientName} on {formatDateTime(r.actualAt)} (recorded by {r.completedBy}){r.handoverNotes ? ` — ${r.handoverNotes}` : ''}
                  </Text>
                )}
                {r.files.map((f) => (
                  <Anchor key={f.id} size="xs" href={`${API_BASE}/files/${f.id}/download?inline=1`} target="_blank" rel="noopener" mr="xs">
                    {f.originalName}
                  </Anchor>
                ))}
              </div>
              {manage && r.status === 'PLANNED' && <Button size="xs" color="green" onClick={() => setCompleting(r.id)}>Record handover</Button>}
            </Group>
          </Card>
        ))
      )}
      {planning && d.activeStage && <PlanDelivery jobId={jobId} stageId={d.activeStage.id} onClose={() => setPlanning(false)} onDone={done} />}
      {completing && <CompleteDelivery jobId={jobId} id={completing} onClose={() => setCompleting(null)} onDone={done} />}
    </Stack>
  );
}

function PlanDelivery({ jobId, stageId, onClose, onDone }: { jobId: string; stageId: string; onClose: () => void; onDone: (d: DeliveriesDto) => void }) {
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const run = useMutation({
    mutationFn: () => post<DeliveriesDto>(`/jobs/${jobId}/delivery-records`, { stageId, plannedAt: new Date(when).toISOString(), notes: notes || null }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Plan delivery">
      <Stack>
        {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
        <TextInput label="When" type="datetime-local" required value={when} onChange={(e) => setWhen(e.currentTarget.value)} />
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!when} loading={run.isPending} onClick={() => run.mutate()}>Plan</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CompleteDelivery({ jobId, id, onClose, onDone }: { jobId: string; id: string; onClose: () => void; onDone: (d: DeliveriesDto) => void }) {
  const [recipient, setRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const run = useMutation({
    mutationFn: async () => {
      const fileIds: string[] = [];
      for (const f of files) fileIds.push((await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/delivery-files`, f, f.name)).id);
      return post<DeliveriesDto>(`/delivery-records/${id}/complete`, { actualAt: new Date().toISOString(), recipientName: recipient, handoverNotes: notes || null, fileIds });
    },
    onSuccess: (d) => {
      onDone(d);
      notifications.show({ color: 'green', message: 'Delivery recorded — the job is closed' });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="Record handover">
      <Stack>
        {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
        <TextInput label="Received by" required value={recipient} onChange={(e) => setRecipient(e.currentTarget.value)} />
        <Textarea label="Handover notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <FileButton multiple accept="image/*,application/pdf" onChange={setFiles}>
          {(props) => <Button variant="default" {...props}>{files.length ? `${files.length} evidence file(s)` : 'Attach handover photos / signed note'}</Button>}
        </FileButton>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="green" disabled={!recipient.trim() || !files.length} loading={run.isPending} onClick={() => run.mutate()}>Record handover</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

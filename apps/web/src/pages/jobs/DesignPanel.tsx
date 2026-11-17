import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Modal, Progress, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { APPROVAL_METHODS, type ApprovalMethod, type ArtworkVersionDto, type DesignDto } from '@jobflow/shared';
import { API_BASE, get, post, uploadWithProgress } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate, formatDateTime, formatSize } from '../../components/format';
import { useDirectory } from '../../components/useDirectory';

export const METHOD: Record<ApprovalMethod, string> = {
  IN_PERSON: 'In person',
  EMAIL: 'Email',
  WHATSAPP: 'WhatsApp',
  PHONE: 'Phone',
  SIGNED_FORM: 'Signed form',
  OTHER: 'Other',
};

export function DesignPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const design = useQuery({ queryKey: ['jobs', jobId, 'design'], queryFn: () => get<DesignDto>(`/jobs/${jobId}/design`) });
  const [uploading, setUploading] = useState(false);
  const [approving, setApproving] = useState<ArtworkVersionDto | null>(null);
  const [round, setRound] = useState(false);

  if (design.isPending) return <LoadingState />;
  if (design.isError) return <ErrorState error={design.error} />;
  const d = design.data;
  const can = (a: DesignDto['allowedActions'][number]) => d.allowedActions.includes(a);
  const latest = d.versions[0];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
  };

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          {latest ? (
            <Text size="sm" component="div">
              Latest: <b>version {latest.versionNo}</b> —{' '}
              {d.latestApproved ? (
                <Badge color="green">Customer approved</Badge>
              ) : (
                <Badge color="orange">Awaiting customer approval</Badge>
              )}
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              No artwork uploaded yet.
            </Text>
          )}
        </div>
        <Group gap="xs">
          {can('manageRounds') && (
            <Button size="xs" variant="default" onClick={() => setRound(true)}>
              New correction round
            </Button>
          )}
          {can('upload') && (
            <Button size="xs" onClick={() => setUploading(true)}>
              Upload new version
            </Button>
          )}
        </Group>
      </Group>

      <Title order={5}>Artwork versions</Title>
      {d.versions.length === 0 ? (
        <EmptyState>No versions.</EmptyState>
      ) : (
        d.versions.map((v) => (
          <Card withBorder key={v.id} padding="sm">
            <Group justify="space-between" align="flex-start">
              <div>
                <Group gap={6}>
                  <Text fw={600}>Version {v.versionNo}</Text>
                  {v.correctionRoundNo && <Badge size="xs" variant="outline">Correction round {v.correctionRoundNo}</Badge>}
                  {v.approvals.length > 0 ? <Badge size="xs" color="green">Approved</Badge> : <Badge size="xs" color="gray">Not approved</Badge>}
                </Group>
                <Text size="sm">
                  <Anchor href={`${API_BASE}/files/${v.file.id}/download`}>{v.file.originalName}</Anchor> · {formatSize(v.file.size)} ·{' '}
                  <Anchor href={`${API_BASE}/files/${v.file.id}/download?inline=1`} target="_blank" rel="noopener">
                    preview
                  </Anchor>
                </Text>
                <Text size="xs" c="dimmed">
                  Uploaded {formatDateTime(v.createdAt)} by {v.uploadedBy ?? '—'} · SHA-256 {v.file.sha256.slice(0, 12)}…{v.notes ? ` · ${v.notes}` : ''}
                </Text>
                {v.approvals.map((a) => (
                  <Text key={a.id} size="sm" c="green.8" mt={4}>
                    ✓ Approved by {a.approverName}
                    {a.approverRole ? ` (${a.approverRole})` : ''} via {METHOD[a.method]} on {formatDateTime(a.approvedAt)} — recorded by {a.recordedBy}
                    {a.notes ? `. ${a.notes}` : ''}
                    {a.evidenceFile && (
                      <>
                        {' · '}
                        <Anchor href={`${API_BASE}/files/${a.evidenceFile.id}/download`}>evidence</Anchor>
                      </>
                    )}
                  </Text>
                ))}
              </div>
              {can('recordApproval') && v.id === latest?.id && v.approvals.length === 0 && (
                <Button size="xs" variant="light" color="green" onClick={() => setApproving(v)}>
                  Record customer approval
                </Button>
              )}
            </Group>
          </Card>
        ))
      )}

      <Title order={5}>Correction rounds</Title>
      {d.rounds.length === 0 ? (
        <EmptyState>No correction rounds.</EmptyState>
      ) : (
        <Table striped>
          <Table.Tbody>
            {d.rounds.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td w={90}>Round {r.roundNo}</Table.Td>
                <Table.Td>
                  <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                    {r.description}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Requested by {r.requestedBy ?? '—'} · designer {r.assignedDesigner?.fullName ?? 'not assigned'} · deadline {formatDate(r.deadline)}
                    {r.files.map((f) => (
                      <span key={f.id}>
                        {' · '}
                        <Anchor href={`${API_BASE}/files/${f.id}/download`} size="xs">
                          {f.originalName}
                        </Anchor>
                      </span>
                    ))}
                  </Text>
                </Table.Td>
                <Table.Td w={170}>
                  {r.status === 'RESOLVED' ? <Badge color="green">Resolved by v{r.resolvedByVersionNo}</Badge> : <Badge color="orange">Open</Badge>}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {uploading && <UploadVersionModal jobId={jobId} design={d} onClose={() => setUploading(false)} onDone={refresh} />}
      {approving && <ApprovalModal jobId={jobId} version={approving} onClose={() => setApproving(null)} onDone={refresh} />}
      {round && <RoundModal jobId={jobId} onClose={() => setRound(false)} onDone={refresh} />}
    </Stack>
  );
}

function UploadVersionModal({ jobId, design, onClose, onDone }: { jobId: string; design: DesignDto; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [roundId, setRoundId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const save = useMutation({
    mutationFn: () =>
      uploadWithProgress<DesignDto>(`/jobs/${jobId}/artwork-versions`, file!, file!.name, setProgress, {
        notes,
        ...(roundId ? { correctionRoundId: roundId } : {}),
      }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'New artwork version uploaded. It needs a new customer approval.' });
      onDone();
      onClose();
    },
  });
  const open = design.rounds.filter((r) => r.status === 'OPEN');
  return (
    <Modal opened onClose={onClose} title="Upload new artwork version">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Text size="sm">Earlier versions are kept unchanged. A new version always needs a new customer approval.</Text>
        <FileButton onChange={setFile}>{(props) => <Button variant="default" {...props}>{file ? file.name : 'Choose file'}</Button>}</FileButton>
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {open.length > 0 && (
          <Select label="Resolves correction round" clearable data={open.map((r) => ({ value: r.id, label: `Round ${r.roundNo}: ${r.description.slice(0, 60)}` }))} value={roundId} onChange={setRoundId} />
        )}
        {save.isPending && <Progress value={progress * 100} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!file} loading={save.isPending} onClick={() => save.mutate()}>
            Upload
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ApprovalModal({ jobId, version, onClose, onDone }: { jobId: string; version: ArtworkVersionDto; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return { approverName: '', approverRole: '', method: 'EMAIL' as ApprovalMethod, approvedAt: local, notes: '' };
  });
  const [evidence, setEvidence] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      let evidenceFileId: string | null = null;
      if (evidence) evidenceFileId = (await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/design-files?kind=evidence`, evidence, evidence.name)).id;
      return post<DesignDto>(`/artwork-versions/${version.id}/approval-records`, {
        approverName: form.approverName,
        approverRole: form.approverRole || null,
        method: form.method,
        approvedAt: new Date(form.approvedAt).toISOString(),
        notes: form.notes || null,
        evidenceFileId,
      });
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: `Customer approval of version ${version.versionNo} recorded` });
      onDone();
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={`Record customer approval — version ${version.versionNo}`}>
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Text size="sm">
          Record only an approval the customer actually gave for <b>{version.file.originalName}</b> (version {version.versionNo}).
        </Text>
        <TextInput label="Approved by (name)" required value={form.approverName} onChange={(e) => setForm({ ...form, approverName: e.currentTarget.value })} />
        <TextInput label="Their role" value={form.approverRole} onChange={(e) => setForm({ ...form, approverRole: e.currentTarget.value })} />
        <Select label="How" data={APPROVAL_METHODS.map((m) => ({ value: m, label: METHOD[m] }))} value={form.method} onChange={(v) => setForm({ ...form, method: (v as ApprovalMethod) ?? 'EMAIL' })} allowDeselect={false} />
        <TextInput label="When" type="datetime-local" required value={form.approvedAt} onChange={(e) => setForm({ ...form, approvedAt: e.currentTarget.value })} />
        <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })} />
        <FileButton onChange={setEvidence}>
          {(props) => (
            <Button variant="default" {...props}>
              {evidence ? `Evidence: ${evidence.name}` : 'Attach evidence (screenshot, email, signed form)'}
            </Button>
          )}
        </FileButton>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="green" disabled={!form.approverName.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Record approval
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RoundModal({ jobId, onClose, onDone }: { jobId: string; onClose: () => void; onDone: () => void }) {
  const dir = useDirectory();
  const [description, setDescription] = useState('');
  const [designer, setDesigner] = useState<string | null>(null);
  const [deadline, setDeadline] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const designers = (dir.data ?? []).filter((u) => u.departments.some((d) => d.code === 'DESIGN'));
  const save = useMutation({
    mutationFn: async () => {
      const fileIds: string[] = [];
      for (const f of files) fileIds.push((await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/design-files?kind=round`, f, f.name)).id);
      return post<DesignDto>(`/jobs/${jobId}/correction-rounds`, { description, assignedDesignerId: designer, deadline: deadline || null, fileIds });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title="New design correction round">
      <Stack>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Textarea label="What must change?" required autosize minRows={3} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <Select label="Designer" data={designers.map((u) => ({ value: u.id, label: u.fullName }))} value={designer} onChange={setDesigner} clearable />
        <TextInput label="Deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.currentTarget.value)} />
        <FileButton multiple onChange={setFiles}>{(props) => <Button variant="default" {...props}>{files.length ? `${files.length} file(s)` : 'Attach markup or references'}</Button>}</FileButton>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!description.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Open round
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

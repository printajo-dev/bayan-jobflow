import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Timeline } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  AUTHORITY_DOCUMENT_KINDS,
  PAYMENT_STATUSES,
  type AuthorityApplicationDto,
  type AuthorityDocumentKind,
  type AuthorityDto,
  type AuthorityStatus,
  type PaymentStatus,
} from '@jobflow/shared';
import { API_BASE, get, patch, post, uploadWithProgress } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate, formatDateTime } from '../../components/format';

export const AUTHORITY_STATUS: Record<AuthorityStatus, { label: string; color: string }> = {
  NOT_REQUIRED: { label: 'Not required', color: 'gray' },
  PENDING_PREPARATION: { label: 'Pending preparation', color: 'yellow' },
  READY_TO_SUBMIT: { label: 'Ready to submit', color: 'cyan' },
  SUBMITTED: { label: 'Submitted', color: 'blue' },
  UNDER_REVIEW: { label: 'Under review', color: 'indigo' },
  MORE_INFO_REQUIRED: { label: 'More information required', color: 'orange' },
  REJECTED: { label: 'Rejected', color: 'red' },
  APPROVED: { label: 'Approved', color: 'green' },
  EXPIRED: { label: 'Expired', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'gray' },
};

export function ProPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['jobs', jobId, 'authority'], queryFn: () => get<AuthorityDto>(`/jobs/${jobId}/authority`) });
  const [typeId, setTypeId] = useState<string | null>(null);
  const done = (d: AuthorityDto) => {
    qc.setQueryData(['jobs', jobId, 'authority'], d);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId, 'workflow'] });
  };
  const create = useMutation({
    mutationFn: () => post<AuthorityDto>(`/jobs/${jobId}/authority-applications`, { authorityTypeId: typeId }),
    onSuccess: (d) => {
      setTypeId(null);
      done(d);
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });
  if (data.isPending) return <LoadingState />;
  if (data.isError) return <ErrorState error={data.error} />;
  const d = data.data;
  const manage = d.allowedActions.includes('manage');
  const used = new Set(d.applications.map((a) => a.authorityType.id));
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm">
          Government approval is{' '}
          {d.cleared ? <Badge color="green">cleared</Badge> : <Badge color="orange">not cleared</Badge>} — Print and Wrap cannot start until every required authority is Approved or
          marked Not Required.
        </Text>
        {manage && (
          <Group gap="xs">
            <Select
              size="xs"
              placeholder="Add authority"
              data={d.types.filter((t) => t.isActive && !used.has(t.id)).map((t) => ({ value: t.id, label: t.name }))}
              value={typeId}
              onChange={setTypeId}
              aria-label="Authority"
              w={260}
            />
            <Button size="xs" disabled={!typeId} loading={create.isPending} onClick={() => create.mutate()}>
              Add application
            </Button>
          </Group>
        )}
      </Group>
      {d.applications.length === 0 ? (
        <EmptyState>No authority applications yet.</EmptyState>
      ) : (
        d.applications.map((a) => <ApplicationCard key={a.id} jobId={jobId} app={a} manage={manage} notRequired={d.allowedActions.includes('markNotRequired')} onDone={done} />)
      )}
    </Stack>
  );
}

function ApplicationCard({ jobId, app: a, manage, notRequired, onDone }: { jobId: string; app: AuthorityApplicationDto; manage: boolean; notRequired: boolean; onDone: (d: AuthorityDto) => void }) {
  const [dialog, setDialog] = useState<'status' | 'details' | 'notRequired' | 'document' | 'payment' | null>(null);
  const [history, setHistory] = useState(false);
  const s = AUTHORITY_STATUS[a.status];
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap={6}>
            <Text fw={600}>{a.authorityType.name}</Text>
            <Badge color={s.color}>{s.label}</Badge>
          </Group>
          <Text size="sm">
            Reference {a.referenceNumber ?? '—'} · submitted {formatDateTime(a.submissionDate)} · expected {formatDate(a.expectedResponseDate)} · response {formatDateTime(a.actualResponseDate)}
            {a.validUntil ? ` · valid until ${formatDate(a.validUntil)}` : ''}
          </Text>
          <Text size="sm">
            Fees {a.fees != null ? a.fees.toFixed(2) : '—'} · payment {a.paymentStatus.toLowerCase().replace('_', ' ')}
          </Text>
          {a.rejectionReason && <Text size="sm" c="red">Rejected: {a.rejectionReason}</Text>}
          {a.notRequiredReason && (
            <Text size="sm" c="dimmed">
              Not required ({a.notRequiredBy}): {a.notRequiredReason}
            </Text>
          )}
          {a.comments && <Text size="sm" c="dimmed">{a.comments}</Text>}
        </div>
        <Group gap={4}>
          {manage && a.allowedStatuses.length > 0 && <Button size="xs" onClick={() => setDialog('status')}>Change status</Button>}
          {manage && <Button size="xs" variant="default" onClick={() => setDialog('details')}>Details</Button>}
          {manage && <Button size="xs" variant="default" onClick={() => setDialog('document')}>Add document</Button>}
          {manage && <Button size="xs" variant="default" onClick={() => setDialog('payment')}>Record payment</Button>}
          {notRequired && a.status !== 'APPROVED' && a.status !== 'NOT_REQUIRED' && (
            <Button size="xs" variant="light" color="gray" onClick={() => setDialog('notRequired')}>
              Mark Not Required
            </Button>
          )}
        </Group>
      </Group>
      {a.submissions.length > 0 && (
        <Table mt="xs" withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Submitted</Table.Th>
              <Table.Th>Reference</Table.Th>
              <Table.Th>Outcome</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {a.submissions.map((x) => (
              <Table.Tr key={x.id}>
                <Table.Td>{x.submissionNo}</Table.Td>
                <Table.Td>{formatDateTime(x.submittedAt)}</Table.Td>
                <Table.Td>{x.referenceNumber ?? '—'}</Table.Td>
                <Table.Td>
                  {x.outcome.toLowerCase().replace('_', ' ')}
                  {x.outcomeNotes ? ` — ${x.outcomeNotes}` : ''}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {a.documents.map((doc) => (
        <Text key={doc.id} size="sm">
          📎 <Anchor href={`${API_BASE}/files/${doc.fileId}/download`}>{doc.originalName}</Anchor> ({doc.kind.toLowerCase()}, {doc.uploadedBy}, {formatDateTime(doc.createdAt)})
        </Text>
      ))}
      {a.payments.map((x) => (
        <Text key={x.id} size="sm">
          💳 {x.amount.toFixed(2)} paid {formatDateTime(x.paidAt)} {x.reference ? `(${x.reference})` : ''} {x.receiptFileId && <Anchor href={`${API_BASE}/files/${x.receiptFileId}/download`}>receipt</Anchor>}
        </Text>
      ))}
      <Button size="compact-xs" variant="subtle" mt={4} onClick={() => setHistory(!history)}>
        History
      </Button>
      {history && (
        <Timeline bulletSize={12} lineWidth={1} mt="xs">
          {a.history.map((h, i) => (
            <Timeline.Item key={i} title={<Text size="xs">{AUTHORITY_STATUS[h.to].label}</Text>}>
              <Text size="xs" c="dimmed">
                {formatDateTime(h.at)} · {h.actor ?? '—'}
                {h.note ? ` · ${h.note}` : ''}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
      {dialog && <ApplicationDialog jobId={jobId} app={a} mode={dialog} onClose={() => setDialog(null)} onDone={onDone} />}
    </Card>
  );
}

function ApplicationDialog({ jobId, app: a, mode, onClose, onDone }: { jobId: string; app: AuthorityApplicationDto; mode: 'status' | 'details' | 'notRequired' | 'document' | 'payment'; onClose: () => void; onDone: (d: AuthorityDto) => void }) {
  const [status, setStatus] = useState<string | null>(a.allowedStatuses[0] ?? null);
  const [note, setNote] = useState('');
  const [ref, setRef] = useState(a.referenceNumber ?? '');
  const [expected, setExpected] = useState(a.expectedResponseDate ?? '');
  const [validUntil, setValidUntil] = useState(a.validUntil ?? '');
  const [fees, setFees] = useState<number | string>(a.fees ?? '');
  const [payment, setPayment] = useState<string>(a.paymentStatus);
  const [kind, setKind] = useState<AuthorityDocumentKind>('APPROVAL');
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState<number | string>(a.fees ?? '');
  const run = useMutation({
    mutationFn: async (): Promise<AuthorityDto> => {
      if (mode === 'notRequired') return post(`/authority-applications/${a.id}/not-required`, { reason: note });
      if (mode === 'status') {
        return patch(`/authority-applications/${a.id}`, {
          status,
          note: note || undefined,
          ...(status === 'REJECTED' ? { rejectionReason: note } : {}),
          ...(status === 'SUBMITTED' && ref ? { referenceNumber: ref } : {}),
        });
      }
      if (mode === 'details') {
        return patch(`/authority-applications/${a.id}`, {
          referenceNumber: ref || null,
          expectedResponseDate: expected || null,
          validUntil: validUntil || null,
          fees: fees === '' ? null : Number(fees),
          paymentStatus: payment as PaymentStatus,
          comments: note || a.comments,
        });
      }
      const fileId = file ? (await uploadWithProgress<{ id: string }>(`/jobs/${jobId}/operation-files?kind=authority`, file, file.name)).id : null;
      if (mode === 'document') return post(`/authority-applications/${a.id}/documents`, { fileId, kind });
      return post(`/authority-applications/${a.id}/payments`, { amount: Number(amount), paidAt: new Date().toISOString(), reference: note || null, receiptFileId: fileId });
    },
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  const title = { status: 'Change status', details: 'Application details', notRequired: 'Mark Not Required', document: 'Add document', payment: 'Record payment' }[mode];
  return (
    <Modal opened onClose={onClose} title={`${a.authorityType.name}: ${title}`}>
      <Stack>
        {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
        {mode === 'status' && (
          <>
            <Select label="New status" data={a.allowedStatuses.map((s) => ({ value: s, label: AUTHORITY_STATUS[s].label }))} value={status} onChange={setStatus} allowDeselect={false} />
            {status === 'SUBMITTED' && <TextInput label="Authority reference / application number" value={ref} onChange={(e) => setRef(e.currentTarget.value)} />}
            {status === 'APPROVED' && <Text size="sm">Upload the approval document first (Add document → Approval).</Text>}
            <Textarea label={status === 'REJECTED' ? 'Rejection reason' : 'Note'} required={['REJECTED', 'MORE_INFO_REQUIRED', 'CANCELLED'].includes(status ?? '')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          </>
        )}
        {mode === 'details' && (
          <>
            <TextInput label="Reference number" value={ref} onChange={(e) => setRef(e.currentTarget.value)} />
            <SimpleGrid cols={2}>
              <TextInput label="Expected response" type="date" value={expected} onChange={(e) => setExpected(e.currentTarget.value)} />
              <TextInput label="Valid until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.currentTarget.value)} />
              <NumberInput label="Authority fees" min={0} decimalScale={2} value={fees} onChange={setFees} />
              <Select label="Payment" data={PAYMENT_STATUSES.map((p) => ({ value: p, label: p.toLowerCase().replace('_', ' ') }))} value={payment} onChange={(v) => setPayment(v ?? 'NOT_DUE')} allowDeselect={false} />
            </SimpleGrid>
            <Textarea label="Comments" value={note} placeholder={a.comments ?? ''} onChange={(e) => setNote(e.currentTarget.value)} />
          </>
        )}
        {mode === 'notRequired' && (
          <>
            <Text size="sm">This approval is not needed for this job. The reason is recorded in the job history and the audit log.</Text>
            <Textarea label="Reason" required value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          </>
        )}
        {(mode === 'document' || mode === 'payment') && (
          <>
            {mode === 'document' && <Select label="Type" data={AUTHORITY_DOCUMENT_KINDS.map((k) => ({ value: k, label: k.toLowerCase() }))} value={kind} onChange={(v) => setKind((v as AuthorityDocumentKind) ?? 'OTHER')} allowDeselect={false} />}
            {mode === 'payment' && <NumberInput label="Amount" min={0} decimalScale={2} required value={amount} onChange={setAmount} />}
            {mode === 'payment' && <TextInput label="Payment reference" value={note} onChange={(e) => setNote(e.currentTarget.value)} />}
            <FileButton onChange={setFile}>{(props) => <Button variant="default" {...props}>{file ? file.name : mode === 'payment' ? 'Attach receipt' : 'Choose file'}</Button>}</FileButton>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={run.isPending} disabled={(mode === 'document' && !file) || (mode === 'notRequired' && note.trim().length < 3)} onClick={() => run.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

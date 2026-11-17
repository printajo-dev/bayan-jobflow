import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { AuthorityTypeDto, JobNumberSettings, MachineDto, QcTemplateDto } from '@jobflow/shared';
import { Badge, Checkbox, Select, Switch, Table, Textarea } from '@mantine/core';
import { get, patch, post, put } from '../../api/client';
import { ErrorState, errorMessage, LoadingState } from '../../components/states';

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings', 'job-number'], queryFn: () => get<JobNumberSettings>('/settings/job-number') });
  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState error={settings.error} />;
  return (
    <Stack maw={720}>
      <Title order={2}>Settings</Title>
      <JobNumberCard initial={settings.data} />
      <AuthorityTypesCard />
      <MachinesCard />
      <QcChecklistCard />
    </Stack>
  );
}

function JobNumberCard({ initial }: { initial: JobNumberSettings }) {
  const qc = useQueryClient();
  const [pattern, setPattern] = useState(initial.pattern ?? '');
  const [example, setExample] = useState(initial.example ?? '');
  const valid = (() => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  })();
  const matches = valid && pattern && example ? new RegExp(`^(?:${pattern})$`).test(example.toUpperCase()) : null;
  const save = useMutation({
    mutationFn: () => put<JobNumberSettings>('/settings/job-number', { pattern: pattern || null, example: example || null }),
    onSuccess: (s) => {
      qc.setQueryData(['settings', 'job-number'], s);
      notifications.show({ color: 'green', message: 'Job Number settings saved' });
    },
  });
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Job Number</Title>
        <Text size="sm" c="dimmed">
          Sales enter the ERP invoice number as the Job Number. Optionally require a format so typing mistakes are caught. Leave the pattern empty to
          accept any unique number. Job Numbers are stored in capital letters.
        </Text>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <TextInput
          label="Format (regular expression)"
          description="Example: INV-[0-9]{5} for INV-10023"
          styles={{ input: { fontFamily: "monospace" } }}
          value={pattern}
          onChange={(e) => setPattern(e.currentTarget.value)}
          error={!valid ? 'Not a valid regular expression' : undefined}
        />
        <TextInput
          label="Example shown to Sales"
          value={example}
          onChange={(e) => setExample(e.currentTarget.value.toUpperCase())}
          error={matches === false ? 'The example does not match the format' : undefined}
        />
        <Group justify="flex-end">
          <Button disabled={!valid || matches === false} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function AuthorityTypesCard() {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['authority-types'], queryFn: () => get<AuthorityTypeDto[]>('/authority-types') });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['authority-types'] });
  const add = useMutation({ mutationFn: () => post('/authority-types', { code, name, isActive: true }), onSuccess: () => { setCode(''); setName(''); refresh(); } });
  const toggle = useMutation({ mutationFn: (t: AuthorityTypeDto) => patch(`/authority-types/${t.id}`, { code: t.code, name: t.name, description: t.description, isActive: !t.isActive }), onSuccess: refresh });
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Government authorities</Title>
        <Text size="sm" c="dimmed">Authorities PRO can apply to (RTA, Dubai Municipality…).</Text>
        {add.isError && <Alert color="red">{errorMessage(add.error)}</Alert>}
        <Table>
          <Table.Tbody>
            {(types.data ?? []).map((t) => (
              <Table.Tr key={t.id}>
                <Table.Td><Badge variant="outline">{t.code}</Badge></Table.Td>
                <Table.Td>{t.name}</Table.Td>
                <Table.Td><Switch label="Active" checked={t.isActive} onChange={() => toggle.mutate(t)} /></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group align="flex-end">
          <TextInput label="Code" w={140} value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} />
          <TextInput label="Name" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button disabled={!code || !name} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </Group>
      </Stack>
    </Card>
  );
}

function MachinesCard() {
  const qc = useQueryClient();
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => get<MachineDto[]>('/machines') });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['machines'] });
  const add = useMutation({ mutationFn: () => post('/machines', { code, name, kind: kind || null, isActive: true }), onSuccess: () => { setCode(''); setName(''); setKind(''); refresh(); } });
  const toggle = useMutation({ mutationFn: (m: MachineDto) => patch(`/machines/${m.id}`, { code: m.code, name: m.name, kind: m.kind, isActive: !m.isActive }), onSuccess: refresh });
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Machines and printers</Title>
        {add.isError && <Alert color="red">{errorMessage(add.error)}</Alert>}
        <Table>
          <Table.Tbody>
            {(machines.data ?? []).map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td><Badge variant="outline">{m.code}</Badge></Table.Td>
                <Table.Td>{m.name}</Table.Td>
                <Table.Td>{m.kind ?? ''}</Table.Td>
                <Table.Td><Switch label="Active" checked={m.isActive} onChange={() => toggle.mutate(m)} /></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group align="flex-end">
          <TextInput label="Code" w={120} value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} />
          <TextInput label="Name" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput label="Kind" w={140} value={kind} onChange={(e) => setKind(e.currentTarget.value)} />
          <Button disabled={!code || !name} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </Group>
      </Stack>
    </Card>
  );
}

function QcChecklistCard() {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['qc-templates'], queryFn: () => get<QcTemplateDto[]>('/qc-checklist-templates') });
  const [code, setCode] = useState<string>('VB');
  const current = templates.data?.find((t) => t.serviceType.code === code);
  const [text, setText] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Set<number>>(new Set());
  const lines = (text ?? current?.items.map((i) => i.label).join('\n') ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      post(`/qc-checklist-templates/${code}`, {
        name: current?.name ?? (code === 'VB' ? 'Vehicle branding QC' : 'Signage QC'),
        items: lines.map((label, i) => ({ label, required: true, requiresEvidence: text === null ? (current?.items[i]?.requiresEvidence ?? false) : evidence.has(i) })),
      }),
    onSuccess: () => {
      setText(null);
      void qc.invalidateQueries({ queryKey: ['qc-templates'] });
    },
  });
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>QC checklists</Title>
        <Text size="sm" c="dimmed">One item per line. Saving creates a new version; inspections already started keep their own copy.</Text>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <Select label="Service type" data={[{ value: 'VB', label: 'Vehicle Branding' }, { value: 'SG', label: 'Signage' }]} value={code} onChange={(v) => { setCode(v ?? 'VB'); setText(null); }} allowDeselect={false} w={240} />
        <Text size="xs">Current: {current ? `${current.name} v${current.version}` : 'none'}</Text>
        <Textarea autosize minRows={5} value={text ?? current?.items.map((i) => i.label).join('\n') ?? ''} onChange={(e) => setText(e.currentTarget.value)} aria-label="Checklist items" />
        {text !== null && (
          <Stack gap={2}>
            <Text size="xs">Photo required for:</Text>
            {lines.map((l, i) => (
              <Checkbox key={i} size="xs" label={l} checked={evidence.has(i)} onChange={(e) => { const n = new Set(evidence); if (e.currentTarget.checked) n.add(i); else n.delete(i); setEvidence(n); }} />
            ))}
          </Stack>
        )}
        <Group justify="flex-end">
          <Button disabled={text === null || lines.length === 0} loading={save.isPending} onClick={() => save.mutate()}>Save new version</Button>
        </Group>
      </Stack>
    </Card>
  );
}

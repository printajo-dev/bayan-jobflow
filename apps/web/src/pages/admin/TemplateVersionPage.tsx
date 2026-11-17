import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { GATES, type DepartmentDto, type GateKey, type SaveTemplateVersionInput, type TemplateVersionDto } from '@jobflow/shared';
import { del, get, post, put } from '../../api/client';
import { ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate } from '../../components/format';
import { VERSION_STATUS } from './TemplatesPage';

interface StageDraft {
  key: string;
  name: string;
  description: string;
  departmentId: string | null;
  gateKeys: GateKey[];
  checklist: { label: string; required: boolean }[];
  isNew: boolean;
}

const gateLabel = (k: string) => GATES.find((g) => g.key === k)?.label ?? k;

export function TemplateVersionPage() {
  const { id = '' } = useParams();
  const version = useQuery({ queryKey: ['template-version', id], queryFn: () => get<TemplateVersionDto>(`/workflow-template-versions/${id}`) });
  if (version.isPending) return <LoadingState />;
  if (version.isError) return <ErrorState error={version.error} />;
  return version.data.status === 'DRAFT' ? <DraftEditor key={version.data.id} version={version.data} /> : <VersionView version={version.data} />;
}

function Header({ version }: { version: TemplateVersionDto }) {
  return (
    <>
      <Anchor component={Link} to="/admin/templates" size="sm">
        ← All templates
      </Anchor>
      <Group gap="xs">
        <Title order={2}>Version {version.versionNo}</Title>
        <Badge color={VERSION_STATUS[version.status].color}>{VERSION_STATUS[version.status].label}</Badge>
      </Group>
      <Text size="sm" c="dimmed">
        {version.publishedAt ? `Published ${formatDate(version.publishedAt)}${version.publishedBy ? ` by ${version.publishedBy}` : ''} · ` : ''}
        {version.jobCount} job(s) use this version
      </Text>
    </>
  );
}

function VersionView({ version }: { version: TemplateVersionDto }) {
  return (
    <Stack>
      <Header version={version} />
      {version.notes && <Alert color="gray">{version.notes}</Alert>}
      <Text size="sm" c="dimmed">
        Published versions cannot be changed. Start a new draft from the templates page to make changes.
      </Text>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={40}>#</Table.Th>
            <Table.Th>Stage</Table.Th>
            <Table.Th>Responsible department</Table.Th>
            <Table.Th>Completion requires</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {version.stages.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.sequence}</Table.Td>
              <Table.Td>
                <Text fw={600}>{s.name}</Text>
                <Text size="xs" c="dimmed">
                  {s.description}
                </Text>
              </Table.Td>
              <Table.Td>{s.department.name}</Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  {s.gateKeys.map((g) => (
                    <Text key={g} size="sm">
                      ✓ {gateLabel(g)}
                    </Text>
                  ))}
                  {s.checklist.map((c) => (
                    <Text key={c.label} size="sm">
                      ☐ {c.label}
                      {c.required ? '' : ' (optional)'}
                    </Text>
                  ))}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {version.returnRules.length > 0 && (
        <Card withBorder>
          <Text fw={600} mb={4}>
            Allowed returns for correction
          </Text>
          {version.returnRules.map((r) => (
            <Text key={`${r.fromKey}-${r.toKey}`} size="sm">
              {version.stages.find((s) => s.key === r.fromKey)?.name} → {version.stages.find((s) => s.key === r.toKey)?.name}
            </Text>
          ))}
        </Card>
      )}
    </Stack>
  );
}

function DraftEditor({ version }: { version: TemplateVersionDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments') });
  const [notes, setNotes] = useState(version.notes ?? '');
  const [stages, setStages] = useState<StageDraft[]>(
    version.stages.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description ?? '',
      departmentId: s.department.id,
      gateKeys: s.gateKeys,
      checklist: s.checklist,
      isNew: false,
    })),
  );
  const [rules, setRules] = useState(version.returnRules);
  const [error, setError] = useState<string | null>(null);

  const body = (): SaveTemplateVersionInput => ({
    notes: notes || null,
    stages: stages.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description || null,
      departmentId: s.departmentId ?? '',
      gateKeys: s.gateKeys,
      checklist: s.checklist.filter((c) => c.label.trim() !== ''),
    })),
    returnRules: rules.filter((r) => stages.some((s) => s.key === r.fromKey) && stages.some((s) => s.key === r.toKey)),
  });
  const refresh = (v: TemplateVersionDto) => {
    qc.setQueryData(['template-version', v.id], v);
    void qc.invalidateQueries({ queryKey: ['templates'] });
  };
  const save = useMutation({
    mutationFn: () => put<TemplateVersionDto>(`/workflow-template-versions/${version.id}`, body()),
    onSuccess: (v) => {
      setError(null);
      refresh(v);
      notifications.show({ color: 'green', message: 'Draft saved' });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const publish = useMutation({
    mutationFn: async () => {
      await put<TemplateVersionDto>(`/workflow-template-versions/${version.id}`, body());
      return post<TemplateVersionDto>(`/workflow-template-versions/${version.id}/publish`);
    },
    onSuccess: (v) => {
      refresh(v);
      notifications.show({ color: 'green', message: `Version ${v.versionNo} published. New jobs use it from now on.` });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => del(`/workflow-template-versions/${version.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      navigate('/admin/templates');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const update = (i: number, patch: Partial<StageDraft>) => setStages(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...stages];
    const [s] = next.splice(i, 1);
    next.splice(i + dir, 0, s!);
    setStages(next);
  };
  const deptOptions = (departments.data ?? []).filter((d) => d.isActive).map((d) => ({ value: d.id, label: d.name }));
  const gateOptions = GATES.filter((g) => g.available).map((g) => ({ value: g.key, label: g.label }));
  const stageOptions = stages.map((s) => ({ value: s.key, label: s.name || s.key }));

  return (
    <Stack>
      <Header version={version} />
      {error && (
        <Alert color="red" style={{ whiteSpace: 'pre-line' }}>
          {error}
        </Alert>
      )}
      <Textarea label="What changes in this version?" autosize minRows={2} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />

      <Title order={4}>Stages (in order)</Title>
      {stages.map((s, i) => (
        <Card withBorder key={i}>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>
                {i + 1}. {s.name || 'New stage'}
              </Text>
              <Group gap={4}>
                <ActionIcon variant="subtle" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </ActionIcon>
                <ActionIcon variant="subtle" aria-label="Move down" disabled={i === stages.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" aria-label="Remove stage" disabled={stages.length === 1} onClick={() => setStages(stages.filter((_, j) => j !== i))}>
                  ×
                </ActionIcon>
              </Group>
            </Group>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <TextInput label="Name" required value={s.name} onChange={(e) => update(i, { name: e.currentTarget.value })} />
              <TextInput
                label="Key"
                description={s.isNew ? 'Permanent id, e.g. site_survey' : 'Permanent id'}
                disabled={!s.isNew}
                value={s.key}
                onChange={(e) => update(i, { key: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              />
              <Select label="Responsible department" data={deptOptions} value={s.departmentId} onChange={(v) => update(i, { departmentId: v })} required />
            </SimpleGrid>
            <TextInput label="Description" value={s.description} onChange={(e) => update(i, { description: e.currentTarget.value })} />
            <MultiSelect label="Automatic checks" data={gateOptions} value={s.gateKeys} onChange={(v) => update(i, { gateKeys: v as GateKey[] })} clearable />
            <Text size="sm" fw={500}>
              Checklist
            </Text>
            {s.checklist.map((c, j) => (
              <Group key={j} gap="xs" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  aria-label={`Checklist item ${j + 1}`}
                  value={c.label}
                  onChange={(e) => update(i, { checklist: s.checklist.map((x, k) => (k === j ? { ...x, label: e.currentTarget.value } : x)) })}
                />
                <Checkbox
                  label="Required"
                  checked={c.required}
                  onChange={(e) => update(i, { checklist: s.checklist.map((x, k) => (k === j ? { ...x, required: e.currentTarget.checked } : x)) })}
                />
                <ActionIcon variant="subtle" color="red" aria-label="Remove item" onClick={() => update(i, { checklist: s.checklist.filter((_, k) => k !== j) })}>
                  ×
                </ActionIcon>
              </Group>
            ))}
            <Group>
              <Button size="compact-xs" variant="subtle" onClick={() => update(i, { checklist: [...s.checklist, { label: '', required: true }] })}>
                Add checklist item
              </Button>
            </Group>
          </Stack>
        </Card>
      ))}
      <Group>
        <Button
          variant="light"
          onClick={() => setStages([...stages, { key: '', name: '', description: '', departmentId: null, gateKeys: [], checklist: [], isNew: true }])}
        >
          Add stage
        </Button>
      </Group>

      <Title order={4}>Allowed returns for correction</Title>
      <Text size="sm" c="dimmed">
        A stage may send the job back to an earlier stage. Only that stage is redone; then the job returns straight to the stage that sent it back.
      </Text>
      {rules.map((r, i) => (
        <Group key={i} gap="xs">
          <Select aria-label="From stage" data={stageOptions} value={r.fromKey} onChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, fromKey: v ?? '' } : x)))} w={220} />
          <Text>may return to</Text>
          <Select aria-label="To stage" data={stageOptions} value={r.toKey} onChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, toKey: v ?? '' } : x)))} w={220} />
          <ActionIcon variant="subtle" color="red" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
            ×
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button size="xs" variant="subtle" onClick={() => setRules([...rules, { fromKey: '', toKey: '' }])}>
          Add return rule
        </Button>
      </Group>

      <Group justify="space-between" mt="md">
        <Button
          variant="subtle"
          color="red"
          loading={remove.isPending}
          onClick={() => {
            if (window.confirm('Delete this draft?')) remove.mutate();
          }}
        >
          Delete draft
        </Button>
        <Group>
          <Button variant="default" loading={save.isPending} onClick={() => save.mutate()}>
            Save draft
          </Button>
          <Button
            loading={publish.isPending}
            onClick={() => {
              if (window.confirm('Publish this version? New jobs will use it. Running jobs keep their current version.')) publish.mutate();
            }}
          >
            Publish
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

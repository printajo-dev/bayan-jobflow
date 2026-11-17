import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ActionIcon, Code, Group, Pagination, Select, Stack, Table, Text, Title } from '@mantine/core';
import type { AuditLogDto, Paginated } from '@jobflow/shared';
import { get, toQuery } from '../../api/client';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';

const ENTITY_TYPES = [
  { value: 'user', label: 'Users and sign-ins' },
  { value: 'role', label: 'Roles' },
  { value: 'department', label: 'Departments' },
];

export function AuditPage() {
  const [entityType, setEntityType] = useState<string | null>(null);
  return (
    <Stack>
      <Title order={2}>Audit log</Title>
      <Text c="dimmed" size="sm">
        Every sensitive action is recorded here and cannot be changed or deleted.
      </Text>
      <Select
        placeholder="All records"
        data={ENTITY_TYPES}
        value={entityType}
        onChange={setEntityType}
        clearable
        w={240}
        aria-label="Filter by record type"
      />
      <AuditTable entityType={entityType ?? undefined} pageSize={50} />
    </Stack>
  );
}

export function AuditTable({ entityId, entityType, pageSize }: { entityId?: string; entityType?: string; pageSize: number }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const logs = useQuery({
    queryKey: ['audit', entityId, entityType, page, pageSize],
    queryFn: () => get<Paginated<AuditLogDto>>(`/audit-logs${toQuery({ entityId, entityType, page, pageSize })}`),
    placeholderData: keepPreviousData,
  });

  if (logs.isPending) return <LoadingState />;
  if (logs.isError) return <ErrorState error={logs.error} />;
  if (logs.data.items.length === 0) return <EmptyState>No history yet.</EmptyState>;

  return (
    <Stack>
      <Table.ScrollContainer minWidth={700}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={180}>When</Table.Th>
              <Table.Th w={140}>Who</Table.Th>
              <Table.Th w={200}>Action</Table.Th>
              <Table.Th>Summary</Table.Th>
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {logs.data.items.map((l) => (
              <Fragment key={l.id}>
                <Table.Tr>
                  <Table.Td>
                    <Text size="sm">{new Date(l.createdAt).toLocaleString()}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{l.actorUsername ?? 'system'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{l.action}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{l.summary}</Text>
                  </Table.Td>
                  <Table.Td>
                    {(l.before !== null || l.after !== null) && (
                      <ActionIcon
                        variant="subtle"
                        aria-label={open === l.id ? 'Hide details' : 'Show details'}
                        onClick={() => setOpen(open === l.id ? null : l.id)}
                      >
                        {open === l.id ? '−' : '+'}
                      </ActionIcon>
                    )}
                  </Table.Td>
                </Table.Tr>
                {open === l.id && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Group align="flex-start" grow>
                        <div>
                          <Text size="xs" fw={600}>
                            Before
                          </Text>
                          <Code block>{JSON.stringify(l.before, null, 2)}</Code>
                        </div>
                        <div>
                          <Text size="xs" fw={600}>
                            After
                          </Text>
                          <Code block>{JSON.stringify(l.after, null, 2)}</Code>
                        </div>
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        IP {l.ip ?? '—'} · request {l.requestId ?? '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {logs.data.total > pageSize && (
        <Pagination total={Math.ceil(logs.data.total / pageSize)} value={page} onChange={setPage} />
      )}
    </Stack>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Card,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { ReportDto } from '@jobflow/shared';
import { API_BASE, get, toQuery } from '../api/client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';

interface ReportListItem {
  key: string;
  title: string;
  canExport: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Management and department reports with CSV/Excel export. */
export function ReportsPage() {
  const list = useQuery({
    queryKey: ['reports'],
    queryFn: () => get<ReportListItem[]>('/reports'),
  });
  const [key, setKey] = useState<string | null>(null);
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 90 * 86_400_000)));
  const [to, setTo] = useState(() => iso(new Date()));
  const [group, setGroup] = useState<'month' | 'week'>('month');
  const selected = key ?? list.data?.[0]?.key ?? null;
  const qs = toQuery({ from, to, group });
  const report = useQuery({
    queryKey: ['report', selected, from, to, group],
    queryFn: () => get<ReportDto>(`/reports/${selected}${qs}`),
    enabled: !!selected,
  });

  if (list.isLoading) return <LoadingState />;
  if (list.error) return <ErrorState error={list.error} />;
  if (!list.data?.length)
    return <EmptyState>No reports are available to you.</EmptyState>;
  const canExport = list.data[0]!.canExport;
  const r = report.data;
  const exportHref = (format: 'csv' | 'xlsx') =>
    `${API_BASE}/reports/${selected}${toQuery({ from, to, group, format })}`;

  return (
    <Stack>
      <Title order={2}>Reports</Title>
      <Card withBorder>
        <Group align="end" wrap="wrap">
          <Select
            label="Report"
            data={list.data.map((x) => ({ value: x.key, label: x.title }))}
            value={selected}
            onChange={setKey}
            allowDeselect={false}
            w={360}
          />
          <TextInput
            type="date"
            label="From"
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
          <TextInput
            type="date"
            label="To"
            value={to}
            onChange={(e) => setTo(e.currentTarget.value)}
          />
          {selected === 'throughput' && (
            <Select
              label="Group by"
              data={[
                { value: 'month', label: 'Month' },
                { value: 'week', label: 'Week' },
              ]}
              value={group}
              onChange={(v) => setGroup((v as 'month' | 'week') ?? 'month')}
              allowDeselect={false}
              w={120}
            />
          )}
          {canExport && (
            <Group gap="xs">
              <Button component="a" href={exportHref('csv')} variant="default">
                Export CSV
              </Button>
              <Button component="a" href={exportHref('xlsx')} variant="default">
                Export Excel
              </Button>
            </Group>
          )}
        </Group>
      </Card>
      {report.isLoading && <LoadingState label="Running report…" />}
      {report.error && <ErrorState error={report.error} />}
      {r && (
        <Card withBorder>
          <Title order={4}>{r.title}</Title>
          <Text size="sm" c="dimmed" mb="sm">
            {r.from} to {r.to} · {r.rows.length} rows
          </Text>
          {r.rows.length === 0 ? (
            <Text c="dimmed">No data for this period.</Text>
          ) : (
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    {r.columns.map((c) => (
                      <Table.Th
                        key={c.key}
                        ta={c.numeric ? 'right' : undefined}
                      >
                        {c.label}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {r.rows.map((row, i) => (
                    <Table.Tr key={i}>
                      {r.columns.map((c) => (
                        <Table.Td
                          key={c.key}
                          ta={c.numeric ? 'right' : undefined}
                        >
                          {row[c.key] ?? '–'}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {r.notes.map((n) => (
            <Text key={n} size="xs" c="dimmed" mt="xs">
              {n}
            </Text>
          ))}
        </Card>
      )}
    </Stack>
  );
}

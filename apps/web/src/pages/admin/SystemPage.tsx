import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type {
  BackupRunStatus,
  OutboxEventDto,
  SystemStatusDto,
} from '@jobflow/shared';
import { useAuth } from '../../auth/AuthContext';
import { get, post, put } from '../../api/client';
import {
  ErrorState,
  LoadingState,
  errorMessage,
} from '../../components/states';
import { formatDateTime, formatSize } from '../../components/format';

function Health({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      color={ok ? 'green' : 'red'}
      variant="light"
      leftSection={ok ? '✓' : '!'}
    >
      {label}
    </Badge>
  );
}

function BackupRow({ label, v }: { label: string; v: BackupRunStatus | null }) {
  return (
    <Table.Tr>
      <Table.Td>{label}</Table.Td>
      <Table.Td>
        {v ? (
          <Health ok={v.ok} label={v.ok ? 'Succeeded' : 'Failed'} />
        ) : (
          <Text size="sm" c="dimmed">
            Never
          </Text>
        )}
      </Table.Td>
      <Table.Td>{v ? formatDateTime(v.at) : '–'}</Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {v?.detail ?? ''}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

/** Administrators: service health, disk, backups, maintenance mode and failed background events. */
export function SystemPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: () => get<SystemStatusDto>('/system/status'),
    refetchInterval: 30_000,
  });
  const dead = useQuery({
    queryKey: ['system', 'outbox', 'DEAD'],
    queryFn: () => get<OutboxEventDto[]>('/system/outbox?status=DEAD'),
  });
  const [message, setMessage] = useState('');
  const maint = useMutation({
    mutationFn: (enabled: boolean) =>
      put('/system/maintenance', { enabled, message: message || null }),
    onSuccess: () =>
      void qc
        .invalidateQueries({ queryKey: ['system'] })
        .then(() => qc.invalidateQueries({ queryKey: ['maintenance'] })),
  });
  const retry = useMutation({
    mutationFn: (id: string) => post(`/system/outbox/${id}/retry`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['system'] }),
  });

  if (status.isLoading) return <LoadingState />;
  if (status.error) return <ErrorState error={status.error} />;
  const s = status.data!;
  const workerAge = s.worker.lastHeartbeat
    ? Math.round((Date.now() - Date.parse(s.worker.lastHeartbeat)) / 1000)
    : null;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>System</Title>
        <Text size="sm" c="dimmed">
          Version {s.version} · checked {formatDateTime(s.checkedAt)}
        </Text>
      </Group>

      {s.backups.warnings.length > 0 && (
        <Alert color="orange" title="Backups need attention">
          {s.backups.warnings.map((w) => (
            <Text key={w} size="sm">
              {w}
            </Text>
          ))}
        </Alert>
      )}
      {s.disk?.warning && (
        <Alert color="red" title="Disk almost full">
          {s.disk.usedPercent}% of the data disk is used. Free space or add
          storage before uploads fail.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <Card withBorder>
          <Text fw={600} mb="xs">
            Services
          </Text>
          <Stack gap={6}>
            <Group justify="space-between">
              <Text size="sm">Database</Text>
              <Health
                ok={s.database.ok}
                label={
                  s.database.ok
                    ? `OK · ${s.database.sizeBytes !== null ? formatSize(s.database.sizeBytes) : ''}`
                    : 'Unreachable'
                }
              />
            </Group>
            <Group justify="space-between">
              <Text size="sm">Background worker</Text>
              <Health
                ok={s.worker.healthy}
                label={
                  s.worker.healthy
                    ? `OK · ${workerAge}s ago`
                    : s.worker.lastHeartbeat
                      ? `Silent since ${formatDateTime(s.worker.lastHeartbeat)}`
                      : 'Not seen'
                }
              />
            </Group>
            <Group justify="space-between">
              <Text size="sm">API uptime</Text>
              <Text size="sm">
                {Math.floor(s.uptimeSeconds / 3600)} h{' '}
                {Math.floor((s.uptimeSeconds % 3600) / 60)} min
              </Text>
            </Group>
          </Stack>
        </Card>
        <Card withBorder>
          <Text fw={600} mb="xs">
            Data disk
          </Text>
          {s.disk ? (
            <Stack gap={4}>
              <Text size="sm">
                {formatSize(s.disk.freeBytes)} free of{' '}
                {formatSize(s.disk.totalBytes)} ({s.disk.usedPercent}% used)
              </Text>
              <div
                style={{
                  height: 8,
                  background: 'var(--mantine-color-gray-2)',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    height: 8,
                    width: `${s.disk.usedPercent}%`,
                    background: s.disk.warning
                      ? 'var(--mantine-color-red-6)'
                      : 'var(--mantine-color-blue-6)',
                    borderRadius: 4,
                  }}
                />
              </div>
              <Text size="xs" c="dimmed">
                {s.disk.path}
              </Text>
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              Not available
            </Text>
          )}
        </Card>
        <Card withBorder>
          <Text fw={600} mb="xs">
            Background events
          </Text>
          <Stack gap={6}>
            <Group justify="space-between">
              <Text size="sm">Waiting</Text>
              <Text size="sm">
                {s.outbox.pending}
                {s.outbox.oldestPendingSeconds !== null &&
                s.outbox.oldestPendingSeconds > 300
                  ? ` (oldest ${Math.round(s.outbox.oldestPendingSeconds / 60)} min)`
                  : ''}
              </Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm">Retrying</Text>
              <Text size="sm">{s.outbox.failed}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm">Failed permanently</Text>
              <Health ok={s.outbox.dead === 0} label={String(s.outbox.dead)} />
            </Group>
          </Stack>
        </Card>
      </SimpleGrid>

      <Card withBorder>
        <Text fw={600} mb="xs">
          Backups
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Backup</Table.Th>
              <Table.Th>Last run</Table.Th>
              <Table.Th>When</Table.Th>
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <BackupRow label="Database (daily)" v={s.backups.database} />
            <BackupRow label="Files (nightly)" v={s.backups.files} />
            <BackupRow label="External copy (weekly)" v={s.backups.offsite} />
            <BackupRow
              label="Restore test (monthly)"
              v={s.backups.restoreTest}
            />
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed" mt="xs">
          Backups run on the server (see the maintenance guide). Run them by
          hand with{' '}
          <Code>sudo /srv/bayan-jobflow/deploy/scripts/backup.sh all</Code>.
        </Text>
      </Card>

      {can('settings.manage') && (
        <Card withBorder>
          <Text fw={600} mb="xs">
            Maintenance mode
          </Text>
          <Text size="sm" c="dimmed" mb="sm">
            While on, only administrators can use JobFlow. Everyone else sees
            the message below. Turn it on before updates or restores.
          </Text>
          <Group align="end">
            <TextInput
              label="Message for users"
              placeholder="Server update until 18:00"
              value={message}
              onChange={(e) => setMessage(e.currentTarget.value)}
              w={360}
              disabled={s.maintenance.enabled}
            />
            <Switch
              size="md"
              label={
                s.maintenance.enabled
                  ? `On since ${formatDateTime(s.maintenance.since)}`
                  : 'Off'
              }
              checked={s.maintenance.enabled}
              onChange={(e) => maint.mutate(e.currentTarget.checked)}
              disabled={maint.isPending}
            />
          </Group>
          {s.maintenance.enabled && s.maintenance.message && (
            <Text size="sm" mt="xs">
              Message: {s.maintenance.message}
            </Text>
          )}
          {maint.error && (
            <Text c="red" size="sm" mt="xs">
              {errorMessage(maint.error)}
            </Text>
          )}
        </Card>
      )}

      <Card withBorder>
        <Text fw={600} mb="xs">
          Failed background events
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          Events that failed after every retry (for example a notification that
          could not be created). Workflow progress is never held here; retrying
          is safe because consumers ignore duplicates.
        </Text>
        {dead.data?.length ? (
          <Table.ScrollContainer minWidth={720}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Attempts</Table.Th>
                  <Table.Th>Last error</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {dead.data.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td>
                      <Code>{e.type}</Code>
                    </Table.Td>
                    <Table.Td>{formatDateTime(e.createdAt)}</Table.Td>
                    <Table.Td>{e.attempts}</Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={3}>
                        {e.lastError}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="light"
                        loading={retry.isPending && retry.variables === e.id}
                        onClick={() => retry.mutate(e.id)}
                      >
                        Retry
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Text size="sm" c="dimmed">
            None.
          </Text>
        )}
      </Card>
    </Stack>
  );
}

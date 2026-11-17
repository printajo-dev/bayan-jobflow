import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Anchor,
  Badge,
  Box,
  Card,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { DashboardDto } from '@jobflow/shared';
import { useAuth } from '../auth/AuthContext';
import { get } from '../api/client';
import { ErrorState, LoadingState } from '../components/states';
import { formatDate } from '../components/format';

function Stat({
  label,
  value,
  to,
  hint,
}: {
  label: string;
  value: number | string;
  to?: string;
  hint?: string;
}) {
  const body = (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text fz={28} fw={700} lh={1.2}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Paper>
  );
  return to ? (
    <Anchor component={Link} to={to} underline="never" c="inherit">
      {body}
    </Anchor>
  ) : (
    body
  );
}

/** Single-hue magnitude bar with its value written beside it. */
function Bar({ value, max }: { value: number; max: number }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Box style={{ flex: 1, minWidth: 60 }}>
        <Box
          h={10}
          style={{
            width: `${max ? Math.max(4, (value / max) * 100) : 0}%`,
            background: 'var(--mantine-color-blue-6)',
            borderRadius: '0 4px 4px 0',
          }}
        />
      </Box>
      <Text size="sm" w={28} ta="right">
        {value}
      </Text>
    </Group>
  );
}

/** Signed-in landing page: my work, my departments' queues and, for Management, the company overview. */
export function HomePage() {
  const { me, can } = useAuth();
  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardDto>('/dashboard'),
    refetchInterval: 60_000,
  });
  if (!me) return null;
  const { user } = me;
  const d = dash.data;
  const maxStage = Math.max(
    0,
    ...(d?.overview?.byStage.map((s) => s.count) ?? []),
  );

  return (
    <Stack>
      <Title order={2}>Welcome, {user.fullName}</Title>
      <Group gap="xs">
        {user.departments.map((dep) => (
          <Badge
            key={dep.departmentId}
            variant={dep.isLeader ? 'filled' : 'light'}
          >
            {dep.name}
            {dep.isLeader ? ' · Leader' : ''}
          </Badge>
        ))}
        {user.roles.map((r) => (
          <Badge key={r.id} variant="outline">
            {r.name}
          </Badge>
        ))}
        {user.departments.length === 0 && user.roles.length === 0 && (
          <Text c="dimmed" size="sm">
            No roles assigned. Ask an administrator for access.
          </Text>
        )}
      </Group>

      {dash.isLoading && <LoadingState label="Loading dashboard…" />}
      {dash.error && <ErrorState error={dash.error} />}
      {d && (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Stat label="My open tasks" value={d.me.openTasks} to="/my-work" />
            <Stat
              label="My overdue tasks"
              value={d.me.overdueTasks}
              to="/my-work"
            />
            <Stat
              label="Corrections for me"
              value={d.me.openCorrections}
              to="/my-work"
            />
            <Stat
              label="Unread notifications"
              value={d.me.unreadNotifications}
              to="/notifications"
            />
          </SimpleGrid>

          {d.overview && (
            <Card withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={4}>Company overview</Title>
                {can('report.view') && (
                  <Anchor component={Link} to="/reports" size="sm">
                    Reports
                  </Anchor>
                )}
              </Group>
              <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} mb="md">
                <Stat label="Active jobs" value={d.overview.activeJobs} />
                <Stat
                  label="Completed (30 days)"
                  value={d.overview.completedLast30}
                />
                <Stat
                  label="Average cycle"
                  value={
                    d.overview.avgCycleDays === null
                      ? '–'
                      : `${d.overview.avgCycleDays} d`
                  }
                  hint="Jobs closed in the last 90 days"
                />
                <Stat label="Stages on hold" value={d.overview.onHold} />
                <Stat
                  label="Rework rounds (30 days)"
                  value={d.overview.reworkRoundsLast30}
                />
                <Stat label="Overdue tasks" value={d.overview.overdueTasks} />
              </SimpleGrid>
              <Text fw={600} size="sm" mb={4}>
                Open jobs by current stage
              </Text>
              {d.overview.byStage.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No open jobs.
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={480}>
                  <Table verticalSpacing={4}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Service</Table.Th>
                        <Table.Th>Stage</Table.Th>
                        <Table.Th w="40%">Jobs</Table.Th>
                        <Table.Th ta="right">Avg days in stage</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {d.overview.byStage.map((s) => (
                        <Table.Tr key={`${s.service}-${s.stage}`}>
                          <Table.Td>{s.service}</Table.Td>
                          <Table.Td>{s.stage}</Table.Td>
                          <Table.Td>
                            <Bar value={s.count} max={maxStage} />
                          </Table.Td>
                          <Table.Td ta="right">{s.avgDays}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Card>
          )}

          {d.queues.map((q) => (
            <Card withBorder key={q.department.id}>
              <Title order={4} mb="sm">
                {q.department.name} queue
              </Title>
              <SimpleGrid
                cols={{ base: 2, md: 4, lg: 4 + Math.min(q.extras.length, 3) }}
                mb="md"
              >
                <Stat label="Jobs here" value={q.jobs.length} />
                <Stat label="Open tasks" value={q.openTasks} />
                <Stat label="Unassigned tasks" value={q.unassignedTasks} />
                <Stat label="Overdue tasks" value={q.overdueTasks} />
                {q.extras.map((e) => (
                  <Stat key={e.label} label={e.label} value={e.value} />
                ))}
              </SimpleGrid>
              {q.jobs.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No jobs waiting at this department.
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={640}>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Job</Table.Th>
                        <Table.Th>Stage</Table.Th>
                        <Table.Th>Days in stage</Table.Th>
                        <Table.Th>Internal deadline</Table.Th>
                        <Table.Th>Customer date</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {q.jobs.map((j) => (
                        <Table.Tr key={`${j.jobId}-${j.stageName}`}>
                          <Table.Td>
                            <Anchor
                              component={Link}
                              to={`/jobs/${j.jobId}`}
                              fw={600}
                            >
                              {j.jobNumber}
                            </Anchor>{' '}
                            <Text span size="sm">
                              {j.title}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {j.serviceType}
                              {j.priority !== 'NORMAL'
                                ? ` · ${j.priority}`
                                : ''}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {j.stageName}
                            {j.occurrenceNo > 1 && (
                              <Badge
                                ml={6}
                                size="xs"
                                color="orange"
                                variant="light"
                              >
                                Rework round {j.occurrenceNo}
                              </Badge>
                            )}
                            {j.stageStatus === 'ON_HOLD' && (
                              <Badge ml={6} size="xs" color="gray">
                                On hold
                              </Badge>
                            )}
                          </Table.Td>
                          <Table.Td>{j.daysInStage}</Table.Td>
                          <Table.Td>{formatDate(j.internalDeadline)}</Table.Td>
                          <Table.Td>
                            {formatDate(j.customerCommitmentDate)}
                            {j.overdue && (
                              <Badge
                                ml={6}
                                size="xs"
                                color="red"
                                variant="light"
                              >
                                Overdue
                              </Badge>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Card>
          ))}
        </>
      )}
    </Stack>
  );
}

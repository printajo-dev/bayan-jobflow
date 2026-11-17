import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Anchor, Badge, Button, Group, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { JOB_PRIORITIES, type DepartmentDto, type JobSummaryDto, type Paginated } from '@jobflow/shared';
import { get, toQuery } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatDate, JOB_STATUS, PRIORITY, STAGE_STATUS } from '../../components/format';

const PAGE_SIZE = 25;

export function JobsPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [filters, setFilters] = useState<{ serviceType: string | null; status: string | null; departmentId: string | null; priority: string | null }>({
    serviceType: null,
    status: 'OPEN',
    departmentId: null,
    priority: null,
  });
  const [sort, setSort] = useState('created_desc');
  const [page, setPage] = useState(1);
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments') });
  const jobs = useQuery({
    queryKey: ['jobs', debounced, filters, sort, page],
    queryFn: () => get<Paginated<JobSummaryDto>>(`/jobs${toQuery({ search: debounced, ...filters, sort, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  const setFilter = (k: keyof typeof filters, v: string | null) => {
    setFilters({ ...filters, [k]: v });
    setPage(1);
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Jobs</Title>
        {can('job.create') && (
          <Button component={Link} to="/jobs/new">
            New job
          </Button>
        )}
      </Group>
      <Group gap="sm" align="flex-end">
        <TextInput
          placeholder="Job Number or title"
          aria-label="Search jobs"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          w={240}
        />
        <Select
          aria-label="Service type"
          placeholder="All services"
          data={[
            { value: 'VB', label: 'Vehicle Branding' },
            { value: 'SG', label: 'Signage' },
          ]}
          value={filters.serviceType}
          onChange={(v) => setFilter('serviceType', v)}
          clearable
          w={170}
        />
        <Select
          aria-label="Status"
          placeholder="Any status"
          data={Object.entries(JOB_STATUS).map(([value, s]) => ({ value, label: s.label }))}
          value={filters.status}
          onChange={(v) => setFilter('status', v)}
          clearable
          w={130}
        />
        <Select
          aria-label="Current department"
          placeholder="Any department"
          data={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          value={filters.departmentId}
          onChange={(v) => setFilter('departmentId', v)}
          clearable
          w={190}
        />
        <Select
          aria-label="Priority"
          placeholder="Any priority"
          data={JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }))}
          value={filters.priority}
          onChange={(v) => setFilter('priority', v)}
          clearable
          w={140}
        />
        <Select
          aria-label="Sort"
          data={[
            { value: 'created_desc', label: 'Newest first' },
            { value: 'created_asc', label: 'Oldest first' },
            { value: 'commitment_asc', label: 'Customer date' },
            { value: 'job_number_asc', label: 'Job Number' },
          ]}
          value={sort}
          onChange={(v) => setSort(v ?? 'created_desc')}
          allowDeselect={false}
          w={160}
        />
      </Group>

      {jobs.isPending ? (
        <LoadingState />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} />
      ) : jobs.data.items.length === 0 ? (
        <EmptyState>No jobs match these filters.</EmptyState>
      ) : (
        <>
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Job Number</Table.Th>
                  <Table.Th>Title</Table.Th>
                  <Table.Th>Service</Table.Th>
                  <Table.Th>Current stage</Table.Th>
                  <Table.Th>Priority</Table.Th>
                  <Table.Th>Customer date</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.data.items.map((j) => (
                  <Table.Tr key={j.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/jobs/${j.id}`} ff="monospace" fw={600}>
                        {j.jobNumber}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{j.title}</Table.Td>
                    <Table.Td>{j.serviceType.name}</Table.Td>
                    <Table.Td>
                      {j.currentStage ? (
                        <Group gap={6}>
                          <Text size="sm">{j.currentStage.name}</Text>
                          {j.currentStage.status === 'ON_HOLD' && (
                            <Badge size="xs" color={STAGE_STATUS.ON_HOLD.color}>
                              On hold
                            </Badge>
                          )}
                          <Text size="xs" c="dimmed">
                            {j.currentStage.departmentName}
                          </Text>
                        </Group>
                      ) : (
                        '—'
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={PRIORITY[j.priority].color}>
                        {PRIORITY[j.priority].label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{formatDate(j.customerCommitmentDate)}</Table.Td>
                    <Table.Td>
                      <Badge color={JOB_STATUS[j.status].color}>{JOB_STATUS[j.status].label}</Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {jobs.data.total} job(s)
            </Text>
            <Pagination total={Math.ceil(jobs.data.total / PAGE_SIZE)} value={page} onChange={setPage} />
          </Group>
        </>
      )}
    </Stack>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Pagination,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { PASSWORD_MIN_LENGTH, type CreateUserInput, type DepartmentDto, type Paginated, type RoleDto, type UserDto } from '@jobflow/shared';
import { get, post, toQuery } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';

const PAGE_SIZE = 25;

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const users = useQuery({
    queryKey: ['users', debounced, status, page],
    queryFn: () => get<Paginated<UserDto>>(`/users${toQuery({ search: debounced, status, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Users</Title>
        <Button onClick={() => setCreating(true)}>New user</Button>
      </Group>
      <Group>
        <TextInput
          placeholder="Search name or username"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          w={280}
          aria-label="Search users"
        />
        <Select
          placeholder="Any status"
          data={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'DISABLED', label: 'Disabled' },
          ]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          clearable
          w={160}
          aria-label="Filter by status"
        />
      </Group>

      {users.isPending ? (
        <LoadingState />
      ) : users.isError ? (
        <ErrorState error={users.error} />
      ) : users.data.items.length === 0 ? (
        <EmptyState>No users match.</EmptyState>
      ) : (
        <>
          <Table.ScrollContainer minWidth={700}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Username</Table.Th>
                  <Table.Th>Departments</Table.Th>
                  <Table.Th>Roles</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.data.items.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/admin/users/${u.id}`}>
                        {u.fullName}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{u.username}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{u.departments.map((d) => d.name + (d.isLeader ? ' (leader)' : '')).join(', ') || '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{u.roles.map((r) => r.name).join(', ') || '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <UserStatusBadge user={u} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {users.data.total} user(s)
            </Text>
            <Pagination total={Math.ceil(users.data.total / PAGE_SIZE)} value={page} onChange={setPage} />
          </Group>
        </>
      )}

      <CreateUserModal opened={creating} onClose={() => setCreating(false)} />
    </Stack>
  );
}

export function UserStatusBadge({ user }: { user: UserDto }) {
  if (user.status === 'DISABLED') return <Badge color="gray">Disabled</Badge>;
  if (user.lockedUntil) return <Badge color="orange">Locked</Badge>;
  if (user.mustChangePassword) return <Badge color="yellow">Must change password</Badge>;
  return <Badge color="green">Active</Badge>;
}

function CreateUserModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles'), enabled: opened });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments'), enabled: opened });
  const empty = { username: '', fullName: '', email: '', password: '', roleIds: [] as string[], departmentIds: [] as string[] };
  const [form, setForm] = useState(empty);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateUserInput = {
        username: form.username,
        fullName: form.fullName,
        email: form.email || null,
        password: form.password,
        roleIds: form.roleIds,
        departments: form.departmentIds.map((departmentId) => ({ departmentId, isLeader: false })),
      };
      return post<UserDto>('/users', body);
    },
    onSuccess: (u) => {
      notifications.show({ color: 'green', message: `User ${u.username} created. They must change the password at first sign-in.` });
      void qc.invalidateQueries({ queryKey: ['users'] });
      setForm(empty);
      onClose();
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title="New user" size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Stack>
          {create.isError && <Alert color="red">{errorMessage(create.error)}</Alert>}
          <Group grow>
            <TextInput label="Full name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.currentTarget.value })} />
            <TextInput
              label="Username"
              description="Lowercase letters, digits, . _ -"
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.currentTarget.value.toLowerCase() })}
            />
          </Group>
          <TextInput label="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
          <PasswordInput
            label="Temporary password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters. The user must change it at first sign-in.`}
            required
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
          />
          <MultiSelect
            label="Departments"
            description="Mark leaders on the user page after creating"
            data={(departments.data ?? []).filter((d) => d.isActive).map((d) => ({ value: d.id, label: d.name }))}
            value={form.departmentIds}
            onChange={(v) => setForm({ ...form, departmentIds: v })}
            searchable
          />
          <MultiSelect
            label="Roles"
            data={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            value={form.roleIds}
            onChange={(v) => setForm({ ...form, roleIds: v })}
            searchable
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create user
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

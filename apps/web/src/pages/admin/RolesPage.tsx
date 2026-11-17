import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Group, Modal, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import type { RoleDto, RoleScope } from '@jobflow/shared';
import { get, post } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';

export function RolesPage() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles') });
  const [creating, setCreating] = useState(false);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Roles & permissions</Title>
        <Button onClick={() => setCreating(true)}>New role</Button>
      </Group>
      <Text c="dimmed" size="sm">
        Global roles apply everywhere. Department roles apply only inside the departments the user belongs to.
      </Text>
      {roles.isPending ? (
        <LoadingState />
      ) : roles.isError ? (
        <ErrorState error={roles.error} />
      ) : roles.data.length === 0 ? (
        <EmptyState>No roles yet.</EmptyState>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Role</Table.Th>
              <Table.Th>Scope</Table.Th>
              <Table.Th>Permissions</Table.Th>
              <Table.Th>Users</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {roles.data.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>
                  <Anchor component={Link} to={`/admin/roles/${r.id}`}>
                    {r.name}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {r.description}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="light" color={r.scope === 'GLOBAL' ? 'violet' : 'blue'}>
                    {r.scope === 'GLOBAL' ? 'Global' : 'Department'}
                  </Badge>
                </Table.Td>
                <Table.Td>{r.permissionKeys.length}</Table.Td>
                <Table.Td>{r.userCount}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {creating && <CreateRoleModal onClose={() => setCreating(false)} />}
    </Stack>
  );
}

function CreateRoleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ key: '', name: '', description: '', scope: 'DEPARTMENT' as RoleScope });
  const create = useMutation({
    mutationFn: () => post<RoleDto>('/roles', { ...form, description: form.description || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      navigate(`/admin/roles/${r.id}`);
    },
  });
  return (
    <Modal opened onClose={onClose} title="New role">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Stack>
          {create.isError && <Alert color="red">{errorMessage(create.error)}</Alert>}
          <TextInput label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          <TextInput
            label="Key"
            description="Permanent identifier: lowercase letters, digits, underscore"
            required
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.currentTarget.value.toLowerCase() })}
          />
          <Select
            label="Scope"
            data={[
              { value: 'DEPARTMENT', label: 'Department — applies inside the user’s departments' },
              { value: 'GLOBAL', label: 'Global — applies everywhere' },
            ]}
            value={form.scope}
            onChange={(v) => setForm({ ...form, scope: (v as RoleScope) ?? 'DEPARTMENT' })}
            allowDeselect={false}
          />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create and choose permissions
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Group, Modal, Stack, Switch, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DepartmentDto } from '@jobflow/shared';
import { get, patch, post } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';

export function DepartmentsPage() {
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments') });
  const [editing, setEditing] = useState<DepartmentDto | 'new' | null>(null);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Departments</Title>
        <Button onClick={() => setEditing('new')}>New department</Button>
      </Group>
      {departments.isPending ? (
        <LoadingState />
      ) : departments.isError ? (
        <ErrorState error={departments.error} />
      ) : departments.data.length === 0 ? (
        <EmptyState>No departments yet.</EmptyState>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Responsibility</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {departments.data.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td>
                  <Text ff="monospace" size="sm">
                    {d.code}
                  </Text>
                </Table.Td>
                <Table.Td>{d.name}</Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {d.description}
                  </Text>
                </Table.Td>
                <Table.Td>{d.isActive ? <Badge color="green">Active</Badge> : <Badge color="gray">Inactive</Badge>}</Table.Td>
                <Table.Td>
                  <Button size="xs" variant="subtle" onClick={() => setEditing(d)}>
                    Edit
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {editing && <DepartmentModal department={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

function DepartmentModal({ department, onClose }: { department: DepartmentDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: department?.code ?? '',
    name: department?.name ?? '',
    description: department?.description ?? '',
    isActive: department?.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () =>
      department
        ? patch<DepartmentDto>(`/departments/${department.id}`, { name: form.name, description: form.description || null, isActive: form.isActive })
        : post<DepartmentDto>('/departments', { code: form.code, name: form.name, description: form.description || null }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notifications.show({ color: 'green', message: `Saved ${d.name}` });
      onClose();
    },
  });

  return (
    <Modal opened onClose={onClose} title={department ? `Edit ${department.name}` : 'New department'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack>
          {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
          <TextInput
            label="Code"
            description="Short permanent code, e.g. SALES. Cannot be changed later."
            required
            disabled={!!department}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.currentTarget.value.toUpperCase() })}
          />
          <TextInput label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          <Textarea label="Responsibility" autosize minRows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
          {department && (
            <Switch
              label="Active"
              description="Inactive departments cannot receive new members"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.currentTarget.checked })}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

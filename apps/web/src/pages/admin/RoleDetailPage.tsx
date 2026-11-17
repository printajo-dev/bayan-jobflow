import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, Badge, Button, Card, Checkbox, Group, MultiSelect, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERMISSIONS, type DepartmentDto, type PermissionKey, type RoleDto } from '@jobflow/shared';
import { get, patch, put } from '../../api/client';
import { ErrorState, errorMessage, LoadingState } from '../../components/states';
import { AuditTable } from './AuditPage';

const AREAS = [...new Set(PERMISSIONS.map((p) => p.area))];

export function RoleDetailPage() {
  const { id = '' } = useParams();
  const role = useQuery({ queryKey: ['roles', id], queryFn: () => get<RoleDto>(`/roles/${id}`) });
  if (role.isPending) return <LoadingState />;
  if (role.isError) return <ErrorState error={role.error} />;
  return <RoleEditor key={role.data.id} role={role.data} />;
}

function RoleEditor({ role: r }: { role: RoleDto }) {
  const id = r.id;
  const qc = useQueryClient();
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments') });
  const [selected, setSelected] = useState<Set<PermissionKey>>(() => new Set(r.permissionKeys));
  const [scope, setScope] = useState<string[]>(r.departmentIds);
  const [name, setName] = useState(r.name);

  const dirty = useMemo(() => {
    const original = new Set(r.permissionKeys);
    return original.size !== selected.size || [...selected].some((k) => !original.has(k));
  }, [r.permissionKeys, selected]);

  const done = (r: RoleDto, message: string) => {
    qc.setQueryData(['roles', id], r);
    void qc.invalidateQueries({ queryKey: ['roles'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
    notifications.show({ color: 'green', message });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', title: 'Not saved', message: errorMessage(e) });

  const savePermissions = useMutation({
    mutationFn: () => put<RoleDto>(`/roles/${id}/permissions`, { permissionKeys: [...selected] }),
    onSuccess: (r) => done(r, 'Permissions saved. They apply to signed-in users on their next action.'),
    onError,
  });
  const saveScope = useMutation({
    mutationFn: () => put<RoleDto>(`/roles/${id}/departments`, { departmentIds: scope }),
    onSuccess: (r) => done(r, 'Department scope saved'),
    onError,
  });
  const saveName = useMutation({
    mutationFn: () => patch<RoleDto>(`/roles/${id}`, { name }),
    onSuccess: (r) => done(r, 'Role renamed'),
    onError,
  });

  const toggle = (key: PermissionKey, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setSelected(next);
  };

  return (
    <Stack>
      <Anchor component={Link} to="/admin/roles" size="sm">
        ← All roles
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{r.name}</Title>
          <Group gap="xs">
            <Badge variant="light" color={r.scope === 'GLOBAL' ? 'violet' : 'blue'}>
              {r.scope === 'GLOBAL' ? 'Global role' : 'Department role'}
            </Badge>
            <Text size="sm" c="dimmed">
              {r.userCount} user(s) · key {r.key}
            </Text>
          </Group>
        </div>
        <Group align="flex-end">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button variant="default" disabled={name === r.name} loading={saveName.isPending} onClick={() => saveName.mutate()}>
            Rename
          </Button>
        </Group>
      </Group>

      {r.scope === 'DEPARTMENT' && (
        <Card withBorder>
          <Group align="flex-end">
            <MultiSelect
              style={{ flex: 1 }}
              label="Limit to departments"
              description="Leave empty to apply in every department the user belongs to"
              data={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              value={scope}
              onChange={setScope}
            />
            <Button loading={saveScope.isPending} onClick={() => saveScope.mutate()}>
              Save scope
            </Button>
          </Group>
        </Card>
      )}

      <Group justify="space-between">
        <Title order={4}>Permissions ({selected.size})</Title>
        <Group>
          <Button variant="default" disabled={!dirty} onClick={() => setSelected(new Set(r.permissionKeys))}>
            Undo changes
          </Button>
          <Button disabled={!dirty} loading={savePermissions.isPending} onClick={() => savePermissions.mutate()}>
            Save permissions
          </Button>
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
        {AREAS.map((area) => (
          <Card withBorder key={area}>
            <Text fw={600} mb="xs">
              {area}
            </Text>
            <Stack gap={6}>
              {PERMISSIONS.filter((p) => p.area === area).map((p) => (
                <Checkbox
                  key={p.key}
                  label={p.description}
                  description={p.key}
                  checked={selected.has(p.key)}
                  onChange={(e) => toggle(p.key, e.currentTarget.checked)}
                />
              ))}
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Title order={4} mt="md">
        History
      </Title>
      <AuditTable entityId={r.id} pageSize={10} />
    </Stack>
  );
}

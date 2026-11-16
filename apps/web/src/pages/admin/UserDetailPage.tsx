import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PASSWORD_MIN_LENGTH, type DepartmentDto, type RoleDto, type UserDto } from '@jobflow/shared';
import { get, patch, post, put } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorState, errorMessage, LoadingState } from '../../components/states';
import { UserStatusBadge } from './UsersPage';
import { AuditTable } from './AuditPage';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const user = useQuery({ queryKey: ['users', id], queryFn: () => get<UserDto>(`/users/${id}`) });
  if (user.isPending) return <LoadingState />;
  if (user.isError) return <ErrorState error={user.error} />;
  // Keyed so the form state starts from the loaded user, and restarts for another user.
  return <UserEditor key={user.data.id} user={user.data} />;
}

function UserEditor({ user: u }: { user: UserDto }) {
  const id = u.id;
  const qc = useQueryClient();
  const { me } = useAuth();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles') });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => get<DepartmentDto[]>('/departments') });

  const [profile, setProfile] = useState({ fullName: u.fullName, email: u.email ?? '' });
  const [roleIds, setRoleIds] = useState<string[]>(u.roles.map((r) => r.id));
  const [memberships, setMemberships] = useState(u.departments.map((d) => ({ departmentId: d.departmentId, isLeader: d.isLeader })));
  const [resetOpen, setResetOpen] = useState(false);

  const onSaved = (u: UserDto, message: string) => {
    qc.setQueryData(['users', id], u);
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
    notifications.show({ color: 'green', message });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', title: 'Not saved', message: errorMessage(e) });

  const saveProfile = useMutation({
    mutationFn: () => patch<UserDto>(`/users/${id}`, { fullName: profile.fullName, email: profile.email || null }),
    onSuccess: (u) => onSaved(u, 'Profile saved'),
    onError,
  });
  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'DISABLED') => patch<UserDto>(`/users/${id}`, { status }),
    onSuccess: (u) => onSaved(u, u.status === 'DISABLED' ? 'User disabled and signed out everywhere' : 'User enabled'),
    onError,
  });
  const saveRoles = useMutation({
    mutationFn: () => put<UserDto>(`/users/${id}/roles`, { roleIds }),
    onSuccess: (u) => onSaved(u, 'Roles saved'),
    onError,
  });
  const saveDepartments = useMutation({
    mutationFn: () => put<UserDto>(`/users/${id}/departments`, { departments: memberships }),
    onSuccess: (u) => onSaved(u, 'Departments saved'),
    onError,
  });
  const unlock = useMutation({
    mutationFn: () => post<UserDto>(`/users/${id}/unlock`),
    onSuccess: (u) => onSaved(u, 'Account unlocked'),
    onError,
  });

  const isSelf = me?.user.id === u.id;
  const deptName = new Map((departments.data ?? []).map((d) => [d.id, d.name]));

  return (
    <Stack>
      <Anchor component={Link} to="/admin/users" size="sm">
        ← All users
      </Anchor>
      <Group justify="space-between">
        <div>
          <Title order={2}>{u.fullName}</Title>
          <Group gap="xs">
            <Text c="dimmed">{u.username}</Text>
            <UserStatusBadge user={u} />
          </Group>
        </div>
        <Group>
          {u.lockedUntil && (
            <Button variant="light" color="orange" loading={unlock.isPending} onClick={() => unlock.mutate()}>
              Unlock
            </Button>
          )}
          <Button variant="light" onClick={() => setResetOpen(true)}>
            Reset password
          </Button>
          {u.status === 'ACTIVE' ? (
            <Button
              color="red"
              variant="light"
              disabled={isSelf}
              title={isSelf ? 'You cannot disable your own account' : undefined}
              loading={setStatus.isPending}
              onClick={() => {
                if (window.confirm(`Disable ${u.fullName}? They will be signed out immediately.`)) setStatus.mutate('DISABLED');
              }}
            >
              Disable
            </Button>
          ) : (
            <Button color="green" variant="light" loading={setStatus.isPending} onClick={() => setStatus.mutate('ACTIVE')}>
              Enable
            </Button>
          )}
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, lg: 3 }}>
        <Card withBorder>
          <Stack>
            <Text fw={600}>Profile</Text>
            <TextInput label="Full name" value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.currentTarget.value })} />
            <TextInput label="Email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.currentTarget.value })} />
            <Text size="xs" c="dimmed">
              Last sign-in: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
            </Text>
            <Button loading={saveProfile.isPending} onClick={() => saveProfile.mutate()}>
              Save profile
            </Button>
          </Stack>
        </Card>

        <Card withBorder>
          <Stack>
            <Text fw={600}>Departments</Text>
            <MultiSelect
              label="Member of"
              data={(departments.data ?? []).filter((d) => d.isActive || memberships.some((m) => m.departmentId === d.id)).map((d) => ({ value: d.id, label: d.name }))}
              value={memberships.map((m) => m.departmentId)}
              onChange={(ids) => setMemberships(ids.map((departmentId) => ({ departmentId, isLeader: memberships.find((m) => m.departmentId === departmentId)?.isLeader ?? false })))}
              searchable
            />
            {memberships.length > 0 && (
              <Table>
                <Table.Tbody>
                  {memberships.map((m) => (
                    <Table.Tr key={m.departmentId}>
                      <Table.Td>{deptName.get(m.departmentId) ?? m.departmentId}</Table.Td>
                      <Table.Td>
                        <Checkbox
                          label="Leader"
                          checked={m.isLeader}
                          onChange={(e) => {
                            const checked = e.currentTarget.checked;
                            setMemberships(memberships.map((x) => (x.departmentId === m.departmentId ? { ...x, isLeader: checked } : x)));
                          }}
                        />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            <Text size="xs" c="dimmed">
              Department membership decides whose work this is. What the user may do comes from roles.
            </Text>
            <Button loading={saveDepartments.isPending} onClick={() => saveDepartments.mutate()}>
              Save departments
            </Button>
          </Stack>
        </Card>

        <Card withBorder>
          <Stack>
            <Text fw={600}>Roles</Text>
            <MultiSelect
              label="Roles"
              data={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
              value={roleIds}
              onChange={setRoleIds}
              searchable
            />
            <Text size="xs" c="dimmed">
              Department roles apply only inside the user’s departments.
            </Text>
            <Button loading={saveRoles.isPending} onClick={() => saveRoles.mutate()}>
              Save roles
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>

      <Title order={4} mt="md">
        History
      </Title>
      <AuditTable entityId={u.id} pageSize={10} />

      <ResetPasswordModal user={u} opened={resetOpen} onClose={() => setResetOpen(false)} onDone={(x) => onSaved(x, 'Password reset. The user must choose a new password at next sign-in.')} />
    </Stack>
  );
}

function ResetPasswordModal({ user, opened, onClose, onDone }: { user: UserDto; opened: boolean; onClose: () => void; onDone: (u: UserDto) => void }) {
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => post<UserDto>(`/users/${user.id}/reset-password`, { newPassword: password }),
    onSuccess: (u) => {
      setPassword('');
      onDone(u);
      onClose();
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={`Reset password for ${user.fullName}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          reset.mutate();
        }}
      >
        <Stack>
          {reset.isError && <Alert color="red">{errorMessage(reset.error)}</Alert>}
          <Text size="sm">
            The user is signed out everywhere and must choose a new password at next sign-in. Give them the temporary password in person.
          </Text>
          <PasswordInput
            label="Temporary password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters`}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" color="orange" loading={reset.isPending}>
              Reset password
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

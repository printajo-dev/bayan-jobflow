import { NavLink as RouterNavLink, Outlet, useLocation } from 'react-router';
import { AppShell, Badge, Burger, Group, Menu, NavLink, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { PermissionKey } from '@jobflow/shared';
import { useAuth } from '../auth/AuthContext';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  to: string;
  label: string;
  permission?: PermissionKey;
}

const MAIN: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/jobs', label: 'Jobs', permission: 'job.view' },
  { to: '/my-work', label: 'My work', permission: 'task.view' },
  { to: '/notifications', label: 'Notifications' },
];

export const ADMIN_NAV: NavItem[] = [
  { to: '/admin/users', label: 'Users', permission: 'user.manage' },
  { to: '/admin/departments', label: 'Departments', permission: 'department.manage' },
  { to: '/admin/roles', label: 'Roles & permissions', permission: 'role.manage' },
  { to: '/admin/templates', label: 'Workflow templates', permission: 'template.manage' },
  { to: '/admin/settings', label: 'Settings', permission: 'settings.manage' },
  { to: '/admin/audit', label: 'Audit log', permission: 'audit.view' },
];

export function Layout() {
  const { me, can, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const forced = me?.user.mustChangePassword ?? false;
  const admin = ADMIN_NAV.filter((i) => !i.permission || can(i.permission));

  const link = (i: NavItem) => (
    <NavLink
      key={i.to}
      component={RouterNavLink}
      to={i.to}
      label={i.label}
      active={i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)}
      onClick={close}
    />
  );

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Title order={4}>Bayan JobFlow</Title>
          </Group>
          <Group gap="sm">
          {!forced && <NotificationBell />}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <UnstyledButton aria-label="Account menu">
                <Text fw={500} size="sm">
                  {me?.user.fullName}
                </Text>
                <Text size="xs" c="dimmed" ta="right">
                  {me?.user.username}
                </Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item component={RouterNavLink} to="/account/password">
                Change password
              </Menu.Item>
              <Menu.Item color="red" onClick={() => void logout()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        {forced ? (
          <Text size="sm" c="dimmed" p="sm">
            Change your password to continue.
          </Text>
        ) : (
          <Stack gap={0}>
            {MAIN.filter((i) => !i.permission || can(i.permission)).map(link)}
            {admin.length > 0 && (
              <>
                <Group px="sm" pt="md" pb={4}>
                  <Badge variant="light" size="sm">
                    Administration
                  </Badge>
                </Group>
                {admin.map(link)}
              </>
            )}
          </Stack>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

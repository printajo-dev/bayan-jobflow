import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useAuth } from '../auth/AuthContext';

/** Signed-in landing page: who I am, my departments and roles. */
export function HomePage() {
  const { me } = useAuth();
  if (!me) return null;
  const { user } = me;
  return (
    <Stack>
      <Title order={2}>Welcome, {user.fullName}</Title>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Text fw={600} mb="xs">
            My departments
          </Text>
          {user.departments.length === 0 ? (
            <Text c="dimmed" size="sm">
              You are not a member of any department yet.
            </Text>
          ) : (
            <Group gap="xs">
              {user.departments.map((d) => (
                <Badge key={d.departmentId} variant={d.isLeader ? 'filled' : 'light'}>
                  {d.name}
                  {d.isLeader ? ' · Leader' : ''}
                </Badge>
              ))}
            </Group>
          )}
        </Card>
        <Card withBorder>
          <Text fw={600} mb="xs">
            My roles
          </Text>
          {user.roles.length === 0 ? (
            <Text c="dimmed" size="sm">
              No roles assigned. Ask an administrator for access.
            </Text>
          ) : (
            <Group gap="xs">
              {user.roles.map((r) => (
                <Badge key={r.id} variant="outline">
                  {r.name}
                </Badge>
              ))}
            </Group>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

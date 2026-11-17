import { Alert, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { ApiError } from '../api/client';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      </Stack>
    </Center>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) return <PermissionDenied />;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <Alert color="red" title="Could not load this page" my="md">
      {message}
    </Alert>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Text c="dimmed" ta="center" py="xl">
      {children}
    </Text>
  );
}

export function PermissionDenied() {
  return (
    <Center py={60}>
      <Stack align="center" gap={4}>
        <Title order={3}>Access denied</Title>
        <Text c="dimmed">You do not have permission to view this page. Ask an administrator if you need access.</Text>
      </Stack>
    </Center>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

import { useQuery } from '@tanstack/react-query';
import { Alert, Center, Stack, Text, Title } from '@mantine/core';
import type { MaintenanceState } from '@jobflow/shared';
import { get } from '../api/client';

export function useMaintenance() {
  return useQuery({
    queryKey: ['maintenance'],
    queryFn: () => get<MaintenanceState>('/system/maintenance'),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function MaintenanceBanner({
  state,
  admin,
}: {
  state: MaintenanceState;
  admin: boolean;
}) {
  return (
    <Alert color="yellow" title="Maintenance mode is on" mb="md">
      <Text size="sm">{state.message ?? 'JobFlow is under maintenance.'}</Text>
      {admin && (
        <Text size="sm" c="dimmed">
          Only administrators can use JobFlow until it is turned off
          (Administration → System).
        </Text>
      )}
    </Alert>
  );
}

export function MaintenanceScreen({ state }: { state: MaintenanceState }) {
  return (
    <Center mih="60vh">
      <Stack align="center" gap="xs" maw={480}>
        <Title order={2}>JobFlow is under maintenance</Title>
        <Text ta="center">{state.message ?? 'Please try again later.'}</Text>
        <Text size="sm" c="dimmed" ta="center">
          Your work is saved. This page checks again every 30 seconds.
        </Text>
      </Stack>
    </Center>
  );
}

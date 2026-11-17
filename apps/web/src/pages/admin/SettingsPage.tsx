import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { JobNumberSettings } from '@jobflow/shared';
import { get, put } from '../../api/client';
import { ErrorState, errorMessage, LoadingState } from '../../components/states';

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings', 'job-number'], queryFn: () => get<JobNumberSettings>('/settings/job-number') });
  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState error={settings.error} />;
  return (
    <Stack maw={720}>
      <Title order={2}>Settings</Title>
      <JobNumberCard initial={settings.data} />
    </Stack>
  );
}

function JobNumberCard({ initial }: { initial: JobNumberSettings }) {
  const qc = useQueryClient();
  const [pattern, setPattern] = useState(initial.pattern ?? '');
  const [example, setExample] = useState(initial.example ?? '');
  const valid = (() => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  })();
  const matches = valid && pattern && example ? new RegExp(`^(?:${pattern})$`).test(example.toUpperCase()) : null;
  const save = useMutation({
    mutationFn: () => put<JobNumberSettings>('/settings/job-number', { pattern: pattern || null, example: example || null }),
    onSuccess: (s) => {
      qc.setQueryData(['settings', 'job-number'], s);
      notifications.show({ color: 'green', message: 'Job Number settings saved' });
    },
  });
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Job Number</Title>
        <Text size="sm" c="dimmed">
          Sales enter the ERP invoice number as the Job Number. Optionally require a format so typing mistakes are caught. Leave the pattern empty to
          accept any unique number. Job Numbers are stored in capital letters.
        </Text>
        {save.isError && <Alert color="red">{errorMessage(save.error)}</Alert>}
        <TextInput
          label="Format (regular expression)"
          description="Example: INV-[0-9]{5} for INV-10023"
          styles={{ input: { fontFamily: "monospace" } }}
          value={pattern}
          onChange={(e) => setPattern(e.currentTarget.value)}
          error={!valid ? 'Not a valid regular expression' : undefined}
        />
        <TextInput
          label="Example shown to Sales"
          value={example}
          onChange={(e) => setExample(e.currentTarget.value.toUpperCase())}
          error={matches === false ? 'The example does not match the format' : undefined}
        />
        <Group justify="flex-end">
          <Button disabled={!valid || matches === false} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

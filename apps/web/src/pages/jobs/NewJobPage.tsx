import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { JOB_PRIORITIES, type JobDetailDto, type JobNumberSettings, type JobPriority, type ServiceTypeCode } from '@jobflow/shared';
import { get, post } from '../../api/client';
import { BriefForm, briefToPayload, emptyBrief } from '../../components/BriefForm';
import { errorMessage } from '../../components/states';
import { PRIORITY } from '../../components/format';

export function NewJobPage() {
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ['settings', 'job-number'], queryFn: () => get<JobNumberSettings>('/settings/job-number') });
  const [serviceType, setServiceType] = useState<ServiceTypeCode>('VB');
  const [jobNumber, setJobNumber] = useState('');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<JobPriority>('NORMAL');
  const [commitment, setCommitment] = useState('');
  const [brief, setBrief] = useState(emptyBrief);

  const create = useMutation({
    mutationFn: () =>
      post<JobDetailDto>('/jobs', {
        jobNumber,
        serviceType,
        title,
        priority,
        customerCommitmentDate: commitment || null,
        brief: briefToPayload(serviceType, brief),
      }),
    onSuccess: (job) => {
      notifications.show({ color: 'green', message: `Job ${job.jobNumber} created` });
      navigate(`/jobs/${job.id}`);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Stack maw={980}>
        <Title order={2}>New job</Title>
        {create.isError && (
          <Alert color="red" style={{ whiteSpace: 'pre-line' }}>
            {errorMessage(create.error)}
          </Alert>
        )}
        <Card withBorder>
          <Stack>
            <div>
              <Text size="sm" fw={500} mb={4}>
                Service type
              </Text>
              <SegmentedControl
                value={serviceType}
                onChange={(v) => setServiceType(v as ServiceTypeCode)}
                data={[
                  { value: 'VB', label: 'Vehicle Branding' },
                  { value: 'SG', label: 'Signage' },
                ]}
              />
            </div>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Job Number"
                description={`The ERP invoice number${settings.data?.example ? `, e.g. ${settings.data.example}` : ''}`}
                required
                value={jobNumber}
                onChange={(e) => setJobNumber(e.currentTarget.value.toUpperCase())}
                styles={{ input: { fontFamily: "monospace" } }}
              />
              <TextInput label="Title" description="Short name everyone will recognise" required value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="Priority"
                data={JOB_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }))}
                value={priority}
                onChange={(v) => setPriority((v as JobPriority) ?? 'NORMAL')}
                allowDeselect={false}
              />
              <TextInput
                label="Customer commitment date"
                description="The date promised to the customer (separate from internal deadlines)"
                type="date"
                value={commitment}
                onChange={(e) => setCommitment(e.currentTarget.value)}
              />
            </SimpleGrid>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={4} mb="sm">
            Job brief
          </Title>
          <BriefForm code={serviceType} value={brief} onChange={setBrief} />
        </Card>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => navigate('/jobs')}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create job
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, Badge, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { TemplateSummaryDto, TemplateVersionDto, TemplateVersionStatus } from '@jobflow/shared';
import { get, post } from '../../api/client';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDate } from '../../components/format';

export const VERSION_STATUS: Record<TemplateVersionStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'yellow' },
  PUBLISHED: { label: 'Published', color: 'green' },
  RETIRED: { label: 'Retired', color: 'gray' },
};

export function TemplatesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => get<TemplateSummaryDto[]>('/workflow-templates') });
  const draft = useMutation({
    mutationFn: (templateId: string) => post<TemplateVersionDto>(`/workflow-templates/${templateId}/versions`, {}),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      navigate(`/admin/templates/versions/${v.id}`);
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  });

  if (templates.isPending) return <LoadingState />;
  if (templates.isError) return <ErrorState error={templates.error} />;
  return (
    <Stack>
      <Title order={2}>Workflow templates</Title>
      <Text c="dimmed" size="sm">
        Each service type follows a versioned template. Changes are made in a draft and take effect for new jobs when published. Jobs already
        running keep the version they started with.
      </Text>
      {templates.data.length === 0 && <EmptyState>No templates.</EmptyState>}
      {templates.data.map((t) => {
        const hasDraft = t.versions.some((v) => v.status === 'DRAFT');
        return (
          <Card withBorder key={t.id}>
            <Group justify="space-between" mb="sm">
              <div>
                <Title order={4}>{t.name}</Title>
                <Text size="sm" c="dimmed">
                  Service type: {t.serviceType.name}
                </Text>
              </div>
              <Button size="xs" variant="light" disabled={hasDraft} loading={draft.isPending} onClick={() => draft.mutate(t.id)}>
                {hasDraft ? 'Draft in progress' : 'New draft version'}
              </Button>
            </Group>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Published</Table.Th>
                  <Table.Th>Jobs using it</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {t.versions.map((v) => (
                  <Table.Tr key={v.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/admin/templates/versions/${v.id}`}>
                        Version {v.versionNo}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={VERSION_STATUS[v.status].color}>{VERSION_STATUS[v.status].label}</Badge>
                    </Table.Td>
                    <Table.Td>{formatDate(v.publishedAt)}</Table.Td>
                    <Table.Td>{v.jobCount}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        );
      })}
    </Stack>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, Badge, Button, Card, Checkbox, Group, Pagination, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { notifications as toast } from '@mantine/notifications';
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES, type NotificationDto, type NotificationType, type Paginated } from '@jobflow/shared';
import { get, post, put } from '../api/client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { formatDateTime } from '../components/format';

export function NotificationsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('unread');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['notifications', filter, page],
    queryFn: () => get<Paginated<NotificationDto> & { unread: number }>(`/notifications?page=${page}&pageSize=30${filter === 'unread' ? '&unread=true' : ''}`),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({ mutationFn: (id: string) => post(`/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read-all'), onSuccess: refresh });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Notifications</Title>
        <Button size="xs" variant="default" disabled={!list.data?.unread} onClick={() => readAll.mutate()}>
          Mark all as read
        </Button>
      </Group>
      <SegmentedControl w={260} value={filter} onChange={(v) => { setFilter(v); setPage(1); }} data={[{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }]} />
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : list.data.items.length === 0 ? (
        <EmptyState>Nothing new.</EmptyState>
      ) : (
        <Stack gap="xs">
          {list.data.items.map((n) => (
            <Card key={n.id} withBorder padding="xs" bg={n.readAt ? undefined : 'blue.0'}>
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Anchor component={Link} to={n.link ?? '/'} onClick={() => !n.readAt && read.mutate(n.id)} fw={n.readAt ? 400 : 600}>
                    {n.title}
                  </Anchor>
                  {n.body && <Text size="sm" c="dimmed">{n.body}</Text>}
                  <Text size="xs" c="dimmed">{formatDateTime(n.createdAt)}</Text>
                </div>
                {!n.readAt && (
                  <Button size="compact-xs" variant="subtle" onClick={() => read.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
              </Group>
            </Card>
          ))}
          {list.data.total > 30 && <Pagination total={Math.ceil(list.data.total / 30)} value={page} onChange={setPage} />}
        </Stack>
      )}
      <Preferences />
    </Stack>
  );
}

function Preferences() {
  const prefs = useQuery({ queryKey: ['notifications', 'preferences'], queryFn: () => get<{ disabled: NotificationType[] }>('/notifications/preferences') });
  const save = useMutation({
    mutationFn: (disabled: NotificationType[]) => put<{ disabled: NotificationType[] }>('/notifications/preferences', { disabled }),
    onSuccess: () => {
      void prefs.refetch();
      toast.show({ color: 'green', message: 'Preferences saved' });
    },
  });
  if (!prefs.data) return null;
  const off = new Set(prefs.data.disabled);
  return (
    <Card withBorder mt="md">
      <Title order={4} mb="xs">
        What should notify me?
      </Title>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {NOTIFICATION_TYPES.map((t) => (
          <Checkbox
            key={t}
            label={NOTIFICATION_LABELS[t]}
            checked={!off.has(t)}
            onChange={(e) => {
              const next = new Set(off);
              if (e.currentTarget.checked) next.delete(t);
              else next.add(t);
              save.mutate([...next]);
            }}
          />
        ))}
      </SimpleGrid>
      <Badge mt="sm" variant="light">In-app only — JobFlow sends no email or messages outside the office network</Badge>
    </Card>
  );
}

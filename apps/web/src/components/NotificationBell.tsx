import { useEffect } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Indicator } from '@mantine/core';
import { notifications as toast } from '@mantine/notifications';
import type { NotificationDto, Paginated } from '@jobflow/shared';
import { get } from '../api/client';
import { connectRealtime } from '../realtime';

type NotificationList = Paginated<NotificationDto> & { unread: number };

export function NotificationBell() {
  const qc = useQueryClient();
  // Polling is the fallback when the live connection is down.
  const unread = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => get<NotificationList>('/notifications?unread=true&pageSize=1'), refetchInterval: 60_000 });
  useEffect(() => {
    const socket = connectRealtime();
    const onNew = (n: { title: string }) => {
      toast.show({ message: n.title, color: 'blue' });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };
    const onRead = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
    const onConnect = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
    socket.on('notification:new', onNew);
    socket.on('notification:read', onRead);
    socket.on('connect', onConnect);
    return () => {
      socket.off('notification:new', onNew);
      socket.off('notification:read', onRead);
      socket.off('connect', onConnect);
    };
  }, [qc]);
  const count = unread.data?.unread ?? 0;
  return (
    <Indicator label={count > 99 ? '99+' : count} size={16} disabled={count === 0} color="red" offset={4}>
      <ActionIcon component={Link} to="/notifications" variant="subtle" size="lg" aria-label={`Notifications${count ? ` (${count} unread)` : ''}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </ActionIcon>
    </Indicator>
  );
}

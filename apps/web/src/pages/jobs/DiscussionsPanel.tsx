import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Drawer,
  FileButton,
  Grid,
  Group,
  Menu,
  Modal,
  MultiSelect,
  NavLink,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ChannelDto, MessageDto } from '@jobflow/shared';
import { API_BASE, del, get, patch, post, uploadWithProgress } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '../../components/states';
import { formatDateTime, formatSize } from '../../components/format';
import { VoiceRecorder, type VoiceClip } from '../../components/VoiceRecorder';
import { membersOf, useDirectory } from '../../components/useDirectory';
import { connectRealtime } from '../../realtime';
import { CreateCorrectionModal } from './CorrectionsPanel';

const EMOJI = ['👍', '✅', '❤️', '😂', '❗', '👀'] as const;

export function DiscussionsPanel({ jobId }: { jobId: string }) {
  const channels = useQuery({ queryKey: ['jobs', jobId, 'discussions'], queryFn: () => get<ChannelDto[]>(`/jobs/${jobId}/discussions`), refetchInterval: 60_000 });
  const [selected, setSelected] = useState<string | null>(null);
  if (channels.isPending) return <LoadingState />;
  if (channels.isError) return <ErrorState error={channels.error} />;
  const current = channels.data.find((c) => c.id === selected) ?? channels.data.find((c) => c.type === 'DEPARTMENT') ?? channels.data[0];
  if (!current) return <EmptyState>You have no channels in this job.</EmptyState>;
  return (
    <Grid>
      <Grid.Col span={{ base: 12, md: 3 }}>
        <Stack gap={0}>
          {channels.data.map((c) => (
            <NavLink
              key={c.id}
              label={c.name}
              active={c.id === current.id}
              onClick={() => setSelected(c.id)}
              rightSection={c.unread > 0 ? <Badge size="sm" color="red">{c.unread}</Badge> : null}
            />
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 9 }}>
        <ChannelView key={current.id} jobId={jobId} channel={current} />
      </Grid.Col>
    </Grid>
  );
}

function ChannelView({ jobId, channel }: { jobId: string; channel: ChannelDto }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [thread, setThread] = useState<MessageDto | null>(null);
  const [toCorrection, setToCorrection] = useState<MessageDto | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [participants, setParticipants] = useState(false);
  const key = ['discussions', channel.id, 'messages', search];
  const messages = useQuery({
    queryKey: key,
    queryFn: () => get<MessageDto[]>(`/discussions/${channel.id}/messages?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`),
  });
  const pins = useQuery({ queryKey: ['discussions', channel.id, 'pins'], queryFn: () => get<MessageDto[]>(`/discussions/${channel.id}/pins`), enabled: showPins });

  useEffect(() => {
    const socket = connectRealtime();
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['discussions', channel.id] });
    };
    const join = () => socket.emit('channel:join', channel.id, () => undefined);
    join();
    socket.on('connect', join);
    for (const e of ['message:created', 'message:updated', 'message:deleted', 'message:system']) socket.on(e, refresh);
    void post(`/discussions/${channel.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['jobs', jobId, 'discussions'] }));
    return () => {
      socket.emit('channel:leave', channel.id);
      socket.off('connect', join);
      for (const e of ['message:created', 'message:updated', 'message:deleted', 'message:system']) socket.off(e, refresh);
    };
  }, [channel.id, jobId, qc]);

  const list = useMemo(() => [...(messages.data ?? [])].reverse(), [messages.data]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView,
    // which React would treat as an (invalid) effect cleanup.
    void bottom.current?.scrollIntoView({ block: 'end' });
  }, [list.length]);

  return (
    <Stack>
      <Group justify="space-between">
        <Text fw={600}>{channel.name} channel</Text>
        <Group gap="xs">
          <TextInput size="xs" placeholder="Search messages" value={q} onChange={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && setSearch(q)} aria-label="Search messages" />
          {search && (
            <Button size="xs" variant="subtle" onClick={() => { setQ(''); setSearch(''); }}>
              Clear
            </Button>
          )}
          <Button size="xs" variant="default" onClick={() => setShowPins(true)}>
            Pinned
          </Button>
          {channel.canManage && (
            <Button size="xs" variant="default" onClick={() => setParticipants(true)}>
              Participants ({channel.participants.length})
            </Button>
          )}
        </Group>
      </Group>
      <Card withBorder p={0}>
        <ScrollArea h={460} p="sm">
          {messages.isPending ? (
            <LoadingState />
          ) : messages.isError ? (
            <ErrorState error={messages.error} />
          ) : list.length === 0 ? (
            <EmptyState>{search ? 'No messages match.' : 'No messages yet. Start the conversation.'}</EmptyState>
          ) : (
            <Stack gap="sm">
              {list.map((m) => (
                <MessageItem key={m.id} message={m} channel={channel} onThread={() => setThread(m)} onCorrection={() => setToCorrection(m)} />
              ))}
              <div ref={bottom} />
            </Stack>
          )}
        </ScrollArea>
      </Card>
      {channel.canPost ? <Composer channel={channel} /> : <Text size="sm" c="dimmed">You can read this channel but not post in it.</Text>}

      <Drawer opened={!!thread} onClose={() => setThread(null)} position="right" size="lg" title="Thread">
        {thread && <ThreadView channel={channel} root={thread} />}
      </Drawer>
      <Modal opened={showPins} onClose={() => setShowPins(false)} title="Pinned messages" size="lg">
        <Stack>{pins.data?.length ? pins.data.map((m) => <MessageItem key={m.id} message={m} channel={channel} />) : <EmptyState>Nothing pinned.</EmptyState>}</Stack>
      </Modal>
      {participants && <ParticipantsModal channel={channel} jobId={jobId} onClose={() => setParticipants(false)} />}
      {toCorrection && <CreateCorrectionModal jobId={jobId} source={{ message: toCorrection, channel }} onClose={() => setToCorrection(null)} />}
    </Stack>
  );
}

function ThreadView({ channel, root }: { channel: ChannelDto; root: MessageDto }) {
  const replies = useQuery({
    queryKey: ['discussions', channel.id, 'thread', root.id],
    queryFn: () => get<MessageDto[]>(`/discussions/${channel.id}/messages?parentMessageId=${root.id}&limit=100`),
  });
  return (
    <Stack>
      <MessageItem message={root} channel={channel} />
      <Text size="sm" fw={600}>
        Replies
      </Text>
      {replies.data?.map((m) => <MessageItem key={m.id} message={m} channel={channel} />)}
      {channel.canPost && <Composer channel={channel} parentId={root.id} />}
    </Stack>
  );
}

function MessageItem({ message: m, channel, onThread, onCorrection }: { message: MessageDto; channel: ChannelDto; onThread?: () => void; onCorrection?: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(m.body);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['discussions', channel.id] });
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) });
  const react = useMutation({ mutationFn: (emoji: string) => post(`/messages/${m.id}/reactions`, { emoji }), onSuccess: refresh, onError });
  const pin = useMutation({ mutationFn: () => (m.pinned ? del(`/messages/${m.id}/pin`) : post(`/messages/${m.id}/pin`)), onSuccess: refresh, onError });
  const save = useMutation({ mutationFn: () => patch(`/messages/${m.id}`, { body }), onSuccess: () => { setEditing(false); refresh(); }, onError });
  const remove = useMutation({ mutationFn: () => del(`/messages/${m.id}`), onSuccess: refresh, onError });

  if (m.kind === 'SYSTEM') {
    return (
      <Text size="xs" c="dimmed" ta="center">
        {formatDateTime(m.createdAt)} · {m.body}
      </Text>
    );
  }
  return (
    <div>
      <Group gap={6}>
        <Text size="sm" fw={600}>
          {m.author?.fullName ?? 'Unknown'}
        </Text>
        <Text size="xs" c="dimmed">
          {formatDateTime(m.createdAt)}
          {m.edited && ' · edited'}
          {m.readBy > 1 && ` · read by ${m.readBy}`}
        </Text>
        {m.pinned && <Badge size="xs" variant="light">Pinned</Badge>}
      </Group>
      {m.deleted ? (
        <Text size="sm" c="dimmed" fs="italic">
          Message deleted
        </Text>
      ) : editing ? (
        <Group gap="xs" align="flex-end">
          <Textarea style={{ flex: 1 }} autosize value={body} onChange={(e) => setBody(e.currentTarget.value)} aria-label="Edit message" />
          <Button size="xs" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          <Button size="xs" variant="default" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Group>
      ) : (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {m.mentions.length > 0 && (
            <Text span c="blue" fw={500}>
              {m.mentions.map((u) => `@${u.fullName}`).join(' ')}{' '}
            </Text>
          )}
          {m.body}
        </Text>
      )}
      {m.attachments.map((a) =>
        a.isVoice ? (
          <Group key={a.id} gap="xs" mt={4}>
            <audio controls preload="none" src={`${API_BASE}/files/${a.id}/download?inline=1`} style={{ height: 32 }} aria-label="Voice note" />
            <Text size="xs" c="dimmed">
              Voice note{a.durationSec ? ` · ${Math.floor(a.durationSec / 60)}:${String(a.durationSec % 60).padStart(2, '0')}` : ''} ·{' '}
              <Anchor href={`${API_BASE}/files/${a.id}/download`} size="xs">
                download
              </Anchor>
            </Text>
          </Group>
        ) : a.mimeType.startsWith('image/') ? (
          <Anchor key={a.id} href={`${API_BASE}/files/${a.id}/download?inline=1`} target="_blank" rel="noopener">
            <img src={`${API_BASE}/files/${a.id}/download?inline=1`} alt={a.originalName} style={{ maxWidth: 240, maxHeight: 180, display: 'block', marginTop: 4, borderRadius: 4 }} />
          </Anchor>
        ) : (
          <Text key={a.id} size="sm" mt={2}>
            📎 <Anchor href={`${API_BASE}/files/${a.id}/download`}>{a.originalName}</Anchor> ({formatSize(a.size)})
          </Text>
        ),
      )}
      {!m.deleted && (
        <Group gap={4} mt={2}>
          {m.reactions.map((r) => (
            <Button key={r.emoji} size="compact-xs" variant={r.mine ? 'light' : 'subtle'} onClick={() => react.mutate(r.emoji)} disabled={!channel.canPost}>
              {r.emoji} {r.count}
            </Button>
          ))}
          {channel.canPost && (
            <Menu position="bottom-start">
              <Menu.Target>
                <ActionIcon size="sm" variant="subtle" aria-label="Add reaction">
                  ☺
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Group gap={2} p={4}>
                  {EMOJI.map((e) => (
                    <ActionIcon key={e} variant="subtle" onClick={() => react.mutate(e)} aria-label={`React ${e}`}>
                      {e}
                    </ActionIcon>
                  ))}
                </Group>
              </Menu.Dropdown>
            </Menu>
          )}
          {onThread && (
            <Button size="compact-xs" variant="subtle" onClick={onThread}>
              {m.replyCount ? `${m.replyCount} repl${m.replyCount === 1 ? 'y' : 'ies'}` : 'Reply'}
            </Button>
          )}
          {onCorrection && can('correction.create') && (
            <Button size="compact-xs" variant="subtle" onClick={onCorrection}>
              Make correction
            </Button>
          )}
          {(m.canEdit || m.canDelete || channel.canManage) && (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon size="sm" variant="subtle" aria-label="Message actions">
                  ⋯
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {m.canEdit && <Menu.Item onClick={() => setEditing(true)}>Edit</Menu.Item>}
                {channel.canManage && <Menu.Item onClick={() => pin.mutate()}>{m.pinned ? 'Unpin' : 'Pin'}</Menu.Item>}
                {m.canDelete && (
                  <Menu.Item color="red" onClick={() => window.confirm('Delete this message? It stays in the audit history.') && remove.mutate()}>
                    Delete
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      )}
    </div>
  );
}

function Composer({ channel, parentId }: { channel: ChannelDto; parentId?: string }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const { can } = useAuth();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [voice, setVoice] = useState<VoiceClip | null>(null);
  const [recording, setRecording] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  // Mention candidates: members of the channel's department plus added participants.
  const candidates = channel.type === 'DEPARTMENT' ? [...membersOf(dir.data, channel.department?.id), ...channel.participants.map((p) => ({ id: p.id, fullName: p.fullName, departments: [] }))] : (dir.data ?? []);
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];

  const send = useMutation({
    mutationFn: async () => {
      const fileIds: string[] = [];
      const total = files.length + (voice ? 1 : 0);
      let done = 0;
      for (const f of files) {
        fileIds.push((await uploadWithProgress<{ id: string }>(`/discussions/${channel.id}/attachments`, f, f.name, (x) => setProgress((done + x) / total))).id);
        done++;
      }
      if (voice) {
        fileIds.push(
          (await uploadWithProgress<{ id: string }>(`/discussions/${channel.id}/attachments?voice=1&durationSec=${voice.durationSec}`, voice.blob, voice.filename, (x) => setProgress((done + x) / total))).id,
        );
      }
      return post<MessageDto>(`/discussions/${channel.id}/messages`, { body, fileIds, mentionUserIds: mentions, parentMessageId: parentId ?? null });
    },
    onSuccess: () => {
      setBody('');
      setFiles([]);
      setVoice(null);
      setMentions([]);
      setProgress(null);
      void qc.invalidateQueries({ queryKey: ['discussions', channel.id] });
    },
    onError: (e) => {
      setProgress(null);
      notifications.show({ color: 'red', title: 'Not sent', message: errorMessage(e) });
    },
  });

  return (
    <Stack gap="xs">
      <Textarea
        placeholder={parentId ? 'Reply…' : `Message ${channel.name}…`}
        autosize
        minRows={2}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send.mutate();
        }}
        aria-label="Message"
      />
      {recording && !voice && (
        <VoiceRecorder
          onReady={(c) => {
            setVoice(c);
            setRecording(false);
          }}
          onCancel={() => setRecording(false)}
        />
      )}
      <Group justify="space-between">
        <Group gap="xs">
          <MultiSelect size="xs" placeholder="@ mention" data={unique.map((u) => ({ value: u.id, label: u.fullName }))} value={mentions} onChange={setMentions} searchable w={220} aria-label="Mention people" />
          <FileButton multiple onChange={(f) => setFiles([...files, ...f])}>
            {(props) => (
              <Button size="xs" variant="default" {...props}>
                Attach
              </Button>
            )}
          </FileButton>
          {can('message.voice') && !voice && !recording && (
            <Button size="xs" variant="default" onClick={() => setRecording(true)}>
              🎤 Voice note
            </Button>
          )}
          {files.map((f, i) => (
            <Badge key={i} variant="light" rightSection={<span style={{ cursor: 'pointer' }} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</span>}>
              {f.name}
            </Badge>
          ))}
          {voice && (
            <Badge color="red" variant="light" rightSection={<span style={{ cursor: 'pointer' }} onClick={() => setVoice(null)}>×</span>}>
              Voice note {voice.durationSec}s
            </Badge>
          )}
        </Group>
        <Button size="xs" loading={send.isPending} disabled={!body.trim() && !files.length && !voice} onClick={() => send.mutate()}>
          Send
        </Button>
      </Group>
      {progress !== null && <Progress value={progress * 100} size="sm" aria-label="Upload progress" />}
    </Stack>
  );
}

function ParticipantsModal({ channel, jobId, onClose }: { channel: ChannelDto; jobId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [userId, setUserId] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['jobs', jobId, 'discussions'] });
  const add = useMutation({ mutationFn: () => post(`/discussions/${channel.id}/participants`, { userId }), onSuccess: () => { setUserId(null); refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => del(`/discussions/${channel.id}/participants/${id}`), onSuccess: refresh });
  return (
    <Modal opened onClose={onClose} title={`Cross-department participants — ${channel.name}`}>
      <Stack>
        <Text size="sm">Added people can read and post in this channel only; they get no other access to the department.</Text>
        {add.isError && <Alert color="red">{errorMessage(add.error)}</Alert>}
        {channel.participants.map((p) => (
          <Group key={p.id} justify="space-between">
            <Text size="sm">{p.fullName}</Text>
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove.mutate(p.id)}>
              Remove
            </Button>
          </Group>
        ))}
        <Group align="flex-end">
          <Select style={{ flex: 1 }} label="Add person" searchable data={(dir.data ?? []).map((u) => ({ value: u.id, label: u.fullName }))} value={userId} onChange={setUserId} />
          <Button disabled={!userId} loading={add.isPending} onClick={() => add.mutate()}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

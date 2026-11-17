import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Checkbox, Group, List, Modal, Select, Stack, Text, Textarea, ThemeIcon, Timeline } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { StageDto, WorkflowDto } from '@jobflow/shared';
import { post } from '../api/client';
import { errorMessage } from './states';
import { formatDateTime, STAGE_STATUS } from './format';

type ReasonAction = 'hold' | 'return' | 'reopen' | 'completeWithException';

const REASON_TITLES: Record<ReasonAction, string> = {
  hold: 'Put stage on hold',
  return: 'Return for correction',
  reopen: 'Reopen stage',
  completeWithException: 'Complete with exception',
};

export function WorkflowTimeline({ jobId, workflow }: { jobId: string; workflow: WorkflowDto }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ action: ReasonAction; stage: StageDto } | null>(null);

  const onDone = (wf: WorkflowDto, message: string) => {
    qc.setQueryData(['jobs', jobId, 'workflow'], wf);
    void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
    void qc.invalidateQueries({ queryKey: ['jobs'], exact: false });
    notifications.show({ color: 'green', message });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', title: 'Not done', message: <span style={{ whiteSpace: 'pre-line' }}>{errorMessage(e)}</span> });

  const complete = useMutation({
    mutationFn: (s: StageDto) => post<WorkflowDto>(`/jobs/${jobId}/stages/${s.id}/complete`),
    onSuccess: (wf, s) => onDone(wf, `${s.name} completed`),
    onError,
  });
  const resume = useMutation({
    mutationFn: (s: StageDto) => post<WorkflowDto>(`/jobs/${jobId}/stages/${s.id}/resume`),
    onSuccess: (wf, s) => onDone(wf, `${s.name} resumed`),
    onError,
  });
  const check = useMutation({
    mutationFn: ({ s, itemId, checked }: { s: StageDto; itemId: string; checked: boolean }) =>
      post<WorkflowDto>(`/jobs/${jobId}/stages/${s.id}/checklist/${itemId}`, { checked }),
    onSuccess: (wf) => qc.setQueryData(['jobs', jobId, 'workflow'], wf),
    onError,
  });

  // Group occurrences under their template stage, in template order.
  const groups = new Map<string, StageDto[]>();
  for (const s of workflow.stages) groups.set(s.key, [...(groups.get(s.key) ?? []), s]);
  const ordered = [...groups.values()];
  const activeIndex = ordered.findIndex((g) => g.some((s) => s.status === 'ACTIVE' || s.status === 'ON_HOLD'));

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {workflow.templateVersion.templateName} workflow · template version {workflow.templateVersion.versionNo}
        </Text>
        {workflow.status !== 'ACTIVE' && <Badge color={workflow.status === 'COMPLETED' ? 'green' : 'gray'}>{workflow.status === 'COMPLETED' ? 'Workflow complete' : 'Cancelled'}</Badge>}
      </Group>
      <Timeline active={activeIndex === -1 ? (workflow.status === 'COMPLETED' ? ordered.length : -1) : activeIndex - 1} bulletSize={26} lineWidth={2}>
        {ordered.map((occurrences) => {
          const latest = occurrences[occurrences.length - 1]!;
          const status = STAGE_STATUS[latest.status];
          return (
            <Timeline.Item
              key={latest.key}
              bullet={<Text size="xs" fw={700}>{latest.sequence}</Text>}
              title={
                <Group gap="xs">
                  <Text fw={600}>{latest.name}</Text>
                  <Badge size="sm" variant="light" color={status.color}>
                    {status.label}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {latest.department.name}
                  </Text>
                  {occurrences.length > 1 && (
                    <Badge size="sm" variant="outline" color="red">
                      {occurrences.length} rounds
                    </Badge>
                  )}
                </Group>
              }
            >
              <Stack gap={6} mt={4}>
                {occurrences.map((s) => (
                  <StageBlock
                    key={s.id}
                    stage={s}
                    showRound={occurrences.length > 1}
                    busy={complete.isPending || resume.isPending}
                    onCheck={(itemId, checked) => check.mutate({ s, itemId, checked })}
                    onComplete={() => complete.mutate(s)}
                    onResume={() => resume.mutate(s)}
                    onReason={(action) => setDialog({ action, stage: s })}
                  />
                ))}
              </Stack>
            </Timeline.Item>
          );
        })}
      </Timeline>
      {dialog && <ReasonDialog jobId={jobId} {...dialog} onClose={() => setDialog(null)} onDone={onDone} />}
    </Stack>
  );
}

function StageBlock({
  stage: s,
  showRound,
  busy,
  onCheck,
  onComplete,
  onResume,
  onReason,
}: {
  stage: StageDto;
  showRound: boolean;
  busy: boolean;
  onCheck: (itemId: string, checked: boolean) => void;
  onComplete: () => void;
  onResume: () => void;
  onReason: (a: ReasonAction) => void;
}) {
  const current = s.status === 'ACTIVE' || s.status === 'ON_HOLD';
  const can = (a: StageDto['allowedActions'][number]) => s.allowedActions.includes(a);
  const failed = s.gates.filter((g) => !g.passed);

  const meta = (
    <Text size="xs" c="dimmed">
      {showRound && `Round ${s.occurrenceNo} · `}
      {s.status === 'COMPLETED' && `Completed ${formatDateTime(s.completedAt)}${s.completedBy ? ` by ${s.completedBy}` : ''}`}
      {current && s.activatedAt && `Started ${formatDateTime(s.activatedAt)}`}
      {s.status === 'RETURNED' && 'Sent back for correction'}
    </Text>
  );

  if (!current) {
    return (
      <Stack gap={2}>
        {meta}
        {s.returnedFrom && (
          <Text size="xs" c="red">
            Returned by {s.returnedFrom.name}: {s.returnReason}
          </Text>
        )}
        {s.exceptionReason && (
          <Text size="xs" c="orange">
            Completed by exception: {s.exceptionReason}
          </Text>
        )}
        {can('reopen') && (
          <Group>
            <Button size="compact-xs" variant="subtle" color="orange" onClick={() => onReason('reopen')}>
              Reopen
            </Button>
          </Group>
        )}
      </Stack>
    );
  }

  return (
    <Card withBorder padding="sm" radius="md" bg={s.status === 'ON_HOLD' ? 'orange.0' : 'blue.0'}>
      <Stack gap="xs">
        {meta}
        {s.returnedFrom && (
          <Alert color="red" p="xs" title={`Returned by ${s.returnedFrom.name}`}>
            {s.returnReason}
          </Alert>
        )}
        {s.status === 'ON_HOLD' && (
          <Alert color="orange" p="xs" title="On hold">
            {s.holdReason}
          </Alert>
        )}
        {s.checklist.length > 0 && (
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              Checklist
            </Text>
            {s.checklist.map((c) => (
              <Checkbox
                key={c.id}
                label={
                  <span>
                    {c.label}
                    {c.required && <Text span c="red"> *</Text>}
                    {c.checkedBy && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        — {c.checkedBy}, {formatDateTime(c.checkedAt)}
                      </Text>
                    )}
                  </span>
                }
                checked={c.checkedAt !== null}
                disabled={!can('check')}
                onChange={(e) => onCheck(c.id, e.currentTarget.checked)}
              />
            ))}
          </Stack>
        )}
        {s.gates.length > 0 && (
          <List size="sm" spacing={2} center>
            {s.gates.map((g) => (
              <List.Item
                key={g.key}
                icon={
                  <ThemeIcon size={16} radius="xl" color={g.passed ? 'green' : 'gray'}>
                    <Text size="10px">{g.passed ? '✓' : '·'}</Text>
                  </ThemeIcon>
                }
              >
                {g.label}
                {!g.passed && g.detail && (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    ({g.detail})
                  </Text>
                )}
              </List.Item>
            ))}
          </List>
        )}
        <Group gap="xs">
          {can('complete') && (
            <Button size="xs" disabled={failed.length > 0} title={failed.length ? 'Finish the open items first' : undefined} loading={busy} onClick={onComplete}>
              Complete {s.name}
            </Button>
          )}
          {can('resume') && (
            <Button size="xs" loading={busy} onClick={onResume}>
              Resume
            </Button>
          )}
          {can('hold') && (
            <Button size="xs" variant="default" onClick={() => onReason('hold')}>
              Put on hold
            </Button>
          )}
          {can('return') && (
            <Button size="xs" variant="light" color="red" onClick={() => onReason('return')}>
              Return for correction
            </Button>
          )}
          {can('completeWithException') && failed.length > 0 && (
            <Button size="xs" variant="subtle" color="orange" onClick={() => onReason('completeWithException')}>
              Complete with exception
            </Button>
          )}
        </Group>
        {!s.allowedActions.length && (
          <Text size="xs" c="dimmed">
            {s.department.name} works on this stage.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function ReasonDialog({
  jobId,
  action,
  stage,
  onClose,
  onDone,
}: {
  jobId: string;
  action: ReasonAction;
  stage: StageDto;
  onClose: () => void;
  onDone: (wf: WorkflowDto, message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<string | null>(stage.returnTargets.length === 1 ? stage.returnTargets[0]!.key : null);
  const path = { hold: 'hold', return: 'return', reopen: 'reopen', completeWithException: 'complete-with-exception' }[action];
  const run = useMutation({
    mutationFn: () => post<WorkflowDto>(`/jobs/${jobId}/stages/${stage.id}/${path}`, action === 'return' ? { targetStageKey: target, reason } : { reason }),
    onSuccess: (wf) => {
      onDone(wf, `${REASON_TITLES[action]}: done`);
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={`${REASON_TITLES[action]} — ${stage.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <Stack>
          {run.isError && <Alert color="red">{errorMessage(run.error)}</Alert>}
          {action === 'return' && (
            <>
              <Text size="sm">Only the selected stage is redone. When it is finished, the job comes straight back to {stage.name}.</Text>
              <Select label="Return to" data={stage.returnTargets.map((t) => ({ value: t.key, label: t.name }))} value={target} onChange={setTarget} required />
            </>
          )}
          {action === 'reopen' && <Text size="sm">A new round of {stage.name} starts. Earlier rounds and their history are kept.</Text>}
          {action === 'completeWithException' && (
            <Text size="sm">The stage completes although some checks are open. The open checks and your reason are recorded in the history.</Text>
          )}
          <Textarea label="Reason" required minLength={3} autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={run.isPending} color={action === 'hold' ? 'blue' : 'orange'}>
              {REASON_TITLES[action]}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

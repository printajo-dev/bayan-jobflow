import { screen } from '@testing-library/react';
import { briefSchemas, type StageDto, type WorkflowDto } from '@jobflow/shared';
import { briefToPayload, emptyBrief } from '../components/BriefForm';
import { WorkflowTimeline } from '../components/WorkflowTimeline';
import { renderWithProviders, mockFetch, fakeMe } from './render';

describe('brief form payload', () => {
  it('produces a Vehicle Branding brief the API accepts as complete, with no customer fields', () => {
    const payload = briefToPayload('VB', {
      ...emptyBrief,
      scope: 'Wrap',
      coverage: 'FULL_WRAP',
      vehicles: [{ description: 'Toyota Hiace', plateOrChassis: 'D 1' }, { description: '  ' }],
    });
    expect(briefSchemas('VB').complete.safeParse(payload).success).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/customer/i);
    expect((payload['details'] as { vehicles: unknown[] }).vehicles).toHaveLength(1);
  });

  it('produces a Signage brief draft without vehicle data', () => {
    const payload = briefToPayload('SG', { ...emptyBrief, siteName: 'Mall' });
    expect(briefSchemas('SG').draft.safeParse(payload).success).toBe(true);
    expect(briefSchemas('SG').complete.safeParse(payload).success).toBe(false);
  });
});

function stage(partial: Partial<StageDto>): StageDto {
  return {
    id: crypto.randomUUID(),
    key: 'design',
    name: 'Design',
    sequence: 2,
    occurrenceNo: 1,
    status: 'PENDING',
    department: { id: 'd', code: 'DESIGN', name: 'Design Team' },
    activatedAt: null,
    completedAt: null,
    completedBy: null,
    returnedFrom: null,
    returnReason: null,
    holdReason: null,
    exceptionReason: null,
    checklist: [],
    gates: [],
    allowedActions: [],
    returnTargets: [],
    ...partial,
  };
}

function workflow(stages: StageDto[]): WorkflowDto {
  return { id: 'w', status: 'ACTIVE', templateVersion: { id: 'v', templateName: 'Vehicle Branding', versionNo: 1 }, stages };
}

describe('workflow timeline', () => {
  beforeEach(() => {
    mockFetch((url) => (url.endsWith('/auth/me') ? { status: 200, body: fakeMe(['job.view']) } : undefined));
  });

  it('shows the actions the API allows and disables completion while checks are open', async () => {
    const wf = workflow([
      stage({ key: 'job_brief', name: 'Job Brief', sequence: 1, status: 'COMPLETED', completedBy: 'Sara' }),
      stage({
        status: 'ACTIVE',
        allowedActions: ['check', 'complete', 'hold', 'return'],
        returnTargets: [{ key: 'job_brief', name: 'Job Brief' }],
        checklist: [{ id: 'c1', label: 'Customer approval recorded', required: true, checkedAt: null, checkedBy: null }],
        gates: [{ key: 'checklist', label: 'Required checklist items are ticked', passed: false, detail: 'Customer approval recorded' }],
      }),
    ]);
    renderWithProviders(<WorkflowTimeline jobId="j" workflow={wf} />);
    expect(await screen.findByRole('button', { name: 'Complete Design' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Put on hold' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return for correction' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Customer approval recorded/ })).toBeEnabled();
  });

  it('shows no actions to a viewer and shows rework rounds', async () => {
    const first = stage({ status: 'COMPLETED' });
    const wf = workflow([
      first,
      stage({ status: 'ACTIVE', occurrenceNo: 2, returnedFrom: { stageId: 'g', key: 'government_approval', name: 'Government Approval' }, returnReason: 'RTA rejected' }),
    ]);
    renderWithProviders(<WorkflowTimeline jobId="j" workflow={wf} />);
    expect(await screen.findByText('2 rounds')).toBeInTheDocument();
    expect(screen.getByText('RTA rejected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Complete/ })).not.toBeInTheDocument();
    expect(screen.getByText('Design Team works on this stage.')).toBeInTheDocument();
  });
});

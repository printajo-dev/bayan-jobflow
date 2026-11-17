import { screen } from '@testing-library/react';
import type { CorrectionDto } from '@jobflow/shared';
import { CorrectionCard } from '../pages/jobs/CorrectionsPanel';
import { fakeMe, mockFetch, renderWithProviders } from './render';

function correction(partial: Partial<CorrectionDto>): CorrectionDto {
  return {
    id: 'c1',
    jobId: 'j1',
    jobNumber: 'INV-1',
    department: { id: 'd1', code: 'DESIGN', name: 'Design Team' },
    stage: { id: 's1', name: 'Design', occurrenceNo: 1 },
    sourceMessageId: null,
    channelId: null,
    title: 'Enlarge QR code',
    description: 'Minimum 3 cm',
    requestedBy: 'Sara',
    assignedTo: null,
    priority: 'NORMAL',
    deadline: null,
    status: 'OPEN',
    blocking: true,
    resolutionNotes: null,
    resolvedAt: null,
    resolvedBy: null,
    files: [],
    history: [{ from: null, to: 'OPEN', actor: 'Sara', reason: null, at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    allowedActions: [],
    ...partial,
  };
}

describe('correction card', () => {
  beforeEach(() => {
    mockFetch((url) => {
      if (url.endsWith('/auth/me')) return { status: 200, body: fakeMe(['job.view']) };
      if (url.endsWith('/directory')) return { status: 200, body: [] };
      return undefined;
    });
  });

  it('shows only the actions the server allows', async () => {
    renderWithProviders(<CorrectionCard correction={correction({ allowedActions: [] })} />);
    expect(await screen.findByText('Enlarge QR code')).toBeInTheDocument();
    expect(screen.getByText('Blocks stage')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Assign correction' })).not.toBeInTheDocument();
  });

  it('lets the assignee resolve and a leader assign', async () => {
    renderWithProviders(<CorrectionCard correction={correction({ status: 'ASSIGNED', allowedActions: ['assign', 'update', 'resolve'] })} />);
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Assign correction' })).toBeInTheDocument();
  });

  it('hides the blocking badge once resolved and offers reopen', async () => {
    renderWithProviders(<CorrectionCard correction={correction({ status: 'RESOLVED', resolutionNotes: 'Done', resolvedBy: 'Dina', allowedActions: ['reopen'] })} />);
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(screen.queryByText('Blocks stage')).not.toBeInTheDocument();
    expect(screen.getByText(/Resolved by Dina/)).toBeInTheDocument();
  });
});

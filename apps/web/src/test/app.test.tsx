import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeMe, mockFetch, renderRoute } from './render';
import { api, setCsrfToken } from '../api/client';

describe('API client', () => {
  it('sends the CSRF token on state-changing requests only', async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    setCsrfToken('abc');
    await api('GET', '/x');
    await api('POST', '/x', {});
    expect(new Headers(calls[0]!.init?.headers).get('X-CSRF-Token')).toBeNull();
    expect(new Headers(calls[1]!.init?.headers).get('X-CSRF-Token')).toBe('abc');
    expect(calls[1]!.init?.credentials).toBe('same-origin');
    setCsrfToken(null);
  });
});

describe('App routing', () => {
  it('shows the sign-in page when not signed in, and reports a failed sign-in', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/me')) return { status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Not signed in' } };
      if (url.endsWith('/auth/login'))
        return { status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Invalid username or password' } };
      return undefined;
    });
    renderRoute('/admin/users');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Username/), 'someone');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  });

  it('forces a password change before anything else', async () => {
    mockFetch((url) => (url.endsWith('/auth/me') ? { status: 200, body: fakeMe(['user.manage'], { mustChangePassword: true }) } : undefined));
    renderRoute('/admin/users');
    expect(await screen.findByText(/Choose a new password to continue/)).toBeInTheDocument();
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
  });

  it('hides administration links from users without admin permissions', async () => {
    mockFetch((url) => (url.endsWith('/auth/me') ? { status: 200, body: fakeMe(['job.view']) } : undefined));
    renderRoute('/');
    expect(await screen.findByText(/Welcome, Test User/)).toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('shows access denied when opening an admin page without permission', async () => {
    mockFetch((url) => (url.endsWith('/auth/me') ? { status: 200, body: fakeMe(['job.view']) } : undefined));
    renderRoute('/admin/roles');
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('shows administration links and the users list to administrators', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/me')) return { status: 200, body: fakeMe(['user.manage', 'role.manage', 'department.manage', 'audit.view']) };
      if (url.includes('/users?'))
        return {
          status: 200,
          body: { items: [fakeMe([], { id: 'u2', fullName: 'Sara Sales', username: 'sara' }).user], page: 1, pageSize: 25, total: 1 },
        };
      return undefined;
    });
    renderRoute('/admin/users');
    expect(await screen.findByText('Sara Sales')).toBeInTheDocument();
    for (const name of ['Users', 'Departments', 'Roles & permissions', 'Audit log']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByText('1 user(s)')).toBeInTheDocument());
  });
});

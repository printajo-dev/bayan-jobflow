import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CurrentUserDto, PermissionKey } from '@jobflow/shared';
import { AuthProvider } from '../auth/AuthContext';
import { routes } from '../App';

export function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>
        <AuthProvider>{ui}</AuthProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderWithProviders(<RouterProvider router={router} />);
}

export function fakeMe(permissions: PermissionKey[], overrides: Partial<CurrentUserDto['user']> = {}): CurrentUserDto {
  return {
    csrfToken: 'csrf-test-token',
    permissions,
    user: {
      id: '0197a3c4-0000-7000-8000-000000000001',
      username: 'test.user',
      fullName: 'Test User',
      email: null,
      status: 'ACTIVE',
      mustChangePassword: false,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      roles: [],
      departments: [],
      ...overrides,
    },
  };
}

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;

/** Routes fetch calls to the handler; unhandled calls fail the test loudly. */
export function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const result = handler(url, init);
    if (!result) throw new Error(`Unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

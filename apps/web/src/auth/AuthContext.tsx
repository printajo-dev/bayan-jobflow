import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangePasswordInput, CurrentUserDto, LoginInput, PermissionKey } from '@jobflow/shared';
import { ApiError, get, post, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { disconnectRealtime } from '../realtime';

interface AuthState {
  me: CurrentUserDto | null;
  loading: boolean;
  can: (permission: PermissionKey) => boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const ME_KEY = ['auth', 'me'] as const;

async function fetchMe(): Promise<CurrentUserDto | null> {
  try {
    return await get<CurrentUserDto>('/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 60_000, retry: false });
  const me = data ?? null;

  useEffect(() => {
    setCsrfToken(me?.csrfToken ?? null);
  }, [me]);

  const setMe = useCallback(
    (value: CurrentUserDto | null) => {
      setCsrfToken(value?.csrfToken ?? null);
      qc.setQueryData(ME_KEY, value);
    },
    [qc],
  );

  /** Signed out (or session expired): drop cached data but keep the auth query alive. */
  const signedOut = useCallback(() => {
    disconnectRealtime();
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    setMe(null);
  }, [qc, setMe]);

  useEffect(() => {
    setUnauthorizedHandler(signedOut);
    return () => setUnauthorizedHandler(null);
  }, [signedOut]);

  const value = useMemo<AuthState>(() => {
    const permissions = new Set(me?.permissions ?? []);
    return {
      me,
      loading: isPending,
      can: (p) => permissions.has(p),
      login: async (input) => setMe(await post<CurrentUserDto>('/auth/login', input)),
      logout: async () => {
        try {
          await post('/auth/logout');
        } finally {
          signedOut();
        }
      },
      changePassword: async (input) => setMe(await post<CurrentUserDto>('/auth/change-password', input)),
    };
  }, [me, isPending, setMe, signedOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

import type { ApiErrorBody } from '@jobflow/shared';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: ApiErrorBody,
  ) {
    super(message);
  }
}

/** CSRF token from the current session; sent on every state-changing request. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request reports the session has ended. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function messageOf(body: ApiErrorBody | undefined, status: number): string {
  if (!body) return `Request failed (${status})`;
  return Array.isArray(body.message) ? body.message.join('\n') : body.message;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the JobFlow server. Check the network connection.');
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = data as ApiErrorBody | undefined;
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') onUnauthorized?.();
    throw new ApiError(res.status, messageOf(err, res.status), err);
  }
  return data as T;
}

/** Multipart upload of one file (field "file"). */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, credentials: 'same-origin', body: form });
  } catch {
    throw new ApiError(0, 'Cannot reach the JobFlow server. Check the network connection.');
  }
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = data as ApiErrorBody | undefined;
    if (res.status === 401) onUnauthorized?.();
    if (res.status === 413) throw new ApiError(413, 'The file is too large.', err);
    throw new ApiError(res.status, messageOf(err, res.status), err);
  }
  return data as T;
}

/** Upload with progress reporting (XMLHttpRequest, because fetch cannot report upload progress). */
export function uploadWithProgress<T>(path: string, file: Blob, filename: string, onProgress?: (fraction: number) => void, fields: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the JobFlow server. Check the network connection.'));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      if (xhr.status === 401) onUnauthorized?.();
      const err = data as ApiErrorBody | undefined;
      reject(new ApiError(xhr.status, xhr.status === 413 ? 'The file is too large.' : messageOf(err, xhr.status), err));
    };
    const form = new FormData();
    // Text fields first so the server sees them before the file stream.
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file, filename);
    xhr.send(form);
  });
}

export const del = <T>(path: string) => api<T>('DELETE', path);
export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);

export function toQuery(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

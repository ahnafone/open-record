import {
  isAccessStatus,
  type AccessAction,
  type AccessRequest,
  type AccessStatus,
} from '@open-record/models';
import type { AuthProjectConfig } from './ports';

/**
 * Calls to the Supabase edge functions behind access requests on the public
 * server: `request-access` (public), `list-access` and `decide-access` (admin
 * only). Plain functions, no DI, so the auth store can probe admin status
 * without depending on the services in `access.service.ts`.
 */

const TIMEOUT_MS = 15_000;

export interface EdgeResponse {
  status: number;
  data: unknown;
}

function parse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The server's `{ error }` text, when it sent one. */
export function edgeError(data: unknown): string | undefined {
  return isRecord(data) && typeof data['error'] === 'string' ? data['error'] : undefined;
}

/**
 * Call one edge function. Resolves for every HTTP status (the caller maps
 * them); rejects only when the request cannot be made (offline, timeout).
 */
export async function callEdgeFunction(
  project: AuthProjectConfig,
  name: string,
  options: { method: 'GET' | 'POST'; token?: string; body?: unknown },
): Promise<EdgeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      apikey: project.anonKey,
      accept: 'application/json',
    };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${project.url.replace(/\/+$/, '')}/functions/v1/${name}`, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    return { status: res.status, data: parse(await res.text()) };
  } finally {
    clearTimeout(timer);
  }
}

/** Admin probe: true only when `list-access` answers 200 (403 and failures are false). */
export async function probeAdmin(project: AuthProjectConfig, token: string): Promise<boolean> {
  try {
    const { status } = await callEdgeFunction(project, 'list-access', { method: 'GET', token });
    return status === 200;
  } catch {
    return false;
  }
}

/** Submit an access request (public; Turnstile token required). */
export async function submitAccessRequest(
  project: AuthProjectConfig,
  input: { email: string; note?: string; turnstileToken: string },
): Promise<AccessStatus> {
  const response = await callEdgeFunction(project, 'request-access', {
    method: 'POST',
    body: input,
  });
  const status = isRecord(response.data) ? response.data['status'] : undefined;
  if (response.status === 200 && isAccessStatus(status)) return status;
  if (response.status === 403) throw new Error('Verification failed. Try again.');
  if (response.status === 429)
    throw new Error(edgeError(response.data) ?? 'Too many requests right now. Try again later.');
  throw new Error(edgeError(response.data) ?? 'Could not send your request. Try again.');
}

/** `list-access` for the signed-in admin: every request, newest first. */
export async function listAccessRequests(
  project: AuthProjectConfig,
  token: string,
): Promise<AccessRequest[]> {
  const response = await callEdgeFunction(project, 'list-access', { method: 'GET', token });
  if (response.status === 200 && isRecord(response.data) && Array.isArray(response.data['requests']))
    return response.data['requests'] as AccessRequest[];
  throw accessAdminError(response, 'Could not load access requests.');
}

/** `decide-access` for the signed-in admin: returns the updated row. */
export async function decideAccessRequest(
  project: AuthProjectConfig,
  token: string,
  id: string,
  action: AccessAction,
): Promise<AccessRequest> {
  const response = await callEdgeFunction(project, 'decide-access', {
    method: 'POST',
    token,
    body: { id, action },
  });
  if (response.status === 200 && isRecord(response.data) && isRecord(response.data['request']))
    return response.data['request'] as unknown as AccessRequest;
  throw accessAdminError(response, 'Could not update that request.');
}

function accessAdminError(response: EdgeResponse, fallback: string): Error {
  if (response.status === 401) return new Error('Sign in again to manage access requests.');
  if (response.status === 403) return new Error('Only the server admin can manage access requests.');
  return new Error(edgeError(response.data) ?? fallback);
}

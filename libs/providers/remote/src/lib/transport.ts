import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { AbortedError, NetworkError } from './errors';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'HEAD';
  url: string;
  headers: Record<string, string>;
  /** JSON-serialisable body (POST). */
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, otherwise text (or `undefined` when empty). */
  data: unknown;
}

/**
 * Minimal HTTP port so the client works over `fetch` (web, tests) or
 * CapacitorHttp (native: no CORS, works with self-signed LAN setups the web
 * view would block). Implementations resolve for every HTTP status and only
 * reject for transport failures ({@link NetworkError}) or aborts.
 */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** `fetch`-based transport (web). Pass a custom `fetch` for tests. */
export function createFetchTransport(fetchImpl: typeof fetch = (...args) => fetch(...args)): HttpTransport {
  return {
    async request(req) {
      if (req.signal?.aborted) throw new AbortedError();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => timeout.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const headers = { ...req.headers };
        let body: string | undefined;
        if (req.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(req.body);
        }
        let res: Response;
        try {
          res = await fetchImpl(req.url, { method: req.method, headers, body, signal: timeout.signal });
        } catch (err) {
          if (req.signal?.aborted) throw new AbortedError();
          throw new NetworkError('Could not reach the download server.', { cause: err });
        }
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => (resHeaders[key.toLowerCase()] = value));
        let data: unknown;
        if (req.method !== 'HEAD') {
          const text = await res.text();
          data = text;
          if (text && /json/i.test(resHeaders['content-type'] ?? '')) {
            try {
              data = JSON.parse(text);
            } catch {
              // leave as text; the client reports a protocol error
            }
          }
          if (text === '') data = undefined;
        }
        return { status: res.status, headers: resHeaders, data };
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Native transport over CapacitorHttp. Aborts are honoured before and after the call only. */
export function createCapacitorHttpTransport(): HttpTransport {
  return {
    async request(req) {
      if (req.signal?.aborted) throw new AbortedError();
      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const headers = { ...req.headers };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await CapacitorHttp.request({
          url: req.url,
          method: req.method,
          headers,
          data: req.body,
          connectTimeout: timeout,
          readTimeout: timeout,
        });
      } catch (err) {
        throw new NetworkError('Could not reach the download server.', { cause: err });
      }
      if (req.signal?.aborted) throw new AbortedError();
      const resHeaders = lowerKeys(res.headers ?? {});
      let data: unknown = res.data;
      if (typeof data === 'string') {
        if (data === '') data = undefined;
        else if (/json/i.test(resHeaders['content-type'] ?? '')) {
          try {
            data = JSON.parse(data);
          } catch {
            // leave as text
          }
        }
      }
      return { status: res.status, headers: resHeaders, data };
    },
  };
}

/** CapacitorHttp on Android/iOS, `fetch` in the browser. */
export function createDefaultTransport(): HttpTransport {
  return Capacitor.isNativePlatform() ? createCapacitorHttpTransport() : createFetchTransport();
}

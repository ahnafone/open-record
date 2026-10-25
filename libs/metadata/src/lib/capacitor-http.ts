import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { METADATA_USER_AGENT, MetadataHttp, MetadataHttpResponse } from './http';

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(',') && b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
  if (data == null || data === '') return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer();
  // Native bridges return binary bodies as base64 strings.
  if (typeof data === 'string') return base64ToArrayBuffer(data);
  return null;
}

/**
 * CapacitorHttp adapter. Native requests bypass CORS and can set User-Agent.
 * `available` is false on web so the service skips lookups there.
 */
export class CapacitorMetadataHttp implements MetadataHttp {
  readonly available: boolean;

  constructor(available: boolean = Capacitor.isNativePlatform()) {
    this.available = available;
  }

  async getJson(url: string): Promise<MetadataHttpResponse<unknown>> {
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: { 'User-Agent': METADATA_USER_AGENT, Accept: 'application/json' },
      responseType: 'json',
    });
    let data: unknown = res.data ?? null;
    if (typeof data === 'string') {
      try {
        data = data ? JSON.parse(data) : null;
      } catch {
        data = null;
      }
    }
    return { status: res.status, data, contentType: headerValue(res.headers, 'content-type') };
  }

  async getBytes(url: string): Promise<MetadataHttpResponse<ArrayBuffer>> {
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: { 'User-Agent': METADATA_USER_AGENT },
      responseType: 'arraybuffer',
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      data: ok ? await toArrayBuffer(res.data) : null,
      contentType: headerValue(res.headers, 'content-type'),
    };
  }
}

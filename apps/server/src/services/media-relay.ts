import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { MediaPlan } from './media-plan';

/** File inside `<dataDir>` holding the per-install HMAC secret. */
export const CAST_SECRET_FILE_NAME = 'cast-secret';

/** Secret length in bytes. */
const CAST_SECRET_BYTES = 32;

/** A relay entry can never outlive 24 hours, however often it is touched. */
export const MAX_RELAY_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PRUNE_MS = 60_000;

/**
 * Reads the relay signing secret from `<dataDir>/cast-secret`, or creates it
 * atomically (32 random bytes, mode 0600) and returns it. The file survives
 * restarts so tokens minted before a restart stay verifiable.
 */
export function loadOrCreateCastSecret(dataDir: string): Buffer {
  const path = join(dataDir, CAST_SECRET_FILE_NAME);

  let existing: Buffer | undefined;
  try {
    existing = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (existing.length !== CAST_SECRET_BYTES) {
      throw new Error(
        `cast secret ${path} must be ${CAST_SECRET_BYTES} bytes; delete it to generate a new one`,
      );
    }
    return existing;
  }

  const secret = randomBytes(CAST_SECRET_BYTES);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = join(dataDir, `.${CAST_SECRET_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, secret);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not have been created; nothing to clean up.
    }
    throw err;
  }
  return secret;
}

export interface RelayEntry {
  /** The id the HMAC signs. */
  id: string;
  userId: string;
  trackId: string;
  plan: MediaPlan;
  /** Resolved media link (yt-dlp); `expiresAt` is epoch ms. */
  resolved?: {
    url: string;
    mimeType?: string;
    headers?: Record<string, string>;
    expiresAt?: number;
  };
  expiresAt: number;
  createdAt: number;
}

export interface MediaRelayOptions {
  /** Per-install HMAC secret (`loadOrCreateCastSecret`). */
  secret: Buffer;
  /** Data directory; kept for parity with the upload cache in Phase 6. */
  dataDir: string;
  /** Public base the cast device can reach, e.g. `http://10.0.0.139:8787`. */
  baseUrl: string;
  /** Sliding TTL, clamped to 24 hours. */
  ttlMs: number;
  now?: () => number;
  /** Prune interval in ms; 60 s by default, 0 disables the timer. */
  pruneMs?: number;
}

/**
 * In-memory registry of signed, short-lived media URLs handed to cast devices.
 * The token is the credential: `base64url(id).base64url(HMAC-SHA256(secret, id))`.
 */
export class MediaRelay {
  private readonly secret: Buffer;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, RelayEntry>();
  private readonly pruneTimer: NodeJS.Timeout | null;

  constructor(opts: MediaRelayOptions) {
    this.secret = Buffer.from(opts.secret);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.ttlMs = Math.max(0, Math.min(opts.ttlMs, MAX_RELAY_TTL_MS));
    this.now = opts.now ?? Date.now;
    const pruneMs = opts.pruneMs ?? DEFAULT_PRUNE_MS;
    this.pruneTimer = pruneMs > 0 ? setInterval(() => this.prune(this.now()), pruneMs) : null;
    this.pruneTimer?.unref();
  }

  /** Mints a signed URL for a plan and remembers the entry. */
  create(params: {
    userId: string;
    trackId: string;
    plan: MediaPlan;
  }): { id: string; url: string; expiresAt: number } {
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    this.entries.set(id, {
      id,
      userId: params.userId,
      trackId: params.trackId,
      plan: params.plan,
      expiresAt,
      createdAt,
    });
    return { id, url: this.urlFor(this.sign(id)), expiresAt };
  }

  /** Returns the live entry for a token, or null when unknown, tampered or expired. */
  verify(token: string): RelayEntry | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [idPart, signaturePart] = parts;
    if (!idPart || !signaturePart) return null;

    const id = Buffer.from(idPart, 'base64url').toString('utf8');
    if (!id || Buffer.from(id, 'utf8').toString('base64url') !== idPart) return null;

    const presented = Buffer.from(signaturePart, 'base64url');
    if (presented.toString('base64url') !== signaturePart) return null;
    const expected = createHmac('sha256', this.secret).update(id).digest();
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry;
  }

  /**
   * Slides the TTL while the session still targets the cast device, capped at
   * 24 hours from creation. Returns false for unknown or expired entries.
   */
  touch(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const now = this.now();
    if (entry.expiresAt <= now) return false;
    entry.expiresAt = Math.min(now + this.ttlMs, entry.createdAt + MAX_RELAY_TTL_MS);
    return true;
  }

  /** Remembers the resolved media link for an entry; a no-op when unknown. */
  setResolved(id: string, resolved: RelayEntry['resolved']): void {
    const entry = this.entries.get(id);
    if (entry) entry.resolved = resolved;
  }

  /** Upload ids referenced by live entries, so the upload cache keeps them. */
  liveUploads(userId?: string): Set<string> {
    const now = this.now();
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) continue;
      if (userId !== undefined && entry.userId !== userId) continue;
      if (entry.plan.kind === 'upload') ids.add(entry.plan.uploadId);
    }
    return ids;
  }

  /** Drops expired entries (also runs on the 60 s interval). */
  prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now || entry.createdAt + MAX_RELAY_TTL_MS <= now) {
        this.entries.delete(id);
      }
    }
  }

  /** Stops the prune timer. The registry stays usable for verification. */
  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private sign(id: string): string {
    const mac = createHmac('sha256', this.secret).update(id).digest('base64url');
    return `${Buffer.from(id, 'utf8').toString('base64url')}.${mac}`;
  }

  private urlFor(token: string): string {
    return `${this.baseUrl}/cast/relay/${token}`;
  }
}

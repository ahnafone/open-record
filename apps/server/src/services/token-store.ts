import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_TOKEN_LENGTH } from '../config';

/** Name of the file, inside the data directory, that holds the generated token. */
export const TOKEN_FILE_NAME = 'token';

/** Minimal file access, injectable for tests. */
export interface TokenFs {
  /** Returns the file contents, or `undefined` when the file does not exist. */
  read(path: string): string | undefined;
  /** Creates the directory (and parents) if missing. */
  mkdir(path: string): void;
  /** Writes the file with the given permission bits. */
  write(path: string, data: string, mode: number): void;
}

export const nodeTokenFs: TokenFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true });
  },
  write(path, data, mode) {
    writeFileSync(path, data, { mode });
    chmodSync(path, mode);
  },
};

export interface ResolveTokenOptions {
  env: Record<string, string | undefined>;
  dataDir: string;
  fs?: TokenFs;
}

export interface ResolvedToken {
  token: string;
  source: 'env' | 'file' | 'generated';
  /** Path of the token file (absent when the token comes from the environment). */
  path?: string;
}

/**
 * Picks the access token: `OPEN_RECORD_TOKEN` if set, else the token persisted
 * in `<dataDir>/token`, else a freshly generated one that is saved (mode 0600)
 * so it survives restarts.
 */
export function resolveToken({ env, dataDir, fs = nodeTokenFs }: ResolveTokenOptions): ResolvedToken {
  const fromEnv = env['OPEN_RECORD_TOKEN']?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const path = join(dataDir, TOKEN_FILE_NAME);
  const stored = fs.read(path)?.trim();
  if (stored) {
    if (stored.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `token file ${path} is shorter than ${MIN_TOKEN_LENGTH} characters; delete it to generate a new token`,
      );
    }
    return { token: stored, source: 'file', path };
  }

  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdir(dataDir);
    fs.write(path, `${token}\n`, 0o600);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot save the access token to ${path} (${reason}); set OPEN_RECORD_TOKEN to run without it`,
    );
  }
  return { token, source: 'generated', path };
}

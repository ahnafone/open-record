import { resolveToken, TOKEN_FILE_NAME, type TokenFs } from './token-store';

/** In-memory TokenFs that records the permission bits used for writes. */
function memoryFs(): TokenFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    read: (path) => files.get(path),
    mkdir: () => undefined,
    write: (path, data, mode) => {
      files.set(path, data);
      modes.set(path, mode);
    },
  };
}

const DATA = '/data/open-record';
const FILE = `${DATA}/${TOKEN_FILE_NAME}`;

describe('resolveToken', () => {
  it('prefers OPEN_RECORD_TOKEN over the stored file', () => {
    const fs = memoryFs();
    fs.files.set(FILE, 'stored-token-0123456789abcdef\n');
    const resolved = resolveToken({
      env: { OPEN_RECORD_TOKEN: 'env-token-0123456789abcdef' },
      dataDir: DATA,
      fs,
    });
    expect(resolved).toEqual({ token: 'env-token-0123456789abcdef', source: 'env' });
  });

  it('generates, saves with mode 0600, and reuses the same token on restart', () => {
    const fs = memoryFs();
    const first = resolveToken({ env: {}, dataDir: DATA, fs });
    expect(first.source).toBe('generated');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.modes.get(FILE)).toBe(0o600);
    expect(fs.files.get(FILE)?.trim()).toBe(first.token);

    const second = resolveToken({ env: {}, dataDir: DATA, fs });
    expect(second).toEqual({ token: first.token, source: 'file', path: FILE });
  });

  it('explains how to recover when the token cannot be saved', () => {
    const fs = memoryFs();
    fs.write = () => {
      throw new Error('EACCES');
    };
    expect(() => resolveToken({ env: {}, dataDir: DATA, fs })).toThrow(/OPEN_RECORD_TOKEN/);
  });
});

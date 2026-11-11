import { describe, expect, it, vi } from 'vitest';
import type { DesktopConfig } from './config';
import { buildContentSecurityPolicy, GITHUB_API_ORIGIN } from './security';

vi.mock('electron', () => ({ session: {} }));

/** The source list of one CSP directive (for example `connect-src`); empty when absent. */
function directiveSources(csp: string, name: string): string[] {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return directive ? directive.slice(name.length + 1).split(' ') : [];
}

describe('buildContentSecurityPolicy', () => {
  const config = { lanEnabled: false } as DesktopConfig;

  it('allows the renderer to read GitHub releases for the in-app update check', () => {
    const csp = buildContentSecurityPolicy(config, null);
    expect(GITHUB_API_ORIGIN).toBe('https://api.github.com');
    expect(directiveSources(csp, 'connect-src')).toContain('https://api.github.com');
  });
});

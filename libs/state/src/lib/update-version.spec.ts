import { compareVersions, normalizeVersion, parseVersion } from './update-version';

/** Sign of `compareVersions` for two tags; throws if either tag is invalid. */
function cmp(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`invalid test version: ${a} / ${b}`);
  return Math.sign(compareVersions(pa, pb));
}

describe('update versions', () => {
  it('orders core versions and a release above its pre-releases', () => {
    expect(cmp('0.0.5', '0.0.4')).toBe(1);
    expect(cmp('1.0.0', '0.9.9')).toBe(1);
    expect(cmp('0.0.5', '0.0.5-beta.1')).toBe(1);
    expect(cmp('0.0.5-beta.1', '0.0.5')).toBe(-1);
    expect(cmp('0.0.5', '0.0.5')).toBe(0);
  });

  it('orders pre-release identifiers by semver rules', () => {
    expect(cmp('0.0.5-beta.2', '0.0.5-beta.1')).toBe(1);
    expect(cmp('0.0.5-beta.10', '0.0.5-beta.2')).toBe(1);
    expect(cmp('0.0.5-alpha', '0.0.5-beta')).toBe(-1);
    expect(cmp('0.0.5-1', '0.0.5-alpha')).toBe(-1);
    expect(cmp('0.0.5-alpha', '0.0.5-alpha.1')).toBe(-1);
  });

  it('accepts a leading v and ignores build metadata', () => {
    expect(cmp('v0.0.5', '0.0.4')).toBe(1);
    expect(cmp('v0.0.5+build.7', 'v0.0.5')).toBe(0);
    expect(normalizeVersion('v0.0.5-beta.1+build.5')).toBe('0.0.5-beta.1');
  });

  it('ignores invalid tags', () => {
    for (const tag of ['', 'latest', 'nightly', '1.2', '01.2.3', '1.2.3.4', 'v1.2.3-', '1.2.3-01']) {
      expect(parseVersion(tag)).toBeNull();
      expect(normalizeVersion(tag)).toBeNull();
    }
  });
});

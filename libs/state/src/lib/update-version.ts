/**
 * Semver parsing and precedence for update checks. Pure, no Angular. Accepts
 * an optional leading `v` (GitHub tags) and ignores build metadata, which
 * never affects precedence.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifiers (`beta`, `1` for `0.0.5-beta.1`); empty for a release. */
  readonly prerelease: readonly string[];
}

const VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const NUMERIC_RE = /^\d+$/;

/** Parses a tag such as `v0.0.5-beta.1`. Returns null for anything that is not semver. */
export function parseVersion(input: string): SemVer | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Plain semver string without the `v` or build metadata (e.g. `0.0.5-beta.1`); null when invalid. */
export function normalizeVersion(input: string): string | null {
  const parsed = parseVersion(input);
  if (!parsed) return null;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length ? `${base}-${parsed.prerelease.join('.')}` : base;
}

/** Semver precedence: negative when `a` is older, positive when newer, 0 when equal. */
export function compareVersions(a: SemVer, b: SemVer): number {
  const core =
    a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  // A release ranks above any pre-release of the same core version.
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
  }
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A shorter set of identifiers ranks lower when all earlier ones match.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = NUMERIC_RE.test(x);
    const yNum = NUMERIC_RE.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    // Numeric identifiers rank below alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

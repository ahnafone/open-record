#!/usr/bin/env node
// Verifies that every place that states the app version agrees with package.json.
//
// Usage:
//   node scripts/check-version-sync.mjs            # consistency across files
//   node scripts/check-version-sync.mjs --tag v1.2.3  # also require tag == v<package.json version>
//
// Read-only: never edits files. Exits 1 on any mismatch or unreadable source.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = '\\d+\\.\\d+\\.\\d+';

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

/** Returns the first capture group of `pattern` in `relPath`, or throws. */
function extract(relPath, pattern, label) {
  const match = read(relPath).match(pattern);
  if (!match) {
    throw new Error(`${relPath}: could not find ${label}`);
  }
  return match[1];
}

function parseArgs(argv) {
  const index = argv.indexOf('--tag');
  if (index === -1) {
    if (argv.some((arg) => arg.startsWith('--tag='))) {
      return {
        tag: argv
          .find((arg) => arg.startsWith('--tag='))
          .slice('--tag='.length),
      };
    }
    return { tag: null };
  }
  const tag = argv[index + 1];
  if (!tag || tag.startsWith('--')) {
    throw new Error('--tag requires a value, e.g. --tag v0.0.3');
  }
  return { tag };
}

function main() {
  const { tag } = parseArgs(process.argv.slice(2));

  const pkg = JSON.parse(read('package.json'));
  const expected = pkg.version;
  if (!new RegExp(`^${SEMVER}$`).test(expected)) {
    throw new Error(`package.json: version "${expected}" is not x.y.z`);
  }

  const sources = [
    {
      file: 'apps/website/src/lib/site.ts',
      label: 'VERSION',
      // Stored with a leading "v" (e.g. 'v0.0.3').
      value: extract(
        'apps/website/src/lib/site.ts',
        new RegExp(`VERSION\\s*=\\s*'v(${SEMVER})'`),
        "export const VERSION = 'vX.Y.Z'",
      ),
    },
    {
      file: 'README.md',
      label: '"Version x.y.z (beta)" line',
      value: extract(
        'README.md',
        new RegExp(`Version (${SEMVER}) \\(beta\\)`),
        '"Version x.y.z (beta)"',
      ),
    },
    {
      // electron-builder writes this into the packaged app's package.json; it
      // is what app.getVersion() and the auto-updater compare against.
      file: 'apps/desktop/electron-builder.yml',
      label: 'extraMetadata.version',
      value: extract(
        'apps/desktop/electron-builder.yml',
        new RegExp(`^extraMetadata:\\s*\\n(?:[ \\t]+[^\\n]*\\n|\\s*\\n)*?[ \\t]+version:[ \\t]*(${SEMVER})\\b`, 'm'),
        'extraMetadata: version x.y.z',
      ),
    },
    {
      file: 'apps/app/android/app/build.gradle',
      label: 'versionName',
      value: extract(
        'apps/app/android/app/build.gradle',
        new RegExp(`versionName\\s+"(${SEMVER})"`),
        'versionName "x.y.z"',
      ),
    },
    {
      file: 'RELEASE_NOTES.md',
      label: 'top heading "# Open Record vX.Y.Z"',
      value: extract(
        'RELEASE_NOTES.md',
        new RegExp(`^# Open Record v(${SEMVER})\\b`, 'm'),
        '"# Open Record vX.Y.Z" heading',
      ),
    },
  ];

  const problems = [];
  const rows = [['package.json', expected]];

  for (const source of sources) {
    rows.push([`${source.file} (${source.label})`, source.value]);
    if (source.value !== expected) {
      problems.push(`${source.file} has ${source.value}, expected ${expected}`);
    }
  }

  // Android versionCode is a build number, not derivable from the version, so
  // only its presence and form are checked here. Bumping it is a manual step.
  const versionCode = extract(
    'apps/app/android/app/build.gradle',
    /versionCode\s+(\d+)\b/,
    'versionCode <integer>',
  );
  rows.push(['apps/app/android/app/build.gradle (versionCode)', versionCode]);
  if (!/^[1-9]\d*$/.test(versionCode)) {
    problems.push(
      `apps/app/android/app/build.gradle versionCode ${versionCode} is not a positive integer`,
    );
  }

  if (tag !== null) {
    rows.push([`tag ${tag}`, tag.replace(/^v/, '')]);
    if (tag !== `v${expected}`) {
      problems.push(
        `tag ${tag} does not match package.json version v${expected}`,
      );
    }
  }

  for (const [name, value] of rows) {
    console.log(`${name.padEnd(60)} ${value}`);
  }

  if (problems.length > 0) {
    console.error('\nVersion sync check FAILED:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `\nVersion sync check passed (${expected}${tag !== null ? `, tag ${tag}` : ''}).`,
  );
}

try {
  main();
} catch (error) {
  console.error(`Version sync check error: ${error.message}`);
  process.exit(1);
}

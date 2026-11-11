#!/usr/bin/env node
// Verifies an electron-updater feed file (latest.yml / latest-linux.yml) against
// the installers actually built into a release directory.
//
// Usage:
//   node scripts/check-update-metadata.mjs <releaseDir> <feedFile>
//   node scripts/check-update-metadata.mjs dist/apps/desktop/release latest.yml
//
// Fails (exit 1) when the feed file is missing or unreadable, when `path` or
// any `files[].url` is not the exact name of a file in the release directory,
// when a recorded `size` differs from the file, or when a `sha512` is missing or
// malformed, or when the digest does not match the file. Read-only; never edits files.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** base64 of a 64-byte SHA-512 digest, with padding. */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Returns a list of problems; an empty list means the feed is consistent. */
export function checkUpdateMetadata(releaseDir, feedFile) {
  const problems = [];

  if (feedFile.includes('/') || feedFile.includes('\\') || feedFile !== feedFile.trim()) {
    return [`feed name "${feedFile}" must be a plain file name`];
  }

  let names;
  try {
    names = readdirSync(releaseDir);
  } catch (err) {
    return [`cannot read release directory ${releaseDir}: ${err.message}`];
  }

  const feedPath = join(releaseDir, feedFile);
  if (!names.includes(feedFile)) {
    return [`${feedFile} is missing from ${releaseDir}`];
  }

  let doc;
  try {
    doc = parse(readFileSync(feedPath, 'utf8'));
  } catch (err) {
    return [`${feedFile} is not valid YAML: ${err.message}`];
  }
  if (!doc || typeof doc !== 'object') {
    return [`${feedFile} is empty or not a mapping`];
  }

  if (typeof doc.version !== 'string' || doc.version.trim() === '') {
    problems.push('version is missing');
  }

  const entries = [];
  if (typeof doc.path === 'string') {
    entries.push({ label: 'path', url: doc.path, sha512: doc.sha512, size: undefined });
  } else {
    problems.push('path is missing');
  }

  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    problems.push('files is missing or empty');
  } else {
    doc.files.forEach((file, index) => {
      const label = `files[${index}]`;
      if (!file || typeof file !== 'object' || typeof file.url !== 'string') {
        problems.push(`${label}.url is missing`);
        return;
      }
      entries.push({ label: `${label}.url`, url: file.url, sha512: file.sha512, size: file.size });
    });
  }

  for (const entry of entries) {
    const { label, url } = entry;
    if (url.includes('/') || url.includes('\\') || url.trim() === '') {
      problems.push(`${label} "${url}" must be a plain file name`);
      continue;
    }
    if (!names.includes(url)) {
      problems.push(`${label} "${url}" does not match any file in ${releaseDir}`);
      continue;
    }

    if (typeof entry.sha512 !== 'string' || !SHA512_BASE64.test(entry.sha512)) {
      problems.push(`${label} "${url}" has a missing or malformed sha512`);
      continue;
    }

    const filePath = join(releaseDir, url);
    if (entry.size !== undefined) {
      const actual = statSync(filePath).size;
      if (Number(entry.size) !== actual) {
        problems.push(`${label} "${url}" records size ${entry.size} but the file is ${actual} bytes`);
        continue;
      }
    }

    const actualSha512 = createHash('sha512').update(readFileSync(filePath)).digest('base64');
    if (actualSha512 !== entry.sha512) {
      problems.push(`${label} "${url}" sha512 does not match the file (stale feed or changed installer)`);
    }
  }

  return problems;
}

function main(argv) {
  const [releaseDir, feedFile] = argv;
  if (!releaseDir || !feedFile || argv.length !== 2) {
    console.error('Usage: node scripts/check-update-metadata.mjs <releaseDir> <feedFile>');
    return 2;
  }

  const problems = checkUpdateMetadata(releaseDir, feedFile);
  if (problems.length > 0) {
    console.error(`Update metadata check FAILED for ${feedFile}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`Update metadata check passed for ${feedFile} in ${releaseDir}.`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}

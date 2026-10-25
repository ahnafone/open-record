#!/usr/bin/env node
// Regenerates libs/ui/src/styles/tokens.css from the YAML front matter in DESIGN.md.
// Usage: npm run tokens          (write the file)
//        npm run tokens -- --check (exit 1 if tokens.css is out of date)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const designPath = resolve(root, 'DESIGN.md');
const outPath = resolve(root, 'libs/ui/src/styles/tokens.css');

const source = readFileSync(designPath, 'utf8');
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!match) {
  console.error('gen-tokens: DESIGN.md has no YAML front matter');
  process.exit(1);
}
const fm = parse(match[1]);

// Full font stacks from DESIGN.md "Typography" (front matter names only the lead family).
const FONT_STACKS = {
  Georgia: 'Georgia, "Times New Roman", serif',
  'system-ui':
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};
// Motion from DESIGN.md "Elevation & Depth" (not present in the front matter).
const MOTION = {
  'ease-standard': 'cubic-bezier(0.23, 1, 0.32, 1)',
  'duration-fast': '140ms',
  'duration-base': '200ms',
};

const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const fontVar = (family) =>
  family === 'Georgia' ? 'var(--font-display)' : family === 'system-ui' ? 'var(--font-body)' : family;

const lines = [];
const section = (title, entries) => {
  lines.push(`  /* ${title} */`);
  for (const [k, v] of entries) lines.push(`  --${k}: ${v};`);
  lines.push('');
};

section('Colors', Object.entries(fm.colors ?? {}).map(([k, v]) => [`color-${k}`, v]));
section('Font families', [
  ['font-display', FONT_STACKS.Georgia],
  ['font-body', FONT_STACKS['system-ui']],
]);
section(
  'Typography',
  Object.entries(fm.typography ?? {}).flatMap(([name, t]) =>
    Object.entries(t).map(([prop, v]) => [
      `type-${name}-${kebab(prop)}`,
      prop === 'fontFamily' ? fontVar(v) : v,
    ]),
  ),
);
section('Radii', Object.entries(fm.rounded ?? {}).map(([k, v]) => [`rounded-${k}`, v]));
section('Spacing', Object.entries(fm.spacing ?? {}).map(([k, v]) => [`spacing-${k}`, v]));
section('Motion', Object.entries(MOTION));

while (lines.at(-1) === '') lines.pop();
const css = `/*
 * GENERATED FILE - do not edit by hand.
 * Source: DESIGN.md front matter (${fm.name ?? 'Open Record'} ${fm.version ?? ''}).
 * Regenerate: npm run tokens
 */
:root {
${lines.join('\n')}
}
`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    /* missing file counts as stale */
  }
  if (current !== css) {
    console.error('gen-tokens: tokens.css is out of date; run `npm run tokens`');
    process.exit(1);
  }
  console.log('gen-tokens: tokens.css is up to date');
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, css);
  console.log(`gen-tokens: wrote ${outPath}`);
}

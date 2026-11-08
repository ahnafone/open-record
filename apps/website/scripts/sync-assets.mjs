// Copies the app screenshots from docs/screenshots/ into public/screenshots/ as WebP.
// Runs before dev/build/typecheck so the site always uses the repo's current captures.
// The output directory is generated and git-ignored; only the source PNGs are tracked.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(siteRoot, '../../docs/screenshots');
const target = path.join(siteRoot, 'public/screenshots');

// Phone captures are 786x1704; desktop captures are 1280x900. Keep 2x-ready sizes.
const PHONE_WIDTH = 600;
const DESKTOP_WIDTH = 1280;

const SHOTS = [
  '01-browse.png',
  '02-search.png',
  '03-library.png',
  '04-playlist.png',
  '06-now-playing.png',
  '07-desktop.png',
  '08-settings.png',
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const present = new Set(await readdir(source));
const missing = SHOTS.filter((name) => !present.has(name));
if (missing.length > 0) {
  throw new Error(`Missing screenshots in docs/screenshots: ${missing.join(', ')}`);
}

for (const name of SHOTS) {
  const width = name.startsWith('07') ? DESKTOP_WIDTH : PHONE_WIDTH;
  const out = path.join(target, name.replace(/\.png$/, '.webp'));
  const info = await sharp(path.join(source, name))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 84 })
    .toFile(out);
  console.log(`screenshot ${name} -> ${path.relative(siteRoot, out)} (${info.width}x${info.height})`);
}

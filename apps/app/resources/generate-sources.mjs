// Generates the Open Record app icon / splash sources (SVG + PNG) in this folder.
// The art is the top-bar brand mark from mockup/index.html: a grooved vinyl disc
// with a coral centre label and dark spindle hole, on the charcoal room colour.
//
// Usage (from repo root):
//   node apps/app/resources/generate-sources.mjs
//   npm run assets:app   (also runs @capacitor/assets to emit all native sizes)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = dirname(fileURLToPath(import.meta.url));

const C = {
  bg: '#171b20',
  vinyl: '#0b0d10',
  groove: '#1c2229',
  border: '#56616c',
  coral: '#ff8d83',
};

/** Disc centred at (cx, cy) with outer radius r. */
function disc(cx, cy, r) {
  const f = (n) => +(n * r).toFixed(2);
  const grooves = [];
  // Dark groove rings over the lighter grooved band (mirrors the mockup's
  // repeating-radial-gradient, but coarse enough to read at 48px).
  for (let i = 0; i < 7; i++) {
    const rr = 0.47 + i * 0.07;
    grooves.push(
      `<circle cx="${cx}" cy="${cy}" r="${f(rr)}" fill="none" stroke="${C.vinyl}" stroke-width="${f(0.022)}"/>`,
    );
  }
  return [
    // vinyl body with a hairline rim so it separates from the charcoal background
    `<circle cx="${cx}" cy="${cy}" r="${f(1)}" fill="${C.vinyl}" stroke="${C.border}" stroke-opacity="0.75" stroke-width="${f(0.028)}"/>`,
    // grooved band
    `<circle cx="${cx}" cy="${cy}" r="${f(0.92)}" fill="${C.groove}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${f(0.42)}" fill="${C.vinyl}"/>`,
    ...grooves,
    // coral centre label + spindle hole
    `<circle cx="${cx}" cy="${cy}" r="${f(0.34)}" fill="${C.coral}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${f(0.06)}" fill="${C.bg}"/>`,
  ].join('\n  ');
}

function svg(size, r, withBg) {
  const c = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${withBg ? `<rect width="${size}" height="${size}" fill="${C.bg}"/>` : ''}
  ${disc(c, c, r)}
</svg>
`;
}

const outputs = [
  // iOS / master: opaque, disc fills most of the square (iOS masks the corners).
  { name: 'icon-only', size: 1024, r: 400, bg: true },
  // Android adaptive foreground. @capacitor/assets wraps it in a 16.7% inset
  // (mipmap-anydpi-v26/ic_launcher.xml), so this whole canvas already maps to
  // the 66% safe zone; r=400 gives the same proportion as the iOS icon.
  { name: 'icon-foreground', size: 1024, r: 400, bg: false },
  { name: 'icon-background', size: 1024, r: 0, bg: true },
  { name: 'splash', size: 2732, r: 360, bg: true },
  { name: 'splash-dark', size: 2732, r: 360, bg: true },
];

for (const o of outputs) {
  const s =
    o.r > 0
      ? svg(o.size, o.r, o.bg)
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}"><rect width="${o.size}" height="${o.size}" fill="${C.bg}"/></svg>\n`;
  const svgPath = join(dir, 'src', `${o.name}.svg`);
  writeFileSync(svgPath, s);
  let img = sharp(Buffer.from(s));
  // iOS rejects icons with alpha; flatten every opaque asset.
  img = o.bg ? img.flatten({ background: C.bg }).removeAlpha() : img.ensureAlpha();
  await img.png().toFile(join(dir, `${o.name}.png`));
  console.log(`wrote ${o.name}.svg / ${o.name}.png`);
}

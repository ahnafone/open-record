#!/usr/bin/env node
/**
 * Regenerates the committed packaging icons in this directory from
 * apps/app/resources/icon-only.png (1024x1024).
 *
 *   node apps/desktop/build/generate-icons.mjs
 *
 * Requires `sharp`, which is already available through the workspace dev
 * dependencies (@capacitor/assets). The generated files are committed so a
 * normal desktop build/CI does not depend on image tooling; electron-builder
 * picks up buildResources/icon.{icns,ico,png} automatically.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const source = resolve(root, 'apps/app/resources/icon-only.png');

const png = async (size) =>
  sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

// icon.png: the 512px icon referenced by the packaging configuration.
writeFileSync(resolve(here, 'icon.png'), await png(512));
console.log('icons: icon.png (512x512)');

// .ico: PNG-compressed entries (supported since Windows Vista / Electron).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = await Promise.all(icoSizes.map((size) => png(size)));
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // 1 = icon
icoHeader.writeUInt16LE(icoImages.length, 4);
const icoEntries = [];
let icoOffset = 6 + 16 * icoImages.length;
for (let i = 0; i < icoImages.length; i += 1) {
  const size = icoSizes[i];
  const image = icoImages[i];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(icoOffset, 12);
  icoOffset += image.length;
  icoEntries.push(entry, image);
}
writeFileSync(resolve(here, 'icon.ico'), Buffer.concat([icoHeader, ...icoEntries]));
console.log('icons: icon.ico (16-256px)');

// .icns: modern PNG-based elements, enough for Finder, Dock and DMG.
// Element types cover 16..1024px plus their @2x variants.
const icnsSizes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];
const icnsChunks = [];
for (const [type, size] of icnsSizes) {
  const image = await png(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(8 + image.length, 4);
  icnsChunks.push(header, image);
}
const icnsBody = Buffer.concat(icnsChunks);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 4, 'ascii');
icnsHeader.writeUInt32BE(8 + icnsBody.length, 4);
writeFileSync(resolve(here, 'icon.icns'), Buffer.concat([icnsHeader, icnsBody]));
console.log('icons: icon.icns (16-1024px)');

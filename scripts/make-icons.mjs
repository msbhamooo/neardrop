#!/usr/bin/env node
/**
 * Generate PWA icons (PNG) with zero dependencies: zlib + hand-rolled PNG chunks.
 * Design: rounded dark-navy square, cyan radar arcs, white paper-plane glyph.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, pixels /* RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * width);
  for (let y = 0; y < width; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  const cx = S / 2;
  const cy = S / 2;
  const r = S * 0.5;
  const rad = S * 0.09; // corner radius
  const put = (x, y, [R, G, B, A]) => {
    const i = (y * S + x) * 4;
    const a = A / 255;
    px[i] = Math.round(px[i] * (1 - a) + R * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + G * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + B * a);
    px[i + 3] = Math.max(px[i + 3], A);
  };
  const insideRounded = (x, y) => {
    const dx = Math.min(Math.abs(x - cx) - (r - rad), 0);
    const dy = Math.min(Math.abs(y - cy) - (r - rad), 0);
    const ddx = Math.max(Math.abs(x - cx) - (r - rad), 0);
    const ddy = Math.max(Math.abs(y - cy) - (r - rad), 0);
    if (ddx === 0 || ddy === 0) return Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
    return ddx * ddx + ddy * ddy <= rad * rad;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      // background
      if (insideRounded(x, y)) {
        put(x, y, [11, 18, 32, 255]);
      }
      // radar arcs (two concentric, cyan)
      for (const [radius, alpha] of [[S * 0.38, 110], [S * 0.22, 150]]) {
        const d = Math.abs(dist - radius);
        if (d < S * 0.014) put(x, y, [34, 211, 238, alpha]);
      }
      // center glow
      if (dist < S * 0.07) put(x, y, [125, 235, 255, 235]);
      // paper plane glyph: triangle pointing up-right
      const nx = (x - cx) / S;
      const ny = (y - cy) / S;
      const inPlane =
        ny > -0.16 && ny < 0.02 && nx > -0.02 && nx - ny < 0.14 && nx - ny > -0.02 && nx * 0.9 + (0.5 + ny) < 0.55;
      if (inPlane) put(x, y, [244, 250, 255, 255]);
    }
  }
  return px;
}

mkdirSync('apps/web/public/icons', { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(`apps/web/public/icons/icon-${size}.png`, png(size, renderIcon(size)));
  console.log(`wrote icon-${size}.png`);
}

// simple SVG variant for favicon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="46" fill="#0b1220"/>
<circle cx="256" cy="256" r="195" fill="none" stroke="#22d3ee" stroke-width="7" opacity=".45"/>
<circle cx="256" cy="256" r="113" fill="none" stroke="#22d3ee" stroke-width="7" opacity=".6"/>
<circle cx="256" cy="256" r="34" fill="#7debff"/>
<path d="M236 296 L296 216 L262 236 L236 296 Z" fill="#f4faff"/>
</svg>`;
writeFileSync('apps/web/public/icons/icon.svg', svg);
console.log('wrote icon.svg');

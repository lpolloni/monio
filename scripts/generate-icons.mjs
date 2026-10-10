#!/usr/bin/env node
// Renders the Monio mark into the PNG icons used by the PWA manifest.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const out = path.resolve(import.meta.dirname, "../public/icons");
mkdirSync(out, { recursive: true });

function svg(size, { padding = 0.18, background = "#0f1118" } = {}) {
  const inner = size * (1 - padding * 2);
  const scale = inner / 32;
  const offset = size * padding;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#7fe0b8"/><stop offset="55%" stop-color="#6aa8e8"/><stop offset="100%" stop-color="#8b6fe0"/>
  </linearGradient></defs>
  <rect width="${size}" height="${size}" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <circle cx="16" cy="16" r="8.5" fill="url(#g)"/>
    <ellipse cx="16" cy="16" rx="14" ry="6.2" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="1.2" transform="rotate(-28 16 16)"/>
    <circle cx="27.4" cy="10.4" r="2.3" fill="#ffffff"/>
  </g>
</svg>`;
}

const targets = [
  ["icon-192.png", 192, { padding: 0.12 }],
  ["icon-512.png", 512, { padding: 0.12 }],
  ["maskable-512.png", 512, { padding: 0.24 }],
  ["apple-touch-icon.png", 180, { padding: 0.14 }],
  ["favicon-32.png", 32, { padding: 0.02 }],
];
for (const [name, size, opts] of targets) {
  await sharp(Buffer.from(svg(size, opts))).png().toFile(path.join(out, name));
}
writeFileSync(path.join(out, "icon.svg"), svg(64, { padding: 0.04 }));
console.log(`Generated ${targets.length + 1} icons in public/icons`);

#!/usr/bin/env node
// Generates assets/icon.png — a 32x32 dark tile with a green $ sign.
// Uses only Node built-ins (zlib, fs, path). Run once: node scripts/make-icon.js

const zlib = require("zlib");
const fs   = require("fs");
const path = require("path");

const SIZE = 32;

// ── PNG helpers ───────────────────────────────────────────────────────────────

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0);
  const crcBuf = Buffer.concat([t, d]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, t, d, crc]);
}

function buildPNG(rgba) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // color type: RGB (we'll strip alpha for simplicity... actually use 6 = RGBA)
  ihdr[9]  = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data: prepend filter byte 0 to each row
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: None
    for (let x = 0; x < SIZE; x++) {
      const src = (y * SIZE + x) * 4;
      const dst = y * (SIZE * 4 + 1) + 1 + x * 4;
      raw[dst]     = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Draw icon ─────────────────────────────────────────────────────────────────

const rgba = Buffer.alloc(SIZE * SIZE * 4);

// Background: #111827
for (let i = 0; i < SIZE * SIZE; i++) {
  rgba[i * 4]     = 17;
  rgba[i * 4 + 1] = 24;
  rgba[i * 4 + 2] = 39;
  rgba[i * 4 + 3] = 255;
}

function px(x, y, r, g, b) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
}

// Green: #4ade80
const [R, G, B] = [74, 222, 128];

// $ bitmap: 9 wide × 13 tall, top-left at (11, 9)
// Each row: 1 = green pixel
const bitmap = [
  [0,1,1,1,1,1,0,0,0],
  [1,1,0,0,0,1,1,0,0],
  [1,1,0,0,0,0,0,0,0],
  [1,1,0,0,0,0,0,0,0],
  [0,1,1,1,1,1,0,0,0],
  [0,0,0,0,1,1,1,0,0],
  [0,0,0,0,0,1,1,0,0],
  [0,0,0,0,0,1,1,0,0],
  [1,1,0,0,0,1,1,0,0],
  [0,1,1,1,1,1,0,0,0],
];

const ox = 11, oy = 10;
for (let row = 0; row < bitmap.length; row++) {
  for (let col = 0; col < bitmap[row].length; col++) {
    if (bitmap[row][col]) px(ox + col, oy + row, R, G, B);
  }
}

// Vertical stem through $ (x=14, y=7..22)
for (let y = 7; y <= 22; y++) px(14, y, R, G, B);

// ── Write output ──────────────────────────────────────────────────────────────

const outDir  = path.join(__dirname, "..", "assets");
const outFile = path.join(outDir, "icon.png");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
fs.writeFileSync(outFile, buildPNG(rgba));
console.log(`✓ icon written to ${outFile}`);

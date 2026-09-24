// Extension icons: a red disc (the badge colour) on transparent, as PNG, no image library.
// `node scripts/make-icons.mjs` writes src/icons/icon-{16,32,48,128}.png. Commit the PNGs.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const RED = [0xd9, 0x30, 0x25];
const SIZES = [16, 32, 48, 128];

const table = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([be32(data.length), t, data, be32(crc32(Buffer.concat([t, data])))]);
};

function png(size) {
  const rows = [];
  const c = size / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      row.set([...RED, Math.round(a * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.concat([be32(size), be32(size), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('src/icons', { recursive: true });
for (const s of SIZES) writeFileSync(`src/icons/icon-${s}.png`, png(s));
console.log('wrote', SIZES.map((s) => `src/icons/icon-${s}.png`).join(' '));

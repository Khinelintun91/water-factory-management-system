// gen-icons.mjs — generates the PWA / touch icons at build time.
//
// Why: the repo's push channel accepts text files only, so the PNG icons
// are produced from this script on every build instead of being committed.
// Pure Node (zlib + a minimal PNG encoder); draws the brand mark — a white
// water droplet on deep teal #0F766E — with 4x supersampling for smooth
// edges, matching the hand-drawn DropIcon in the app.
//
// Outputs (into public/, which Vite copies to dist):
//   public/icons/icon-192.png      192x192 rounded square
//   public/icons/icon-512.png      512x512 rounded square
//   public/icons/maskable-512.png  512x512 full-bleed, droplet in safe zone
//   public/apple-touch-icon.png    180x180 full-bleed (iOS masks corners)
//   public/favicon.png             64x64 rounded square

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEAL = [15, 118, 110]
const WHITE = [255, 255, 255]

// --- minimal PNG encoder (RGBA, no filtering tricks) ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- shape tests (in unit space 0..1) ---
function inRoundedSquare(x, y, r) {
  const qx = Math.min(Math.max(x, r), 1 - r)
  const qy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - qx
  const dy = y - qy
  return dx * dx + dy * dy <= r * r
}
function inDroplet(x, y, scale) {
  // Teardrop in scaled space around (0.5, 0.55): round bottom, tapered tip.
  const u = (x - 0.5) / scale
  const v = (y - 0.55) / scale
  const r = 0.21
  if (v >= 0.01) {
    const dy = v - 0.03
    return u * u + dy * dy <= r * r
  }
  const tipV = -0.31
  if (v >= tipV) {
    const t = (v - tipV) / (0.01 - tipV) // 0 at the tip, 1 at the join
    const halfW = r * Math.pow(t, 0.7)
    return Math.abs(u) <= halfW
  }
  return false
}

function render(size, { rounded = true, dropletScale = 1 } = {}) {
  const SS = 4
  const big = size * SS
  const out = Buffer.alloc(size * size * 4)
  const radius = 0.22
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tealHits = 0
      let dropHits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) / big
          const y = (py * SS + sy + 0.5) / big
          const inBg = rounded ? inRoundedSquare(x, y, radius) : x >= 0 && x <= 1 && y >= 0 && y <= 1
          if (inBg) tealHits++
          if (inBg && inDroplet(x, y, dropletScale)) dropHits++
        }
      }
      const total = SS * SS
      const i = (py * size + px) * 4
      if (dropHits > 0) {
        const a = dropHits / total
        out[i] = Math.round(WHITE[0] * a + TEAL[0] * (1 - a))
        out[i + 1] = Math.round(WHITE[1] * a + TEAL[1] * (1 - a))
        out[i + 2] = Math.round(WHITE[2] * a + TEAL[2] * (1 - a))
        out[i + 3] = 255
      } else if (tealHits > 0) {
        out[i] = TEAL[0]
        out[i + 1] = TEAL[1]
        out[i + 2] = TEAL[2]
        out[i + 3] = Math.round(255 * (tealHits / total))
      } else {
        out[i + 3] = 0
      }
    }
  }
  return encodePng(size, size, out)
}

const targets = [
  ['public/icons/icon-192.png', render(192)],
  ['public/icons/icon-512.png', render(512)],
  ['public/icons/maskable-512.png', render(512, { rounded: false, dropletScale: 0.8 })],
  ['public/apple-touch-icon.png', render(180, { rounded: false })],
  ['public/favicon.png', render(64)],
]
for (const [rel, buf] of targets) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, buf)
  console.log('icon:', rel, buf.length, 'bytes')
}

#!/usr/bin/env node
'use strict'

// 生成托盘图标 app/icon.png。
//
// 为什么要自己画：Electron 的 Tray 必须有图标，空图标在 Windows 上是隐形的
// （托盘里点不到、也看不见）。又不想为一个 16x16 的方块引入图片依赖，
// 所以直接用 zlib 手搓一个 PNG —— 一次性生成，之后就是普通文件。
//
// 画的是一个圆角方块 + 中间一条竖线，配色跟看板「运行中」的蓝一致。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 32

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

// RGBA 像素
const px = Buffer.alloc(SIZE * SIZE * 4, 0)
const BLUE = [0x15, 0x65, 0xC0]
const WHITE = [0xFF, 0xFF, 0xFF]

function set(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a
}

// 圆角方块底
const R = 6
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const inset = 2
    const x0 = inset, y0 = inset, x1 = SIZE - 1 - inset, y1 = SIZE - 1 - inset
    if (x < x0 || x > x1 || y < y0 || y > y1) continue
    // 四角做圆角
    const cx = (x < x0 + R) ? x0 + R : (x > x1 - R ? x1 - R : x)
    const cy = (y < y0 + R) ? y0 + R : (y > y1 - R ? y1 - R : y)
    const d = Math.hypot(x - cx, y - cy)
    if (d > R) continue
    set(x, y, BLUE, 255)
  }
}

// 中间三条横杠，象征"会话列表"
for (const row of [11, 16, 21]) {
  for (let x = 9; x <= 22; x++) {
    set(x, row, WHITE, 255)
    set(x, row + 1, WHITE, 255)
  }
}

// PNG 每行前面要一个 filter 字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8            // bit depth
ihdr[9] = 6            // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, 'icon.png')
fs.writeFileSync(out, png)
console.log('wrote ' + out + '  ' + png.length + ' bytes  ' + SIZE + 'x' + SIZE)

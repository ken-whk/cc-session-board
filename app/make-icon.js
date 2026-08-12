#!/usr/bin/env node
'use strict'

// 生成应用图标：app/icon.png（托盘用，32x32）+ app/icon.ico（Windows 打包用，多尺寸）。
//
// 为什么要自己画：Electron 的 Tray 必须有图标，空图标在 Windows 上是隐形的
// （托盘里点不到、也看不见）。又不想为一个方块引入图片依赖，
// 所以直接用 zlib 手搓 PNG，再手搓一层 ICO 容器 —— 一次性生成，之后就是普通文件。
//
// 为什么必须有 .ico：electron-packager 在 win32 上只认 .ico，给它 .png 会打印
// 「Could not find icon "app\icon.ico", not updating app icon」然后**继续打包**，
// 产物默默用 Electron 默认图标。警告很容易被忽略，分发出去才发现不像自家应用。
//
// 画的是一个圆角方块 + 三条横杠（象征会话列表），配色取看板「运行中」的蓝。
//
//   node app/make-icon.js

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ICO 里放这几档。16/32 是任务栏与文件列表，256 是大图标视图；
// 少了 256 在"超大图标"下会被拉伸得很糊。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const TRAY_SIZE = 32

const BLUE = [0x15, 0x65, 0xC0]
const WHITE = [0xFF, 0xFF, 0xFF]

// 采样倍率：每个像素取 SS×SS 个子样本算覆盖率，得到抗锯齿的圆角。
// 原版没有这一步，32x32 时看不出来，放到 256 就是明显的锯齿楼梯。
const SS = 4

/**
 * 画一枚图标。
 *
 * 所有几何量都按 size 比例算 —— 原版把 inset / 圆角半径 / 横杠位置写成了
 * 32 像素下的绝对值，换尺寸就全错位。
 *
 * @param {number} size 边长（像素）
 * @returns {Buffer} RGBA 像素，长度 size*size*4
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4, 0)

  const inset = size * 2 / 32
  const r = size * 6 / 32
  const x0 = inset, y0 = inset, x1 = size - 1 - inset, y1 = size - 1 - inset

  // 圆角矩形的覆盖率：点在内缩矩形内、且到最近圆心的距离 <= r
  const inside = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    const cx = (x < x0 + r) ? x0 + r : (x > x1 - r ? x1 - r : x)
    const cy = (y < y0 + r) ? y0 + r : (y > y1 - r ? y1 - r : y)
    return Math.hypot(x - cx, y - cy) <= r
  }

  // 三条横杠：位置和粗细同样按比例
  const barX0 = size * 9 / 32, barX1 = size * 22 / 32
  const barH = Math.max(1, Math.round(size * 2 / 32))
  const barRows = [11, 16, 21].map((v) => size * v / 32)
  const onBar = (x, y) => {
    if (x < barX0 || x > barX1) return false
    for (const row of barRows) if (y >= row && y < row + barH) return true
    return false
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0
      let barCover = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS
          const fy = y + (sy + 0.5) / SS
          if (inside(fx, fy)) {
            cover++
            if (onBar(fx, fy)) barCover++
          }
        }
      }
      if (cover === 0) continue
      const total = SS * SS
      const a = Math.round(255 * cover / total)
      // 杠的覆盖率决定蓝白混合，边缘因此也是平滑的
      const t = barCover / cover
      const i = (y * size + x) * 4
      px[i] = Math.round(BLUE[0] * (1 - t) + WHITE[0] * t)
      px[i + 1] = Math.round(BLUE[1] * (1 - t) + WHITE[1] * t)
      px[i + 2] = Math.round(BLUE[2] * (1 - t) + WHITE[2] * t)
      px[i + 3] = a
    }
  }
  return px
}

// ---- PNG 编码 ----

const CRC_TABLE = (() => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
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

function encodePng(size, px) {
  // PNG 每行前面要一个 filter 字节（0 = None）
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    px.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8            // bit depth
  ihdr[9] = 6            // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO 容器 ----
//
// 结构：ICONDIR(6) + N × ICONDIRENTRY(16) + N 段图像数据。
// 图像数据这里直接放 PNG（Vista 起支持 PNG 压缩的 ICO 条目），
// 省掉 BMP + AND 掩码那套老格式的对齐规则。
function encodeIco(images) {
  const count = images.length
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)      // reserved
  dir.writeUInt16LE(1, 2)      // type: 1 = icon
  dir.writeUInt16LE(count, 4)

  const entries = []
  let offset = 6 + count * 16
  for (const img of images) {
    const e = Buffer.alloc(16)
    // 256 在这里写 0 —— 这两个字段各只有 1 字节，装不下 256
    e[0] = img.size >= 256 ? 0 : img.size
    e[1] = img.size >= 256 ? 0 : img.size
    e[2] = 0                   // 调色板颜色数（真彩为 0）
    e[3] = 0                   // reserved
    e.writeUInt16LE(1, 4)      // color planes
    e.writeUInt16LE(32, 6)     // bits per pixel
    e.writeUInt32LE(img.data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += img.data.length
  }

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)])
}

// ---- ICNS 容器（macOS）----
//
// 结构：'icns' + 文件总长(BE) + 若干 [类型(4) + 段长(BE，含这 8 字节头) + 数据]。
// 段数据同样直接放 PNG（macOS 10.7 起支持）。
// 类型码就是尺寸的约定名，写错了 Finder 会整枚图标不显示：
//   icp4=16 icp5=32 icp6=64 ic07=128 ic08=256 ic09=512
//   ic11=32(16@2x) ic12=64(32@2x) ic13=256(128@2x) ic14=512(256@2x)
// 后四个是 Retina 变体，尺寸与前面重复，直接复用同一份数据。
const ICNS_MAP = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
]

function encodeIcns(pngBySize) {
  const parts = []
  for (const [type, size] of ICNS_MAP) {
    const data = pngBySize.get(size)
    if (!data) continue
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    parts.push(head, data)
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ---- 输出 ----

const outPng = path.join(__dirname, 'icon.png')
fs.writeFileSync(outPng, encodePng(TRAY_SIZE, render(TRAY_SIZE)))
console.log('wrote ' + outPng + '  ' + fs.statSync(outPng).size + ' bytes  ' + TRAY_SIZE + 'x' + TRAY_SIZE)

// 两个容器要的尺寸取并集，各尺寸只渲染一次
const ALL_SIZES = [...new Set([...ICO_SIZES, ...ICNS_MAP.map(([, s]) => s)])].sort((a, b) => a - b)
const pngBySize = new Map(ALL_SIZES.map((size) => [size, encodePng(size, render(size))]))

const outIco = path.join(__dirname, 'icon.ico')
fs.writeFileSync(outIco, encodeIco(ICO_SIZES.map((size) => ({ size, data: pngBySize.get(size) }))))
console.log('wrote ' + outIco + '  ' + fs.statSync(outIco).size + ' bytes  sizes: ' + ICO_SIZES.join('/'))

const outIcns = path.join(__dirname, 'icon.icns')
fs.writeFileSync(outIcns, encodeIcns(pngBySize))
console.log('wrote ' + outIcns + '  ' + fs.statSync(outIcns).size + ' bytes  types: '
  + ICNS_MAP.map(([t, s]) => t + '(' + s + ')').join(' '))

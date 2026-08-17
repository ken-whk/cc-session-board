#!/usr/bin/env node
'use strict'

// 生成应用图标：app/icon.png（托盘用，32x32）+ app/icon.ico（Windows）+ app/icon.icns（macOS）。
// 素材是 app/icon-source.jpg —— 一头小牛坐在工位上对着笔记本（牛马）。
//
//   npm run icon
//
// ★ 必须用 electron 跑，不能用 node。
//   这个脚本要解 JPEG、要做高质量缩放，纯 node 两样都没有；Electron 的
//   nativeImage 两样都有，而它本来就是本项目的依赖，不必为此再装图形库。
//   直接 `node app/make-icon.js` 会在 require('electron') 那行拿到一个字符串路径
//   而不是模块，报错很难懂，所以开头显式挡一下。
//
// ★ 为什么必须有 .ico：electron-packager 在 win32 上只认 .ico，给它 .png 会打印
//   「Could not find icon "app\icon.ico", not updating app icon」然后**继续打包**，
//   产物默默用 Electron 默认图标。警告很容易被忽略，分发出去才发现不像自家应用。
//
// ★ 分档裁切（这个脚本最不显然的地方）：
//   图标是一组固定尺寸的位图，32x32 一共就 1024 个像素 —— 把整张工位照片缩进去
//   只会得到一团糊（实测过，认不出有牛）。所以**小尺寸裁紧、大尺寸放全景**：
//   像素预算少的时候只留主体，预算够了再把场景交代完整。这是图标的常规做法，
//   不是偷懒。右下角的水印在所有档位都被裁掉。
//
// 上一版是纯解析式绘制的牛头剪影（椭圆 / 圆弧 / 胶囊的并集，不依赖任何素材），
// 想找回去看 git 历史。

const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

let nativeImage, app
try {
  ({ nativeImage, app } = require('electron'))
  if (!nativeImage) throw new Error('no nativeImage')
} catch (_) {
  console.error('这个脚本必须用 electron 跑：npm run icon')
  console.error('（纯 node 没有 JPEG 解码，也没有高质量缩放）')
  process.exit(1)
}

const SRC = path.join(__dirname, 'icon-source.jpg')

// ICO 里放这几档。16/32 是任务栏与文件列表，256 是大图标视图；
// 少了 256 在"超大图标"下会被拉伸得很糊。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const TRAY_SIZE = 32

// 分档裁切表。原图 960x960；右下角的水印在 y>880 / x>700 一带，
// 三档的取景框都避开了它。
//
// 改这里就能调松紧：width 越小 = 裁得越紧 = 该档主体越大越清楚。
const TIERS = [
  { max: 24, box: { x: 250, y: 320, width: 350, height: 350 } },   // 只要牛头
  { max: 48, box: { x: 180, y: 265, width: 560, height: 560 } },   // 牛 + 电脑
  { max: 9999, box: { x: 0, y: 0, width: 872, height: 872 } },     // 全景
]
const boxFor = (size) => TIERS.find((t) => size <= t.max).box

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

// ---- 预览对照图（--preview）----
//
// 把各档按整数倍最近邻放大并排。**改裁切表之前必须先看它** ——
// 只看大图会让你把一个 16px 下糊成一坨的取景当成好设计，
// 而 16/32 才是任务栏和托盘里天天出现的那两档。
const CRC = (() => {
  const t = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0 }
  return t
})()
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii'); const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, c])
}
function encodePng(w, h, rgba) {
  const stride = w * 4 + 1
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4) }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 圆角 ----
//
// 为什么必须做：macOS 的 Dock 里所有图标都是圆角方形，icns **不会**替你切角，
// 直角照片摆进去一眼不合群；Windows 虽不强制，但一块直角照片在任务栏里
// 像贴了张图、不像应用图标。
//
// 半径取 18%：比 macOS 那个 squircle（约 22%）保守一点 —— 照片是有内容的，
// 切太狠会啃掉牛耳朵和咖啡杯。
//
// 边缘用 SS×SS 超采样求覆盖率再乘进 alpha，否则小尺寸下圆角是锯齿楼梯。
const CORNER = 0.18
const SS = 4

function roundCorners(img, size) {
  const bmp = img.toBitmap()          // BGRA
  const out = Buffer.alloc(size * size * 4)
  const r = size * CORNER
  const cover = (x, y) => {
    // 落在四个角的圆心之外才需要判距离，其余一律全覆盖
    const cx = x < r ? r : (x > size - r ? size - r : x)
    const cy = y < r ? r : (y > size - r ? size - r : y)
    if (cx === x && cy === y) return true
    return Math.hypot(x - cx, y - cy) <= r
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (cover(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++
        }
      }
      const i = (y * size + x) * 4
      out[i] = bmp[i + 2]; out[i + 1] = bmp[i + 1]; out[i + 2] = bmp[i]
      out[i + 3] = Math.round(bmp[i + 3] * hit / (SS * SS))
    }
  }
  return out
}

function writePreview(rgbaBySize) {
  const SHOW = [16, 24, 32, 48, 64]
  const CELL = 150, GAP = 10
  const W = SHOW.length * CELL + (SHOW.length + 1) * GAP, H = CELL + GAP * 2
  const out = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) { out[i * 4] = 0x3a; out[i * 4 + 1] = 0x3a; out[i * 4 + 2] = 0x3a; out[i * 4 + 3] = 255 }
  SHOW.forEach((s, ci) => {
    const rgba = rgbaBySize.get(s)                 // 已切圆角，带 alpha
    const k = Math.floor(CELL / s), draw = k * s
    const ox = GAP + ci * (CELL + GAP) + Math.floor((CELL - draw) / 2)
    const oy = GAP + Math.floor((CELL - draw) / 2)
    for (let y = 0; y < draw; y++) {
      for (let x = 0; x < draw; x++) {
        const si = (Math.floor(y / k) * s + Math.floor(x / k)) * 4
        const di = ((oy + y) * W + ox + x) * 4
        // 按 alpha 压在灰底上 —— 不这么做圆角在预览里看不出来
        const a = rgba[si + 3] / 255
        out[di] = Math.round(rgba[si] * a + 0x3a * (1 - a))
        out[di + 1] = Math.round(rgba[si + 1] * a + 0x3a * (1 - a))
        out[di + 2] = Math.round(rgba[si + 2] * a + 0x3a * (1 - a))
        out[di + 3] = 255
      }
    }
  })
  const p = path.join(require('os').tmpdir(), 'board-icon-preview.png')
  fs.writeFileSync(p, encodePng(W, H, out))
  console.log('preview (16/24/32/48/64 放大对照): ' + p)
}

// ---- 输出 ----

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const src = nativeImage.createFromPath(SRC)
  const { width, height } = src.getSize()
  if (!width) {
    console.error('读不到素材：' + SRC)
    app.exit(1)
    return
  }
  console.log('source: ' + path.basename(SRC) + '  ' + width + 'x' + height)

  // 两个容器要的尺寸取并集，各尺寸只裁缩一次
  const ALL = [...new Set([...ICO_SIZES, ...ICNS_MAP.map(([, s]) => s)])].sort((a, b) => a - b)
  const imgBySize = new Map()
  for (const size of ALL) {
    // quality:'best' = Lanczos。缩放是图标的本质要求（32x32 只有 1024 个像素），
    // 能做的是别再额外损失：无损 PNG、不二次压 JPEG、按档裁紧。
    imgBySize.set(size, src.crop(boxFor(size)).resize({ width: size, height: size, quality: 'best' }))
  }
  // 切圆角后自己编码 PNG —— 不能再走 nativeImage.toPNG()，
  // 那条路出来的是原样矩形，alpha 通道里没有圆角。
  const rgbaBySize = new Map([...imgBySize].map(([s, im]) => [s, roundCorners(im, s)]))
  const pngBySize = new Map([...rgbaBySize].map(([s, rgba]) => [s, encodePng(s, s, rgba)]))

  const outPng = path.join(__dirname, 'icon.png')
  fs.writeFileSync(outPng, pngBySize.get(TRAY_SIZE))
  console.log('wrote ' + outPng + '  ' + fs.statSync(outPng).size + ' bytes  ' + TRAY_SIZE + 'x' + TRAY_SIZE)

  // 界面左上角那枚 20px 的应用图标，单独出一张 40px（2x，高分屏下才不糊）。
  // 为什么不直接用 icon.png：它是 32 档、取的是"牛 + 电脑"那一版，
  // 缩到 20px 只剩一小块看不清的色块。这里强制用最紧的那一档（头部特写）。
  const uiPx = 40
  const uiImg = src.crop(TIERS[0].box).resize({ width: uiPx, height: uiPx, quality: 'best' })
  const outUi = path.join(__dirname, 'icon-ui.png')
  fs.writeFileSync(outUi, encodePng(uiPx, uiPx, roundCorners(uiImg, uiPx)))
  console.log('wrote ' + outUi + '  ' + fs.statSync(outUi).size + ' bytes  ' + uiPx + 'x' + uiPx + ' (界面用 2x)')

  // 系统通知 / 窗口（Alt-Tab）用的大图：256。
  // Why 不能沿用 icon.png：那是 32 的托盘图，而 Windows 通知里的应用图标要显示到
  // 48~96px，32 拉大必糊（实测反馈"通知里的图片不清晰"就是这个）。
  // Why 取"牛 + 电脑"那一档而不是全景：通知里实际也就 48px 上下，
  // 整个工位场景在那个尺寸下太碎。
  const bigPx = 256
  const bigImg = src.crop(TIERS[1].box).resize({ width: bigPx, height: bigPx, quality: 'best' })
  const outBig = path.join(__dirname, 'icon-large.png')
  fs.writeFileSync(outBig, encodePng(bigPx, bigPx, roundCorners(bigImg, bigPx)))
  console.log('wrote ' + outBig + '  ' + fs.statSync(outBig).size + ' bytes  ' + bigPx + 'x' + bigPx + ' (通知/窗口用)')

  const outIco = path.join(__dirname, 'icon.ico')
  fs.writeFileSync(outIco, encodeIco(ICO_SIZES.map((size) => ({ size, data: pngBySize.get(size) }))))
  console.log('wrote ' + outIco + '  ' + fs.statSync(outIco).size + ' bytes  sizes: ' + ICO_SIZES.join('/'))

  const outIcns = path.join(__dirname, 'icon.icns')
  fs.writeFileSync(outIcns, encodeIcns(pngBySize))
  console.log('wrote ' + outIcns + '  ' + fs.statSync(outIcns).size + ' bytes  types: '
    + ICNS_MAP.map(([t, s]) => t + '(' + s + ')').join(' '))

  if (process.argv.includes("--preview")) writePreview(rgbaBySize)
  app.quit()
})

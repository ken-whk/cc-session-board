#!/usr/bin/env node
'use strict'

// 打包收尾：把分发说明放到产物**顶层**，与可执行文件平级。
//
// 为什么需要这一步：electron-packager 只负责把应用塞进 resources/app，
// 那个位置对收到压缩包的人是不可见的（谁会去翻 resources/app）。
// 而 macOS 那四条命令（tar -xzf / chmod +x / xattr）缺一不可、
// 又完全无法从界面上发现，所以说明书必须落在解压出来就能看到的地方。
//
// 幂等，可反复跑；dist 下每个产物目录都放一份。
//
//   node postpack.js

const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')
const SRC = path.join(ROOT, 'README-分发.md')

// 分发副本用 .txt：收到包的人双击就能打开。
// .md 在没装编辑器的机器上会弹「选择打开方式」，多一道摩擦。
// 源文件本身刻意写成"不依赖 markdown 渲染也读得顺"的纯文本排版。
const DEST_NAME = '使用说明.txt'

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('postpack: 找不到 ' + SRC + '，跳过')
    process.exitCode = 1
    return
  }
  let dirs = []
  try {
    dirs = fs.readdirSync(DIST, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(DIST, d.name))
  } catch (_) {
    console.error('postpack: 还没有 dist/，跳过')
    return
  }
  if (dirs.length === 0) {
    console.error('postpack: dist/ 下没有产物目录，跳过')
    return
  }
  // 加 BOM：Win10 1903 之后的记事本能认无 BOM 的 UTF-8，但更早的系统
  // 和一些老工具会按 ANSI 解码 -> 整篇中文乱码。分发件不该留这种风险，
  // 而 BOM 对 VS Code / 记事本 / Mac 的文本编辑都无副作用。
  const text = '﻿' + fs.readFileSync(SRC, 'utf8')
  for (const dir of dirs) {
    // 显式按 utf8 写而不是 copyFileSync：无论平台默认编码是什么，落盘都是 UTF-8
    fs.writeFileSync(path.join(dir, DEST_NAME), text, 'utf8')
    console.log('postpack: 已放入 ' + path.join(path.basename(dir), DEST_NAME))
  }
}

main()

#!/usr/bin/env node
'use strict'

// 把会话看板的四个 hook 注册进用户级 ~/.claude/settings.json。
// 幂等：已注册过就先摘旧的再写新的，可反复运行（升级/改状态映射后重跑即可）。
// 写入前自动备份，出问题可以直接拿备份覆盖回去。
//
// 既是 CLI 也是模块 —— Electron 版首次运行要复用同一套注册逻辑，
// 两处各写一份必然随时间漂移，所以这里只留一个定义。
//
// 用法：
//   node install-hooks.js            安装
//   node install-hooks.js --remove   卸载（只摘掉本看板的 hook，不动其他）

const fs = require('fs')
const os = require('os')
const path = require('path')

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')

// 事件 -> 传给 hook.js 的状态实参。
const MAP = {
  UserPromptSubmit: 'running',
  Stop: 'done',
  Notification: 'waiting',
  SessionEnd: 'closed',
}

// 用这个标记识别"哪些 hook 条目是本看板装的"，卸载时精确摘除，
// 不误伤 sdlc 插件或其他来源的 hook。
// 注意：注册进去的 hook.js 路径必须真的包含这段，否则幂等和卸载一起失效 ——
// 这也是 hook.js 必须落在 ~/.claude/session-board/ 而非应用包内部的原因之一。
const TAG = 'session-board/hook.js'

/**
 * 读写 ~/.claude/settings.json，注册或摘除本看板的 hook。
 *
 * @param {object} opts
 * @param {string} opts.hookJs  hook.js 的绝对路径（本函数内部统一转成正斜杠）
 * @param {boolean} [opts.remove=false]  true = 只摘除不注册
 * @param {function} [opts.log]  进度回调，缺省静默（Electron 里不该往 stdout 打）
 * @returns {{changed:number, backup:string|null, settingsPath:string}}
 *          changed = 增删的条目数；0 表示配置原本就是目标状态
 * @throws  仅在最终写盘失败时抛出；settings.json 缺失/损坏都按空配置兜住
 */
function applyHooks(opts) {
  const hookJs = String(opts.hookJs).replace(/\\/g, '/')
  const remove = !!opts.remove
  const log = opts.log || function () { }

  // settings.json 可能根本不存在（全新装的 Claude Code 就没有），
  // 也可能内容损坏。直接 readFileSync 会 ENOENT 抛出把安装整个搞挂 ——
  // 这种情况按空配置起步，而不是让同事看到一屏 stack trace。
  let raw = ''
  let settings = {}
  try {
    raw = fs.readFileSync(SETTINGS, 'utf8')
    settings = JSON.parse(raw)
  } catch (e) {
    if (e.code === 'ENOENT') {
      log('settings.json 不存在，将新建')
      fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
    } else {
      log('settings.json 解析失败（' + e.message + '），将按空配置重建；原文件已备份')
    }
    settings = {}
  }
  // JSON 合法但不是对象（比如文件里是 null 或数组）也要兜住
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {}

  // 只在原文件确实存在时才备份 —— 没有原文件就没什么可备份的
  let backup = null
  const backupPath = SETTINGS + '.bak-session-board'
  if (raw && !fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, raw, 'utf8')
    backup = backupPath
    log('备份已写入: ' + backupPath)
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  let changed = 0

  for (const event of Object.keys(MAP)) {
    const status = MAP[event]
    const command = 'node "' + hookJs + '" ' + status
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const groups = settings.hooks[event]

    // 先摘掉本看板的旧条目（幂等的关键：不累积重复注册）。
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue
      const before = g.hooks.length
      g.hooks = g.hooks.filter(function (h) {
        return !(h && typeof h.command === 'string' && h.command.indexOf(TAG) !== -1)
      })
      if (g.hooks.length !== before) changed++
    }
    // 清掉因摘除而变空的分组，避免留下空壳。
    settings.hooks[event] = groups.filter(function (g) {
      return g && Array.isArray(g.hooks) && g.hooks.length > 0
    })

    if (!remove) {
      settings.hooks[event].push({ hooks: [{ type: 'command', command: command }] })
      changed++
      log(event + ' -> ' + status)
    }

    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return { changed: changed, backup: backup, settingsPath: SETTINGS }
}

/**
 * 判断 settings.json 里本看板的四个 hook 是否都已指向给定路径。
 * 用于首次运行时决定"要不要动配置"——已经对了就别每次启动都重写文件。
 *
 * @param {string} hookJs hook.js 的绝对路径
 * @returns {string[]} 尚未正确注册的状态名，空数组 = 全部就绪
 */
function findUnregistered(hookJs) {
  const want = String(hookJs).replace(/\\/g, '/')
  const all = Object.keys(MAP).map(function (k) { return MAP[k] })
  let sj = ''
  try {
    sj = fs.readFileSync(SETTINGS, 'utf8')
  } catch (_) {
    return all   // settings.json 不存在或读不了，按全部未装处理
  }
  return all.filter(function (s) {
    // JSON 里的引号是转义过的，所以比对时也要按转义形态拼
    return sj.indexOf('node \\"' + want + '\\" ' + s) === -1
  })
}

module.exports = { applyHooks: applyHooks, findUnregistered: findUnregistered, MAP: MAP, TAG: TAG, SETTINGS: SETTINGS }

// ---- 直接运行时作 CLI ----
if (require.main === module) {
  const remove = process.argv.indexOf('--remove') !== -1
  // CLI 场景注册的是**本脚本旁边**的 hook.js。
  // 源码目录 = ~/.claude/session-board，与 board-core 的 INSTALL_DIR 一致。
  const hookJs = path.join(__dirname, 'hook.js')
  const res = applyHooks({ hookJs: hookJs, remove: remove, log: console.log })
  console.log((remove ? '已卸载' : '已安装') + '，改动条目数=' + res.changed)
  console.log('提示：hook 只在新会话生效，已开的会话不会追溯。')
}

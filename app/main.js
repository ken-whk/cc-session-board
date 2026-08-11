'use strict'

// Claude 会话看板 —— Electron 主进程（Windows / macOS 共用）
//
// 职责：开窗口、定时向渲染层推数据、托盘图标、系统通知、设置持久化。
// 所有判定逻辑都在 board-core.js 里，本文件不做业务判断。

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, clipboard, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

const core = require('../board-core.js')
const firstRun = require('./first-run.js')
const hudGuide = require('./hud-guide.js')

// 落在 INSTALL_DIR（home 下）而不是应用包内 —— 包内在 macOS/Program Files 下只读，
// 写设置会静默失败，表现为"每次开都忘记窗口位置和勾选项"。
const SETTINGS_FILE = path.join(core.INSTALL_DIR, 'ui-electron.json')
const ICON = path.join(__dirname, 'icon.png')
const REFRESH_MS = 1500

let win = null
let tray = null
let timer = null
let firstRender = true
const prevStatus = new Map()

// 折叠条数。设置菜单在主进程按需构建，而计数只在 tick 里算得出来，
// 所以留一个最近值给菜单标签用。
let lastFolded = 0

// 默认设置。sort: 0 需求度 / 1 启动顺序 / 2 最近活动 / 3 项目名
let settings = {
  x: null, y: null, w: 1080, h: 620,
  alwaysOnTop: false, sound: true, notify: true,
  showFolded: false, sort: 0, autoLaunch: false,
  // 排序改成点表头之后，sort 这个旧键不再使用（留着不删，免得回退版本时丢配置）。
  // sortCol 为空串 = 默认排法（启动顺序）；colWidths 是 {列key: px}。
  sortCol: '', sortDir: 'asc', colWidths: {},
  // auto = 跟随系统（Windows/macOS 都能读到）；light / dark = 手动锁定
  theme: 'auto',
  // 用量引导只在首次运行自动弹一次；之后靠设置菜单里的入口按需打开，
  // 免得每次启动都被同一个提示拦一下。
  hudGuideShown: false,
}

function loadSettings() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    settings = Object.assign(settings, o)
  } catch (_) { /* 首次运行没有配置文件，用默认值 */ }
}

function saveSettings() {
  try {
    if (win && !win.isDestroyed() && !win.isMinimized()) {
      const b = win.getBounds()
      settings.x = b.x; settings.y = b.y; settings.w = b.width; settings.h = b.height
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
  } catch (_) { }
}

// 标题栏配色。系统那条标题栏只能跟随系统深浅、颜色不可指定，
// 所以改用 titleBarOverlay：边框交给系统（最小化/最大化/关闭还是原生的），
// 底色和按钮符号色由我们给，页面自己在那块区域画标题和工具条。
function overlayColors() {
  return resolvedTheme() === 'dark'
    ? { color: '#23272b', symbolColor: '#e6e6e6' }
    : { color: '#f7f7f7', symbolColor: '#222222' }
}

const TITLEBAR_H = 34

// 只在 Windows / macOS 用自绘标题栏。Linux 下 titleBarOverlay 不支持，
// 硬开会得到"没有标题栏也没有窗口按钮"的窗口 —— 拖不动也关不掉。
const USE_OVERLAY = process.platform === 'win32' || process.platform === 'darwin'

function createWindow() {
  const opts = {
    width: settings.w, height: settings.h,
    minWidth: 760, minHeight: 380,
    title: 'Claude 会话看板',
    icon: ICON,
    alwaysOnTop: !!settings.alwaysOnTop,
    autoHideMenuBar: true,
    backgroundColor: resolvedTheme() === 'dark' ? '#1c1f22' : '#ffffff',
    ...(USE_OVERLAY ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...overlayColors(), height: TITLEBAR_H },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  // 只在坐标确实落在某块屏幕上时才用 —— 换显示器后旧坐标会把窗口摆到看不见的地方
  if (Number.isInteger(settings.x) && Number.isInteger(settings.y)) {
    const { screen } = require('electron')
    const inSomeDisplay = screen.getAllDisplays().some((d) => {
      const b = d.bounds
      return settings.x >= b.x - 50 && settings.y >= b.y - 50 &&
        settings.x < b.x + b.width - 100 && settings.y < b.y + b.height - 60
    })
    if (inSomeDisplay) { opts.x = settings.x; opts.y = settings.y }
  }

  win = new BrowserWindow(opts)
  win.loadFile(path.join(__dirname, 'index.html'))

  win.on('close', saveSettings)
  win.on('closed', () => { win = null })
}

function createTray() {
  let img = nativeImage.createFromPath(ICON)
  // macOS 托盘图标要小一号，否则会被拉伸得很糊
  if (process.platform === 'darwin') img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('Claude 会话看板')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示看板', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { saveSettings(); app.quit() } },
  ]))
  tray.on('click', showWindow)
}

function showWindow() {
  if (!win) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---- 系统通知 ----

// macOS 未签名时的通知兜底路径。
//
// 实证（Electron 官方文档 api/notification）：macOS 的通知底层是 UNNotification，
// "requires an application to be code-signed in order for notifications to appear"，
// 未签名的包只会异步 emit 一个 'failed' 事件 —— 既不抛异常（所以 try/catch 抓不到）、
// isSupported() 也照样返回 true。结果是界面上通知开关开着、实际一条都不弹，
// 比"明确不支持"更误导人。本项目的 mac 包是交叉打包出来的、不签名，必然踩这条。
//
// 兜底走 osascript：借系统自带（已签名）的宿主弹真通知，无需给应用签名。
// 代价是通知归属会显示成「脚本编辑器」而不是看板自己，且首次需要用户在
// 系统设置里给脚本编辑器放行通知权限。
function notifyViaOsascript(title, body, silent) {
  // AppleScript 字符串只认双引号，内部的反斜杠和双引号必须转义；
  // 真换行会截断 -e 的单条语句，统一压成空格。
  const esc = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
  const script = 'display notification "' + esc(body) + '" with title "' + esc(title) + '"' +
    (silent ? '' : ' sound name "default"')
  execFile('/usr/bin/osascript', ['-e', script], (err) => {
    if (err) console.warn('[board] osascript notification failed: ' + err.message)
  })
}

/**
 * 弹一条系统通知。
 *
 * @param {string} title 标题
 * @param {string} body 正文
 * @param {boolean} silent true = 不响铃
 * @param {string} sessionId 点通知时要跳到哪个会话（可空）
 */
function showNotification(title, body, silent, sessionId) {
  const isMac = process.platform === 'darwin'

  if (!Notification.isSupported()) {
    if (isMac) notifyViaOsascript(title, body, silent)
    return
  }

  let n
  try {
    n = new Notification({ title, body, icon: ICON, silent })
  } catch (e) {
    console.warn('[board] notification ctor failed: ' + (e && e.message))
    if (isMac) notifyViaOsascript(title, body, silent)
    return
  }

  // 点通知直接跳到那一行 —— 否则拿到"某个会话在等你"之后还得自己在列表里找。
  // 注意 macOS 未签名走 osascript 兜底时没有这个回调（osascript 弹的通知
  // 归属于脚本宿主，点它只会打开脚本编辑器），这是那条兜底路径的固有代价。
  n.on('click', () => {
    showWindow()
    if (sessionId && win && !win.isDestroyed()) {
      win.webContents.send('board:focusRow', sessionId)
    }
  })

  // 失败是异步事件而不是异常 —— 不挂这个监听就完全静默，
  // 下次"通知怎么不弹"又得从头查一遍签名那条链。
  n.on('failed', (_e, err) => {
    console.warn('[board] native notification failed: ' + err)
    if (isMac) notifyViaOsascript(title, body, silent)
  })

  try { n.show() } catch (e) {
    console.warn('[board] notification show failed: ' + (e && e.message))
    if (isMac) notifyViaOsascript(title, body, silent)
  }
}

// ---- 定时刷新 ----

function tick() {
  let res
  try {
    res = core.buildRows({ sortIndex: settings.sort, showFolded: settings.showFolded })
  } catch (e) {
    // 异常不静默吞掉 —— 否则界面静止不动，人会读成"没有会话在变化"
    if (win && !win.isDestroyed()) win.webContents.send('board:error', String(e && e.message))
    return
  }

  // 跃变提醒：只有真的从别的状态变成"需要你"才提醒，
  // 否则每次刷新都会变成噪音轰炸。
  const alerts = []
  for (const r of res.rows) {
    const old = prevStatus.get(r.sessionId)
    if (old !== r.eff && (r.eff === 'done' || r.eff === 'waiting' || r.eff === 'asking')) {
      if (!firstRender) alerts.push(r)
    }
    prevStatus.set(r.sessionId, r.eff)
  }
  firstRender = false

  if (alerts.length) {
    const lead = alerts[0]
    if (settings.notify) {
      const title = lead.statusText.replace(/^\S+\s*/, '') + ' · ' + lead.label
      let body = lead.summary || ''
      if (body.length > 140) body = body.slice(0, 140) + '…'
      if (alerts.length > 1) body = '（共 ' + alerts.length + ' 个会话有变化）\n' + body
      showNotification(title, body, !settings.sound, lead.sessionId)
    }
    // 提醒但不抢焦点：Windows 闪任务栏，macOS 弹 Dock 图标
    if (win && !win.isDestroyed() && !win.isFocused()) {
      if (process.platform === 'darwin') { try { app.dock.bounce('informational') } catch (_) { } }
      else { try { win.flashFrame(true) } catch (_) { } }
    }
  }

  const folded = res.idleCount + res.closedCount + res.hiddenCount
  lastFolded = folded
  if (tray) {
    tray.setToolTip('Claude 会话看板：' + res.liveCount + ' 活 / ' + res.needYou + ' 待处理')
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('board:rows', {
      rows: res.rows,
      stats: {
        live: res.liveCount, needYou: res.needYou,
        idle: res.idleCount, closed: res.closedCount, folded,
        regUsable: res.regUsable,
        usage: res.usage,
        // 主题在主进程解析成最终值（auto 要查系统），页面只管照着套 ——
        // 免得渲染层也去猜"系统现在是深色还是浅色"。
        theme: resolvedTheme(),
        // 页面要知道标题栏是不是自绘的：自绘时顶栏要留出系统按钮的位置
        overlay: USE_OVERLAY,
        health: core.getHealthIssues(),
        platform: process.platform,
      },
      settings,
    })
  }
}

// ---- IPC ----

ipcMain.handle('board:getExchange', (_e, sid, transcript) => {
  try { return core.getLastExchange(transcript) } catch (_) { return { user: '', assistant: '' } }
})
// 选中行才取的补充信息，避免塞进每帧的每行循环
ipcMain.handle('board:getSessionMeta', (_e, transcript) => {
  try { return core.readSessionMeta(transcript) } catch (_) { return { compactions: -1 } }
})
ipcMain.handle('board:removeRecord', (_e, sid) => { core.removeRecord(sid); tick(); return true })
ipcMain.handle('board:unhideRecord', (_e, sid) => { core.unhideRecord(sid); tick(); return true })
ipcMain.handle('board:clearStale', () => { core.clearStaleRecords(); tick(); return true })
ipcMain.handle('board:openFolder', (_e, dir) => { if (dir) shell.openPath(dir); return true })
// 帮助面板的状态图例走数据层，别在页面里再抄一份字形和配色
ipcMain.handle('board:statusLegend', () => core.statusLegend())

// 帮助面板要显示"当前真实走的是哪条数据源"，而不是只描述机制。
//
// Why：静态文案会替一个未生效的路径背书 —— 没装 hud 的人读到
// "上下文占用 ← claude-hud 快照"会以为自己看的是原生值，其实是 transcript 估算。
// 说明书把失效路径写成特性，这类错误在本项目犯过一次（README 曾给"删不掉"背书）。
ipcMain.handle('board:hudStatus', () => {
  try { return hudGuide.detect() } catch (_) { return null }
})

// 版本信息。打包发给别人之后，双方对不上版本是最难查的一类问题。
ipcMain.handle('board:appInfo', () => {
  let codeMs = 0
  // 没有真正的构建戳，用主进程文件的 mtime 当"这份代码是什么时候放上来的"。
  // 诚实标注为「代码时间」而不是「构建时间」—— 它确实只是文件时间。
  try { codeMs = fs.statSync(__filename).mtimeMs } catch (_) { }
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform + ' ' + process.arch,
    codeMs,
    installDir: core.INSTALL_DIR,
    claudeDir: core.CLAUDE_DIR,
    configDirFromEnv: !!process.env.CLAUDE_CONFIG_DIR,
  }
})

// 帮助页里那条"未启用 → 开启"要能直接把引导叫起来
ipcMain.handle('board:openHudGuide', async () => {
  const changed = await hudGuide.show({ win, manual: true })
  if (changed) tick()
  return changed
})
ipcMain.handle('board:copyPath', (_e, dir) => { if (dir) clipboard.writeText(String(dir)); return true })

// 右键菜单必须由主进程弹原生菜单。
// 不能在页面里用 window.prompt() —— Electron **默认禁用 prompt**（返回 null 并告警），
// 我第一版就是那么写的，在打包版里等于没有右键功能。
ipcMain.on('board:contextMenu', (e, row) => {
  if (!row) return
  const menu = Menu.buildFromTemplate([
    row.hidden
      ? { label: '取消隐藏', click: () => { core.unhideRecord(row.sessionId); tick() } }
      : { label: '隐藏这一条', click: () => { core.removeRecord(row.sessionId); tick() } },
    { label: '复制目录路径', click: () => { if (row.cwd) clipboard.writeText(String(row.cwd)) } },
    { label: '打开目录', click: () => { if (row.cwd) shell.openPath(row.cwd) } },
  ])
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) })
})

// 把主题同步给 Electron 本身。
//
// Why 必须做：⚙ 的设置菜单、用量引导那几个对话框都是**原生**控件，
// 由系统按 themeSource 绘制。只改页面 CSS 的话，深色模式下一点开菜单
// 就是一块白 —— "做了深色主题"这件事会当场露馅。
function resolvedTheme() {
  const t = settings.theme
  if (t === 'light' || t === 'dark') return t
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function applyThemeSource() {
  const t = settings.theme
  nativeTheme.themeSource = (t === 'light' || t === 'dark') ? t : 'system'
  // 自绘标题栏的底色不会自己跟着变，得显式改
  if (win && !win.isDestroyed() && USE_OVERLAY) {
    try { win.setTitleBarOverlay({ ...overlayColors(), height: TITLEBAR_H }) } catch (_) { }
  }
}

function applySetting(key, value) {
  settings[key] = value
  if (key === 'theme') applyThemeSource()
  if (key === 'alwaysOnTop' && win) win.setAlwaysOnTop(!!value)
  if (key === 'autoLaunch') {
    // 开机自启：两个平台 Electron 都封装好了，不用各写一套
    try { app.setLoginItemSettings({ openAtLogin: !!value }) } catch (_) { }
  }
  saveSettings()
  tick()
}

ipcMain.handle('board:setSetting', (_e, key, value) => {
  applySetting(key, value)
  return settings
})

// 设置菜单走原生 Menu 的 checkbox 项。
//
// Why 收进菜单：置顶 / 响铃 / 通知 / 开机自启都是"设一次就不动"的开关，
// 常驻顶栏占掉一整行（约 40px），而那一行本该给列表。
// Why 用原生 checkbox 项而不是自绘：菜单一打开就能看见勾选状态，
// 所以收起来并不丢"当前开没开"这个信息 —— 只是从常驻改成按需。
ipcMain.on('board:settingsMenu', (e) => {
  const cb = (label, key) => ({
    label,
    type: 'checkbox',
    checked: !!settings[key],
    click: (item) => applySetting(key, !!item.checked),
  })
  const foldedLabel = lastFolded > 0
    ? ('显示已隐藏 / 久候 / 已关闭（' + lastFolded + '）')
    : '显示已隐藏 / 久候 / 已关闭'

  const menu = Menu.buildFromTemplate([
    cb('窗口置顶', 'alwaysOnTop'),
    { type: 'separator' },
    cb('提醒响铃', 'sound'),
    cb('系统通知', 'notify'),
    { type: 'separator' },
    { ...cb(foldedLabel, 'showFolded'), label: foldedLabel },
    {
      label: '把已完成 / 久候 / 已关闭收起来',
      toolTip: '只记一条"我不想再看见它"的意图，不删数据；它们下次有动静会自己回来',
      click: () => { core.clearStaleRecords(); tick() },
    },
    { type: 'separator' },
    {
      label: '外观',
      submenu: [
        { label: '跟随系统', type: 'radio', checked: settings.theme !== 'light' && settings.theme !== 'dark', click: () => applySetting('theme', 'auto') },
        { label: '浅色', type: 'radio', checked: settings.theme === 'light', click: () => applySetting('theme', 'light') },
        { label: '深色', type: 'radio', checked: settings.theme === 'dark', click: () => applySetting('theme', 'dark') },
      ],
    },
    cb('开机自启', 'autoLaunch'),
    { type: 'separator' },
    {
      label: '用量显示设置（5h / 周）…',
      click: () => { hudGuide.show({ win, manual: true }).then((changed) => { if (changed) tick() }) },
    },
  ])
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) })
})

// ---- 生命周期 ----

// 单实例：第二次启动就把已有窗口叫到前面，而不是再开一个
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    // 必须在 loadSettings 之前 —— 它负责把 INSTALL_DIR 建出来，
    // 设置文件就在那个目录里。
    const inst = firstRun.ensureInstalled()
    if (inst.actions.length) console.log('[first-run] ' + inst.actions.join(' | '))
    if (inst.errors.length) console.log('[first-run] error: ' + inst.errors.join(' | '))

    loadSettings()
    // 必须在建窗口之前：窗口底色和原生控件都按这个走，
    // 晚了会先闪一下浅色再变深。
    applyThemeSource()
    try { app.setLoginItemSettings({ openAtLogin: !!settings.autoLaunch }) } catch (_) { }
    createWindow()
    createTray()
    tick()
    timer = setInterval(tick, REFRESH_MS)

    // 系统主题切换时：重推一帧给页面，同时刷标题栏底色（跟随系统模式下才有效）
    nativeTheme.on('updated', () => {
      if (settings.theme !== 'light' && settings.theme !== 'dark' && win && !win.isDestroyed() && USE_OVERLAY) {
        try { win.setTitleBarOverlay({ ...overlayColors(), height: TITLEBAR_H }) } catch (_) { }
      }
      tick()
    })

    // 首次运行才自动弹用量引导，且要等窗口先画出来 ——
    // 空窗口上盖一个对话框，人会以为程序卡了。
    if (!settings.hudGuideShown) {
      setTimeout(() => {
        applySetting('hudGuideShown', true)
        hudGuide.show({ win, manual: false }).then((changed) => { if (changed) tick() })
      }, 1800)
    }
  })

  // macOS 习惯：点 Dock 图标重新开窗口
  app.on('activate', () => { if (!win) createWindow() })

  // 关掉窗口不退出（托盘还在），与 macOS 的常规行为一致；
  // Windows 上也保留这个语义 —— 看板本来就是常驻工具。
  app.on('window-all-closed', () => { })

  app.on('before-quit', () => {
    if (timer) clearInterval(timer)
    saveSettings()
  })
}

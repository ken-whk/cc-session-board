'use strict'

// Claude 会话看板 —— Electron 主进程（Windows / macOS 共用）
//
// 职责：开窗口、定时向渲染层推数据、托盘图标、系统通知、设置持久化。
// 所有判定逻辑都在 board-core.js 里，本文件不做业务判断。

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')

const core = require('../board-core.js')
const firstRun = require('./first-run.js')

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

// 默认设置。sort: 0 需求度 / 1 启动顺序 / 2 最近活动 / 3 项目名
let settings = {
  x: null, y: null, w: 1080, h: 620,
  alwaysOnTop: false, sound: true, notify: true,
  showFolded: false, sort: 0, autoLaunch: false,
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

function createWindow() {
  const opts = {
    width: settings.w, height: settings.h,
    minWidth: 760, minHeight: 380,
    title: 'Claude 会话看板',
    icon: ICON,
    alwaysOnTop: !!settings.alwaysOnTop,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
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
    if (settings.notify && Notification.isSupported()) {
      const title = lead.statusText.replace(/^\S+\s*/, '') + ' · ' + lead.label
      let body = lead.summary || ''
      if (body.length > 140) body = body.slice(0, 140) + '…'
      if (alerts.length > 1) body = '（共 ' + alerts.length + ' 个会话有变化）\n' + body
      try { new Notification({ title, body, icon: ICON, silent: !settings.sound }).show() } catch (_) { }
    }
    // 提醒但不抢焦点：Windows 闪任务栏，macOS 弹 Dock 图标
    if (win && !win.isDestroyed() && !win.isFocused()) {
      if (process.platform === 'darwin') { try { app.dock.bounce('informational') } catch (_) { } }
      else { try { win.flashFrame(true) } catch (_) { } }
    }
  }

  const folded = res.idleCount + res.closedCount + res.hiddenCount
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
ipcMain.handle('board:removeRecord', (_e, sid) => { core.removeRecord(sid); tick(); return true })
ipcMain.handle('board:unhideRecord', (_e, sid) => { core.unhideRecord(sid); tick(); return true })
ipcMain.handle('board:clearStale', () => { core.clearStaleRecords(); tick(); return true })
ipcMain.handle('board:openFolder', (_e, dir) => { if (dir) shell.openPath(dir); return true })
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

ipcMain.handle('board:setSetting', (_e, key, value) => {
  settings[key] = value
  if (key === 'alwaysOnTop' && win) win.setAlwaysOnTop(!!value)
  if (key === 'autoLaunch') {
    // 开机自启：两个平台 Electron 都封装好了，不用各写一套
    try { app.setLoginItemSettings({ openAtLogin: !!value }) } catch (_) { }
  }
  saveSettings()
  tick()
  return settings
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
    try { app.setLoginItemSettings({ openAtLogin: !!settings.autoLaunch }) } catch (_) { }
    createWindow()
    createTray()
    tick()
    timer = setInterval(tick, REFRESH_MS)
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

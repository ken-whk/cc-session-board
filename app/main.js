'use strict'

// Claude 会话看板 —— Electron 主进程（Windows / macOS 共用）
//
// 职责：开窗口、定时向渲染层推数据、托盘图标、系统通知、设置持久化。
// 所有判定逻辑都在 board-core.js 里，本文件不做业务判断。

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, clipboard, nativeTheme, dialog } = require('electron')
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

// 自动删除阈值的常用档（小时）。0 = 关闭。
// 任意时长走「自定义…」，所以这里只放最常用的几个，不追求覆盖全部场景。
const PURGE_PRESETS = [0, 6, 24, 72, 168]

// 阈值 -> 人话。数据层只认小时，「天」只是显示和输入时的单位，
// 所以换算只在这一层做，别让"天"漏进 board-core。
function formatPurgeHours(h) {
  const n = Math.max(0, Number(h) || 0)
  if (n === 0) return '关闭'
  if (n < 24) return n + ' 小时'
  const d = Math.floor(n / 24)
  const rest = n % 24
  return rest === 0 ? d + ' 天' : d + ' 天 ' + rest + ' 小时'
}

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
  // 残留记录（会话没了、注册表也没了，只剩 state 文件）过多少**小时**自动删掉。0 = 关闭。
  // 默认 72（3 天）：短到不让残留堆积，长到你隔个周末回来还能看见前两天关掉的会话。
  // 存小时是为了让用户能填任意时长（界面上按小时/天输入，落盘统一成小时）。
  // 不放心自动删数据就在设置里调到「关闭」，右键「删除记录」照样可用。
  autoPurgeHours: 72,
}

function loadSettings() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    settings = Object.assign(settings, o)
    // 旧键迁移：阈值一开始是"天"，改成"小时"以支持任意时长。
    // 只在新键缺席时换算，否则会把用户后来设的小时值覆盖回去。
    if (o.autoPurgeDays != null && o.autoPurgeHours == null) {
      settings.autoPurgeHours = Math.max(0, Number(o.autoPurgeDays) || 0) * 24
    }
    delete settings.autoPurgeDays
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
    res = core.buildRows({
      sortIndex: settings.sort,
      showFolded: settings.showFolded,
      autoPurgeHours: settings.autoPurgeHours,
    })
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
ipcMain.handle('board:purgeRecord', (_e, sid) => { const ok = core.purgeRecord(sid); tick(); return ok })
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

// 切到该会话所在的终端窗口。
//
// 只有 Windows 有实现。macOS 要另写一段 AppleScript（osascript 的先例见
// notifyViaOsascript），没有样本机器验证之前不做 —— 菜单项在 mac 上直接不出现，
// 好过给一个点了没反应的项。
//
// 精度分两档，调用方要照实转述、不能假装做到了标签级：
//   'title'  —— 命中控制台标题（Claude 会把会话标题写进去），精确到这个会话
//   'folder' —— 只命中工作区名，VS Code / IDEA 一个窗口装多个终端标签，
//               落到窗口就到头了，选哪个标签仍得人来点
// 生成出来的助手 exe。落 INSTALL_DIR 而不是应用包内：包可能装在只读位置
// （Program Files / macOS 的 /Applications），往里写会静默失败（铁律 4）。
// 文件名带版本号 —— 改了 focus-window.cs 却不改它，已经编译过的机器会一直用旧的，
// 改动静默不生效。旧文件不清理，它只有几 KB。
// v2：请求格式从 title/folder/host 改成 title/host/候选列表。不升版本号的话，
// 装过 v1 的机器会拿旧 exe 去读新格式（把 host 当 folder），既不报错也不对。
const FOCUS_EXE = path.join(core.INSTALL_DIR, 'cc-board-focuswin-v2.exe')

// 在盒的 .NET Framework 编译器。Win10/11 一定有，路径固定；64 位优先。
function cscPath() {
  const root = process.env.WINDIR || 'C:\\Windows'
  const cands = [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c } catch (_) { } }
  return ''
}

// 看板启动时后台编译一次，把这一秒钟花在没人等的时候。
// 编译不成不报错也不重试：拿不到 exe 时点击会自动降级走 .ps1，功能不缺，只是慢。
function ensureFocusHelper() {
  if (process.platform !== 'win32') return
  try { if (fs.statSync(FOCUS_EXE).isFile()) return } catch (_) { /* 没有就编 */ }
  const csc = cscPath()
  if (!csc) return
  const cs = path.join(core.CODE_DIR, 'focus-window.cs')
  if (!fs.existsSync(cs)) return
  execFile(csc,
    ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/out:' + FOCUS_EXE, cs],
    { timeout: 60000, windowsHide: true },
    () => { /* 成败都不打扰：失败时点击自然降级 */ })
}

// 这些路径段谁都可能有，拿它们去匹配窗口标题只会撞上无关窗口。
// 判据是"这个词能不能指认一个工作区"，不是"它是不是目录名"。
const GENERIC_SEG = new Set([
  'src', 'app', 'lib', 'test', 'tests', 'main', 'dist', 'build', 'out', 'bin',
  'node_modules', 'packages', 'apps', 'code', 'work', 'workspace', 'projects',
  '.sdlc', 'worktrees', '.git', 'server', 'client', 'web', 'api', 'ui', 'docs',
  // Windows 用户目录那几段：出现在无数窗口标题里，指认不了任何工作区
  'users', 'home', 'documents', 'desktop', 'downloads', 'temp', 'appdata',
])

// 工作区名候选，**由细到粗**。
//
// 为什么不能只给一个：会话的注册表 cwd 是启动目录（如主仓根），而它实际待的地方
// 常常是 worktree（.sdlc/worktrees/D-0xx-...）。你要是给那个 worktree 单开一个
// VS Code 窗口，那个窗口标题里只有 worktree 名、没有主仓名 —— 只拿主仓名去匹配，
// 会稳定地切到开着主仓的**另一个**窗口，而且看上去还"成功了"。
//
// 由细到粗排列，匹配方按顺序取第一个命中的档次，于是"一窗口一 worktree"能精确命中，
// "只开主仓一个窗口"退回原来的行为、不变差。
//
// 上限 6 个：再往上就是 yxt / aicoding 这种共同祖先，对区分窗口没有贡献，
// 反而多一次撞上无关窗口的机会。
function folderCandidates(row) {
  const out = []
  const push = (p) => {
    const segs = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]
      // 盘符（E:）、过短、通用段一律跳过
      if (s.length < 3 || /^[a-zA-Z]:$/.test(s)) continue
      if (GENERIC_SEG.has(s.toLowerCase())) continue
      if (!out.includes(s)) out.push(s)
      if (out.length >= 6) return
    }
  }
  // state 的 cwd 更贴近会话实际位置（哪怕它会跟着 cd 漂），先拿它；
  // 注册表 cwd 是稳定的启动目录，垫底兜住。
  push(row.cwd)
  push(row.regCwd)
  return out
}

function focusSessionWindow(row, onDone) {
  const plat = process.platform
  if (plat !== 'win32' && plat !== 'darwin') { onDone({ ok: false, reason: 'unsupported' }); return }

  // 请求走 UTF-8 文件而不是命令行参数：会话标题是中文，命令行传参要过控制台
  // 代码页，Windows 上会乱码（CLAUDE.md 铁律 3 是同一个根因的另一面）。
  //
  // 三行纯文本而不是 JSON：字段只有三个且永不嵌套，C# 侧解析 JSON 要么加依赖
  // 要么手写；顺带也躲掉了 .ps1 那版踩过的 ConvertFrom-Json 类型强转坑。
  const reqFile = path.join(app.getPath('temp'), 'cc-board-focus.txt')
  const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ')
  const lines = [oneLine(row.title), oneLine(row.host)].concat(folderCandidates(row))
  try {
    fs.writeFileSync(reqFile, lines.join('\n'), 'utf8')
  } catch (e) {
    onDone({ ok: false, reason: 'error' })
    return
  }

  const done = (err, stdout) => {
    let res = { ok: false, reason: 'error' }
    try { res = JSON.parse(String(stdout).trim()) } catch (_) { /* 保持 error */ }
    if (err && !res.ok) res.reason = res.reason || 'error'
    onDone(res)
  }

  // macOS：走 AppleScript。输出是 `ok=1 tier=tab app=Terminal` 这种扁平 kv，
  // 不是 JSON —— AppleScript 拼 JSON 要处理引号转义，为三个字段不值当。
  //
  // 这条路径**未经实测**（本机是 Windows）。所以调用方把任何非 ok 的结果都当作
  // "什么也没做"，退回打开目录 —— 即 macOS 在这个功能出现之前的行为。
  // 猜错的代价被限制在"没变好"，不会"变坏"。
  if (plat === 'darwin') {
    const script = path.join(core.CODE_DIR, 'focus-window.applescript')
    execFile('osascript', [script, reqFile], { timeout: 15000 }, (err, stdout) => {
      const out = String(stdout || '').trim()
      const ok = /(^|\s)ok=1(\s|$)/.test(out)
      const tier = (out.match(/tier=(\w+)/) || [])[1] || ''
      const proc = (out.match(/app=([\w \-.]+)/) || [])[1] || ''
      onDone({ ok, reason: ok ? '' : ((out.match(/reason=(\w+)/) || [])[1] || (err ? 'error' : 'no_match')), tier, proc })
    })
    return
  }

  // 快路径：生成好的 exe，几十毫秒。
  let hasExe = false
  try { hasExe = fs.statSync(FOCUS_EXE).isFile() } catch (_) { hasExe = false }
  if (hasExe) {
    execFile(FOCUS_EXE, [reqFile], { timeout: 15000, windowsHide: true }, done)
    return
  }

  // 兜底：同样逻辑的 PowerShell 版，慢约十倍（实测 ~870ms vs ~70ms），
  // 但不依赖 csc。exe 还没编好、或这台机器编不出来时走这里。
  // .ps1 走 CODE_DIR：它是**代码**，跟着应用包走，不在可写目录里。
  ensureFocusHelper()
  const ps1 = path.join(core.CODE_DIR, 'focus-window.ps1')
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Req', reqFile],
    { timeout: 15000, windowsHide: true }, done)
}

// macOS 取证：把当前所有 Terminal / iTerm 的标签名列出来，写进桌面文件并弹框告知。
//
// 存在的唯一理由是**这台开发机没有 Mac**：AppleScript 那条路径依赖一个没法在
// Windows 上验证的假设（Claude 写的控制台标题能不能到 Terminal 标签名上）。
// 与其反复猜，不如让用 Mac 的人点一下、把文件发回来。
function diagnoseMacTerminals(parentWin) {
  const reqFile = path.join(app.getPath('temp'), 'cc-board-focus-diag.txt')
  const outFile = path.join(app.getPath('home'), 'Desktop', 'claude-board-mac-diag.txt')
  try { fs.writeFileSync(reqFile, 'DIAG\n', 'utf8') } catch (_) { }
  const script = path.join(core.CODE_DIR, 'focus-window.applescript')
  execFile('osascript', [script, reqFile], { timeout: 20000 }, (err, stdout, stderr) => {
    const body = String(stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '')
      + (err ? '\n--- error ---\n' + err.message : '')
    let saved = outFile
    try { fs.writeFileSync(outFile, body, 'utf8') } catch (_) { saved = '(写桌面失败)' }
    dialog.showMessageBox(parentWin, {
      type: 'info',
      title: 'macOS 终端诊断',
      message: '已导出到：\n' + saved + '\n\n把这个文件发回来即可。',
      detail: body.slice(0, 1500),
      buttons: ['知道了'],
    })
  })
}

// 成功不提示：窗口已经切过去了，再弹个框反而把焦点抢回来，等于把刚做成的事撤销一半。
// 失败才说话，且要说清为什么 —— 静默失败会让人以为看板卡了。
function focusWithFeedback(row, parentWin) {
  focusSessionWindow(row, (res) => {
    if (res.ok) return
    // macOS 上的实现尚未实测，失败一律**静默退回打开目录**（该平台原本的双击行为），
    // 不弹框 —— 弹一个"没找到窗口"只会让人以为看板坏了，而实际上是这条路径本来
    // 就还没被验证过。等有人在 Mac 上验完，再考虑给它正常的报错。
    if (process.platform === 'darwin') {
      if (row.cwd) shell.openPath(String(row.cwd))
      return
    }
    const why = {
      no_match: '没找到对应的窗口。\n\n'
        + '可能原因：会话所在的终端已经关掉；或者它的宿主看板还认不出来'
        + '（IDEA / Windows Terminal / 裸 cmd 这几档判据尚未实证）。',
      focus_refused: '找到了窗口，但系统拒绝了置顶请求。再点一次通常就好。',
      unsupported: '这个功能目前只在 Windows 上实现。',
      error: '调用失败。',
    }[res.reason] || '调用失败。'
    dialog.showMessageBox(parentWin, {
      type: 'info', title: '切到该会话的窗口', message: why, buttons: ['知道了'],
    })
  })
}

ipcMain.handle('board:focusWindow', (e, row) => {
  if (!row) return true
  // Windows / macOS 都走 focusWithFeedback；它内部对 macOS 的失败会静默退回
  // 打开目录（该平台原本的双击行为），其他平台直接落到 unsupported 分支。
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    if (row.cwd) shell.openPath(String(row.cwd))
    return true
  }
  focusWithFeedback(row, BrowserWindow.fromWebContents(e.sender))
  return true
})

// 右键菜单必须由主进程弹原生菜单。
// 不能在页面里用 window.prompt() —— Electron **默认禁用 prompt**（返回 null 并告警），
// 我第一版就是那么写的，在打包版里等于没有右键功能。
ipcMain.on('board:contextMenu', (e, row) => {
  if (!row) return
  const menu = Menu.buildFromTemplate([
    row.hidden
      ? { label: '取消隐藏', click: () => { core.unhideRecord(row.sessionId); tick() } }
      : { label: '隐藏这一条', click: () => { core.removeRecord(row.sessionId); tick() } },
    // 「删除记录」只对残留记录出现（row.orphan，判据在数据层的 isOrphan）。
    // Why 条件显示而不是常驻置灰：删不掉的行给了入口就得解释"为什么点了还在"，
    // 而那个解释（存在性是注册表 ∪ state 的并集）根本不该出现在右键菜单里。
    ...(row.orphan ? [{
      label: '删除记录',
      toolTip: '这个会话已经不在了，只剩一条观测记录。删掉不可撤销，也不会再回来',
      click: () => { core.purgeRecord(row.sessionId); tick() },
    }] : []),
    { label: '复制目录路径', click: () => { if (row.cwd) clipboard.writeText(String(row.cwd)) } },
    { label: '打开目录', click: () => { if (row.cwd) shell.openPath(row.cwd) } },
    ...((process.platform === 'win32' || process.platform === 'darwin') ? [{
      label: '切到该会话的窗口',
      click: () => focusWithFeedback(row, BrowserWindow.fromWebContents(e.sender)),
    }] : []),
    // macOS 专有的取证入口。那条路径没有 Mac 可实测，只能让真正用 Mac 的人
    // 跑一次把现场发回来 —— 不给这个入口，远程排查就只能靠猜。
    // 验完 macOS 分支后连同 focus-window.applescript 的 DIAG 分支一起删。
    ...(process.platform === 'darwin' ? [{
      label: '诊断：导出终端窗口清单（macOS 调试用）',
      click: () => diagnoseMacTerminals(BrowserWindow.fromWebContents(e.sender)),
    }] : []),
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
  // 阈值统一在这里收口 —— 菜单档位和自定义对话框都经过这条路，
  // 校验只写一次。0 = 关闭，其余夹到 [1 小时, 1 年]。
  //
  // 下限 1 小时：更短没有实用意义，而且一个 hook 事件迟到就可能误删掉
  // 还在跑的会话的观测记录（下次 hook 会重建，但标题/摘要会闪一下）。
  // 上限 1 年：纯防呆，手滑多打几个 0 不该变成"看起来开着其实永不触发"。
  if (key === 'autoPurgeHours') {
    const n = Math.round(Number(value) || 0)
    value = n <= 0 ? 0 : Math.min(Math.max(n, 1), 24 * 365)
  }
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
    {
      // 常用档一点即中，「自定义」是逃生口 —— 原生菜单里没有输入控件
      // （Electron 连 window.prompt 都禁用了），任意时长只能弹自绘对话框。
      // 「关闭」那一档是退路：哪天不放心自动删数据，关掉它，
      // 右键「删除记录」照样能一条条清。
      label: '自动删除残留记录（' + formatPurgeHours(settings.autoPurgeHours) + '）',
      toolTip: '会话没了、注册表也没了、只剩一条观测记录的行；超过这个时长自动删掉',
      submenu: [
        ...PURGE_PRESETS.map((h) => ({
          label: h === 0 ? '关闭（只手动删）' : formatPurgeHours(h) + '后',
          type: 'radio',
          checked: Number(settings.autoPurgeHours) === h,
          click: () => applySetting('autoPurgeHours', h),
        })),
        // 这里**不能**放 separator：Electron 的 radio 分组以分隔符为界，
        // 隔开后档位是一组、自定义是另一组。选了自定义时档位那组一个都没 checked，
        // Chromium 会把组内第一项（「关闭」）渲染成选中 —— 两个圆点同时亮，
        // 而且谎报当前规则是"关闭"。合成一组才有"有且只有一个选中"的语义。（实测踩过）
        {
          // 自定义值必须写在标签上 —— 子菜单展开后父项的「（3 天）」被盖住，
          // 只剩一个光秃秃的「自定义…」，看不出当前到底是几小时。
          label: PURGE_PRESETS.includes(Number(settings.autoPurgeHours))
            ? '自定义…'
            : '自定义（当前 ' + formatPurgeHours(settings.autoPurgeHours) + '）…',
          type: 'radio',
          checked: !PURGE_PRESETS.includes(Number(settings.autoPurgeHours)),
          click: () => {
            if (win && !win.isDestroyed()) {
              // 连同格式化好的文案一起送过去：格式化只在主进程有一份，
              // 渲染层再抄一份的话，改了显示规则必然漏掉其中一处。
              win.webContents.send('board:askPurgeThreshold', {
                hours: Number(settings.autoPurgeHours) || 0,
                label: formatPurgeHours(settings.autoPurgeHours),
              })
            }
          },
        },
      ],
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

    // 切窗口用的助手 exe：放在这里编，是因为此刻没人在等 —— 编译约 1 秒，
    // 挪到第一次点击时做就正好把那一秒摊在最该快的路径上。已存在则直接返回。
    ensureFocusHelper()

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

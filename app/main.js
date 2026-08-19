'use strict'

// Claude Code 会话看板 —— Electron 主进程（Windows / macOS 共用）
//
// 职责：开窗口、定时向渲染层推数据、托盘图标、系统通知、设置持久化。
// 所有判定逻辑都在 board-core.js 里，本文件不做业务判断。

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, clipboard, nativeTheme, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile, spawn } = require('child_process')

const core = require('../board-core.js')
const uploadCore = require('../upload-core.js')
const firstRun = require('./first-run.js')
const hudGuide = require('./hud-guide.js')

// 落在 INSTALL_DIR（home 下）而不是应用包内 —— 包内在 macOS/Program Files 下只读，
// 写设置会静默失败，表现为"每次开都忘记窗口位置和勾选项"。
const SETTINGS_FILE = path.join(core.INSTALL_DIR, 'ui-electron.json')
// 托盘用 32 —— 那正是托盘槽位的尺寸，给大图反而要它自己缩。
const ICON = path.join(__dirname, 'icon.png')
// 通知和窗口（Alt-Tab）要大图：这两处会把图标显示到 48~96px，
// 喂 32 的托盘图会被拉糊。Windows 的窗口图标直接给 .ico（内含各档，系统自己挑），
// 其他平台不认 .ico，退回 256 的 png。
const ICON_LARGE = path.join(__dirname, 'icon-large.png')
const ICON_WINDOW = process.platform === 'win32' ? path.join(__dirname, 'icon.ico') : ICON_LARGE
const REFRESH_MS = 1500

// 进程身份 / 脱钩探测的周期。远慢于 REFRESH_MS 是硬要求，不是调优 ——
// 探测要起一个 powershell 子进程，跟着 1.5 秒的刷新走等于每秒拉一个进程起来。
const PROBE_MS = 30 * 1000

let win = null
let tray = null
let timer = null
let probeTimer = null
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
  // 最小化时收进托盘（不在任务栏留一格）。trayHintShown 记"那句解释说过没"。
  trayOnMinimize: true, trayHintShown: false,
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
  // 注册表残留清理。默认开：它只删 `~/.claude/sessions/<pid>.json` 里
  // **进程已经不在、或 pid 已被复用**的那些条目（身份靠 procStart 校验，
  // 不是光看 pid），删错的唯一后果是 Claude Code 下次开会话重新写一份。
  // 而不开的代价是确定的：上游不清，下游 autoPurge 永远不触发，
  // 残留记录挂在看板上不会走（实测挂过 16 小时）。
  registryGc: true,
  // 脱钩会话（终端窗口没了但进程还活着）怎么处置。
  // 'mark' 只标记（默认）/ 'kill' 静默够久后自动结束进程。
  //
  // 默认只标记是刻意的：判据（有没有活的 console）目前只有独立 Git Bash
  // 这一类宿主的样本，VS Code 集成终端走 ConPTY，一个样本都没有。
  // 标错一个徽标可以撤，杀错一个正在跑的会话撤不回来 —— 先让人看几天准不准，
  // 觉得判对了再去菜单里打开自动结束。
  detachedAction: 'mark',
  // 自动结束前要求的静默时长（分钟）。脱钩的会话可能正跑到一半（还在写文件），
  // 立刻杀会把它截断在半路。
  detachedIdleMinutes: 10,
  // NAS 归档面板看谁的目录（域账号）。空 = 用推测值。
  //
  // 必须能记住：共享盘上是全公司每个人一个目录，不记的话每次打开都要在一长串
  // 别人的名字里找自己。而且默认推测值取自 git email，SKILL.md 明说它不一定
  // 等于域账号 —— 所以这个值只能由人确认一次，不能靠猜。
  nasUser: '',
  // 到点提醒"今天该上报会话了"。默认开着 —— 它要解决的就是"忘了报"，
  // 而默认关闭的提醒功能救不了任何一个会忘的人。
  uploadRemind: true,
  uploadRemindTimes: uploadCore.DEFAULT_REMIND_TIMES.slice(),
  // 今天已经提醒过哪几个点。落盘而不是只放内存：不落的话，晚上重启一次看板
  // 就会把当天过掉的点重新提醒一遍。跨天由 dueReminders 按 firedDate 自动作废。
  uploadRemindFiredDate: '',
  uploadRemindFired: [],
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
    title: 'Claude Code 会话看板',
    icon: ICON_WINDOW,
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

  // 最小化收进托盘：任务栏上不再占一格，托盘图标点一下回来。
  // Why 默认开：这是个"看一眼就切走"的常驻工具，一天要最小化很多次，
  // 每次都在任务栏留一格纯属占地方；而托盘本来就常驻（关窗口也不退出，
  // window-all-closed 是空实现）。
  // 关掉这个开关就恢复系统默认的最小化行为。
  win.on('minimize', (e) => {
    if (!settings.trayOnMinimize) return
    e.preventDefault()
    win.hide()
    // 只提示一次：窗口从任务栏消失是个会吓人的动作，得说清它去哪了。
    // 之后不再打扰 —— 知道一次就够。
    //
    // **标志位只在真的说出口之后才烧掉**。原先是先置 true 再判 win32，于是
    // mac 上窗口从 Dock 消失、一句解释都没有，而"已经提示过"却被记下了 ——
    // 之后永远不会再提示。这类"把没做的事记成做过了"最难查。
    if (!settings.trayHintShown) {
      const content = process.platform === 'darwin'
        ? '已收进菜单栏，点那个图标回来。不想这样：⚙ 设置 → 关掉「最小化到菜单栏」'
        : '已收进托盘，点这个图标回来。不想这样：⚙ 设置 → 关掉「最小化到托盘」'
      let told = false
      if (process.platform === 'win32' && tray) {
        // Windows 走托盘气泡：它从托盘图标上长出来，指向"东西在这儿"
        try {
          tray.displayBalloon({ title: 'Claude Code 会话看板', content })
          told = true
        } catch (_) { /* 气泡失败不影响功能，静默 */ }
      } else if (process.platform === 'darwin') {
        // mac 没有 displayBalloon（Tray 上那是 Windows 专有 API）。改走系统通知 ——
        // showNotification 里已经有未签名走 osascript 的兜底，这条不会白发。
        showNotification('Claude Code 会话看板', content, true)
        told = true
      }
      if (told) {
        settings.trayHintShown = true
        saveSettings()
      }
    }
  })

  win.on('close', saveSettings)
  win.on('closed', () => { win = null })
}

function createTray() {
  let img = nativeImage.createFromPath(ICON)
  // macOS 托盘图标要小一号，否则会被拉伸得很糊
  if (process.platform === 'darwin') img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('Claude Code 会话看板')
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
 * @param {Function} onClick 给非会话类通知（如上报提醒）用；给了就取代"跳到那一行"
 */
function showNotification(title, body, silent, sessionId, onClick) {
  const isMac = process.platform === 'darwin'

  if (!Notification.isSupported()) {
    if (isMac) notifyViaOsascript(title, body, silent)
    return
  }

  let n
  try {
    n = new Notification({ title, body, icon: ICON_LARGE, silent })
  } catch (e) {
    console.warn('[board] notification ctor failed: ' + (e && e.message))
    if (isMac) notifyViaOsascript(title, body, silent)
    return
  }

  // 点通知直接跳到那一行 —— 否则拿到"某个会话在等你"之后还得自己在列表里找。
  // 注意 macOS 未签名走 osascript 兜底时没有这个回调（osascript 弹的通知
  // 归属于脚本宿主，点它只会打开脚本编辑器），这是那条兜底路径的固有代价。
  n.on('click', () => {
    // 上报提醒点开该去上报日历，不是主列表 —— 通知说的是"去报"，
    // 落到一个跟它无关的界面等于让人自己再找一次入口。
    if (onClick) { onClick(); return }
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

// 探一轮所有注册会话的进程身份 + 终端通道。结果落进 board-core 的缓存，
// 由后续的 tick 同步消费 —— 数据层那边全程不阻塞。
//
// 探完主动补一帧：不补的话新结论要等下一个 1.5 秒周期才显示，
// 而首次探测正好发生在开板那一刻，那一眼看到的就是旧判定。
function probeTick() {
  try {
    core.refreshProcProbe(core.probeTargets(core.readRegistry()), () => tick())
  } catch (e) {
    console.warn('[board] proc probe failed: ' + (e && e.message))
  }
}

function tick() {
  let res
  try {
    res = core.buildRows({
      sortIndex: settings.sort,
      showFolded: settings.showFolded,
      autoPurgeHours: settings.autoPurgeHours,
      registryGc: settings.registryGc,
      detachedAction: settings.detachedAction,
      detachedIdleMinutes: settings.detachedIdleMinutes,
      // 「今天动过的会话有几个」。纯本地计算（比对 state 的 updated_ms），
      // 不碰 NAS —— 底栏那条指示的**数字**来自这里，**该不该显示**才来自
      // 那一天最多几次的 NAS 核对。两件事分开，才不至于为了刷新一个数字
      // 把共享盘拖进 1.5 秒的循环。
      activeSinceMs: uploadCore.localDayStartMs(),
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
    tray.setToolTip('Claude Code 会话看板：' + res.liveCount + ' 活 / ' + res.needYou + ' 待处理')
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
        // 「今天还没上报」指示。null = 不显示（没到 17:30 / 今天已报 /
        // 关掉了上报提醒）。跟着 uploadRemind 走：那个开关表达的是"上报这件事
        // 别来烦我"，只关掉通知却在底栏常驻一句欠账，等于没关。
        uploadPending: (settings.uploadRemind && uploadPending)
          ? {
            count: res.activeSince,
            verified: uploadPending.verified,
            reason: uploadPending.reason,
            checkedMs: uploadPending.checkedMs,
          }
          : null,
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
// 结束进程：数据层会**重新探一次**再决定动不动手（右键菜单拿的是上一帧快照），
// 所以这里是异步的。杀完立刻补一帧，让那一行当场翻成「已关闭」——
// 否则要等下一个探测周期（30s）才变，人会以为没点动。
ipcMain.handle('board:endProcess', (_e, sid) => new Promise((resolve) => {
  core.endProcess(sid, (ok) => { tick(); resolve(ok) })
}))
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
// v3：同一档候选内改为「词边界命中优先于子串命中」。请求格式没变，所以旧 exe
// 不会报错 —— 它只是继续按 z 序在 oteapi / oteapi-facade 之间乱挑，正是要修的症状。
// 这种"格式兼容但行为不同"的改动最需要升号：不升就完全看不出来没生效。
const FOCUS_EXE = path.join(core.INSTALL_DIR, 'cc-board-focuswin-v3.exe')

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
    // 「结束进程」只对已脱钩的行出现（row.canEnd，判据在数据层）。同「删除记录」
    // 一样按行条件显示 —— 给活会话这个入口等于递给人一把误伤自己的刀。
    //
    // 这是第四个动作词，与隐藏/取消隐藏/删除记录**不是同义词**：前三个动的是
    // 观测记录，这个动的是真实进程。脱钩会话两样都要收，而且必须先杀进程 ——
    // 进程不死，pid 判活就翻不成「已关闭」，注册表 GC 和自动删除依次接不上。
    ...(row.canEnd ? [{
      label: '结束进程',
      toolTip: '这个会话的终端窗口已经没了，再也输入不进去。结束它的进程，记录随后自动回收',
      click: () => confirmEndProcess(row, BrowserWindow.fromWebContents(e.sender)),
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

// 结束进程前问一句。
//
// Why 这里要确认而「删除记录」不用：那个判据（注册表里还有没有这个 id）是读文件，
// 对错当场可查；这个判据（有没有活的 console）目前只有独立 Git Bash 一类宿主的
// 样本，VS Code 集成终端走 ConPTY，一个样本都没有。判错的后果是杀掉一个人正在用的
// 会话 —— 在判据攒够样本之前，这一句确认就是最后一道人肉护栏。
// 判准了之后可以把这个对话框去掉，届时连同本注释一起删。
function confirmEndProcess(row, parent) {
  const title = String(row.title || row.label || row.sessionId || '').slice(0, 60)
  dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['结束进程', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '结束进程',
    message: '结束这个会话的进程？',
    detail: title + '\n\n看板判定它已脱钩：终端窗口没了，进程还活着，再也输入不进去。'
      + '\n结束后它会变成「已关闭」，记录随后自动回收。'
      + '\n\n如果你还能在某个终端窗口里找到并操作它，说明这次判错了 —— 请点取消。',
  }).then((r) => {
    if (r.response !== 0) return
    core.endProcess(row.sessionId, (ok) => {
      tick()
      if (ok) return
      // 失败要说话。静默失败在这里特别坏：人点完看它还在，会反复点，
      // 而真正的原因（复核时发现它其实还活着）恰恰是最该被看见的那条信息。
      dialog.showMessageBox(parent, {
        type: 'info',
        title: '没有结束',
        message: '没有结束这个进程',
        detail: '动手前会重新探一次。这次复核没通过 —— 它可能刚被 --resume 拉起来、'
          + 'pid 已被别的进程复用、或者探测本身失败了。看板下一轮会自己纠正显示。',
      })
    })
  })
}

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
  // 静默守卫的下限 1 分钟：再短就等于没有守卫，会把正跑到一半（还在写文件）
  // 的脱钩会话截断。上限 1 天纯防呆。和上面同一条纪律 —— 校验只写在这一处。
  if (key === 'detachedIdleMinutes') {
    const n = Math.round(Number(value) || 0)
    value = Math.min(Math.max(n, 1), 24 * 60)
  }
  // 只认这两个取值。菜单之外的来路（旧配置文件、手改 json）给了别的值时
  // 退回 'mark' —— 认不出的取值绝不能落进"自动杀进程"那一档。
  if (key === 'detachedAction') {
    value = value === 'kill' ? 'kill' : 'mark'
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
// ---- 会话上报归档面板 ----
//
// **嵌在主窗口里，不再另开 BrowserWindow。** 独立窗口会在任务栏多占一个条目，
// 而这是个偶尔看一眼的面板，不值得一个窗口；顺带也解决了配色不一致
// （那个独立页面只跟 prefers-color-scheme，而主窗口支持手动锁定深浅色）。
//
// 但"NAS 不进刷新循环"这条约束照旧：面板里的所有 NAS 读都由页面按需触发
// （第一次打开 + 你点刷新），绝不跟着 1.5 秒的 tick 走 —— 那等于后台轮询共享盘，
// 会破掉看板"无后台网络出口"这条性质。
function openUploadPanel() {
  showWindow()
  if (win && !win.isDestroyed()) win.webContents.send('board:openArchive')
}

// 三个 handler 全是**只读**。看板不执行上报 —— 上报走 cc-session-nas-upload
// skill 本身，它的 list 带 uploadState / 待报条数 / 已归档到哪一刻，那是"选哪些
// 会话"真正需要的信息，而看板本地拿不到（必须比对 NAS）。看板只补 skill 没有的
// 那一半：它没有 history 子命令，答不了"我哪天报过哪些"。
//
// 账号（域账号）由页面传：默认值是从 git email 猜的，SKILL.md 自己就说过它
// 不一定等于域账号，所以页面给下拉让人选盘上真实存在的目录。
// saved 是**你确认过**的账号，优先级高于枚举和推测：盘上有几十个人的目录，
// 每次让你在里头找自己是没必要的。枚举结果仍然回给页面，但只当输入提示用。
// 顺带把平台与 smb 地址带上：挂载引导要按平台换说法和按钮，而它拿到的就是
// 这两个结果之一。渲染层不自己判平台（navigator.platform 是另一套口径，
// 两处各判一次迟早对不上），smb 地址也只有数据层一处定义。
const nasEnv = () => ({ platform: process.platform, smb: uploadCore.nasSmbUrl() })

ipcMain.handle('upload:listUsers', () => Object.assign(
  uploadCore.listExportUsers(),
  { saved: String(settings.nasUser || '') },
  nasEnv(),
))

// 单独一条而不是走 applySetting：那条会顺带 tick() 踢主看板刷新，
// 而这只是上报窗口的一个偏好，跟主列表无关。
ipcMain.handle('upload:setUser', (e, user) => {
  settings.nasUser = String(user || '').trim()
  saveSettings()
  return settings.nasUser
})
ipcMain.handle('upload:listDates', (e, user) => {
  const res = uploadCore.listUploadedDates(user ? { user: String(user) } : undefined)

  // 顺带重核底栏那条「今天还没上报」。
  //
  // Why 挂在这里：这次 NAS 读**本来就在发生**（你打开或刷新了上报日历），
  // 从它的结果里读出"今天有没有目录"是零成本的，而且这正是你报完之后
  // 让指示立刻消失的那条路 —— 否则要等下一个提醒点才更新。
  //
  // 只在**看的是自己那份**时才据此下结论：日历上可以切到别人的域账号看，
  // 拿别人的目录去断言"我今天报了没"是典型的张冠李戴（铁律 9）。
  const mine = !user || String(user) === String(settings.nasUser || '')
  if (mine && pastPendingHour(new Date())) {
    const today = uploadCore.localDate()
    const hit = res.ok ? res.dates.find((d) => d.date === today) : null
    applyPendingResult(
      { ok: !!res.ok, uploaded: !!(hit && hit.sessions > 0), reason: res.reason || '' },
      today,
    )
  }

  return Object.assign(res, { plugin: uploadCore.resolvePlugin() }, nasEnv())
})
ipcMain.handle('upload:listSessions', (e, date, user) => uploadCore.listUploadedSessions(
  String(date || ''), user ? { user: String(user) } : undefined,
))

// 「打开共享」——**不是**代你挂载。
//
// 挂载走系统级 SMB 认证：域账号+密码只能由你本人在系统弹出的认证框里输入。
// 看板（和 skill 的脚本一样）从不读取、不询问、不缓存任何密码 —— 凭据绝不落地明文。
// 这个按钮做的事就是把你送到那个认证框前：用资源管理器打开 UNC 路径，
// 没认证过的话 Windows 自己会弹框。域内机器且用域账号登录时往往直接就通了
// （Kerberos/NTLM 单点登录），压根不用手动映射。
// macOS 上这个按钮**不能**照搬 openPath。
//
// Windows 的机制是：打开 UNC 路径 -> 资源管理器发现没认证 -> 系统弹 SMB 认证框，
// 所以"打开路径"本身就是"去认证"。mac 没有这条：未挂载时 /Volumes/研发专用/…
// 这个目录**压根不存在**，openPath 只会返回一个错误字符串，点了没反应 ——
// 而这正是最需要它管用的时刻（要连的时候必然还没挂上）。
//
// mac 的等价入口是 smb URL：openExternal('smb://…') 让访达去连，没认证过时
// 访达自己弹认证框（与 skill 给 mac 的挂载步骤同一条路）。密码仍然只由本人
// 在系统的框里填，看板不读、不问、不存 —— "不碰凭据"这条性质不变。
ipcMain.handle('upload:openShare', async () => {
  const root = uploadCore.nasRoot()
  if (process.platform === 'darwin') {
    // 已经挂上了就直接开目录（此时 openPath 是对的，还省一次访达连接）
    let mounted = false
    try { mounted = fs.statSync(root).isDirectory() } catch (_) { mounted = false }
    if (mounted) {
      const err = await shell.openPath(root)
      return { ok: !err, path: root, error: err || '', via: 'open_path' }
    }
    const smb = uploadCore.nasSmbUrl()
    // env 覆盖了根路径时服务器地址无从推导，如实说不知道，别编一个去连
    if (!smb) return { ok: false, path: root, error: 'CC_SESSION_NAS_DIR 指向自定义路径，看板推不出服务器地址', via: 'none' }
    try {
      await shell.openExternal(smb)
      return { ok: true, path: smb, error: '', via: 'smb' }
    } catch (e) {
      return { ok: false, path: smb, error: String((e && e.message) || e), via: 'smb' }
    }
  }
  // shell.openPath 返回错误字符串（空串 = 成功），不抛异常
  const err = await shell.openPath(root)
  return { ok: !err, path: root, error: err || '', via: 'open_path' }
})

// 开一个**交互式** Claude 会话窗口并把提示词填进去。
//
// `claude [prompt]`（不带 -p）就是交互式 + 初始提示，正合用 —— 你在那个窗口里
// 可以接着对话，而不是拿一段一次性输出。
//
// 为什么用 mintty 而不是 cmd：提示词是中文。走 `cmd.exe /c start ...` 时命令行要过
// 控制台代码页，中文会乱码（与 CLAUDE.md 铁律 3 同一个根因）。这里用 Node 的
// spawn 直接拉 mintty，args 经 CreateProcess 以 UTF-16 传递、全程不经 cmd 解析，
// 而 mintty/bash 本身是 UTF-8 的。cmd 只作最后兜底，且会在日志里说明可能乱码。
//
// --plugin-dir：那个插件是 project 作用域装的，不显式加载的话，在别的目录起的
// 会话看不见 cc-session-nas-upload。显式给上就不依赖你在哪个目录起。
// async：mac 分支要等 `open` 的退出码才知道成不成，不能先回一个 ok 再看结果
ipcMain.handle('upload:openClaude', async (e, prompt) => {
  const text = String(prompt || '').trim()
  if (!text) return { ok: false, reason: 'empty_prompt' }
  const p = uploadCore.resolvePlugin()
  const home = require('os').homedir()

  // bash 单引号内只有单引号需要转义，其余（含中文、空格）原样安全
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
  // 提示词作为位置参数直接带上：一步到位，不用人再粘一次。
  //
  // **这条路的代价是知情选择的**，实测清楚：`claude "初始提示"` 起出来的会话
  // 既不写 sessions/<pid>.json、也不落 transcript。于是
  //   · 拿不到上下文百分比、心跳、真实标题（标题退回你敲的那句）
  //   · **该会话自己不会被归档**（skill 上报的就是 transcript 切片）
  //   · **不能 --resume**，窗口关掉就找不回来
  // 前两条对"临时开个窗口让它去上报"无所谓；最后一条要留意 ——
  // 别在这个窗口里做需要留存的活。
  //
  // 排除过程（都有实测，别重复走）：不是 winpty（正常注册的会话父链同样是
  // winpty）；不是非交互 shell（换成 `bash --rcfile ... -i` 后仍然不落盘，
  // SHLVL 一直是 3 —— 那是 npm 的 claude shell 外壳套出来的层数，与这一层无关）。
  // 剩下唯一站得住的嫌疑就是位置参数本身。
  //
  // **不碰剪贴板**：提示词已经自动提交了，再写一份是多余的；而静默覆盖用户
  // 剪贴板里的东西是实打实的打扰 —— 他可能正拿着别的内容准备粘。
  const parts = ['claude']
  if (p.ok && p.installPath) parts.push('--plugin-dir', q(p.installPath))
  parts.push(q(text))

  // 走 --rcfile + -i（**交互式** shell），不用 `bash -l -c`。
  //
  // Why：`-c` 是非交互 shell。实测这么起出来的会话 Claude Code **不落盘** ——
  // 既不写 sessions/<pid>.json、也不写 transcript，于是看板拿不到判活信源、
  // 算不出上下文百分比、也读不到标题（hook 那侧全正常，你敲的话都记下了）。
  // 两个会话的 env 指纹几乎一致，唯一差别是 SHLVL（1 vs 3），指向"是否交互式"
  // 这条判据。改成交互式 shell 是目前唯一有证据支撑的方向。
  //
  // rcfile 里带中文提示词，所以必须用 fs 以 utf8 写（禁止 shell 重定向 —— 那会
  // 走控制台代码页把中文写坏，与 CLAUDE.md 铁律 3 同一个根因）。
  const rc = path.join(app.getPath('temp'), 'cc-board-launch.sh')
  const script = [
    '# 看板「上报当日」生成，每次覆盖',
    'source ~/.bash_profile 2>/dev/null || source ~/.profile 2>/dev/null',
    'cd ' + q(home),
    // 这个窗口的会话不落盘（见上），提前说清楚，免得有人在这儿干正事
    'echo "[看板] 临时会话：不会被归档、也不能 --resume。要留存的活请另开窗口。"',
    'echo',
    parts.join(' '),
    'echo; echo "[会话已结束，窗口保留]"',
  ].join('\n') + '\n'

  // macOS：同一段 bash 写成 .command 文件交给「终端」。**在写 rcfile 之前分叉** ——
  // 那个 rcfile 只有 mintty 用得上，在 mac 上写它等于在临时目录里留一个永不执行
  // 的文件，还会让"写失败"变成一条与本平台无关的报错。
  //
  // Why 用 `open -a Terminal <file>`：mac 上没有 mintty，而这是唯一不需要
  // AppleScript 自动化权限、也不经任何 shell 解析的开窗方式（中文提示词在文件里，
  // 以 utf8 落盘，终端按 UTF-8 读 —— 与 Windows 侧躲开控制台代码页同一个理由）。
  //
  // .command 必须带执行位，否则终端拒绝运行；交叉打包时 NTFS 存不住执行位，
  // 所以每次生成都显式 chmod，不指望包里的权限。
  //
  // **这条路径未在真机实测**（开发机是 Windows），所以结果如实回报、不假装成功。
  // 原先这里没有 mac 分支，会掉进下面的 cmd.exe 兜底：spawn 对不存在的可执行
  // 文件不同步抛错，try/catch 抓不到，于是返回 ok:true（谎报"已开窗口"），
  // 而那个 ChildProcess 还会异步 emit 一个没人监听的 'error' 事件 ——
  // Node 对此是抛出，即主进程一个未捕获异常。
  if (process.platform === 'darwin') {
    const cmdFile = path.join(app.getPath('temp'), 'cc-board-launch.command')
    try {
      fs.writeFileSync(cmdFile, '#!/bin/bash\n' + script, 'utf8')
      fs.chmodSync(cmdFile, 0o755)
    } catch (err) {
      return { ok: false, reason: 'command_write_failed: ' + String((err && err.message) || err) }
    }
    return await new Promise((resolve) => {
      execFile('/usr/bin/open', ['-a', 'Terminal', cmdFile], { timeout: 15000 }, (err) => {
        resolve(err
          ? { ok: false, reason: 'open_terminal_failed: ' + err.message }
          : { ok: true, via: 'terminal' })
      })
    })
  }

  try { fs.writeFileSync(rc, script, 'utf8') } catch (err) {
    return { ok: false, reason: 'rcfile_write_failed: ' + String((err && err.message) || err) }
  }
  // MSYS 路径：mintty 里的 bash 认 /c/... 而不是 C:\...
  const rcMsys = '/' + rc.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase())

  const MINTTY = 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe'
  try {
    if (fs.existsSync(MINTTY)) {
      const child = spawn(MINTTY, ['-w', 'max', '/usr/bin/bash', '--rcfile', rcMsys, '-i'], {
        // cwd 必须显式给 —— 子进程默认继承 Electron 的工作目录，而看板是被
        // 快捷方式/脚本拉起来的，那个目录可能是任何地方（实测见过
        // `C:\Program Files\Git`）。会话的 cwd 决定看板列表里那一行的项目名，
        // 不给就会出现"项目显示成 Git"这种看不懂的数据。
        cwd: home,
        detached: true, stdio: 'ignore', windowsHide: false,
      })
      // 必须挂 'error'：spawn 对"可执行文件不存在/被策略挡住"是**异步** emit
      // 'error' 而不是同步抛错，外面的 try/catch 抓不到；而 ChildProcess 是
      // EventEmitter，没人监听的 'error' 事件 Node 直接抛 —— 那就是主进程一个
      // 未捕获异常（打包版上表现为"点一下就崩"）。只留痕不改返回值：窗口已经
      // detached 出去了，这里回不了头。
      child.on('error', (err) => { console.warn('[board] openClaude mintty error: ' + err.message) })
      child.unref()
      return { ok: true, via: 'mintty' }
    }
    // 兜底：cmd。中文提示词在这条路上**可能乱码**，如实回给界面。
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', 'claude', text], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.on('error', (err) => { console.warn('[board] openClaude cmd error: ' + err.message) })
    child.unref()
    return { ok: true, via: 'cmd', warn: 'cmd 路径下中文提示词可能乱码' }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
})

// 直连被拒时的退路：拉起系统「映射网络驱动器」向导。
// 同样只是打开向导，账号密码仍由你在向导里填，并且要**勾上「记住我的凭据」**——
// 不勾的话下次重连还得再输一遍。
//
// **Windows 专有，且这不是缺口**：Windows 有两套机制（透明认证 / 凭据向导），
// 所以有两个按钮；mac 只有一套（访达连接服务器 -> 认证框 -> 勾"存入钥匙串"），
// 上面的 openShare 已经把它整条走完了。所以 mac 这里如实报不支持，由界面换成
// 「拷贝服务器地址」+ mac 口径的步骤说明 —— 而不是留一个点了什么都不发生的按钮
// （原先 execFile('rundll32.exe') 在 mac 上失败进回调、却照样 return ok:true，
//  是货真价实的谎报成功）。
ipcMain.handle('upload:mapDrive', () => {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported_platform' }
  try {
    execFile('rundll32.exe', ['shell32.dll,SHHelpShortcuts_RunDLL', 'Connect'], { windowsHide: false }, () => { })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

// ---- 上报提醒 ----
//
// 到点提醒"今天该上报会话了"，当天已经报过就不提醒。判定全在 upload-core：
// dueReminders（现在到点了没，纯函数）+ hasUploadedOn（今天报了没，读 NAS）。
//
// 每 30 秒看一眼钟，但**只有到点那一次才真去读 NAS** —— 一天最多四次网络读。
// 绝不能挂到 1.5 秒的 tick 上：那等于后台轮询共享盘，会破掉看板"无后台网络
// 出口"这条性质（与上报窗口同一条纪律）。
const REMIND_CHECK_MS = 30000

// ---- 底栏「今天还没上报」指示 ----
//
// 与上面的提醒是同一件事的两种呈现：提醒是**敲你一下**（一天几次），这条是
// **常驻的欠账指示**（看一眼就知道今天这笔还欠着）。所以判定完全复用提醒那套
// （hasUploadedOn 读 NAS + remindDoneDate 当天记忆），不另起一条判据。
//
// 只在 17:30 之后出现：更早出现没有意义 —— 一天还没过完，"还没上报"是常态，
// 常态不该占底栏一格（与 health 灯、offhint 同一条原则：正常无需发声）。
const PENDING_AFTER_MIN = 17 * 60 + 30

// NAS 读的时机是这条功能唯一的设计风险，写死在这里：
//   ① 过 17:30 之后的第一次 30 秒周期（每天一次）
//   ② 四个提醒点各自那次（本来就要读，顺带更新，零额外开销）
//   ③ 你打开 / 刷新上报日历时（同样是本来就在读）
// **绝不进 tick()** —— 1.5 秒一轮去 stat 共享盘就是后台轮询 NAS，
// 会破掉看板"无后台网络出口"这条性质（CLAUDE.md 上报提醒那节的第四条）。
// 代价（知情接受）：你在 17:40 报完，这条指示最晚要等到 18:00 那次提醒才消失；
// 想立刻消掉就点它一下 —— 那会打开上报日历，而日历加载本身就会重核。
let uploadPending = null
let pendingCheckedDate = ''

// 现在过 17:30 了没。纯时钟判断，不碰任何 IO —— 每 30 秒都要问一次。
function pastPendingHour(now) {
  return (now.getHours() * 60 + now.getMinutes()) >= PENDING_AFTER_MIN
}

/**
 * 重算「今天还没上报」的指示状态。
 *
 * @param {{ok:boolean, uploaded:boolean, reason?:string}} r hasUploadedOn 的结果
 * @param {string} date 本地日期（YYYY-MM-DD）
 */
function applyPendingResult(r, date) {
  pendingCheckedDate = date
  // 已经报过 -> 这条指示直接消失。事做完了就不该继续在底栏挂着一句欠账，
  // 那是"一个看着开着、其实已经不成立"的提示（与提醒当天不再打扰同一条）。
  if (r && r.ok && r.uploaded) {
    remindDoneDate = date
    uploadPending = null
    return
  }
  // ok=false 是"核对不了"（没设域账号 / NAS 读不到），**不等于没报**，
  // 但也绝不能当成已报把指示藏掉 —— 藏掉就是拿"不知道"冒充"安全"。
  // 照常显示，并在文案里说清没核对上，由人自己判断。
  uploadPending = {
    verified: !!(r && r.ok),
    reason: (r && r.reason) || '',
    checkedMs: Date.now(),
  }
}

let remindTimer = null
// 上一次 NAS 读还没回来就不叠第二次：SMB 挂住时能拖十几秒，30 秒的周期会往上摞
let remindBusy = false
// 当天已核实"报过了"。核实到之后当天不再读 NAS，也不再提醒 —— 事已经做完了
let remindDoneDate = ''

// 当前提醒规则的一句话描述。菜单标签和对话框共用，免得两处各写一套措辞
function describeRemind() {
  if (!settings.uploadRemind) return '关闭'
  const t = settings.uploadRemindTimes || []
  return t.length ? t.join(' ') : '没选时间'
}

// 记账：这几个点今天处理过了。**不管结果是"提醒了"还是"查到已报"都要记** ——
// 尤其是读 NAS 失败那次，不记的话下一个 30 秒周期立刻重来，直到读通为止，
// 断网的晚上会变成每半分钟一条通知。
function markRemindFired(date, due) {
  const keep = (settings.uploadRemindFiredDate === date && Array.isArray(settings.uploadRemindFired))
    ? settings.uploadRemindFired : []
  settings.uploadRemindFiredDate = date
  settings.uploadRemindFired = keep.concat(due.filter((t) => !keep.includes(t)))
  saveSettings()
}

async function checkUploadReminder() {
  if (!settings.uploadRemind || remindBusy) return
  const now = new Date()
  const { date, due } = uploadCore.dueReminders({
    now,
    times: settings.uploadRemindTimes,
    firedDate: settings.uploadRemindFiredDate,
    fired: settings.uploadRemindFired,
  })

  // 跨天先清账：昨天的结论（"已报"记忆、指示状态）今天一律不算数。
  // 不清的话，昨晚报过之后看板一直开着，今天 17:30 会因为 remindDoneDate
  // 还停在昨天而直接跳过核对，指示永远不出现。
  if (pendingCheckedDate && pendingCheckedDate !== date) {
    pendingCheckedDate = ''
    uploadPending = null
  }

  // 底栏指示的**每日第一次**核对：过了 17:30 且今天还没核过。
  // 与下面提醒点那次共用同一个 remindBusy 闸和同一个 hasUploadedOn，
  // 所以每天最多多出这一次 NAS 读。
  if (pastPendingHour(now) && pendingCheckedDate !== date && remindDoneDate !== date) {
    remindBusy = true
    let pr
    try {
      pr = await uploadCore.hasUploadedOn(date,
        settings.nasUser ? { user: settings.nasUser } : undefined)
    } catch (_) {
      pr = { ok: false, reason: 'error' }
    }
    remindBusy = false
    applyPendingResult(pr, date)
  }

  if (!due.length) return
  // 今天已核实报过：后面的点直接记掉，不必再为它们各读一次 NAS
  if (remindDoneDate === date) { markRemindFired(date, due); return }

  remindBusy = true
  let r
  try {
    r = await uploadCore.hasUploadedOn(date,
      settings.nasUser ? { user: settings.nasUser } : undefined)
  } catch (err) {
    r = { ok: false, reason: 'error' }
  }
  remindBusy = false
  markRemindFired(date, due)
  // 这次读本来就要发生，顺带把底栏指示一起更新 —— 零额外网络开销。
  // 这也是"17:40 报完、18:00 那次提醒把指示抹掉"的那条路径。
  applyPendingResult(r, date)

  if (r.ok && r.uploaded) { remindDoneDate = date; return }

  // 核对不上时**照常提醒**，但正文里说清没核对上。
  //
  // Why 不静默跳过：域账号填错、NAS 抽风、在家没挂 VPN 都会走到这里，静默的话
  // 提醒功能整个失效而你不会知道 —— 一个看起来开着、实际不响的开关比没有更糟。
  // 代价是断网的晚上会按你设的点数被敲几次，那是明说过的取舍。
  const why = {
    nas_unreachable: 'NAS 读不到，没能核对',
    no_user_dir: '域账号目录不存在，没能核对',
    no_user: '没设域账号，没能核对',
    error: '核对出错',
  }[r.reason]
  showNotification(
    '今天该上报会话了',
    why ? (why + ' —— 已经报过就忽略这条') : '今天还没有上报记录 · 点这里打开上报日历',
    // 提醒是不是响铃跟着全局的「提醒响铃」走；但**不受「系统通知」管** ——
    // 那个开关管的是会话状态跃变的轰炸，跟一天四次的上报提醒不是一回事，
    // 上报提醒有自己的开关。
    !settings.sound,
    '',
    () => openUploadPanel(),
  )

  // 提醒但不抢焦点，与会话跃变提醒同一套：Windows 闪任务栏，macOS 弹 Dock
  if (win && !win.isDestroyed() && !win.isFocused()) {
    if (process.platform === 'darwin') { try { app.dock.bounce('informational') } catch (_) { } }
    else { try { win.flashFrame(true) } catch (_) { } }
  }
}

// 提醒设置走自绘对话框（原生菜单没有输入控件，先例见自动删除阈值那条）。
//
// 时间格式的权威只有 upload-core.parseTimes 一处：渲染层把原始输入整个送过来，
// 看不懂的条目由这里回报、由它显示。两边各写一套正则的话，迟早出现
// "对话框收了、落盘时被丢掉"这种静默不一致。
ipcMain.handle('board:setRemind', (_e, on, rawTimes) => {
  const { times, dropped } = uploadCore.parseTimes(rawTimes)
  // 有看不懂的就整个不保存 —— 半套生效比不生效更难查
  if (dropped.length) return { ok: false, dropped }
  settings.uploadRemind = !!on
  settings.uploadRemindTimes = times
  saveSettings()
  return { ok: true, on: settings.uploadRemind, times }
})

// 自绘设置面板里点「修改提醒时间…」-> 复用原生菜单那条同样的对话框链路，
// 不为面板另写一份（参数与默认值都从 upload-core 带过去，只有一处权威）。
ipcMain.on('board:askRemindTimesNow', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('board:askRemindTimes', {
      on: !!settings.uploadRemind,
      times: (settings.uploadRemindTimes || []).slice(),
      defaults: uploadCore.DEFAULT_REMIND_TIMES.slice(),
      nasUser: String(settings.nasUser || ''),
    })
  }
})

ipcMain.on('board:settingsMenu', (e) => {
  const cb = (label, key) => ({
    label,
    type: 'checkbox',
    checked: !!settings[key],
    click: (item) => applySetting(key, !!item.checked),
  })
  const foldedLabel = lastFolded > 0 ? ('显示全部（' + lastFolded + '）') : '显示全部'

  const menu = Menu.buildFromTemplate([
    cb('窗口置顶', 'alwaysOnTop'),
    // mac 上那个常驻图标住在菜单栏、不叫托盘；说错地方等于让人去找一个不存在的东西
    cb(process.platform === 'darwin' ? '最小化到菜单栏' : '最小化到托盘', 'trayOnMinimize'),
    { type: 'separator' },
    cb('提醒响铃', 'sound'),
    cb('系统通知', 'notify'),
    // 上报提醒自成一组（子菜单），和「外观」「自动删除残留记录」同一个处理 ——
    // 它有两个东西要管（开关 + 时间点），平铺在顶层会和「提醒响铃」「系统通知」
    // 这些单开关混在一起，层级读不出来。
    {
      label: '会话上报提醒',
      submenu: [
        // 开关做成真 checkbox。之前只有一个"带括号的普通项"，夹在两个真 checkbox
        // 中间却没有勾，一眼看过去像是关着的 —— 实测被误读过。
        cb('开启提醒', 'uploadRemind'),
        { type: 'separator' },
        {
          // 时间是多选且允许非整点，原生菜单表达不了，所以走自绘对话框。
      // 标签**不要**前置空格做缩进：原生菜单里 checkbox 会占一列，
      // 缩进出来的空白正好落在那一列上，看着就是"一个没打勾的复选框"（实测被这么读过）。
      // 它是动作项不是开关，靠动词 + 省略号表达"点了会弹窗"就够。
      //
      // 当前时间点**不写进标签**：值在对话框里就看得见，写在这儿只是让菜单变长
      // （四个时间点能占半行）。改放 toolTip —— 想确认时悬停一下，不占版面。
      label: '设置提醒时间…',
      toolTip: '当前：' + describeRemind() + '\n'
        + '到点提醒你上报当天的会话；当天已经报过就不再提醒。'
        + '不受「系统通知」开关管，它有自己的开关',
      click: () => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('board:askRemindTimes', {
            on: !!settings.uploadRemind,
            times: (settings.uploadRemindTimes || []).slice(),
            // 「恢复默认」要用的那一组，从数据层带过去 ——
            // 渲染层自己抄一份的话，改了默认值必然漏掉其中一处
            defaults: uploadCore.DEFAULT_REMIND_TIMES.slice(),
            // 核对靠的就是这个账号，空着要在对话框里明说，否则"为什么老提醒"无从查起
            nasUser: String(settings.nasUser || ''),
          })
        }
          },
        },
      ],
    },
    { type: 'separator' },
    { ...cb(foldedLabel, 'showFolded'), label: foldedLabel },
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
    // 通知的"应用身份"。不设的话 Windows 只能拿 exe 名兜底，通知卡片顶部
    // 那行归属看着不像自家应用；设了之后同一应用的通知还会归成一组，
    // 不再一条条散落在操作中心里。
    //
    // 放在最前面：必须早于任何一条通知发出，而 first-run 的引导框之后
    // 就可能弹通知了。macOS 上这个调用是空操作，不用加平台判断。
    if (process.platform === 'win32') app.setAppUserModelId('ClaudeCode.SessionBoard')

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

    // 进程身份 / 脱钩探测单独一个慢周期，**绝不搭 tick 的车** ——
    // 它要起一个 powershell（约 300ms），混进 1.5 秒的循环就是每秒钟
    // 拉一个进程起来。脱钩本身是低频事件（实测 5 天 2 次），30 秒足够灵敏。
    // 首次立刻探一次：不探的话开板后头 30 秒里脱钩的行会显示成「等你输入」，
    // 而那正是人开板第一眼要看的时候。
    probeTick()
    probeTimer = setInterval(probeTick, PROBE_MS)

    // 上报提醒单独一个慢周期，不搭 tick 的车 —— 它到点要读 NAS，
    // 混进 1.5 秒的循环就成了后台轮询共享盘。首次检查也等这 30 秒：
    // 开机那一刻正忙，没必要再挤一次网络读进去。
    remindTimer = setInterval(checkUploadReminder, REMIND_CHECK_MS)

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

  // macOS 习惯：点 Dock 图标重新开窗口。
  // **窗口存在但被隐藏时也要叫回来** —— 「最小化到托盘」走的是 win.hide()，
  // 只判 !win 的话那个窗口在 macOS 上就被困住了：Dock 点击没反应，
  // 只能去菜单栏图标里找「显示看板」。
  app.on('activate', () => { if (!win) createWindow(); else showWindow() })

  // 关掉窗口不退出（托盘还在），与 macOS 的常规行为一致；
  // Windows 上也保留这个语义 —— 看板本来就是常驻工具。
  app.on('window-all-closed', () => { })

  app.on('before-quit', () => {
    if (timer) clearInterval(timer)
    if (remindTimer) clearInterval(remindTimer)
    saveSettings()
  })
}

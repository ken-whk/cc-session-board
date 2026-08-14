#!/usr/bin/env node
'use strict'

// 已上报归档 —— 数据层。
//
// 职责是回答"我报过什么"这一类问题，共两问：
//   ① 我哪天报过哪些会话（归档浏览，给上报日历窗口用）
//   ② 今天报了没 / 现在该不该提醒（给主进程的上报提醒用）
// 不列本地会话、不做勾选、不执行上报 —— 上报走 cc-session-nas-upload skill 本身。
//
// Why 只做这一半：skill 的 `list` 已经把"选哪些会话"做得更好（它带 uploadState /
// 待报条数 / 已归档到哪一刻，那是做这个决策真正需要的信息，而看板本地拿不到 ——
// 那些字段必须比对 NAS 才有）。看板在这件事上重复造只会造出一个信息更少的列表。
// 反过来，"我报过哪些"是 skill 结构上不提供的（它没有 history 子命令），
// 读 NAS 目录正好补位。两边不重叠。
//
// 单独一个模块而不是塞进 board-core.js：后者的职责是"该切到哪个会话去"，每 1.5 秒
// 跑一次；这里碰的是 SMB 网络读，混进去迟早有人把 NAS 读进刷新循环。
//
// 自检：node upload-core.js

const fs = require('fs')
const fsp = require('fs').promises
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude')

const INSTALLED_PLUGINS = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')

// 产出这些归档的插件。看板不调它，只用它的版本号判断"我读 metadata 的字段口径还准不准"。
const PLUGIN_KEY = 'aisdlc-saas-extension@aisdlc-saas-extension'

// 看板复核过的插件版本。不一致 -> 界面挂提示，但**不阻断**。
//
// Why 需要：metadata 的字段口径是随 skill 版本变的。0.7.x -> 0.8.0 就把产物从
// "全量副本"改成了"增量切片"，`stats` 从"整个会话"变成"本切片"—— 字段名可以一个没动，
// 含义全变了，那种情况下看板会照常渲染一个含义已经不对的数字，不报错。
// 我自己也踩过一次同类问题：照顶层读 `sessionId` / `firstPrompt`，而它们实际在
// `source` 下，结果是整列静默空白。所以宁可让"版本变了"显式可见，由人复核一次。
const REVIEWED_PLUGIN_VERSION = '0.9.0'

/**
 * 解析产出归档的插件版本，用于判断字段口径是否还是看板复核过的那一版。
 *
 * 路径**绝不硬编码**：安装目录带版本号，插件一升级就换目录，硬编码不会报错、
 * 只会继续对着旧版本读 —— 静默失效比崩掉难查。`installed_plugins.json` 是
 * Claude Code 自己维护的第一方清单，升级时跟着更新，所以每次现读。
 */
function resolvePlugin() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, 'utf8'))
  } catch (_) {
    return { ok: false, reason: 'no_installed_plugins_json' }
  }
  const entries = (raw && raw.plugins && raw.plugins[PLUGIN_KEY]) || []
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: 'plugin_not_installed' }
  }
  const pick = entries.find((e) => e && e.scope === 'user') || entries[0]
  return {
    ok: true,
    // 起交互会话时用 --plugin-dir 显式加载它：这个插件是 project 作用域装的，
    // 不显式加载的话在别的目录起的会话看不见 cc-session-nas-upload
    installPath: String(pick.installPath || ''),
    version: String(pick.version || ''),
    sha: String(pick.gitCommitSha || '').slice(0, 8),
    scope: String(pick.scope || ''),
    reviewed: String(pick.version || '') === REVIEWED_PLUGIN_VERSION,
    reviewedVersion: REVIEWED_PLUGIN_VERSION,
  }
}

// NAS 根。与 skill 的默认推导保持一致，允许环境变量覆盖。
// 不做"探测多个候选路径"那套：那是 skill 脚本的职责，看板只读它约定的位置，
// 读不到就如实说读不到。
function nasRoot() {
  if (process.env.CC_SESSION_NAS_DIR) return process.env.CC_SESSION_NAS_DIR
  if (process.platform === 'win32') return '\\\\172.17.100.110\\研发专用\\AI_SDLC'
  return '/Volumes/研发专用/AI_SDLC'
}

// 上报目录名的**推测值**。skill 默认取 git config user.email 的 @ 前半段。
//
// 只是推测：SKILL.md 自己写着"这个默认值**不一定等于域账号**"—— 域账号是登录 NAS
// 用的，git email 是另一套身份。实测本机推出来是 `ken-whk`（看板仓的 repo-local 身份），
// 几乎肯定不是域账号。所以 NAS 可达时优先走 listExportUsers() 枚举真实存在的目录，
// 推测值只用来在候选里做默认高亮。猜错的表现是"明明报过却说没有历史"，很难自查。
function guessExportUser() {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (email && email.includes('@')) return email.split('@')[0]
  } catch (_) { /* 没装 git / 没配 email -> 退系统用户名 */ }
  try { return os.userInfo().username } catch (_) { return '' }
}

/**
 * 枚举 NAS 上真实存在的上报目录（= 各人的域账号）。
 * 这是"我的归档在哪"的正门：与其猜域账号，不如看盘上到底有哪些目录，让人选一次。
 */
function listExportUsers(opts) {
  const root = (opts && opts.root) || nasRoot()
  const base = path.join(root, 'exports')
  const res = { ok: false, root, base, users: [], guess: guessExportUser() }
  try {
    res.users = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()
    res.ok = true
  } catch (_) {
    res.reason = 'nas_unreachable'
  }
  return res
}

/**
 * 列出已上报的日期。
 *
 * **只在用户打开/刷新面板时调用，绝不能进刷新循环** —— 这是 SMB 网络读，
 * 放进 1.5 秒的 tick 里等于后台轮询 NAS，会破掉看板"无后台网络出口"这条性质。
 *
 * @returns {{ok:boolean, reason?:string, root:string, user:string, base:string,
 *            dates:Array<{date:string, sessions:number, projects:number}>}}
 */
function listUploadedDates(opts) {
  const root = (opts && opts.root) || nasRoot()
  const user = (opts && opts.user) || guessExportUser()
  const base = path.join(root, 'exports', user)
  const res = { ok: false, root, user, base, dates: [] }
  if (!user) { res.reason = 'no_user'; return res }

  let names = []
  try { names = fs.readdirSync(base) } catch (_) {
    // ENOENT 有两种完全不同的成因，对人的处置也不同，所以分开报：
    // 根目录都读不到 = 没挂载；根在但自己那个目录没有 = 账号名不对或还没报过。
    let rootOk = false
    try { rootOk = fs.statSync(root).isDirectory() } catch (_) { rootOk = false }
    res.reason = rootOk ? 'no_uploads_yet' : 'nas_unreachable'
    return res
  }

  for (const n of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) continue
    const dayDir = path.join(base, n)
    let projects = 0
    let sessions = 0
    try {
      for (const p of fs.readdirSync(dayDir, { withFileTypes: true })) {
        if (!p.isDirectory()) continue
        projects++
        try {
          sessions += fs.readdirSync(path.join(dayDir, p.name))
            .filter((f) => f.endsWith('.metadata.json')).length
        } catch (_) { /* 单个项目目录读不到就不计，不影响其余 */ }
      }
    } catch (_) { continue }
    res.dates.push({ date: n, sessions, projects })
  }
  res.dates.sort((a, b) => (a.date < b.date ? 1 : -1))
  res.ok = true
  return res
}

/**
 * 列出某个上报日期下的会话明细。
 *
 * 注意目录日期是**上报日**不是内容日：某天的切片可能覆盖前面好几天
 * （skill 会自动补齐漏报的空档），实际范围看 coversFrom / coversTo。
 */
function listUploadedSessions(date, opts) {
  const root = (opts && opts.root) || nasRoot()
  const user = (opts && opts.user) || guessExportUser()
  const dayDir = path.join(root, 'exports', user, date)
  const res = { ok: false, date, dayDir, sessions: [] }

  let dirs = []
  try {
    dirs = fs.readdirSync(dayDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (_) { res.reason = 'day_unreadable'; return res }

  for (const d of dirs) {
    const pdir = path.join(dayDir, d.name)
    let files = []
    try { files = fs.readdirSync(pdir) } catch (_) { continue }
    for (const f of files) {
      if (!f.endsWith('.metadata.json')) continue
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')) } catch (_) { meta = {} }
      // 字段路径按 SKILL.md 的 metadata 字段表：sessionId 与首条提问都在 `source` 下，
      // 不是顶层。照顶层读会静默得到空值（提问那一列整片空白）—— 核对过才发现。
      const source = meta.source || {}
      const stats = meta.stats || {}
      const slice = meta.slice || {}
      const whole = slice.session || {}
      res.sessions.push({
        // source.projectName 是 skill 记下的项目真名，比目录名可信；退回目录名
        project: String(source.projectName || d.name),
        sessionId: String(source.sessionId || f.replace(/\.metadata\.json$/, '')),
        // stats 是**本切片**口径不是整个会话；两个都给，界面才能说清"这次报了多少 / 一共多少"
        msgCount: Number(stats.msgCount) || 0,
        totalMsgCount: Number(whole.totalMsgCount) || 0,
        // 0.7.x 的旧产物没有 slice 字段，留空而不是编一个范围出来
        coversFrom: slice.coversFrom || '',
        coversTo: slice.coversTo || '',
        isContinuation: !!slice.isContinuation,
        feedbacks: Array.isArray(meta.feedbacks) ? meta.feedbacks.length : 0,
        firstPrompt: String(source.firstUserMsg || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      })
    }
  }
  res.sessions.sort((a, b) => (a.project === b.project
    ? b.msgCount - a.msgCount
    : (a.project < b.project ? -1 : 1)))
  res.ok = true
  return res
}

// ---- 上报提醒 ----
//
// 提醒要回答两个问题，一个碰网络、一个不碰，所以分开写：
//   hasUploadedOn  —— 今天报了没（读 NAS，异步）
//   dueReminders   —— 现在到哪几个提醒点了（纯函数，可构造样本验）
// 混成一个的话，判定逻辑就只能靠"真到 18 点 + NAS 通着"才验得了。

// 默认提醒时间。晚饭后到睡前这四个整点 —— 早于 18:00 那会儿一天还没过完，
// 晚于 21:00 报完就该睡了，再提醒也来不及做。
const DEFAULT_REMIND_TIMES = ['18:00', '19:00', '20:00', '21:00']

/**
 * 本地日期 key（YYYY-MM-DD）。
 *
 * **不能用 toISOString** —— 那是 UTC，东八区晚上 8 点就已经是 UTC 的 12 点、
 * 凌晨那几个小时更是整体差一天。上报目录名是按本地日期建的，口径必须一致，
 * 否则会出现"明明报过却查的是昨天的目录"。upload.html 的日历同口径。
 */
function localDate(d) {
  const dt = d || new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate())
}

/**
 * 解析提醒时间列表，返回规范化结果与看不懂的原始条目。
 *
 * 这是时间格式的**唯一权威**：菜单、对话框、落盘前都过它一遍，规则只写一次。
 * dropped 必须回给调用方 —— 静默丢掉一个填错的时间，表现是"我明明设了 22 点
 * 却不响"，而界面上什么都不会说。
 *
 * @param {Array<string>|string} list 数组，或逗号/空格分隔的串
 * @returns {{times:string[], dropped:string[]}} times 已去重并按时间升序
 */
function parseTimes(list) {
  const src = Array.isArray(list)
    ? list
    : String(list == null ? '' : list).split(/[,，、\s]+/)
  const times = []
  const dropped = []
  for (const raw of src) {
    const s = String(raw == null ? '' : raw).trim()
    if (!s) continue
    // 全角冒号一并收下：中文输入法下打出来的就是它，报错在这里毫无道理
    const m = /^(\d{1,2})[:：](\d{1,2})$/.exec(s)
    if (!m) { dropped.push(s); continue }
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h > 23 || mi > 59) { dropped.push(s); continue }
    const t = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
    if (!times.includes(t)) times.push(t)
  }
  times.sort()
  return { times, dropped }
}

/**
 * 现在到点的提醒有哪几个。**纯函数**，不碰时钟以外的任何东西。
 *
 * 判据是"过点且今天还没记过账"，不设宽限窗口：看板 20:30 才开机时，18/19/20
 * 三个点一起到期、合并成一条提醒 —— 那正是你想知道的（今天还没报）。
 * 反过来给宽限窗口的话，关着看板的那几个小时会把提醒整个吞掉。
 *
 * 记账（fired）按天失效：firedDate 不是今天就当空的，跨天自动重置，
 * 不需要谁在半夜去清一次。
 *
 * @param {{now?:Date, times?:string[], firedDate?:string, fired?:string[]}} opts
 * @returns {{date:string, due:string[]}} due 为空 = 现在什么都不用做
 */
function dueReminders(opts) {
  const o = opts || {}
  const now = o.now || new Date()
  const date = localDate(now)
  const times = Array.isArray(o.times) ? o.times : []
  const fired = (o.firedDate === date && Array.isArray(o.fired)) ? o.fired : []
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const due = []
  for (const t of times) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(t))
    if (!m) continue
    if (Number(m[1]) * 60 + Number(m[2]) > nowMin) continue
    if (fired.includes(t)) continue
    due.push(t)
  }
  return { date, due }
}

/**
 * 某天报了没。
 *
 * **异步**（fs.promises）而不是跟本文件其余读法一样用同步 API —— 那些都是人点了
 * 才跑的，卡一下看得见原因；这个是后台定时跑的，SMB 在对端不可达时 readdir 能
 * 挂十几秒，同步版会把主进程连同 1.5 秒的刷新循环一起冻住，表现为"看板每天晚上
 * 定时卡一下"，根因极难指回这里。异步版走 libuv 线程池，事件循环照转。
 *
 * ok 与 uploaded 是**两件事**，调用方必须分开看：
 *   ok=true  uploaded=true   报过了
 *   ok=true  uploaded=false  确实没报（盘读得到，就是没有今天的目录）
 *   ok=false                 核对不了（盘读不到 / 没有域账号）—— 不等于没报
 *
 * @returns {Promise<{ok:boolean, uploaded:boolean, sessions:number,
 *                    reason?:string, date:string, user:string, base:string}>}
 */
async function hasUploadedOn(date, opts) {
  const root = (opts && opts.root) || nasRoot()
  const user = (opts && opts.user) || guessExportUser()
  const res = { ok: false, uploaded: false, sessions: 0, date, user, base: '' }
  if (!user) { res.reason = 'no_user'; return res }

  const base = path.join(root, 'exports', user)
  res.base = base
  let projects
  try {
    projects = await fsp.readdir(path.join(base, date), { withFileTypes: true })
  } catch (_) {
    // 读不到当天目录有三种成因，能不能断言"没报"完全不同，逐层往上探：
    //   账号目录在 -> 盘上确实没有今天这一天，可以断言没报
    //   账号目录不在 -> 域账号填错 / 从没报过，两者分不开，**不能**断言没报
    //   根也不在   -> 没挂载，更不能断言
    // 少中间那一层的后果很隐蔽：域账号一个字母打错，看板会一口咬定"今天没报"，
    // 而它其实什么也没看见（本文件开头那条"猜错很难自查"说的就是这个）。
    let baseOk = false
    try { baseOk = (await fsp.stat(base)).isDirectory() } catch (_) { baseOk = false }
    if (baseOk) { res.ok = true; res.reason = 'no_upload_today'; return res }
    let rootOk = false
    try { rootOk = (await fsp.stat(root)).isDirectory() } catch (_) { rootOk = false }
    res.reason = rootOk ? 'no_user_dir' : 'nas_unreachable'
    return res
  }

  for (const p of projects) {
    if (!p.isDirectory()) continue
    try {
      const files = await fsp.readdir(path.join(base, date, p.name))
      res.sessions += files.filter((f) => f.endsWith('.metadata.json')).length
    } catch (_) { /* 单个项目目录读不到就不计，不影响其余 */ }
  }
  res.ok = true
  // 目录在但一条 metadata 都没有 = 上报中途断了。判成"已上报"会让提醒当天彻底
  // 静默，而那恰恰是最需要提醒的一天，所以按没报算 —— 宁可多提醒一次。
  res.uploaded = res.sessions > 0
  if (!res.uploaded) res.reason = 'empty_day_dir'
  return res
}

module.exports = {
  resolvePlugin,
  listExportUsers,
  listUploadedDates,
  listUploadedSessions,
  guessExportUser,
  nasRoot,
  // 上报提醒：前两个是纯函数，主进程和自检都从这里取，不各写一份
  DEFAULT_REMIND_TIMES, localDate, parseTimes, dueReminders, hasUploadedOn,
}

// 直接运行 = 自检：三条读路径各跑一遍，看真实环境下是否成立
if (require.main === module) {
  console.log('plugin:', JSON.stringify(resolvePlugin()))
  const users = listExportUsers()
  console.log('export users: ok=' + users.ok + (users.reason ? ' reason=' + users.reason : '')
    + '  guess=' + users.guess + '  found=[' + users.users.join(', ') + ']')
  const dates = listUploadedDates()
  console.log('dates: ok=' + dates.ok + (dates.reason ? ' reason=' + dates.reason : ''))
  console.log('  base=' + dates.base)
  for (const d of dates.dates.slice(0, 10)) {
    console.log('  ' + d.date + '  sessions=' + d.sessions + '  projects=' + d.projects)
  }
  if (dates.dates.length) {
    const first = listUploadedSessions(dates.dates[0].date)
    console.log('detail of ' + dates.dates[0].date + ': ok=' + first.ok + '  n=' + first.sessions.length)
    for (const s of first.sessions.slice(0, 5)) {
      console.log('    ' + String(s.project).padEnd(24) + ' 本次' + String(s.msgCount).padStart(4)
        + ' 全量' + String(s.totalMsgCount).padStart(5) + (s.isContinuation ? ' 续接' : '     ')
        + '  ' + s.firstPrompt.slice(0, 30))
    }
  }

  // ---- 提醒判定：纯函数部分用构造样本跑，不依赖现在几点、也不碰 NAS ----
  //
  // Why 必须构造：这两个函数真正出错的场景（跨天重置、开机时补发、全角冒号）
  // 靠"等到那个点"验，一天只有一次机会，且失败了看不出是哪条判据错的。
  let pass = 0
  let fail = 0
  const eq = (name, got, want) => {
    const a = JSON.stringify(got)
    const b = JSON.stringify(want)
    if (a === b) { pass++; return }
    fail++
    console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b)
  }
  const at = (h, m) => new Date(2026, 7, 14, h, m, 0)
  const T = DEFAULT_REMIND_TIMES

  eq('格式：补零/全角冒号/去重/排序',
    parseTimes(['9:5', '21：00', '18:00', '18:00']).times, ['09:05', '18:00', '21:00'])
  eq('格式：看不懂的原样回报，不静默丢',
    parseTimes('18:00, 25:00, 中午, 12:61').dropped, ['25:00', '中午', '12:61'])
  eq('格式：逗号/空格/顿号混着分隔',
    parseTimes('18:00，19:00 20:00、21:00').times, T)
  eq('排期：没到点 -> 不提醒',
    dueReminders({ now: at(17, 59), times: T }).due, [])
  eq('排期：到点 -> 提醒',
    dueReminders({ now: at(18, 0), times: T }).due, ['18:00'])
  eq('排期：20:30 开机 -> 过掉的点合并成一次，不是补三条',
    dueReminders({ now: at(20, 30), times: T }).due, ['18:00', '19:00', '20:00'])
  eq('排期：记过账的不再提醒',
    dueReminders({ now: at(20, 30), times: T, firedDate: '2026-08-14', fired: ['18:00', '19:00'] }).due,
    ['20:00'])
  eq('排期：昨天的账不算数（跨天自动重置）',
    dueReminders({ now: at(20, 30), times: T, firedDate: '2026-08-13', fired: T }).due,
    ['18:00', '19:00', '20:00'])
  eq('排期：日期用本地时区，不是 UTC',
    dueReminders({ now: at(23, 30), times: T }).date, '2026-08-14')
  console.log('reminder self-check: ' + pass + ' passed, ' + fail + ' failed')

  // 今天报了没 —— 这条要碰 NAS，所以放最后、异步跑，前面的结论不受它影响
  hasUploadedOn(localDate(), { user: guessExportUser() }).then((r) => {
    console.log('today ' + r.date + ': ok=' + r.ok + ' uploaded=' + r.uploaded
      + ' sessions=' + r.sessions + (r.reason ? ' reason=' + r.reason : ''))
  })
}

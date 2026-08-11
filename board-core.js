#!/usr/bin/env node
'use strict'

// Claude 会话看板 —— 数据层（跨平台，Windows / macOS 共用）
//
// 这里只做"算出该显示什么"，不碰任何界面。
// 早期还有一份 PowerShell 平行实现，2026-08-10 已删除 —— 现在这是唯一数据层。
//
// 单独运行可作自检：
//     node board-core.js            打印当前该显示的行（表格）
//     node board-core.js --json     输出 JSON，供界面层消费

const fs = require('fs')
const os = require('os')
const path = require('path')

// ---- 可调阈值 ----

// 「运行中」但 transcript 静默超过这个时长 -> 标为「失联？」。
// 不能设太短：跑构建、发部署这类长任务期间 transcript 本来就不写。
const SILENT_STALL_MS = 5 * 60 * 1000

// 静默超过这个时长才去探"是不是卡在 AskUserQuestion 等人作答"。
// 正在刷输出的会话不可能是阻塞态，用这个门槛把绝大多数轮次的探测直接省掉。
const ASK_PROBE_AFTER_MS = 15 * 1000
const ASK_TAIL_BYTES = 64 * 1024

// 「等你输入 / 已完成」超过这个时长没被处理 -> 降级为「久候」，单独一档沉底。
// Why：不分档的话隔夜挂着的会话永远霸榜，把刚跑完的挤到最下面。
const IDLE_LONG_MS = 2 * 60 * 60 * 1000

const CLAUDE_DIR = path.join(os.homedir(), '.claude')

// 可写数据（state / UI 设置 / 已安装的 hook.js）一律住这里，**固定在 home 下**。
// 早先用 __dirname，在源码目录跑时恰好等于同一个路径，所以本机从没暴露问题；
// 但打包成 .app / .exe 后 __dirname 落在应用包**内部** ——
// macOS 放进 /Applications 或 Windows 放进 Program Files 时那里是只读的，
// hook 会静默写失败、看板永远空着且不报错。
// 另外 install-hooks 用 'session-board/hook.js' 作卸载标记，
// 注册进去的路径必须真的含这段，包内路径不含 -> 幂等与卸载一起失效。
const INSTALL_DIR = path.join(CLAUDE_DIR, 'session-board')
const BOARD_DIR = INSTALL_DIR
const STATE_DIR = path.join(INSTALL_DIR, 'state')
const HOOK_JS = path.join(INSTALL_DIR, 'hook.js')

// 「已隐藏」墓碑：{ sessionId: 隐藏时刻ms }。
// Why 要单独一个文件、而不是删 state 文件：一行是否显示由
// `注册表 ∪ state 文件` 的并集决定，注册表不归看板管 ——
// 只删 state 文件，注册表还在的那一行下一帧就原地重建，等于删不掉。
// 隐藏是**用户意图**，属于第三类事实，必须自己落盘，不能靠抹掉某个输入来表达。
const HIDDEN_JSON = path.join(INSTALL_DIR, 'hidden.json')

// 本份代码自己所在的位置。打包后 = 应用包内的只读副本，
// 首次运行时要从这里把 hook.js 拷到 INSTALL_DIR。
const CODE_DIR = __dirname
const SETTINGS_JSON = path.join(CLAUDE_DIR, 'settings.json')

// Claude Code 自己维护的活会话注册表，一个活会话一个 <pid>.json。
// 权威信源：有哪些会话、是否还活着（pid）、忙闲（status）。
// **未公开实现** —— 读不到就整体降级回 hook 推导，不硬依赖。
// 实测 macOS 上同样存在且格式一致。
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions')

const titleCache = new Map()
const transcriptCache = new Map()
const labelCache = new Map()

// ---- 基础工具 ----

function formatDuration(ms) {
  if (!(ms > 0)) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h >= 1) return h + 'h' + String(m).padStart(2, '0') + 'm'
  if (m >= 1) return m + 'm' + String(sec).padStart(2, '0') + 's'
  return sec + 's'
}

function fileMs(p) {
  try { return fs.statSync(p).mtimeMs } catch (_) { return 0 }
}

// 状态呈现表。排序权重按"有多需要你"定，不是按时间。
//
// 配色原则：颜色信号集中在「状态」列的文字上（accent），行底色只做极淡的暗示（back）。
// 整行铺饱和底色会让信号强度和覆盖面积不匹配，看着刺眼 —— 实测调整过。
// fore 是行内其余文字的颜色：不需要你关注的状态压灰。
function statusMeta(status) {
  switch (status) {
    case 'asking':  return { rank: 0, text: '？ 在问你',  accent: '#D32F2F', back: '#FFF4F4', fore: '#222222' }
    case 'waiting': return { rank: 1, text: '▲ 等你输入', accent: '#E07C00', back: '#FFFAF1', fore: '#222222' }
    case 'done':    return { rank: 2, text: '✔ 已完成',   accent: '#2E7D32', back: '#F5FAF6', fore: '#222222' }
    case 'running': return { rank: 3, text: '● 运行中',   accent: '#1565C0', back: '#FFFFFF', fore: '#222222' }
    case 'fresh':   return { rank: 4, text: '○ 空闲',     accent: '#9E9E9E', back: '#FFFFFF', fore: '#909090' }
    case 'stalled': return { rank: 5, text: '… 失联？',   accent: '#757575', back: '#FAFAFA', fore: '#909090' }
    case 'idle':    return { rank: 6, text: '· 久候',     accent: '#9E9E9E', back: '#FAFAFA', fore: '#A0A0A0' }
    case 'closed':  return { rank: 7, text: '✕ 已关闭',   accent: '#8D6E63', back: '#FAFAFA', fore: '#A0A0A0' }
    case 'hidden':  return { rank: 8, text: '· 已隐藏',   accent: '#9E9E9E', back: '#FAFAFA', fore: '#A0A0A0' }
    default:        return { rank: 9, text: '? ' + status, accent: '#555555', back: '#FFFFFF', fore: '#222222' }
  }
}

// ---- 信源读取 ----

function readRegistry() {
  const map = new Map()
  let names = []
  try { names = fs.readdirSync(SESSIONS_DIR) } catch (_) { return map }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const o = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8'))
      if (o && o.sessionId) map.set(String(o.sessionId), o)
    } catch (_) { /* 正在被写 / 内容损坏 —— 跳过，下一轮再读 */ }
  }
  return map
}

// 进程是否还活着。
//
// 跨平台的关键改动：PowerShell 版用 `Get-Process -Name claude`，但那个名字
// 是平台相关的（Windows 上是 claude.exe，macOS 上不一定叫这个）。
// 改用 signal 0 探测 —— 不发信号、只查存在性，Windows / macOS / Linux 通用，
// 而且比枚举全部进程便宜得多。
// EPERM = 进程存在但没权限操作它，同样算活着。
function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

function readStates() {
  const list = []
  let names = []
  try { names = fs.readdirSync(STATE_DIR) } catch (_) { return list }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const o = JSON.parse(fs.readFileSync(path.join(STATE_DIR, n), 'utf8'))
      if (o && o.session_id) list.push(o)
    } catch (_) { }
  }
  return list
}

// ---- 已隐藏墓碑 ----

function readHidden() {
  try {
    const o = JSON.parse(fs.readFileSync(HIDDEN_JSON, 'utf8'))
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}
  } catch (_) { return {} }
}

// temp + rename 原子落盘，与 hook.js 写 state 的做法一致。
// temp 名带 pid，避免两个实例互相踩（虽然有单实例锁，打包版与开发版可能并存）。
function writeHidden(map) {
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true })
    const tmp = HIDDEN_JSON + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    fs.renameSync(tmp, HIDDEN_JSON)
    return true
  } catch (_) { return false }
}

function resolveTranscript(sid) {
  if (!sid) return ''
  if (transcriptCache.has(sid)) return transcriptCache.get(sid)
  let found = ''
  try {
    const root = path.join(CLAUDE_DIR, 'projects')
    for (const d of fs.readdirSync(root)) {
      const c = path.join(root, d, sid + '.jsonl')
      if (fs.existsSync(c)) { found = c; break }
    }
  } catch (_) { }
  if (found) transcriptCache.set(sid, found)   // 只缓存命中，没找到下轮再找
  return found
}

function readTranscriptTail(p, maxBytes) {
  try {
    const size = fs.statSync(p).size
    const take = Math.min(maxBytes, size)
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(take)
      fs.readSync(fd, buf, 0, take, size - take)
      return { text: buf.toString('utf8'), full: take === size }
    } finally { fs.closeSync(fd) }
  } catch (_) {
    return { text: '', full: true }
  }
}

// 老记录没有 title 时兜底：全量读 transcript 找 ai-title。
// 标题可能只在很靠前的位置写过一次，只扫尾部会漏。带 TTL，标题改了也能跟上。
function resolveTitle(sid, transcript) {
  if (!sid || !transcript) return ''
  const now = Date.now()
  const c = titleCache.get(sid)
  if (c && (now - c.at) < 120000) return c.value
  let t = ''
  try {
    const text = fs.readFileSync(transcript, 'utf8')
    const k = text.lastIndexOf('"aiTitle":"')
    if (k >= 0) {
      const s = k + 11
      const e = text.indexOf('"', s)
      if (e > s) t = text.slice(s, e)
    }
  } catch (_) { }
  if (t) titleCache.set(sid, { value: t, at: now })
  return t
}

// 检测"此刻卡在 AskUserQuestion 等人作答"。
// 实证：tool_use 在用户作答**之前**就已落盘 —— 未作答时其后紧跟 last-prompt/mode
// 记录、没有配对的 tool_result。做文本级子串匹配，不做完整 JSON 解析（每轮都要跑）。
function testAskBlocking(transcript) {
  if (!transcript) return false
  const { text } = readTranscriptTail(transcript, ASK_TAIL_BYTES)
  if (!text) return false
  const at = text.lastIndexOf('"name":"AskUserQuestion"')
  if (at < 0) return false
  const idAt = text.lastIndexOf('"id":"toolu_', at)
  if (idAt < 0) return false
  const idStart = idAt + 6
  const idEnd = text.indexOf('"', idStart)
  if (idEnd < 0) return false
  const id = text.slice(idStart, idEnd)
  return !text.slice(at).includes('"tool_use_id":"' + id + '"')
}

// 剥掉壳层注入的包装块。
// transcript 里 user 角色的内容 ≠ 人真正打的字 —— Claude Code 会往里塞
// <ide_opened_file>、<system-reminder>、<command-name> 等。
// 用白名单而不是通配 <...>：用户自己可能就在聊 XML/HTML。
const HARNESS_TAGS = [
  'ide_opened_file', 'ide_selection', 'system-reminder', 'local-command-stdout',
  'command-message', 'command-name', 'command-args', 'user-prompt-submit-hook',
  'task-notification', 'ide_diagnostics',
]
function clearHarnessNoise(t) {
  if (!t) return ''
  const alt = HARNESS_TAGS.join('|')
  t = t.replace(new RegExp('<(' + alt + ')\\b[^>]*>[\\s\\S]*?</\\1>', 'g'), ' ')
  t = t.replace(new RegExp('</?(' + alt + ')\\b[^>]*/?>', 'g'), ' ')
  return t.replace(/\s+/g, ' ').trim()
}

function exchangeFromText(text) {
  const res = { user: '', assistant: '' }
  if (!text) return res
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (res.user && res.assistant) break
    const l = lines[i].trim()
    if (!l) continue
    let o
    try { o = JSON.parse(l) } catch (_) { continue }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    // content 可能是纯字符串，也可能是块数组；只取 text 块 ——
    // 工具调用和工具结果不是"对话内容"。
    const c = o.message && o.message.content
    let t = ''
    if (typeof c === 'string') t = c
    else if (Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'text' && b.text) t += ' ' + b.text
    }
    t = clearHarnessNoise(t.replace(/\s+/g, ' ').trim())
    if (!t) continue
    if (o.type === 'assistant' && !res.assistant) res.assistant = t
    else if (o.type === 'user' && !res.user) res.user = t
  }
  return res
}

function getLastExchange(transcript) {
  let res = { user: '', assistant: '' }
  if (!transcript) return res
  const chunk = readTranscriptTail(transcript, 262144)
  res = exchangeFromText(chunk.text)
  // 尾部窗口未必够回溯到最近一条用户消息（工具输出会把它挤出窗口），
  // 缺任一侧就整文件再扫一次。只在选中某行时发生，代价可接受。
  if ((!res.user || !res.assistant) && !chunk.full) {
    const whole = readTranscriptTail(transcript, 64 * 1024 * 1024)
    const r2 = exchangeFromText(whole.text)
    if (!res.user) res.user = r2.user
    if (!res.assistant) res.assistant = r2.assistant
  }
  return res
}

// 从 cwd 推人类可读标签。
// 先匹配 .sdlc/worktrees/<slug>（slug 优先，否则会被外层仓吃掉），
// 否则向上找**最外层**带 .git 的祖先算「仓名/相对路径」——
// 不能只往上找一层：子模块自己也带 .git，会停在它们身上得到无信息量的目录名。
function labelFromCwd(cwd) {
  if (!cwd) return '(未知目录)'
  if (labelCache.has(cwd)) return labelCache.get(cwd)

  let label = ''
  const norm = String(cwd).replace(/\\/g, '/')

  const wt = norm.match(/\.sdlc\/worktrees\/([^/]+)(\/.*)?$/)
  if (wt) {
    const slug = wt[1]
    const sub = (wt[2] || '').replace(/^\/+|\/+$/g, '')
    label = sub ? slug + '/' + sub : slug
    if (label.length > 42 && sub) label = slug + '/…/' + sub.split('/').pop()
    labelCache.set(cwd, label)
    return label
  }

  try {
    let dir = cwd
    let outermost = ''
    for (let i = 0; i < 12; i++) {
      if (!dir || !fs.existsSync(dir)) break
      if (fs.existsSync(path.join(dir, '.git'))) outermost = dir
      const parent = path.dirname(dir)
      if (!parent || parent === dir) break
      dir = parent
    }
    if (outermost) {
      const root = path.basename(outermost)
      let rel = ''
      if (cwd.length > outermost.length) {
        rel = cwd.slice(outermost.length).replace(/^[\\/]+|[\\/]+$/g, '').replace(/\\/g, '/')
      }
      label = rel ? root + '/' + rel : root
      if (label.length > 42 && rel && rel.includes('/')) {
        label = root + '/…/' + rel.split('/').pop()
      }
    }
  } catch (_) { }

  if (!label) label = norm.replace(/\/+$/, '').split('/').pop() || norm
  labelCache.set(cwd, label)
  return label
}

// 旧的状态推导（hook 事件 + 心跳）。仅在注册表整体不可用、
// 或某条注册表条目缺 status 时使用 —— 降级路径，不主动走。
function legacyStatus(st, hasBeat, silent, tp) {
  if (!st) return 'fresh'
  const e = String(st.status || '')
  if (e === 'running' && hasBeat) {
    if (silent > ASK_PROBE_AFTER_MS && testAskBlocking(tp)) return 'asking'
    if (silent > SILENT_STALL_MS) return 'stalled'
  }
  return e
}

// 尚未注册的 hook 事件名；空数组 = 4 个都齐了。
function getMissingHooks() {
  const all = ['running', 'done', 'waiting', 'closed']
  try {
    const sj = fs.readFileSync(SETTINGS_JSON, 'utf8')
    return all.filter((s) => !sj.includes('hook.js\\" ' + s))
  } catch (_) {
    return all   // settings.json 不存在或损坏，按全部未装处理
  }
}

function getHealthIssues() {
  const issues = []
  if (!fs.existsSync(HOOK_JS)) issues.push('hook.js 缺失')
  for (const m of getMissingHooks()) issues.push('hook 未注册: ' + m)
  return issues
}

// ---- 核心：算出本轮该显示哪些行 ----
//
// 三个信源合并：
//   registry = Claude Code 的活会话注册表 —— 权威：有哪些会话 / 死活 / 忙闲
//   states   = hook 记录 —— 补充：等你多久 / 本轮用时 / 摘要 / 标题 / 你敲的原话
//   pid 存活 = 把注册表条目判成"还活着"还是"已关闭"
// 注册表读不到就整体降级回旧逻辑，绝不误报"已关闭"。
function buildRows(opts) {
  const sortIndex = (opts && opts.sortIndex) || 0
  const showFolded = !!(opts && opts.showFolded)

  const now = Date.now()
  const reg = readRegistry()
  const states = readStates()
  const hidden = readHidden()
  const regUsable = reg.size > 0
  let hiddenDirty = false

  const stateBy = new Map()
  for (const s of states) stateBy.set(String(s.session_id), s)

  // 并集：注册表里有但还没 hook 记录的（刚开、没说过话）也要显示
  const ids = new Set([...reg.keys(), ...stateBy.keys()])

  // 先算标签，用于识别重名（同一 cwd 开多个会话时附 session id 区分）
  const baseLabel = new Map()
  const labelCount = new Map()
  for (const id of ids) {
    const st = stateBy.get(id)
    const rg = reg.get(id)
    const cw = (st && st.cwd) || (rg && rg.cwd) || ''
    const lb = labelFromCwd(cw)
    baseLabel.set(id, lb)
    labelCount.set(lb, (labelCount.get(lb) || 0) + 1)
  }

  let rows = []
  for (const id of ids) {
    const st = stateBy.get(id)
    const rg = reg.get(id)
    const cwd = (st && st.cwd) || (rg && rg.cwd) || ''

    let tp = (st && st.transcript_path) || ''
    if (!tp || !fs.existsSync(tp)) tp = resolveTranscript(id)

    // 心跳 = transcript 的 mtime。拿不到就说"心跳未知"，不用 updated_ms 冒充 ——
    // 那会把长轮次误判成失联。
    let lastMs = tp ? fileMs(tp) : 0
    const hasBeat = lastMs > 0
    if (!hasBeat && st) lastMs = Number(st.updated_ms) || 0
    const silent = lastMs > 0 ? now - lastMs : 0

    const alive = !!(rg && isPidAlive(rg.pid))
    const regStatus = (rg && rg.status) ? String(rg.status) : ''

    let eff
    if (!regUsable) {
      eff = legacyStatus(st, hasBeat, silent, tp)
    } else if (!alive) {
      eff = 'closed'
    } else if (hasBeat && silent > ASK_PROBE_AFTER_MS && testAskBlocking(tp)) {
      eff = 'asking'
    } else if (regStatus === 'busy') {
      eff = 'running'
    } else if (regStatus === 'idle') {
      if (!st) eff = 'fresh'
      else if (String(st.status) === 'waiting') eff = 'waiting'
      else if (String(st.status) === 'running') eff = 'done'
      else eff = String(st.status)
    } else {
      // 注册表条目缺 status（实测 VS Code entrypoint 就没有）-> 这一条降级
      eff = legacyStatus(st, hasBeat, silent, tp)
    }

    let wait = 0
    if (st && (eff === 'done' || eff === 'waiting' || eff === 'asking')) {
      wait = now - (Number(st.updated_ms) || now)
    }
    if ((eff === 'waiting' || eff === 'done') && wait > IDLE_LONG_MS) eff = 'idle'

    let dur = 0
    if (st) {
      dur = (eff === 'running' || eff === 'stalled')
        ? now - (Number(st.turn_started_ms) || now)
        : (Number(st.duration_ms) || 0)
    }

    // 隐藏判定放在所有派生值算完之后 —— 勾「显示全部」时那些数值还要照常显示。
    // 复活条件：这个会话在隐藏之后又有过 hook 事件（updated_ms 变新）。
    // 即"我先收起来，它下次叫我时自己回来"，这正是看板的主循环。
    const baseEff = eff
    const hiddenAt = Number(hidden[id]) || 0
    if (hiddenAt > 0) {
      const lastAct = st ? (Number(st.updated_ms) || 0) : 0
      if (lastAct > hiddenAt) {
        delete hidden[id]
        hiddenDirty = true
      } else {
        eff = 'hidden'
      }
    }

    let label = baseLabel.get(id)
    if (labelCount.get(label) > 1) label = label + '  #' + id.slice(0, 8)

    const lastPrompt = (st && st.last_prompt) || ''
    const summary = (st && st.summary) || ''

    // 标题优先级：注册表自定义名 > ai-title > 你最近敲的那句 > 占位。
    // 第一项目前恒为 derived（官方还没把重命名落盘），留作前瞻兼容。
    let title = ''
    if (rg && rg.name && String(rg.nameSource) !== 'derived') title = String(rg.name)
    if (!title && st && st.title) title = String(st.title)
    if (!title) title = resolveTitle(id, tp)
    if (!title && lastPrompt) {
      const p = lastPrompt.length > 24 ? lastPrompt.slice(0, 24) + '…' : lastPrompt
      title = '「' + p + '」'
    }
    if (!title) title = '（暂无标题）'

    // 启动时刻：注册表的 startedAt 最准；没有就退回首次见到它的时间。
    // 两者都没有时排最后，而不是抢第一行。
    let started = 0
    if (rg && rg.startedAt) started = Number(rg.startedAt)
    else if (st && st.first_seen_ms) started = Number(st.first_seen_ms)
    if (!(started > 0)) started = Number.MAX_SAFE_INTEGER

    const meta = statusMeta(eff)

    rows.push({
      sessionId: id,
      cwd,
      transcript: tp,
      summary,
      lastPrompt,
      eff,
      // 隐藏之下真实的状态。计数（活/待处理/已关闭）一律按它算，
      // 否则一条被收起来的死会话会被记成"还活着"。
      baseEff,
      hidden: eff === 'hidden',
      rank: meta.rank,
      statusText: meta.text,
      accent: meta.accent,
      back: meta.back,
      fore: meta.fore,
      title,
      label,
      waitText: formatDuration(wait),
      durText: formatDuration(dur),
      silentText: hasBeat ? formatDuration(silent) : '心跳未知',
      lifeText: (started > 0 && started < Number.MAX_SAFE_INTEGER) ? formatDuration(now - started) : '—',
      wait,
      silent,
      started,
    })
  }

  // 墓碑 GC：既不在注册表、也没有 state 文件的 id 已经无从复活，留着只会让文件无限长。
  for (const id of Object.keys(hidden)) {
    if (!ids.has(id)) { delete hidden[id]; hiddenDirty = true }
  }
  if (hiddenDirty) writeHidden(hidden)

  // 非「需求度」排法一律把久候/已关闭/已隐藏沉底 —— 否则一个昨天开的死会话
  // 会仅仅因为"启动得早"而插在第一行。
  const sink = (r) => (r.eff === 'idle' || r.eff === 'closed' || r.eff === 'hidden') ? 1 : 0
  const by = (...fns) => (a, b) => {
    for (const f of fns) { const d = f(a, b); if (d !== 0) return d }
    return 0
  }
  const cmpSink = (a, b) => sink(a) - sink(b)

  if (sortIndex === 1) {
    rows.sort(by(cmpSink, (a, b) => a.started - b.started))
  } else if (sortIndex === 2) {
    rows.sort(by(cmpSink, (a, b) => a.silent - b.silent))
  } else if (sortIndex === 3) {
    rows.sort(by(cmpSink, (a, b) => String(a.label).localeCompare(String(b.label))))
  } else {
    // 需求度：同档按"等你多久"倒排。末位 tiebreak 用 started（恒定）
    // 而不是 silent —— silent 一有输出就归零，会让行序每秒都在变。
    rows.sort(by(
      (a, b) => a.rank - b.rank,
      (a, b) => b.wait - a.wait,
      (a, b) => a.started - b.started
    ))
  }

  const all = rows
  const visible = all.filter((r) => showFolded || (r.eff !== 'idle' && r.eff !== 'closed' && r.eff !== 'hidden'))

  // 计数一律走 baseEff：被隐藏不改变它客观上是死是活。
  // 唯独 needYou 例外 —— 隐藏就是"这条我处理过了"，不该再催我。
  return {
    rows: visible,
    regUsable,
    needYou: all.filter((r) => !r.hidden && (r.baseEff === 'asking' || r.baseEff === 'waiting' || r.baseEff === 'done')).length,
    idleCount: all.filter((r) => r.eff === 'idle').length,
    closedCount: all.filter((r) => r.eff === 'closed').length,
    hiddenCount: all.filter((r) => r.hidden).length,
    liveCount: all.filter((r) => r.baseEff !== 'closed').length,
  }
}

// 把一条隐藏起来。
// 语义：记一条"我不想再看见它"的意图，**不删任何数据** ——
// 摘要/标题/耗时都留着，勾「显示全部」还能找回来，
// 该会话下次有动静（hook 事件）会自己回到列表里。
function removeRecord(sid) {
  if (!sid) return
  const map = readHidden()
  map[String(sid)] = Date.now()
  writeHidden(map)
}

// 取消隐藏，立刻回到列表。
function unhideRecord(sid) {
  if (!sid) return
  const map = readHidden()
  if (map[String(sid)] === undefined) return
  delete map[String(sid)]
  writeHidden(map)
}

// 一键隐藏：已完成 / 久候 / 已确认关闭 的都收进去。
//
// 这里必须同时扫注册表，不能只扫 state 文件 ——
// 进程已死但注册表条目还在的行**根本没有 state 文件**（强杀不触发 SessionEnd），
// 老实现只 unlink state 文件，对这类行完全无效，是同一个根因的第二个症状。
function clearStaleRecords() {
  const now = Date.now()
  const reg = readRegistry()
  const hidden = readHidden()

  let names = []
  try { names = fs.readdirSync(STATE_DIR) } catch (_) { names = [] }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const o = JSON.parse(fs.readFileSync(path.join(STATE_DIR, n), 'utf8'))
      const sid = String(o.session_id)
      const stale = (o.status === 'waiting' || o.status === 'done') &&
        (now - (Number(o.updated_ms) || 0)) > IDLE_LONG_MS
      if (stale || o.status === 'done') hidden[sid] = now
    } catch (_) { }
  }

  for (const [sid, rg] of reg) {
    if (!isPidAlive(rg.pid)) hidden[String(sid)] = now
  }

  writeHidden(hidden)
}

module.exports = {
  buildRows, getLastExchange, getHealthIssues, getMissingHooks,
  removeRecord, unhideRecord, clearStaleRecords, formatDuration,
  BOARD_DIR, STATE_DIR, CLAUDE_DIR, SESSIONS_DIR, INSTALL_DIR, CODE_DIR, HOOK_JS, HIDDEN_JSON,
}

// ---- 直接运行时作自检 ----
if (require.main === module) {
  const asJson = process.argv.includes('--json')
  const res = buildRows({ sortIndex: 1, showFolded: true })
  if (asJson) {
    process.stdout.write(JSON.stringify(res, null, 2))
  } else {
    console.log('platform: ' + process.platform + '  registry usable: ' + res.regUsable)
    console.log('live=' + res.liveCount + '  needYou=' + res.needYou +
      '  idle=' + res.idleCount + '  closed=' + res.closedCount)
    const issues = getHealthIssues()
    console.log('health: ' + (issues.length ? issues.join(' / ') : 'ok'))
    console.log('')
    const pad = (s, n) => {
      // 中文按两个宽度算，否则表格对不齐
      let w = 0
      for (const ch of String(s)) w += (ch.charCodeAt(0) > 0x2E80) ? 2 : 1
      return String(s) + ' '.repeat(Math.max(0, n - w))
    }
    console.log(pad('状态', 14) + pad('标题', 34) + pad('项目', 34) +
      pad('等你', 10) + pad('本轮', 10) + pad('静默', 10) + '整体')
    for (const r of res.rows) {
      console.log(pad(r.statusText, 14) + pad(r.title.slice(0, 15), 34) +
        pad(r.label.slice(0, 15), 34) + pad(r.waitText, 10) +
        pad(r.durText, 10) + pad(r.silentText, 10) + r.lifeText)
    }
  }
}

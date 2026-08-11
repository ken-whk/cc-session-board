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
const { createHash } = require('crypto')

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

// Claude Code 的配置根目录。**必须认 CLAUDE_CONFIG_DIR** ——
// 用户把 .claude 挪走时，claude-hud 等周边工具都读这个变量；
// 看板不认就会一边（hud）往 $CLAUDE_CONFIG_DIR 写、一边（看板）去 ~/.claude 找，
// 表现为"明明开启了用量快照却一直显示未启用"，且极难自查。
// hook.js / install-hooks.js 里有同样的推导，改这里必须同步改那两处。
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude')

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

// ---- 上下文用量：两个信源都是"借"来的，都不是我们的契约 ----

// claude-hud 的 per-session 上下文快照目录。文件名 = sha256(path.resolve(transcript_path))，
// 内容含 used_percentage / current_usage / context_window_size / saved_at。
// 每个会话自己的 statusline 进程每 ~3s 刷一次，所以是活数据。
//
// Why 借它而不自己算：真正准确的 used_percentage 由 Claude Code 通过
// **statusline 的 stdin**（context_window 字段）下发，hook payload 里没有这个字段
// （实测 4 类 payload 的 key 都没有）—— 看板作为独立进程根本拿不到原生值。
// hud 的注释也明说原生值 "accurate and matches /context"，自己累加只是近似。
// 代价：这是 hud 的私有缓存、无公开契约，它升级改格式就会失效 -> 必须有兜底。
const HUD_DIR = path.join(CLAUDE_DIR, 'plugins', 'claude-hud')
const HUD_CONTEXT_CACHE_DIR = path.join(HUD_DIR, 'context-cache')

// hud 解析 transcript 后的缓存，键的算法与 context-cache 相同。
// 里面还有 tools / skills / todos / sessionTokens 等，目前只取 compactionCount。
const HUD_TRANSCRIPT_CACHE_DIR = path.join(HUD_DIR, 'transcript-cache')

// 账号级用量快照（5小时窗 / 7天窗）。由 claude-hud 的
// display.externalUsageWritePath 配置项写出，是它给外部消费者留的正门。
//
// Why 不自己调 API：那两个数字来自 api.anthropic.com 的 usage 接口，认证要读
// 你的 OAuth token（keychain / .credentials.json）。看板目前**零网络出口、
// 不碰任何凭据**，这是它值得保住的属性 —— 为一个显示项破掉不值得。
const USAGE_SNAPSHOT = path.join(CLAUDE_DIR, 'usage-snapshot.json')

// 正在跑的会话，快照超过这个时长就视为"不新鲜"（可能低报），界面上灰显。
// 只对运行中生效 —— 判据见 buildRows 里 ctxGrowing 处的注释。
// 不直接隐藏：会话关掉后最后一次的占用量仍是有意义的信息。
const CTX_STALE_MS = 2 * 60 * 1000

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
//
// desc 是给帮助面板用的一句话释义。放在这里而不是界面层：
// 帮助里那份图例原先是手抄的一份平行清单，字形 / 配色 / 顺序改了不会同步，
// 迟早变成"看起来权威但已过时"的说明。同源之后它抄不错。
function statusMeta(status) {
  switch (status) {
    case 'asking':  return { rank: 0, text: '？ 在问你',  accent: '#D32F2F', back: '#FFF4F4', fore: '#222222', desc: '卡在 AskUserQuestion 等你作答，不理它就永远不会继续' }
    case 'waiting': return { rank: 1, text: '▲ 等你输入', accent: '#E07C00', back: '#FFFAF1', fore: '#222222', desc: '空闲等待你的输入' }
    case 'done':    return { rank: 2, text: '✔ 已完成',   accent: '#2E7D32', back: '#F5FAF6', fore: '#222222', desc: '这一轮跑完了，球在你手上' }
    case 'running': return { rank: 3, text: '● 运行中',   accent: '#1565C0', back: '#FFFFFF', fore: '#222222', desc: '正在干活，不用管' }
    case 'fresh':   return { rank: 4, text: '○ 空闲',     accent: '#9E9E9E', back: '#FFFFFF', fore: '#909090', desc: '会话开着但还没交互过' }
    case 'stalled': return { rank: 5, text: '… 失联？',   accent: '#757575', back: '#FAFAFA', fore: '#909090', desc: '心跳静默超过 5 分钟（仅注册表降级时出现）' }
    case 'idle':    return { rank: 6, text: '· 久候',     accent: '#9E9E9E', back: '#FAFAFA', fore: '#A0A0A0', desc: '超过 2 小时没被处理，默认不显示' }
    case 'closed':  return { rank: 7, text: '✕ 已关闭',   accent: '#8D6E63', back: '#FAFAFA', fore: '#A0A0A0', desc: '进程已退出（按 pid 精确判定），默认不显示' }
    case 'hidden':  return { rank: 8, text: '· 已隐藏',   accent: '#9E9E9E', back: '#FAFAFA', fore: '#A0A0A0', desc: '你手动隐藏的，默认不显示；它下次有动静会自己回来' }
    default:        return { rank: 9, text: '? ' + status, accent: '#555555', back: '#FFFFFF', fore: '#222222', desc: '' }
  }
}

// 帮助面板的状态图例。顺序 = rank 顺序 = 「需求度」排序的顺序，
// 所以图例本身就解释了默认排法。
function statusLegend() {
  return ['asking', 'waiting', 'done', 'running', 'fresh', 'stalled', 'idle', 'closed', 'hidden']
    .map((eff) => {
      const m = statusMeta(eff)
      // 字形与文字拆开给界面：图例里字形要单独占一列才能对齐
      // （？▲✔●○…·✕ 宽度各不相同，混在一个字符串里排出来是锯齿状的）
      const sp = m.text.indexOf(' ')
      return {
        eff,
        glyph: sp > 0 ? m.text.slice(0, sp) : '',
        label: sp > 0 ? m.text.slice(sp + 1) : m.text,
        text: m.text,
        accent: m.accent,
        back: m.back,
        desc: m.desc,
      }
    })
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

// ---- 上下文用量读取 ----

function formatTokens(n) {
  if (!(n > 0)) return '—'
  if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n)
}

// hud 的两个缓存都按 sha256(path.resolve(transcript_path)) 命名（读 hud 源码得到）
function hudCacheFile(dir, transcriptPath) {
  const hash = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex')
  return path.join(dir, hash + '.json')
}

// 首选信源：hud 的快照。命中即拿到与 /context 一致的原生百分比。
function ctxFromHud(transcriptPath) {
  if (!transcriptPath) return null
  try {
    const o = JSON.parse(fs.readFileSync(hudCacheFile(HUD_CONTEXT_CACHE_DIR, transcriptPath), 'utf8'))
    const pct = Number(o.used_percentage)
    if (!Number.isFinite(pct)) return null
    const u = o.current_usage || {}
    const tokens = (Number(u.input_tokens) || 0) +
      (Number(u.cache_creation_input_tokens) || 0) +
      (Number(u.cache_read_input_tokens) || 0)
    return {
      pct: Math.max(0, Math.min(100, Math.round(pct))),
      tokens,
      windowSize: Number(o.context_window_size) || 0,
      savedAt: Number(o.saved_at) || 0,
      source: 'hud',
    }
  } catch (_) {
    // 没装 hud / 该会话没渲染过 statusline / 格式变了 -> 交给兜底
    return null
  }
}

// 兜底路径的窗口大小只能推。两个信源都**不带**这个事实：
// transcript 的 message.model 是 "claude-opus-5"（实测无 [1m] 后缀）、
// 会话注册表里也没有模型字段。唯一带标记的是 settings.json 的 "model": "opus[1m]"，
// 但那是**全局默认**，某个会话中途 /model 切过就不准 -> 所以这条路的百分比标 ~。
function defaultContextWindow() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'))
    if (/\[1m\]/i.test(String(s.model || ''))) return 1000000
  } catch (_) { /* 读不到就按小窗算，下面还有观测反推兜一层 */ }
  return 200000
}

// 兜底信源：transcript 里**最后一条** assistant 消息的 usage。
//
// Why 取最后一条而不是累加所有消息：usage 是**时点值**（这一次请求送进去多少
// 上下文），累加得到的是"整场花掉的 token 总量"，那是成本指标、不是占用量，
// 会随会话长度无限增长。取时点值还天然躲过 compact —— 压缩后的下一条消息
// 自己就反映了压缩后的上下文，不需要额外追 compact 边界。
function ctxFromTranscript(transcriptPath, windowDefault) {
  if (!transcriptPath) return null
  const { text } = readTranscriptTail(transcriptPath, 512 * 1024)
  if (!text) return null

  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]
    if (!ln || ln.indexOf('"usage"') < 0 || ln.indexOf('"assistant"') < 0) continue
    let o
    try { o = JSON.parse(ln) } catch (_) { continue }   // 尾部第一行常是截断的半条
    const u = o && o.message && o.message.usage
    if (!u) continue
    const tokens = (Number(u.input_tokens) || 0) +
      (Number(u.cache_creation_input_tokens) || 0) +
      (Number(u.cache_read_input_tokens) || 0)
    if (!(tokens > 0)) continue

    // 观测反推：这次请求既然成功了就没有溢出，所以窗口至少装得下已观测到的
    // token 量。settings.json 猜小了（会话单独切过 1M 模型）时靠这一层纠回来。
    let windowSize = windowDefault > 0 ? windowDefault : 200000
    if (tokens > windowSize) windowSize = 1000000

    return {
      pct: Math.max(0, Math.min(100, Math.round((tokens / windowSize) * 100))),
      tokens,
      windowSize,
      savedAt: fileMs(transcriptPath),
      source: 'transcript',
    }
  }
  return null
}

function readContextUsage(transcriptPath, windowDefault) {
  return ctxFromHud(transcriptPath) || ctxFromTranscript(transcriptPath, windowDefault)
}

/**
 * 选中某行时才读的会话补充信息（详情面板用）。
 *
 * Why 不放进 buildRows：这是**按需**信息，只有被选中的那一行需要。
 * 塞进每行循环等于每 1.5 秒多读 N 个文件，为一个偶尔看一眼的数字不值得。
 *
 * @param {string} transcriptPath 该会话的 transcript 路径
 * @returns {{compactions:number}} compactions 为 -1 表示读不到（没装 hud / 该会话没渲染过 statusline）
 */
function readSessionMeta(transcriptPath) {
  const res = { compactions: -1 }
  if (!transcriptPath) return res
  try {
    const o = JSON.parse(fs.readFileSync(hudCacheFile(HUD_TRANSCRIPT_CACHE_DIR, transcriptPath), 'utf8'))
    const n = Number(o && o.data && o.data.compactionCount)
    if (Number.isFinite(n) && n >= 0) res.compactions = n
  } catch (_) { /* 缓存不存在 / 格式变了 -> 保持 -1，界面显示"未知" */ }
  return res
}

// 账号级用量快照。读不到就返回 null，界面整块不显示 ——
// 不用 0% 冒充"还没用"，那是把"不知道"呈现成"很安全"。
function readUsageWindows() {
  let o
  try {
    o = JSON.parse(fs.readFileSync(USAGE_SNAPSHOT, 'utf8'))
  } catch (_) {
    return null
  }
  const win = (k) => {
    const w = o && o[k]
    const pct = Number(w && w.used_percentage)
    if (!Number.isFinite(pct)) return null
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) : 0
    return {
      pct: Math.max(0, Math.min(100, Math.round(pct))),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0,
    }
  }
  const fiveHour = win('five_hour')
  const sevenDay = win('seven_day')
  if (!fiveHour && !sevenDay) return null
  const updatedAt = o.updated_at ? Date.parse(o.updated_at) : 0
  return {
    fiveHour,
    sevenDay,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    // hud 每次渲染 statusline 才刷（30s 节流）；全部会话都关掉时它就不再更新，
    // 所以要让界面能把"陈旧"说出来，而不是把过期数字当现值展示。
    stale: !updatedAt || (Date.now() - updatedAt) > 10 * 60 * 1000,
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

  // 兜底路径要用的窗口大小，每帧读一次就够 —— 不要放进按行的循环里重复读文件
  const ctxWindowDefault = defaultContextWindow()

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

    // 上下文占用。读不到就留空字符串，界面显示 '—'。
    //
    // "陈旧"只对**正在跑**的会话成立 —— 它的上下文在增长，旧快照会低报。
    // 空闲 / 等你输入 / 在问你 / 已关闭的会话上下文根本没在变，
    // 最后一次快照就是当前真相，不该灰显（阻塞会话的 statusline 不再渲染，
    // 快照必然变旧，按时间一刀切会把这些行全打成"不可信"）。
    const ctx = readContextUsage(tp, ctxWindowDefault)
    const ctxGrowing = (eff === 'running' || eff === 'stalled')
    const ctxStale = !!(ctx && ctxGrowing && ctx.savedAt > 0 && (now - ctx.savedAt) > CTX_STALE_MS)

    rows.push({
      sessionId: id,
      cwd,
      transcript: tp,
      ctxPct: ctx ? ctx.pct : -1,
      // transcript 兜底算出来的百分比刻度依赖猜窗口大小，标 ~ 提示是近似值
      ctxText: ctx ? ((ctx.source === 'transcript' ? '~' : '') + ctx.pct + '%') : '—',
      ctxTokensText: ctx ? formatTokens(ctx.tokens) : '—',
      ctxWindowText: ctx && ctx.windowSize ? formatTokens(ctx.windowSize) : '—',
      ctxSource: ctx ? ctx.source : '',
      ctxStale,
      // 详情面板用的会话元信息，全部来自会话注册表（拿不到就留空 / 0）。
      // 注意与上面的 started 区分：started 会用 first_seen 兜底、并且拿不到时
      // 填 MAX_SAFE_INTEGER 供排序用，不能直接当"启动时刻"显示。
      startedMs: (rg && Number(rg.startedAt)) || 0,
      pid: (rg && Number(rg.pid)) || 0,
      ccVersion: (rg && rg.version) ? String(rg.version) : '',
      entrypoint: (rg && rg.entrypoint) ? String(rg.entrypoint) : '',
      kind: (rg && rg.kind) ? String(rg.kind) : '',
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
      // 原始数值一并给出去：界面要按列排序，而按 '3m20s' 这类显示文本排序
      // 会得出 '10s' > '3m' 的荒谬结果。
      wait,
      dur,
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
    usage: readUsageWindows(),
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
  buildRows, getLastExchange, getHealthIssues, getMissingHooks, statusLegend,
  removeRecord, unhideRecord, clearStaleRecords, formatDuration,
  // 用量快照的读取与路径由数据层单一定义，界面层/引导层都从这里取 ——
  // 各自硬编码一份路径的话，改一处就会静默错位（引导写 A、看板读 B）。
  readUsageWindows, readSessionMeta, USAGE_SNAPSHOT, HUD_DIR, HUD_CONTEXT_CACHE_DIR,
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

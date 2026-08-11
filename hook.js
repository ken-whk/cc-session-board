#!/usr/bin/env node
'use strict'

// Claude 并发会话看板 —— 状态写入 hook。
//
// 由三个 hook 事件调用，用 argv[2] 显式传状态（不依赖 hook_event_name，
// 免得平台改字段名就静默失效）：
//   UserPromptSubmit -> running   （这一轮开始跑）
//   Stop             -> done      （这一轮回答结束）
//   Notification     -> waiting   （等你授权 / 空闲等你输入）
//   SessionEnd       -> closed    （会话关闭，直接删记录）
//
// 设计约束：
// 1) 每个 session 单独一个 json 文件。多会话并发时各写各的，不会互相覆盖
//    ——这是本方案能支撑"任意多并发会话"的前提。
// 2) 写入走 temp + rename（同盘 rename 在 Windows 上是原子替换），
//    保证看板 GUI 永远不会读到写了一半的文件。
// 3) 全程 try/catch + 恒 exit 0，且**绝不往 stdout 写任何东西**
//    ——UserPromptSubmit 的 stdout 会被注入进会话上下文，写东西就污染对话；
//    Stop 的非零退出码会阻断会话。看板是旁路设施，绝不能干扰会话本身。

const fs = require('fs')
const os = require('os')
const path = require('path')

// 状态过期阈值：超过这个时长的状态文件在每次写入时顺手清掉，
// 避免 state 目录随会话数无限增长（关掉的会话不会自己来删文件）。
const STALE_MS = 24 * 60 * 60 * 1000

// transcript 尾部读取窗口：只读最后这些字节找最后一句回答，
// 避免长会话 transcript（可达数十 MB）被整体读进内存。
const TAIL_BYTES = 256 * 1024

// 摘要截断长度：看板底部单行显示，过长无意义。
const SUMMARY_MAX = 300

// 看板和 hook 必须读写**同一个** state 目录，否则 hook 往 A 写、看板从 B 读，
// 看板永远空着且不报错。做法是双方都固定用 home 下的同一路径 ——
// 与 board-core.js 的 INSTALL_DIR 必须逐字一致。
//
// 早先这里用 __dirname。在源码目录跑时它恰好等于下面这个路径，所以本机没暴露；
// 但打包后 __dirname 落在应用包内部（macOS 的 .app / Windows 的安装目录），
// 那里通常只读，写 state 会静默失败。
const BOARD_DIR = path.join(os.homedir(), '.claude', 'session-board')
const STATE_DIR = path.join(BOARD_DIR, 'state')

function readStdin() {
  try {
    // fd 0 同步读到 EOF。hook 的 stdin 是一次性 JSON，量很小。
    return fs.readFileSync(0, 'utf8')
  } catch (_) {
    return ''
  }
}

// 从 cwd 推出人类可读的标签。
// worktree 布局 .sdlc/worktrees/{slug} 下取 slug（这才是"哪个交付"），
// 否则退化为目录名。
function deriveLabel(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/')
  if (!norm) return '(未知目录)'
  const wt = norm.match(/\.sdlc\/worktrees\/([^/]+)/)
  if (wt) return wt[1]
  const parts = norm.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || norm
}

// 定位 transcript。优先用 payload 给的路径；缺失时按
// ~/.claude/projects/<编码后的cwd>/<session_id>.jsonl 的布局兜底搜一层。
function resolveTranscript(payload, sessionId) {
  const given = payload && payload.transcript_path
  if (given && fs.existsSync(given)) return given
  if (!sessionId) return ''
  try {
    const projects = path.join(os.homedir(), '.claude', 'projects')
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, sessionId + '.jsonl')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch (_) { /* 找不到就不给摘要，不是错误 */ }
  return ''
}

// 取 transcript 里最后一条 assistant 文本，作为"最后一句"摘要。
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return ''
  let raw = ''
  try {
    const size = fs.statSync(transcriptPath).size
    const start = Math.max(0, size - TAIL_BYTES)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const len = size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      raw = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (_) {
    return ''
  }

  const lines = raw.split('\n')
  // 从后往前找：第一行可能被 TAIL_BYTES 切断，JSON.parse 失败就跳过。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch (_) {
      continue
    }
    if (rec.type !== 'assistant') continue
    const content = rec.message && rec.message.content
    if (!Array.isArray(content)) continue
    const texts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (!texts.length) continue
    const flat = texts.join(' ').replace(/\s+/g, ' ').trim()
    if (!flat) continue
    return flat.length > SUMMARY_MAX ? flat.slice(0, SUMMARY_MAX) + '…' : flat
  }
  return ''
}

// 提取会话标题：Claude Code 自己会往 transcript 里写 {"type":"ai-title","aiTitle":"..."}，
// 就是 /resume 列表里显示的那个标题，比 worktree 目录名有信息量得多。
//
// 坑：标题不一定在文件尾部 —— 有的会话整场只写过 1 条 ai-title，位置很靠前，
// 只扫尾部会漏。所以尾部找不到时允许全量扫一次（调用方负责只扫一次并把结果记进 state）。
function extractTitle(transcriptPath, allowFullScan) {
  if (!transcriptPath) return ''

  const pick = (text) => {
    const idx = text.lastIndexOf('"type":"ai-title"')
    if (idx < 0) return ''
    const lineStart = text.lastIndexOf('\n', idx) + 1
    let lineEnd = text.indexOf('\n', idx)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const rec = JSON.parse(text.slice(lineStart, lineEnd))
      return typeof rec.aiTitle === 'string' ? rec.aiTitle.trim() : ''
    } catch (_) {
      return ''
    }
  }

  try {
    const size = fs.statSync(transcriptPath).size
    const start = Math.max(0, size - TAIL_BYTES)
    let tail = ''
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const len = size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      tail = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const hit = pick(tail)
    if (hit) return hit
    // 已经读到文件头了就没必要再全量读一遍
    if (!allowFullScan || start === 0) return ''
    return pick(fs.readFileSync(transcriptPath, 'utf8'))
  } catch (_) {
    return ''
  }
}

// 顺手清理过期状态文件。放在写入路径里，省掉一个常驻清理进程。
function pruneStale() {
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(STATE_DIR)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(STATE_DIR, name)
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file)
      } catch (_) { /* 单个文件清不掉不影响其他 */ }
    }
  } catch (_) { /* 目录还不存在等，忽略 */ }
}

function writeAtomic(file, text) {
  // 同目录 temp + rename：Windows 下同盘 rename 是原子替换，
  // GUI 侧因此不需要加锁也读不到半个文件。
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function main() {
  const status = process.argv[2] || 'running'

  let payload = {}
  const raw = readStdin()
  try {
    if (raw) payload = JSON.parse(raw)
  } catch (_) { /* 非法 stdin -> 空 payload，仍然记一条，至少能看到有会话在动 */ }

  fs.mkdirSync(STATE_DIR, { recursive: true })

  // 首次运行留一份原始 payload，供事后核对字段名是否与预期一致
  // （平台改 hook 契约时，这是唯一的现场证据）。
  try {
    const probe = path.join(BOARD_DIR, '_last-payload-' + status + '.json')
    fs.writeFileSync(probe, raw || '{}', 'utf8')
  } catch (_) { /* 探针写不了不影响主流程 */ }

  const sessionId = payload.session_id || ('unknown-' + process.pid)
  const cwd = payload.cwd || process.cwd()
  const file = path.join(STATE_DIR, String(sessionId).replace(/[^\w.-]/g, '_') + '.json')

  // 会话关闭：直接删记录。否则关掉的会话会挂在看板上直到 24h 过期清理，
  // 让你误以为它还在跑（实测踩过：看板行数比真实开着的会话多）。
  if (status === 'closed') {
    try { fs.unlinkSync(file) } catch (_) { /* 本来就没有，无所谓 */ }
    pruneStale()
    return
  }

  let prev = {}
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) { /* 首次见到这个 session */ }

  // transcript 路径必须落进 state：看板用它的 mtime 当心跳
  // （每条消息落盘就会更新），也用它检测"是否卡在 AskUserQuestion 等人作答"。
  // 这是"运行中"能区分真跑 / 失联 / 阻塞的唯一信源。
  const transcript = resolveTranscript(payload, sessionId) || prev.transcript_path || ''

  // 标题：优先取 transcript 尾部最新的；取不到就沿用上次的；
  // 都没有且从没全量扫过，才允许全量扫一次（扫过就打标记，避免每轮重复读整个文件）。
  const prevTitle = prev.title || ''
  const allowFullScan = !prevTitle && !prev.title_scanned
  const title = extractTitle(transcript, allowFullScan) || prevTitle

  const now = Date.now()
  const state = {
    session_id: sessionId,
    cwd: cwd,
    label: deriveLabel(cwd),
    status: status,
    title: title,
    title_scanned: (prev.title_scanned === true) || allowFullScan,
    transcript_path: transcript,
    // 你真正敲进去的那句话。
    // 为什么不从 transcript 里刨：transcript 的 user 消息**不等于**人打的字 ——
    // 壳层会把 SKILL.md 正文、IDE 上下文、hook 注入内容都塞成 user 角色消息
    // （实测：一次 /sdlc:implement 让"你说的话"变成整篇 skill 文档）。
    // UserPromptSubmit 的 payload.prompt 只在人真的提交时出现，是唯一干净的信源。
    last_prompt: prev.last_prompt || '',
    first_seen_ms: prev.first_seen_ms || now,
    updated_ms: now,
    // 本轮开始时间：running 时刷新；其他状态沿用，用来算用时。
    turn_started_ms: status === 'running' ? now : (prev.turn_started_ms || now),
    turn_count: status === 'running' ? (prev.turn_count || 0) + 1 : (prev.turn_count || 0),
    summary: prev.summary || '',
    duration_ms: prev.duration_ms || 0,
  }

  if (status === 'running') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.replace(/\s+/g, ' ').trim() : ''
    if (prompt) state.last_prompt = prompt.slice(0, SUMMARY_MAX)
    state.summary = prompt ? '（正在处理）' + prompt.slice(0, SUMMARY_MAX) : '（正在处理）'
    state.duration_ms = 0
  } else if (status === 'done') {
    state.duration_ms = Math.max(0, now - state.turn_started_ms)
    const text = lastAssistantText(resolveTranscript(payload, sessionId))
    if (text) state.summary = text
  } else if (status === 'waiting') {
    // Notification 事件：可能是等授权，也可能是空闲等输入。
    // message 是平台给的提示文案，直接透传比自己编更可信。
    const msg = typeof payload.message === 'string' ? payload.message.replace(/\s+/g, ' ').trim() : ''
    state.summary = msg || '等待你的输入'
    // 用时保持 done 时算出的值；若从 running 直接来（等授权），按当前时长算。
    if (!state.duration_ms) state.duration_ms = Math.max(0, now - state.turn_started_ms)
  }

  writeAtomic(file, JSON.stringify(state, null, 2))
  pruneStale()
}

try {
  main()
} catch (_) {
  // 恒静默成功：看板坏了也不许拖累会话。
}
process.exit(0)

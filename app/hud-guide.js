'use strict'

// 顶部「5h / 周用量」的依赖引导。
//
// 背景：那两个数字来自 Anthropic 官方 usage 接口，认证要读账号的 OAuth token
// （keychain / .credentials.json）。看板**不联网、不碰凭据**是它值得保住的属性，
// 所以不自己调接口 —— 改为消费 claude-hud 落下的快照文件。
// 代价是多了一个外部依赖，于是需要这份引导。
//
// 三档状态里只有中间那档能自动化：
//   没装 hud            -> 只能给命令。插件安装是 Claude Code 自己 marketplace 的
//                          行为，Electron 进程无从代劳（也不该去伪造 settings.json，
//                          插件本体没下载，写了也跑不起来）。
//   装了但快照出口没开   -> **可以代办**：写一行 hud 的 config.json。这是默认状态。
//   都齐了              -> 静默通过（只有手动打开引导时才回一句"已就绪"）。

const fs = require('fs')
const path = require('path')
const { dialog, clipboard, shell } = require('electron')

const core = require('../board-core.js')

const HUD_CONFIG = path.join(core.HUD_DIR, 'config.json')

// 安装命令来自实测：本机 marketplace 的 git remote 是这个仓库，
// marketplace 名与插件名都叫 claude-hud（读 .claude-plugin/marketplace.json 得到）。
// 不要凭印象改这几行 —— 写错了用户照抄会失败。
const INSTALL_STEPS = [
  '/plugin marketplace add https://github.com/jarrodwatts/claude-hud.git',
  '/plugin install claude-hud@claude-hud',
  '/claude-hud:setup',
].join('\n')

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
}

// 判据是"有没有真东西"，不是"目录在不在" —— plugins/cache 下可能留着
// 卸载后的空壳目录，只看目录存在会把没装判成装了。
function hudInstalled() {
  const cacheRoot = path.join(core.CLAUDE_DIR, 'plugins', 'cache')
  let markets
  try { markets = fs.readdirSync(cacheRoot) } catch (_) { return false }
  for (const m of markets) {
    const hudRoot = path.join(cacheRoot, m, 'claude-hud')
    let versions
    try { versions = fs.readdirSync(hudRoot) } catch (_) { continue }
    for (const v of versions) {
      if (fs.existsSync(path.join(hudRoot, v, 'dist', 'index.js'))) return true
    }
  }
  return false
}

// hud 装了不等于在跑 —— 它得被接成 statusline 才会周期性渲染并写快照。
function statuslineWired() {
  const s = readJson(path.join(core.CLAUDE_DIR, 'settings.json'))
  const cmd = s && s.statusLine && s.statusLine.command
  return typeof cmd === 'string' && /hud/i.test(cmd)
}

function detect() {
  const cfg = readJson(HUD_CONFIG)
  const writePath = (cfg && cfg.display && cfg.display.externalUsageWritePath) || ''
  const usage = core.readUsageWindows()
  return {
    installed: hudInstalled(),
    wired: statuslineWired(),
    // 只认指向看板真正读取的那个路径 —— 指向别处等于没开
    writePathOk: path.normalize(String(writePath) || '.') === path.normalize(core.USAGE_SNAPSHOT),
    writePath: String(writePath || ''),
    hasSnapshot: !!usage,
    snapshotStale: !!(usage && usage.stale),
  }
}

function ready(st) {
  return st.installed && st.wired && st.writePathOk && st.hasSnapshot && !st.snapshotStale
}

// 代写 hud 的配置：只加/改 display.externalUsageWritePath 这一个键，
// 其余键原样保留（外科手术，别顺手规范化人家的配置文件）。
function enableSnapshot() {
  const cfg = readJson(HUD_CONFIG) || {}
  if (!cfg.display || typeof cfg.display !== 'object') cfg.display = {}
  cfg.display.externalUsageWritePath = core.USAGE_SNAPSHOT.replace(/\\/g, '/')
  fs.mkdirSync(path.dirname(HUD_CONFIG), { recursive: true })
  fs.writeFileSync(HUD_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

function statusLines(st) {
  const mark = (ok) => (ok ? '✓' : '✗')
  return [
    mark(st.installed) + ' claude-hud 已安装',
    mark(st.wired) + ' 已接成 statusline（不接就不会周期刷新）',
    mark(st.writePathOk) + ' 用量快照出口已指向 ' + core.USAGE_SNAPSHOT,
    mark(st.hasSnapshot && !st.snapshotStale) + ' 快照文件有新鲜数据',
  ].join('\n')
}

/**
 * 弹出引导。
 *
 * @param {object} opts
 * @param {import('electron').BrowserWindow} opts.win  父窗口，可为 null
 * @param {boolean} opts.manual  true = 用户主动从菜单打开（就绪时也要给回执）；
 *                               false = 首次运行自动弹（就绪则静默）
 * @param {function} opts.onDismissForever  用户勾了"不再自动提示"时回调
 * @returns {Promise<boolean>} 是否做过改动（调用方据此决定要不要刷新）
 */
async function show(opts) {
  const win = opts && opts.win
  const manual = !!(opts && opts.manual)
  const st = detect()

  if (ready(st)) {
    if (manual) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: '用量显示已就绪',
        message: '顶部的 5h / 周用量正常工作',
        detail: statusLines(st) + '\n\n看板只读这个快照文件，不联网、不读取任何凭据。',
        buttons: ['好'],
      })
    }
    return false
  }

  // 装了、也接上了，只差那个出口 —— 唯一能代办的一档
  if (st.installed && st.wired) {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: '开启 5h / 周用量显示',
      message: '需要让 claude-hud 把用量快照写到一个文件，看板读它',
      detail: statusLines(st)
        + '\n\n点「帮我开启」会在 claude-hud 的配置里加一行：'
        + '\n  display.externalUsageWritePath = ' + core.USAGE_SNAPSHOT
        + '\n\n只加这一个键，其余配置原样保留。开启后下一次 statusline 刷新即生效。',
      buttons: ['帮我开启', '以后再说'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: '不再自动提示',
      checkboxChecked: false,
    })
    if (r.checkboxChecked && opts && opts.onDismissForever) opts.onDismissForever()
    if (r.response !== 0) return false

    try {
      enableSnapshot()
      await dialog.showMessageBox(win, {
        type: 'info',
        title: '已开启',
        message: '配置写好了',
        detail: '任意 Claude Code 会话下一次刷新 statusline 时（约 30 秒内）'
          + '就会写出快照，顶部随即显示 5h / 周用量。',
        buttons: ['好'],
      })
      return true
    } catch (e) {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '写入失败',
        message: '没能改 claude-hud 的配置',
        detail: String((e && e.message) || e) + '\n\n配置文件：' + HUD_CONFIG,
        buttons: ['好'],
      })
      return false
    }
  }

  // 没装 / 没接 statusline —— 只能引导，代劳不了
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    title: '顶部 5h / 周用量需要 claude-hud',
    message: st.installed
      ? 'claude-hud 装了，但还没接成 statusline'
      : '这项显示依赖 claude-hud（未安装）',
    detail: statusLines(st)
      + '\n\n为什么绕一层：那两个数字来自 Anthropic 官方接口，认证要读你的账号凭据。'
      + '看板刻意不联网、不碰凭据，所以改为读 claude-hud 落下的快照。'
      + '\n\n在任意 Claude Code 会话里依次执行：\n' + INSTALL_STEPS
      + '\n\n装好后回到看板：设置菜单 → 用量显示设置，点「帮我开启」。'
      + '\n\n（不装也不影响看板其余功能，只是顶部没有 5h / 周两个数字。'
      + '每个会话自己的上下文占用不依赖它。）',
    buttons: ['复制这三条命令', '打开项目主页', '知道了'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: '不再自动提示',
    checkboxChecked: false,
  })
  if (r.checkboxChecked && opts && opts.onDismissForever) opts.onDismissForever()
  if (r.response === 0) clipboard.writeText(INSTALL_STEPS)
  if (r.response === 1) shell.openExternal('https://github.com/jarrodwatts/claude-hud')
  return false
}

module.exports = { detect, ready, show }

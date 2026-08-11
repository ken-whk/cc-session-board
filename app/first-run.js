'use strict'

// 首次运行自安装。Electron 版原先完全没有这一步 ——
// 同事装上打开只会看到一块空白看板：Claude Code 那边没注册任何 hook，
// 没人往 state 里写数据，而且不报错，看起来像"没有会话"而不是"没装好"。
//
// 做三件事，全部幂等，每次启动都可以安全地跑：
//   1. 建 ~/.claude/session-board/ 与其 state/ 子目录
//   2. 把应用包里的 hook.js 拷到上面这个目录（内容不同才拷，兼作升级）
//   3. 把四个 hook 注册进 ~/.claude/settings.json（已正确注册就不动文件）
//
// 为什么 hook.js 必须拷出应用包、不能就地注册包内路径：
//   - macOS 的 .app 放进 /Applications 后内部只读，写 state 会静默失败
//   - 应用被移动/改名/重装后，注册进去的绝对路径就悬空了
//   - install-hooks 用 'session-board/hook.js' 作卸载标记，包内路径不含这段

const fs = require('fs')
const path = require('path')

const core = require('../board-core.js')
const installer = require('../install-hooks.js')

/**
 * 确保 hook 链路已就绪。
 *
 * 不抛异常：安装失败也要让看板正常开起来，然后由界面顶部的健康提示
 * （getHealthIssues）把问题显示给用户 —— 静默失败和崩溃都比这个差。
 *
 * @returns {{ok:boolean, actions:string[], errors:string[]}}
 *          actions = 本次真正做了的改动，空数组表示本来就装好了
 */
function ensureInstalled() {
  const actions = []
  const errors = []

  try {
    fs.mkdirSync(core.STATE_DIR, { recursive: true })
  } catch (e) {
    errors.push('建目录失败: ' + e.message)
    // 目录都建不出来，后面两步没有意义
    return { ok: false, actions: actions, errors: errors }
  }

  // ---- hook.js 就位 ----
  const src = path.join(core.CODE_DIR, 'hook.js')
  const dst = core.HOOK_JS
  try {
    // 源码目录直接跑时两者是同一个文件，拷贝会把文件截断成空 —— 必须先判同。
    const same = path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()
    if (!same) {
      let need = true
      if (fs.existsSync(dst)) {
        // 按内容比而不是按 mtime：解压/拷贝会重置时间戳，mtime 判不准。
        try {
          need = fs.readFileSync(src, 'utf8') !== fs.readFileSync(dst, 'utf8')
        } catch (_) { need = true }
      }
      if (need) {
        fs.copyFileSync(src, dst)
        actions.push('已安装 hook.js -> ' + dst)
      }
    }
  } catch (e) {
    errors.push('拷贝 hook.js 失败: ' + e.message)
  }

  // ---- 注册进 settings.json ----
  try {
    const missing = installer.findUnregistered(dst)
    if (missing.length > 0) {
      const res = installer.applyHooks({ hookJs: dst })
      actions.push('已注册 hook（缺 ' + missing.join('/') + '，改动 ' + res.changed + ' 条）')
    }
  } catch (e) {
    errors.push('注册 hook 失败: ' + e.message)
  }

  return { ok: errors.length === 0, actions: actions, errors: errors }
}

module.exports = { ensureInstalled: ensureInstalled }

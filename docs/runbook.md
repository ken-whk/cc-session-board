# 运维手册（换机器 / 打包分发）

从 `CLAUDE.md` 移出来的两段。它们是**刻意去查**的操作流程，不是"改代码前必须知道"的约束，
所以不放在每个会话都加载的 `CLAUDE.md` 里 —— 那里的常驻额度留给铁律。

改代码相关的踩坑与约束仍在 `CLAUDE.md`；产品说明看 `README.md`；
装给别人用的说明看 `README-分发.md`。

---

## 换了机器怎么接着做

**必须 clone 到 `~/.claude/session-board/`**，不能放别处 —— `board-core.js` 的 `INSTALL_DIR` 和注册进 `settings.json` 的 hook 路径都以它为准（见 CLAUDE.md 铁律 4）。

```
git clone https://github.com/ken-whk/cc-session-board.git ~/.claude/session-board
cd ~/.claude/session-board
npm i          # node_modules 不进仓；只有打包才真正需要它，npm start 也依赖 electron
npm start      # 从源码跑，开发时用这个
node install-hooks.js    # 注册 4 个 hook（首次启动时 app/first-run.js 也会自动做）
```

跟着仓库走的：代码、`README.md`、`CLAUDE.md`（所有踩过的坑）、本文件。
**不跟着走**的：`state/` `hidden.json` `ui*.json`（本机运行数据，by design）、以及这台机器 Claude Code 的 memory —— 所以别把作业约束写进 memory，**写进 `CLAUDE.md`**。

新机器只需要 node + Claude Code；不需要 PowerShell 特定版本（三个 .ps1 只是调试工具，不跑也不影响看板）。

从源码跑（`npm start`）比装打包版省事：**没有"同步进 bundle"这一步**，改完重启即可。只有要发给别人时才需要打包。

---

## 分发

**日常改动不需要打包** —— 改完 JS/HTML 同步进 `D:\Tools\...\resources\app\` 再重启即可（见 CLAUDE.md 铁律 1、2）。

真要重新发给同事时：

1. **先 `npm i`** —— `node_modules/`（electron + electron-packager，约 374M）已在 2026-08-10 清理时删掉，仓里只有 `package.json` / `package-lock.json`。不装依赖直接跑 `npm run pack:*` 会失败。
2. Windows 包 `npm run pack:win`；**macOS 包跑 `build-mac.cmd`**（不是 `npm run pack:mac` —— 那条已改成直接报错并指向这里，见下条 4 的理由）。产物落 `dist/`（该目录里的包是可重新生成的产物）。
3. **打 macOS 包必须提权**（或开开发者模式）：`.app` 内含 14 个符号链接，Windows 建符号链接要管理员权限。不满足时 electron-packager **只打印一行 skip 然后什么都不产出**，不报错也不退出非零，极易误判成"打好了"。自查 `find X.app -type l | wc -l` 应为 14。
4. **macOS 包只能由 `build-mac.cmd` 打，不要手敲 tar**。它在 electron-packager 之后接一步 `tar --mode=755` 把执行位**写进归档**——Git Bash 的 `chmod` 在 NTFS 上是 no-op（2026-08-18 实测：`chmod 755` 后 `ls -l` 仍 `-rw-r--r--`），所以权限只能在打包这一刻给，给不了就得让每个 Mac 同事手敲三条 `chmod +x`。

   两个坑：① **不能用裸 `tar`**——Win10 1803+ 的 `tar` 是 `System32\tar.exe`（bsdtar），它直接拒绝 `--mode`（`Option --mode=755 is not supported`），脚本因此按全路径找 Git 自带的 GNU tar；② 仍**必须走 tar.gz**，zip 会破坏符号链接，Mac 侧也仍用 `tar -xzf` 解压（"双击解压会不会毁符号链接"这条至今没真机核实，先保守）。

   Gatekeeper 隔离照旧：从共享盘/U 盘拿包通常不会被标记；被拦时右键→打开一次，或 `xattr -dr com.apple.quarantine`。
5. **打完审隐私**：`--ignore` 漏了会把 `state/`（含你的会话标题、项目路径、你敲的原话）、`_last-payload-*.json`（含 prompt 原文）、UI 设置、调试截图一起打进去。曾实测把含会话标题和项目路径的 `board-capture.png` 打进过两个包。打完 grep 一遍产物确认。

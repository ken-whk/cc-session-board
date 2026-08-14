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
2. `npm run pack:win` / `npm run pack:mac`，产物落 `dist/`（该目录里旧的两个包已删，是可重新生成的产物）。
3. **打 macOS 包必须提权**（或开开发者模式）：`.app` 内含 14 个符号链接，Windows 建符号链接要管理员权限。不满足时 electron-packager **只打印一行 skip 然后什么都不产出**，不报错也不退出非零，极易误判成"打好了"。自查 `find X.app -type l | wc -l` 应为 14。
4. **必须用 tar.gz 传 macOS 包**，zip 会破坏符号链接；Mac 侧也必须 `tar -xzf`，不能双击解压。执行位在 NTFS 上必然丢失，要 Mac 侧 `chmod +x`，外加 `xattr -dr com.apple.quarantine` 解 Gatekeeper 隔离。
5. **打完审隐私**：`--ignore` 漏了会把 `state/`（含你的会话标题、项目路径、你敲的原话）、`_last-payload-*.json`（含 prompt 原文）、UI 设置、调试截图一起打进去。曾实测把含会话标题和项目路径的 `board-capture.png` 打进过两个包。打完 grep 一遍产物确认。

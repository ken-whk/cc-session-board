# Claude 会话看板（session-board）

本机自建的并发会话状态面板。**不在任何 git 仓里** —— 改动没有回退点，动大改造前先手动拷一份备份目录。

产品说明看 `README.md`（面向使用者）；本文件是给 AI 的作业约束（面向修改者）。

---

## 它是什么

并发跑多个 Claude Code 会话时，一个常驻窗口告诉你**现在该切到哪个会话去**。按"有多需要你"排序，最上面那条就是该先处理的。

**只有一套实现**（Electron，跨 Windows / macOS）：

| 层 | 文件 |
|---|---|
| 界面 | `app/main.js`（主进程）+ `app/index.html`（渲染层）+ `app/preload.js`（IPC 通道） |
| 数据 | `board-core.js` —— 只算"该显示什么"，不碰界面 |
| 采集 | `hook.js`（4 个 hook 事件调起）+ `install-hooks.js`（幂等注册/卸载） |
| 启动 | `D:\Tools\ClaudeBoard-win-x64\ClaudeBoard.exe`（桌面快捷方式指向它） |

历史上还有 WinForms（`board.ps1`）和 WPF（`board-wpf.ps1` + `board-core.ps1`）两套 PS 实现，**2026-08-10 已全部删除**。删的原因是双实现的同步成本每次改动都要付，而退路价值是假设的——打包版自带 runtime，真出问题回退上一个包即可。**不要再引入第二套 UI**；要真退路就整个拷一份 `D:\Tools\ClaudeBoard-win-x64\` 存快照，零维护。

---

## 三信源模型（改任何显示逻辑前必须先理解）

| 信源 | 性质 | 提供 |
|---|---|---|
| `~/.claude/sessions/<pid>.json` | Claude Code 的活会话注册表，**未公开实现**，不归看板管 | 有哪些会话 / 死活（pid）/ 忙闲（status） |
| `state/<session_id>.json` | 本看板 4 个 hook 写的观测记录 | 等你多久 / 本轮用时 / 摘要 / 标题 / 你敲的原话 |
| `hidden.json` | **用户意图**（第三类事实） | 哪些被你手动隐藏了 |

**一行是否存在 = 注册表 ∪ state 文件的并集。** 注册表读不到时整体降级回 hook 推导，且不再判定「已关闭」。

hook 事件映射：`UserPromptSubmit`→running / `Stop`→done / `Notification`→waiting / `SessionEnd`→closed（删 state 文件）。

---

## 铁律（踩过的坑，全部有实证）

### 1. 改完 JS/HTML 必须同步进已安装的那份，否则跑的还是旧代码

跑的是 `D:\Tools\ClaudeBoard-win-x64\`，不是源码目录：

```
cp board-core.js  "D:/Tools/ClaudeBoard-win-x64/resources/app/board-core.js"
cp app/*.js app/index.html "D:/Tools/ClaudeBoard-win-x64/resources/app/app/"
```

拷完 `cmp -s` 逐个比对确认。**只改 JS/HTML 不必重打整包**，symlink 不受影响。

### 2. 重启必须"全杀再拉起"，否则被单实例锁静默挡掉

双击 exe 时若旧实例还在，新进程会被 `requestSingleInstanceLock()` 挡掉、**静默退出**，现象是"重启了但改动没生效"，极易误判成代码有问题。

正确做法：`Get-Process ClaudeBoard | Stop-Process -Force` → 确认全没了 → `Start-Process` 拉起 → **用 `CreationDate` 确认是新实例**。

判据陷阱：`Get-Process` 会列出一堆同名进程，其中多数是 helper。看 `ParentProcessId` —— 父进程指向老 main 的都是 helper，不是新实例。（已实测误判过一次。）

### 3. 编码：`hidden.json` 不能有 BOM；剩下的 .ps1 保持 ASCII-only

- `hidden.json` **必须 UTF-8 无 BOM** —— node 的 `JSON.parse` 遇 BOM 直接抛。
- `capture.ps1` / `watch-flicker.ps1` / `close-board.ps1` 三个调试脚本头部都写了 **ASCII-only**，别往里加中文。本机只有 PowerShell 5.1，无 BOM 的中文会被按 ANSI 解码成乱码并解析失败；真要加中文就必须存成 UTF-8 with BOM（`head -c 3` 验 `ef bb bf`）。

### 4. 可写数据固定在 `~/.claude/session-board/`，不用 `__dirname`

`state/` / UI 设置 / `hidden.json` / 被注册进 `settings.json` 的那份 `hook.js` 一律走 `INSTALL_DIR`。打包后 `__dirname` 落在应用包内部（macOS `/Applications`、Windows `Program Files` 只读）→ 静默写失败、看板永远空着还不报错。源码目录跑时两者恰好相等，所以本机长期不暴露。

**代码/脚本自身**（找同目录的图标、模板）才用 `__dirname`。

### 5. 渲染层 → 主进程的 IPC 对象是**裁剪过的**，加字段要两头都改

`index.html` 的 contextmenu 只传 `{sessionId, cwd, label, hidden}`，不是整行。主进程要读新字段，必须先在渲染层加上——否则恒为 `undefined`，分支永远走不到。（已实测踩过：菜单里的「取消隐藏」一直不出现。）

### 6. 隐藏靠墓碑，绝不靠删数据

想让一行消失只能**多喂一条事实**（写 `hidden.json`），不能删它的某个输入。曾经的 `removeRecord` 实现成删 state 文件，但存在性判据是并集，注册表还在的那一行下一帧原地重建 —— 表现为"删不掉"。

复活条件：`state.updated_ms > 隐藏时刻`（它下次有动静自己回来）。GC：id 既不在注册表也无 state 文件就丢弃墓碑。

**这条的一般形式**：信源升级后，必须回头审计所有依赖旧存在性判据的操作。

### 7. 术语只有一套：**隐藏 / 取消隐藏**

已废除「收起」「折叠」两个词。复选框叫「显示全部」（它管的不只手动隐藏那一档）。新增文案沿用这套，别再引入第三个词。

### 8. 界面重绘类问题用抓帧比对，别猜

`watch-flicker.ps1` 连续截同一窗口区域逐像素 diff，看 changed 数量与 bbox —— bbox 形态能直接区分"几个数字在变"和"整片重绘"。当年靠它才定位到 WinForms 版闪烁的元凶是 ToolTip 而非刷新逻辑。`capture.ps1` 截当前窗口存 `board-capture.png`。两个都按**窗口标题 + 最小尺寸**匹配，与 UI 框架无关。

`close-board.ps1` 发 `WM_CLOSE` 而不是杀进程 —— 走正常关闭路径，`win.on('close')` 里的 `saveSettings` 才会执行。调试时想保住窗口位置/勾选项就用它。

---

## 自检方式

```
node board-core.js            # 打印当前该显示的行，能跑通即数据层没崩
node board-core.js --json     # 结构化输出
```

改判定逻辑（隐藏/复活/GC/计数）时写一次性自检脚本跑全路径，跑完删掉 —— 已有先例，12 项断言覆盖"隐藏 → 折叠视图可达 → 复活 → GC → 取消隐藏"全链路。

自检脚本会真的写 `hidden.json`，**开头先存原值、结尾恢复**，否则跑一次测试就把你真实的隐藏列表改了（踩过：上一轮崩掉的测试留下一条脏记录，导致下一轮两个断言假 FAIL，白查一轮）。

---

## 已知硬限制（别再尝试绕）

- **强杀 / 直接关终端 / 关机不触发 `SessionEnd`**，记录会残留。transcript 文件锁、`~/.claude/ide/*.lock` 两条替代判活路子实测都不通，只能靠 pid 交叉校验。
- **终端标签页名读不到**。VS Code 那个 `· Claude Code` 标签与 Claude 会话无任何数据关联，已按字节全量搜过 `~/.claude` 全树 + VS Code storage，0 命中。要稳定命名只能自建别名。
- **双击只能打开目录**，切不到那个终端窗口 —— 拿不到窗口句柄。

---

## 分发

**日常改动不需要打包** —— 改完 JS/HTML 同步进 `D:\Tools\...\resources\app\` 再重启即可（见铁律 1、2）。

真要重新发给同事时：

1. **先 `npm i`** —— `node_modules/`（electron + electron-packager，约 374M）已在 2026-08-10 清理时删掉，仓里只有 `package.json` / `package-lock.json`。不装依赖直接跑 `npm run pack:*` 会失败。
2. `npm run pack:win` / `npm run pack:mac`，产物落 `dist/`（该目录里旧的两个包已删，是可重新生成的产物）。
3. **打 macOS 包必须提权**（或开开发者模式）：`.app` 内含 14 个符号链接，Windows 建符号链接要管理员权限。不满足时 electron-packager **只打印一行 skip 然后什么都不产出**，不报错也不退出非零，极易误判成"打好了"。自查 `find X.app -type l | wc -l` 应为 14。
4. **必须用 tar.gz 传 macOS 包**，zip 会破坏符号链接；Mac 侧也必须 `tar -xzf`，不能双击解压。执行位在 NTFS 上必然丢失，要 Mac 侧 `chmod +x`，外加 `xattr -dr com.apple.quarantine` 解 Gatekeeper 隔离。
5. **打完审隐私**：`--ignore` 漏了会把 `state/`（含你的会话标题、项目路径、你敲的原话）、`_last-payload-*.json`（含 prompt 原文）、UI 设置、调试截图一起打进去。曾实测把含会话标题和项目路径的 `board-capture.png` 打进过两个包。打完 grep 一遍产物确认。

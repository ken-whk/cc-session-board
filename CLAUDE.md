# Claude Code 会话看板（session-board）

本机自建的并发会话状态面板。远端 `github.com/ken-whk/cc-session-board`（私有仓，分支 `main`）。

**提交纪律**：`state/` / `_last-payload-*.json` / `hidden.json` / `ui*.json` 装的是运行数据（含会话标题、项目路径、你敲的原话），已在 `.gitignore` 里挡掉 —— 新增任何写运行数据的文件时，**先确认它被 ignore 再 `git add -A`**。本仓用 repo-local 身份提交（`ken-whk@users.noreply.github.com`），不要用全局的公司邮箱。

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

hook 事件映射：`UserPromptSubmit`→running / `Stop`→done / `Notification`→waiting / `SessionEnd`→closed（删 state 文件）。**例外**：`Notification` 且 `notification_type=idle_prompt` 不落记录（铁律 9）。

---

## 上报提醒

> 判定分两半（`dueReminders` 纯函数 + `hasUploadedOn` 读 NAS），产品决策与自检做法见 [`docs/upload-reminder.md`](docs/upload-reminder.md)。下面四条是不看文档也不能踩的：

- **`hasUploadedOn` 必须异步**。同文件其余读法是同步的，那些人点了才跑；这个后台定时跑，SMB 挂住时同步版会把主进程连同 1.5 秒刷新循环一起冻住，现象是"每天晚上定时卡一下"，根因指不回来。
- **`ok` 与 `uploaded` 是两件事**。`ok=false` 是"核对不了"，不等于"没报"——域账号打错一个字母就走这条，合成一个布尔会让看板一口咬定今天没报（铁律 9 同类）。
- **读 NAS 失败也要记账**。不记的话下一个 30 秒周期立刻重来，断网的晚上变成每半分钟一条通知。
- **别挂到 `tick()` 上**。到点才读，一天最多四次；进刷新循环等于后台轮询共享盘。

---

## 换机器 / 打包分发

> 见 [`docs/runbook.md`](docs/runbook.md)：**必须 clone 到 `~/.claude/session-board/`**（铁律 4）；日常改动不需要打包；打包有四个静默失败点。
> 这两件事刻意去查即可，不占常驻额度 —— 本文件只装"改代码前必须知道"的。作业约束别写进 memory（不跟仓库走），**写进本文件**。

---

## 铁律（踩过的坑，全部有实证）

### 1. 跑的是打包版时，改完 JS/HTML 必须同步进去，否则跑的还是旧代码

**先确认在跑哪一份**（这一步不能跳，本机踩过）：

```
Get-CimInstance Win32_Process -Filter "Name='ClaudeBoard.exe'" | Select ProcessId,ExecutablePath
```

- **从源码跑**（`npm start`）→ 改完直接重启，**没有同步这一步**。开发时推荐这种。
- **跑打包版** → 源码目录的改动对它无效，必须拷进 `<包目录>/resources/app/`：

  ```
  BUNDLE=<上面查出来的 ExecutablePath 所在目录>
  cp board-core.js "$BUNDLE/resources/app/board-core.js"
  cp app/*.js app/index.html "$BUNDLE/resources/app/app/"
  ```

  拷完 `cmp -s` 逐个比对确认。**只改 JS/HTML 不必重打整包**，symlink 不受影响。

（本机 2026-08 时的包在 `D:\Tools\ClaudeBoard-win-x64\`，换机器后按上面的命令重新查，别照抄这个路径。）

### 1b. `hook.js` 改完**也必须**同步进 bundle，否则下次重启被 first-run 覆盖回旧版

铁律 4 说"被注册进 `settings.json` 的那份 `hook.js` 走 `INSTALL_DIR`"——那句讲的是**哪一份被执行**，不是**改动能不能留住**。`app/first-run.js` 每次启动都会把**包内的 `hook.js` 拷到 `INSTALL_DIR`**（"内容不同才拷，兼作升级"）。所以跑打包版时只改源码目录那份，**下一次重启就被静默还原**。

现象极具迷惑性（2026-08-12 实测踩过）：改动**先生效、后消失**——改完到重启之间触发的 hook 事件写出了带新字段的 state，看着一切正常；重启后 `hook.js` 被还原，各会话下一次 hook 事件又把 state 覆盖成没有新字段的，于是界面上的东西一个一个地掉。很容易误判成"界面层的渲染有 bug"，而实际根因在采集层且已经不在文件里了。

自查：`grep -c <你加的函数名> hook.js`，以及 `ls -la hook.js` 看 mtime 是不是你刚才那次编辑。改完照抄：

```
cp hook.js "$BUNDLE/resources/app/hook.js" && cmp -s hook.js "$BUNDLE/resources/app/hook.js"
```

改完重启一次再 `grep` 一遍——**能扛住一次重启才算改完**。

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

### 6b. 唯一能真删数据的情形：残留记录（`isOrphan`）

铁律 6 管的是**隐藏**，不是说数据永远不能删。2026-08-13 加的「删除记录」是独立动作，边界由 `isOrphan(reg, regUsable, id)` 单一定义 —— **注册表里已经没有这个 id**。此时并集只剩 state 文件那半边，删掉它这一行永久消失，不会重建。注册表还有条目的行删了没用（那正是铁律 6 的原始症状），所以右键菜单**按行条件显示**，删不掉的行根本不给入口。

三个必守点：

- **`regUsable` 是护栏，不是可选项**。注册表整体读不到时每行的 `rg` 都是 undefined，判据全线假阳性 —— 少这一条，一次读取失败就能清空整个 `state/`。自动删除（`buildRows` 里那段）和手动删除（`purgeRecord`）都必须过它。
- **`purgeRecord` 自己重读注册表复核**，不信调用方传来的 `row.orphan`：右键菜单拿的是上一帧快照，点下去那一刻会话可能刚被 `--resume` 拉起来。
- **自动删除默认关闭**（`buildRows` 不传 `autoPurgeHours` 即 0）。`node board-core.js` 自检和任何未显式开启的调用都不许删数据。年龄按 `updated_ms` 而非文件 mtime 算。

**阈值的单位与收口**：落盘与数据层一律用**小时**（`settings.autoPurgeHours`，0 = 关闭），「天」只是界面上的输入/显示单位，换算只在 `main.js` 的 `formatPurgeHours` 与对话框里做，**不许让"天"漏进 `board-core`**。常用档 `PURGE_PRESETS` + 「自定义…」自绘对话框（Electron 原生菜单没有输入控件、`window.prompt` 被禁用，这是唯一路子）。校验与夹取 `[1 小时, 365 天]` 统一在 `applySetting` 里做 —— 两个入口都经过它，规则只写一次。旧键 `autoPurgeDays` 在 `loadSettings` 里迁移后删除。

**触发时机**：自动删除长在 `buildRows` 里，跟着 `tick()` 走（`REFRESH_MS` = 1.5s，外加启动时、每次隐藏/删除/改设置之后）。**看板关着就完全不清理**，下次打开第一帧补上。所以阈值不是"到点必删"，是"到点后第一次看板运行时删"。

**两个界面坑（均 2026-08-13 实测）**：① 自绘弹窗要自己挡按键 —— `keydown` 挂在 document 上，弹窗开着时整个 return，否则在输入框里按 Delete 会穿透下去把选中的行隐藏掉（原生对话框天然吃掉按键，自绘的不会）。② **radio 菜单项之间不许插 separator** —— Electron 按分隔符分 radio 组，档位与「自定义…」被隔开后，选自定义时档位那组一个都没 checked，Chromium 把组内第一项渲染成选中：两个圆点同时亮，且谎报当前规则是「关闭」。同一语义的 radio 必须连成一组。

**已知代价**：一个活会话都没有时 `regUsable` 为 false，残留记录既删不掉也不显示为「已关闭」（整体降级，见三信源模型），开一个会话就恢复。要改只能把判据从"注册表非空"换成"注册表目录可读"，但那会动到全局的已关闭判定。

自检跑在临时 `CLAUDE_CONFIG_DIR`（路径常量在 require 时定格，环境变量必须先设），碰不到真实 `state/` 与 `hidden.json`，比"先存原值后恢复"省心。踩过：测判据的场景忘了放活注册表条目，`regUsable=false` 让护栏先一步拦下，4 条断言测的全是护栏。

### 7. 术语封闭：**隐藏 / 取消隐藏 / 删除记录**，三个词封顶

已废除「收起」「折叠」两个词。复选框叫「显示全部」（它管的不只手动隐藏那一档）。

2026-08-13 加入第三个词「删除记录」—— 它和前两个是**不同的动作**，不是同义词：隐藏留数据可找回，删除真删且不可撤销（见铁律 6b）。选「删除」不选「清除」，因为后者听起来像批量操作。新增文案只能在这三个里挑，别再造第四个。

上报那条线同理，只有「**上报日历**」一个词：按钮、窗口标题、通知落点全用它。2026-08-14 把原来的「归档」改掉，是因为提醒文案说的是"该**上报**了"，而入口上一个「上报」都没有 —— 被提醒之后在界面上找不到该点哪儿。**「归档」已废**，别再冒出来。

### 8. 界面重绘类问题用抓帧比对，别猜

`watch-flicker.ps1` 连续截同一窗口区域逐像素 diff，看 changed 数量与 bbox —— bbox 形态能直接区分"几个数字在变"和"整片重绘"。当年靠它才定位到 WinForms 版闪烁的元凶是 ToolTip 而非刷新逻辑。`capture.ps1` 截当前窗口存 `board-capture.png`。两个都按**窗口标题 + 最小尺寸**匹配，与 UI 框架无关。

`close-board.ps1` 本意是发 `WM_CLOSE` 走正常关闭路径（`win.on('close')` 里的 `saveSettings` 才会执行）。**但它至今匹配的是 `CommandLine -like '*board-wpf*'`，WPF 版 2026-08-10 已删，所以它对 Electron 版恒返回 "no board running"** —— 要保住窗口位置/勾选项，目前只能自己给主窗口 `PostMessage WM_CLOSE`，然后再 `Stop-Process`（关窗口不退进程，它是托盘应用，`window-all-closed` 故意留空）。

### 9. 信号归因：别拿 A 的证据去解释 B

这一类错误反复踩，共性是**用一个来源的事实去断言另一个对象**，且错的方向往往偏"看起来正常"。六条实证结论：

- **状态档只反映主循环**。子代理 / 后台 shell 不改状态档、不改配色与排序，只在状态文字后加「· N 个子任务」后缀。曾有过「⧗ 后台任务」一档，已按明确要求撤掉 —— 想加回来先确认是不是真要它。
- **空闲通知不是新事实**。`Notification` 且 `notification_type=idle_prompt` 一律不落记录：轮次早在 `Stop` 时结束了，收下它会把「已完成」冲成「等你输入」、把 summary 覆盖成一句废话、把 `updated_ms` 刷成通知时刻让「等你多久」重新起算。按**白名单**挡，认不出的取值沿用旧行为（宁可多叫你一次，不可漏掉真的等授权）。
- **mtime 不是判活信号**。子代理写入间隔实测 189 份记录 p50=86s / p90=213s，30 秒窗口下 **95%** 会中途掉出计数。判活 = 10 分钟兜底窗口 + 「晚于该文件最后一次写入的 completed 通知」；通知**只用来证明"已完成"**，反过来用（没通知=还在跑）会在会话空闲时永远误报。后台 Agent 的 `tool_result` 在 spawn 那一刻就落了（实测 use→result 间隔 0.0s），**不是**完成信号。
- **共享快照里 `updated_at` 是写盘时刻，不是取数时刻**。用量快照全部会话共写一个文件，落后会话会把旧读数配上新鲜时间戳写回去（实测 5h 在 31%/18% 间来回，周期 2–5 秒）。所以"取更新的"没用；只能按配额窗口语义取同 `resets_at` 内的最大值，更旧窗口整条忽略，`resets_at` 已成过去时的不显示。
- **无终端指纹 ≠ 裸 cmd**。SDK 会话（注册表 `entrypoint=sdk-*`）没有自己的窗口、模型也由宿主选。判成 `console` 会让切窗口只在 conhost/cmd/powershell 里找、永远找不到；`settings.json` 的上下文窗口对它同样不是证据（实测宿主给的是 200k 模型，167k 被按你的 1M 算成 17%，真实约 84% —— 把快撑满显示成很安全）。宿主档由注册表 `entrypoint` 接管，不必等下一次 hook 事件。
- **窗口标题按词边界匹配**。`oteapi` 会被 `oteapi-facade` 子串劫持，而多个候选之间由 z 序决胜 —— 表现为跟着你最后碰过的窗口漂，不是稳定地错，因此更难查。JetBrains 多个项目窗口住在**同一个** idea64 进程里，pid 也分不开它们。

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

- **强杀 / 直接关终端 / 关机不触发 `SessionEnd`**，记录会残留。transcript 文件锁、`~/.claude/ide/*.lock` 两条替代判活路子实测都不通，只能靠 pid 交叉校验。残留本身已由「删除记录」+ 自动删除兜住（铁律 6b），但**触发不了 `SessionEnd` 这件事本身绕不过**——别再往这个方向试。
- **终端标签页名读不到**。VS Code 那个 `· Claude Code` 标签与 Claude 会话无任何数据关联，已按字节全量搜过 `~/.claude` 全树 + VS Code storage，0 命中。要稳定命名只能自建别名。
- **切窗口只能落到「窗口」，落不到「标签页」**。（这条原先写的是"只能打开目录、拿不到窗口句柄"，已被切窗口功能推翻，勿再照抄。）VS Code / IDEA 把工作区名写进窗口标题、但不写标签页，同一窗口里的多个会话必然塌缩成同一个目标；SDK 会话更是全归宿主窗口。

---


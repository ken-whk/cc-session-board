# 脱钩会话：判据、落点与踩过的坑

> 2026-08-18 加入。CLAUDE.md 只留一句指针，细节在这里 —— 改这块之前把本文读完。

## 要解决什么

强杀终端 / 关机不触发 `SessionEnd`（见 CLAUDE.md「已知硬限制」），于是出现一类会话：
**claude 进程还活着，但它的终端窗口已经没了，再也输入不进去**。

它在看板上长得跟「等你输入」一模一样，于是：

- 排在最上面催你去处理，而你**根本处理不了**
- pid 还活着 → `autoPurge` 的 `statePidAlive !== true` 判据不成立 → 永远不会自动收
- `~/.claude/sessions/<pid>.json` 还在 → `isOrphan` 不成立 → 「删除记录」也不给入口

实测有一条这样挂了 16 小时不消失。**三道闸全部卡在「pid 还活着」上，而脱钩的特征恰恰是进程活着、通道死了。**

## 判据：有没有活的 console

`AttachConsole(pid)` 失败且 `GetLastError() = 233`（`ERROR_PIPE_NOT_CONNECTED`）
= 那个 console 的管道另一端没进程了 = 终端宿主已死。

2026-08-18 本机 6 个样本，与「winpty-agent 父进程是否存活」**100% 一致**：

| pid | console | winpty-agent 父进程 | 判定 |
|---|---|---|---|
| 15336 / 16248 / 28932 / 21384 | True | 活 | 活 |
| 17552 / 20512 | False err=233 | GONE | 脱钩 |

### 为什么不用父进程链

`hook.js:227-229`（2026-08-12 实证）：Windows 上终端宿主经 ConPTY 与 shell 通信，
**不是 shell 的祖先**，祖先链会断在已退出的中间 pid 上。上面那 6 个样本恰好全是 winpty 宿主
所以父进程链看着也对 —— 那是巧合，不是判据。console 探测不依赖进程树拓扑。

### 未验证的一整片

6 个样本**全是 winpty 宿主**。VS Code 集成终端走 ConPTY（本机有 3 个 OpenConsole 活着，
只是当时没在里面开 claude），那条路径下 AttachConsole 的行为**一个样本都没有**。

所以 `detachedAction` 默认 `'mark'` 只标记，右键「结束进程」还压了一道确认对话框。
判准了之后再打开自动结束、再考虑去掉对话框 —— 别反过来。

### SDK 会话必须排除

SDK 会话（注册表 `entrypoint=sdk-*`）压根没有自己的终端窗口（铁律 9），
console 探测对它恒为假，探了必然误判。`probeTargets` 里已经挡掉。

## procStart 精度陷阱（差点清空全部数据）

pid 会被系统复用，所以身份 = `pid + procStart`（进程创建时刻，FILETIME）。
注册表里那份由 Claude Code 直接读，精度 100ns；我们只能经 WMI 拿，
而 **WMI 的 `CreationDate` 只到微秒，最后一位 100ns 恒为 0**：

```
注册表 134314396804547945
WMI    134314396804547940     <- 六个样本全部差在末位
```

字符串全等比会**全线不匹配** → 每个活会话都被判成 pid 复用残留 → GC 删光注册表文件
→ `isOrphan` 全线成立 → `autoPurge` 连 state 一起清空。

`procStartKey()` 因此把两边都降到微秒粒度再比。**不许改回全等。**

## 落点：为什么在看板不在 hook

原方案是落 `SessionStart` hook，改成落看板的慢周期定时器（`PROBE_MS` = 30s），理由三条：

1. **hook 跟会话共享 console** —— 在 hook 自己进程里 `FreeConsole()` 会把它自己摘掉。
   落看板则无此问题：看板是 GUI 进程，**自己没有 console**
   （实测 `AttachConsole(看板 pid)` 返回 `err=6` = 目标无 console）。
2. `SessionStart` 在 hook.js 里根本不存在（只有 running/done/waiting/closed 四个），
   新增要动 `install-hooks.js` + 每个人的 `settings.json`，同事都得重跑安装。
3. 落 hook 意味着只在开新会话时清扫，重启看板不会立刻标记。

探测仍然**起独立子进程**做，不在看板进程里直接调 AttachConsole ——
附加期间调用方会成为目标 console 的进程组成员，那一刻目标终端里的 Ctrl+C 会打到看板身上。
子进程被打死无所谓，看板不能死。

**绝不能进 1.5s 刷新路径**：一次探测要起一个 powershell（约 300ms）。
异步探测 + 同步读缓存，`buildRows` 全程不阻塞。

## 完整链路（缺一环就断）

```
结束进程（人点 / 自动）
  -> pid 死
  -> alive=false           -> eff 翻成「已关闭」
  -> 注册表 GC 删 <pid>.json
  -> isOrphan 成立
  -> autoPurge 到点收掉 state
```

反过来先删记录没用：注册表还在，下一帧原地重建（铁律 6）。
**只标记那一档不会启动这条链** —— 那两条脱钩记录会一直挂着，直到人点一下或重启机器。

## 自检覆盖

一次性自检脚本（跑完已删）覆盖 15 条，其中不可逆动作全部有对照：

- `procStartKey` 容忍 WMI 微秒精度 / 仍能区分不同进程
- 活会话不判脱钩、不给「结束进程」入口
- pid 被复用 → 判「已关闭」而不是「还活着」
- `registryGc` 默认关时一个文件都不删；开了只删进程已不在的那条，保住活会话
- SDK 会话被排除在探测之外
- 无 console 的活进程被判脱钩、才给「结束进程」入口
- 只标记时不杀 / 静默不够时不杀 / 静默够久且开了自动结束才杀

**杀进程那条路用脚本自己起的一次性进程验**（`detached` + `stdio: 'ignore'` + `windowsHide`
天生没有 console，是个可控的真实脱钩样本），绝不拿真实会话试。要重跑就照这个思路重写一份。

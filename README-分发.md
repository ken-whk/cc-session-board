Claude 会话看板 —— 安装与使用说明
=====================================

这是一个本机工具：同时开着好几个 Claude Code 会话时，告诉你哪个在等你处理。
所有数据都在你自己电脑上读取 —— 程序没有任何网络出口，也不读取任何账号凭据。

前提：你已经装了 Claude Code，并且在用默认的配置目录（~/.claude）。
      如果你设了 CLAUDE_CONFIG_DIR 环境变量，看板也会跟着用那个目录。


------------------------------------------------------------------
Windows（ClaudeBoard-win-x64.zip）
------------------------------------------------------------------

1. 解压到任意目录（别放 C:\Program Files 下，那里需要管理员权限）

2. 双击 ClaudeBoard.exe

3. 首次运行 Windows 可能弹「Windows 已保护你的电脑」——
   这是因为程序没有做代码签名。点「更多信息」→「仍要运行」。

就这样，没有安装程序。首次启动时它会自动完成三件事（幂等，重复启动没影响）：

   - 建 ~/.claude/session-board/ 和它的 state/ 子目录
   - 把 hook.js 拷到上面这个目录
   - 把 4 个 hook 注册进 ~/.claude/settings.json
     （UserPromptSubmit / Stop / Notification / SessionEnd）

★ 重要：已经开着的 Claude Code 会话不会立刻出现在看板里。
  hook 是刚刚才注册进配置的，只有**新开的会话**才会带上它。
  你会看到一块空看板，而底部的 hook 指示灯是绿的 —— 那不是坏了，
  开一个新的 Claude Code 会话就有数据了。


------------------------------------------------------------------
macOS（ClaudeBoard-mac-arm64.tar.gz）
------------------------------------------------------------------

★ 这个包只支持 Apple Silicon（M 系列芯片）。Intel Mac 请找我要 x64 版本。

必须用命令行装，四步缺一不可（原因在每步后面）：

    tar -xzf ClaudeBoard-mac-arm64.tar.gz
    cd ClaudeBoard-darwin-arm64

    find ClaudeBoard.app -type f -path "*/Contents/MacOS/*" -exec chmod +x {} +
    find ClaudeBoard.app -type f -name "*.dylib" -exec chmod +x {} +
    chmod +x "ClaudeBoard.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"

    xattr -dr com.apple.quarantine ClaudeBoard.app

    open ClaudeBoard.app

为什么不能双击解压：
    .app 内部有 14 个符号链接（Electron Framework 那套）。
    「归档实用工具」会把它们展开成普通文件，应用直接跑不起来。

为什么要 chmod +x：
    这个包是在 Windows 上交叉打出来的，NTFS 存不了 Unix 执行位，
    归档里的主程序权限是 -rw-r--r--。不补执行位，双击会报「无法打开」。

为什么要 xattr：
    程序没有 Apple 开发者签名，Gatekeeper 默认拦下从网络拿到的应用。

macOS 上的一个已知限制：
    系统通知需要应用已签名才能弹出，所以这个包改用 osascript 兜底。
    弹出的通知归属会显示成「脚本编辑器」而不是看板本身；
    首次可能需要在「系统设置 → 通知」里给脚本编辑器放行。
    Dock 图标弹跳提醒不受影响。


------------------------------------------------------------------
顶部那两个额度数字（5h / 周）
------------------------------------------------------------------

这两个数字来自 Anthropic 官方的用量接口，认证需要读你的账号凭据。
看板刻意不联网、不碰凭据，所以改成读 claude-hud 写出的快照文件。

因此：装了 claude-hud 才有这两个数字。首次启动看板会弹一个引导：

   - 已经装了 hud 但没开快照出口（默认状态）→ 点「帮我开启」，看板替你改配置
   - 没装 hud → 引导里给出可复制的三条安装命令
   - 不装也完全能用，只是底部少这两个数字。
     每个会话自己的「上下文占用」不依赖 hud（没有 hud 时用 transcript 估算，
     数字前面会带一个 ~ 表示是估的）

随时可以再打开这个引导：⚙ 设置 → 用量显示设置（5h / 周）


------------------------------------------------------------------
怎么用
------------------------------------------------------------------

点 ? 按钮，里面有完整说明（状态含义、排序、柱子配色、数据来源）。
几个常用的：

   双击某一行       在文件管理器里打开该会话的工作目录
   右键             隐藏这一条 / 复制路径 / 打开目录
   Delete           隐藏这一条（不等于关会话，它下次有动静会自己回来）
   点表头           排序：升序 → 降序 → 恢复默认（启动顺序）
   拖表头分隔处     调列宽，会记住
   ⚙ 设置           置顶 / 响铃 / 通知 / 显示已隐藏 / 开机自启 / 深浅主题


------------------------------------------------------------------
数据存在哪 / 怎么卸载
------------------------------------------------------------------

运行数据都在 ~/.claude/session-board/ 下：

   state/              每个会话一个 json（工作目录、标题、你最近敲的那句、摘要）
   hidden.json         你手动隐藏了哪些会话
   ui-electron.json    窗口位置、勾选项、列宽、排序

这些内容里有你的项目路径和对话片段，都只在本机，不会外发。
不想留就直接删掉这个目录。

卸载 hook（只摘掉本看板注册的那 4 个，不动你其他 hook）：

   Windows:  node "<解压目录>\resources\app\install-hooks.js" --remove
   macOS:    node "ClaudeBoard.app/Contents/Resources/app/install-hooks.js" --remove

然后删掉程序目录和 ~/.claude/session-board/ 即可，没有注册表项、没有后台服务。

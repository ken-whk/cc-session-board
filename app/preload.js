'use strict'

// 渲染层与主进程之间的唯一通道。
// contextIsolation 开着、nodeIntegration 关着，所以页面里没有 require、
// 也碰不到文件系统 —— 只能用下面暴露的这几个方法。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('board', {
  onRows: (cb) => ipcRenderer.on('board:rows', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('board:error', (_e, msg) => cb(msg)),

  getExchange: (sid, transcript) => ipcRenderer.invoke('board:getExchange', sid, transcript),
  getSessionMeta: (transcript) => ipcRenderer.invoke('board:getSessionMeta', transcript),
  removeRecord: (sid) => ipcRenderer.invoke('board:removeRecord', sid),
  unhideRecord: (sid) => ipcRenderer.invoke('board:unhideRecord', sid),
  // 删除记录 = 真删 state 文件，不可撤销；只对残留记录成立（判据在数据层）
  purgeRecord: (sid) => ipcRenderer.invoke('board:purgeRecord', sid),
  openFolder: (dir) => ipcRenderer.invoke('board:openFolder', dir),
  // 切到会话所在的终端窗口。传的是裁剪过的行（同右键菜单那份），
  // 主进程要读的字段必须在调用处一并传上去，否则恒为 undefined。
  focusWindow: (row) => ipcRenderer.invoke('board:focusWindow', row),
  statusLegend: () => ipcRenderer.invoke('board:statusLegend'),
  hudStatus: () => ipcRenderer.invoke('board:hudStatus'),
  appInfo: () => ipcRenderer.invoke('board:appInfo'),
  openHudGuide: () => ipcRenderer.invoke('board:openHudGuide'),
  // 通知点开 -> 主进程叫出窗口并让页面选中对应会话
  onFocusRow: (cb) => ipcRenderer.on('board:focusRow', (_e, sid) => cb(sid)),
  // 设置菜单点「自定义…」-> 页面弹自绘对话框收数字（原生菜单没有输入控件）。
  // 传的是 {hours, label}：label 由主进程格式化好，渲染层不再抄一份换算规则。
  onAskPurgeThreshold: (cb) => ipcRenderer.on('board:askPurgeThreshold', (_e, payload) => cb(payload)),
  // 上报提醒的时间是多选 + 允许非整点，原生菜单表达不了，同样走自绘对话框。
  // rawTimes 原样送过去不在页面里判格式 —— 格式的权威是 upload-core.parseTimes，
  // 看不懂的条目由它回报（{ok:false, dropped:[...]}），页面只负责显示。
  onAskRemindTimes: (cb) => ipcRenderer.on('board:askRemindTimes', (_e, payload) => cb(payload)),
  setRemind: (on, rawTimes) => ipcRenderer.invoke('board:setRemind', on, rawTimes),
  // 自绘设置面板里的「修改提醒时间…」：让主进程走它原有的那条对话框链路，
  // 不在页面里另造一套（时间格式的权威只有 upload-core.parseTimes 一处）
  askRemindTimes: () => ipcRenderer.send('board:askRemindTimesNow'),
  copyPath: (dir) => ipcRenderer.invoke('board:copyPath', dir),
  setSetting: (key, value) => ipcRenderer.invoke('board:setSetting', key, value),
  // 右键菜单走主进程弹原生菜单 —— 页面里的 window.prompt() 被 Electron 禁用
  showContextMenu: (row) => ipcRenderer.send('board:contextMenu', row),
  // 设置收进原生菜单（checkbox 项），页面只负责在按钮上触发
  showSettingsMenu: () => ipcRenderer.send('board:settingsMenu'),
  // 打开上报归档窗口。独立窗口，不占主界面 —— 主窗口的唯一职责是
  // "该切到哪个会话去"，把归档浏览混进去会稀释它。
  // 主进程叫页面打开归档面板（上报提醒的通知点开时用）。
  // 面板嵌在主窗口里，不另开 OS 窗口 —— 所以这里是推送而不是 send 请求开窗。
  onOpenArchive: (cb) => ipcRenderer.on('board:openArchive', () => cb()),
})

// 上报归档窗口专用通道。单独一个命名空间而不是并进 board：
// 两个窗口共用这一个 preload，但各自只该看见自己需要的方法。
//
// 全部是**只读** —— 上报本身走 cc-session-nas-upload skill，看板不执行上报。
contextBridge.exposeInMainWorld('upload', {
  listUsers: () => ipcRenderer.invoke('upload:listUsers'),
  // 记住"我是谁"。共享盘上每个人一个目录，不记的话每次打开都要在别人的名字里找自己
  setUser: (user) => ipcRenderer.invoke('upload:setUser', user),
  listDates: (user) => ipcRenderer.invoke('upload:listDates', user),
  listSessions: (date, user) => ipcRenderer.invoke('upload:listSessions', date, user),
  // 这两个**不代你挂载**，只是把你送到系统自己的认证框/向导前 ——
  // 密码只能你本人填，看板不读、不问、不存（与 skill 的脚本同一条纪律）
  openShare: () => ipcRenderer.invoke('upload:openShare'),
  mapDrive: () => ipcRenderer.invoke('upload:mapDrive'),
  // 开一个交互式 Claude 会话窗口，把提示词填进去。上报本身在那个窗口里由你
  // 跟 skill 对话完成 —— 看板不代你执行上报。
  openClaude: (prompt) => ipcRenderer.invoke('upload:openClaude', prompt),
})

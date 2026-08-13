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
  clearStale: () => ipcRenderer.invoke('board:clearStale'),
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
  copyPath: (dir) => ipcRenderer.invoke('board:copyPath', dir),
  setSetting: (key, value) => ipcRenderer.invoke('board:setSetting', key, value),
  // 右键菜单走主进程弹原生菜单 —— 页面里的 window.prompt() 被 Electron 禁用
  showContextMenu: (row) => ipcRenderer.send('board:contextMenu', row),
  // 设置收进原生菜单（checkbox 项），页面只负责在按钮上触发
  showSettingsMenu: () => ipcRenderer.send('board:settingsMenu'),
})

'use strict'

// 渲染层与主进程之间的唯一通道。
// contextIsolation 开着、nodeIntegration 关着，所以页面里没有 require、
// 也碰不到文件系统 —— 只能用下面暴露的这几个方法。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('board', {
  onRows: (cb) => ipcRenderer.on('board:rows', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('board:error', (_e, msg) => cb(msg)),

  getExchange: (sid, transcript) => ipcRenderer.invoke('board:getExchange', sid, transcript),
  removeRecord: (sid) => ipcRenderer.invoke('board:removeRecord', sid),
  unhideRecord: (sid) => ipcRenderer.invoke('board:unhideRecord', sid),
  clearStale: () => ipcRenderer.invoke('board:clearStale'),
  openFolder: (dir) => ipcRenderer.invoke('board:openFolder', dir),
  copyPath: (dir) => ipcRenderer.invoke('board:copyPath', dir),
  setSetting: (key, value) => ipcRenderer.invoke('board:setSetting', key, value),
  // 右键菜单走主进程弹原生菜单 —— 页面里的 window.prompt() 被 Electron 禁用
  showContextMenu: (row) => ipcRenderer.send('board:contextMenu', row),
})

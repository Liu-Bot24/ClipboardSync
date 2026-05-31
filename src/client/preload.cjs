const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardSync', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('client:get-state'),
  updateRule: (deviceId, column, checked) => ipcRenderer.invoke('client:update-rule', deviceId, column, checked),
  updateSetting: (patch) => ipcRenderer.invoke('client:update-setting', patch),
  refresh: () => ipcRenderer.invoke('client:refresh'),
  showHistory: () => ipcRenderer.invoke('client:show-history'),
  applyHistory: (eventId) => ipcRenderer.invoke('client:apply-history', eventId),
  clearHistory: () => ipcRenderer.invoke('client:clear-history'),
  quit: () => ipcRenderer.invoke('client:quit'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('client:state', handler);
    return () => ipcRenderer.off('client:state', handler);
  }
});

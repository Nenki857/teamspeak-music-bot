const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('musicDesk', {
  rpc: (method, args) => ipcRenderer.invoke('music:rpc', method, args),
  resources: () => ipcRenderer.invoke('music:resources'),
  subscribe: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('music:state', listener); return () => ipcRenderer.removeListener('music:state', listener); },
  copy: text => ipcRenderer.invoke('music:copy', text),
  openData: () => ipcRenderer.invoke('music:open-data'),
  openLink: url => ipcRenderer.invoke('music:open-link', url),
  quit: () => ipcRenderer.invoke('music:quit')
});

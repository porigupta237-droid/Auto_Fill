const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoFill', {
  start: (config) => ipcRenderer.invoke('autofill:start', config),
  pause: (config) => ipcRenderer.invoke('autofill:pause', config),
  continue: (config) => ipcRenderer.invoke('autofill:continue', config),
  cancelImmediate: () => ipcRenderer.send('autofill:cancelImmediate'),
  cancel: () => ipcRenderer.invoke('autofill:cancel'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('autofill:status', listener);
    return () => ipcRenderer.removeListener('autofill:status', listener);
  },
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('autofill:progress', listener);
    return () => ipcRenderer.removeListener('autofill:progress', listener);
  },
  onComplete: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('autofill:complete', listener);
    return () => ipcRenderer.removeListener('autofill:complete', listener);
  },
});

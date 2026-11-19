import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('boleDesktop', {
  version: process.versions.electron,
  openExternal: (url: string) => ipcRenderer.invoke('bole:open-external', url),
});

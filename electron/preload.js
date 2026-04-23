const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termulAPI', {
  // ─── Window Controls ────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },

  // ─── Connection Profiles ────────────────────────────────────────────
  profiles: {
    getAll: () => ipcRenderer.invoke('profiles:getAll'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    delete: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),
  },

  // ─── SSH Connections ────────────────────────────────────────────────
  ssh: {
    connect: (profile) => ipcRenderer.invoke('ssh:connect', profile),
    disconnect: (connectionId) => ipcRenderer.invoke('ssh:disconnect', connectionId),
    createShell: (connectionId) => ipcRenderer.invoke('ssh:createShell', connectionId),
    shellWrite: (streamId, data) => ipcRenderer.invoke('ssh:shell-write', streamId, data),
    shellResize: (streamId, cols, rows) => ipcRenderer.invoke('ssh:shell-resize', streamId, cols, rows),
    shellClose: (streamId) => ipcRenderer.invoke('ssh:shell-close', streamId),
    onShellData: (callback) => {
      ipcRenderer.on('ssh:shell-data', (event, data) => callback(data));
    },
    onShellClosed: (callback) => {
      ipcRenderer.on('ssh:shell-closed', (event, data) => callback(data));
    },
    removeShellDataListener: () => {
      ipcRenderer.removeAllListeners('ssh:shell-data');
    },
    removeShellClosedListener: () => {
      ipcRenderer.removeAllListeners('ssh:shell-closed');
    },
  },

  // ─── Plugins ────────────────────────────────────────────────────────
  plugins: {
    getAll: () => ipcRenderer.invoke('plugins:getAll'),
    loadFiles: (dirName) => ipcRenderer.invoke('plugins:loadFiles', dirName),
    install: (pluginData) => ipcRenderer.invoke('plugins:install', pluginData),
    uninstall: (dirName) => ipcRenderer.invoke('plugins:uninstall', dirName),
    readFile: (pluginDir, fileName) => ipcRenderer.invoke('plugins:readFile', pluginDir, fileName),
  },

  // ─── Dialogs ────────────────────────────────────────────────────────
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  },

  // ─── Platform Info ──────────────────────────────────────────────────
  platform: process.platform,

  // ─── xterm.js Terminal Library ───────────────────────────────────────
  xterm: {
    getJS: () => ipcRenderer.invoke('xterm:getJS'),
    getCSS: () => ipcRenderer.invoke('xterm:getCSS'),
    getFitAddonJS: () => ipcRenderer.invoke('xterm:getFitAddonJS'),
  },

  // ─── Shared UI Components ───────────────────────────────────────────
  ui: {
    getSharedCSS: () => ipcRenderer.invoke('ui:getSharedCSS'),
  },
});

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
    // Connection lifecycle events (dropped, error, closed)
    onConnectionClosed: (callback) => {
      ipcRenderer.on('ssh:connection-closed', (event, data) => callback(data));
    },
    onConnectionError: (callback) => {
      ipcRenderer.on('ssh:connection-error', (event, data) => callback(data));
    },
    removeConnectionClosedListener: () => {
      ipcRenderer.removeAllListeners('ssh:connection-closed');
    },
    removeConnectionErrorListener: () => {
      ipcRenderer.removeAllListeners('ssh:connection-error');
    },
    // SFTP operations
    sftpListDir: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpListDir', connectionId, remotePath),
    sftpStat: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpStat', connectionId, remotePath),
    sftpDownload: (connectionId, remotePath, localPath, transferId) => ipcRenderer.invoke('ssh:sftpDownload', connectionId, remotePath, localPath, transferId),
    sftpUpload: (connectionId, localPath, remotePath, transferId) => ipcRenderer.invoke('ssh:sftpUpload', connectionId, localPath, remotePath, transferId),
    sftpMkdir: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpMkdir', connectionId, remotePath),
    sftpDelete: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpDelete', connectionId, remotePath),
    sftpRmdir: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpRmdir', connectionId, remotePath),
    sftpRename: (connectionId, oldPath, newPath) => ipcRenderer.invoke('ssh:sftpRename', connectionId, oldPath, newPath),
    sftpHome: (connectionId) => ipcRenderer.invoke('ssh:sftpHome', connectionId),
    sftpReadFile: (connectionId, remotePath) => ipcRenderer.invoke('ssh:sftpReadFile', connectionId, remotePath),
    sftpWriteFile: (connectionId, remotePath, content) => ipcRenderer.invoke('ssh:sftpWriteFile', connectionId, remotePath, content),
    exec: (connectionId, command) => ipcRenderer.invoke('ssh:exec', connectionId, command),
    onSftpProgress: (callback) => {
      ipcRenderer.on('ssh:sftp-progress', (event, data) => callback(data));
    },
    removeSftpProgressListener: () => {
      ipcRenderer.removeAllListeners('ssh:sftp-progress');
    },
  },

  // ─── Local Filesystem ─────────────────────────────────────────────
  fs: {
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
    userDirs: () => ipcRenderer.invoke('fs:userDirs'),
    deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
    deletePath: (targetPath) => ipcRenderer.invoke('fs:deletePath', targetPath),
    mkdir: (dirPath) => ipcRenderer.invoke('fs:mkdir', dirPath),
    createFile: (filePath) => ipcRenderer.invoke('fs:createFile', filePath),
    readFile: (filePath, encoding) => ipcRenderer.invoke('fs:readFile', filePath, encoding),
    writeFile: (filePath, content, encoding) => ipcRenderer.invoke('fs:writeFile', filePath, content, encoding),
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

  // ─── Settings Persistence ─────────────────────────────────────────
  settings: {
    get: (key, defaultValue) => ipcRenderer.invoke('settings:get', key, defaultValue),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },

  // ─── Platform Info ──────────────────────────────────────────────────
  platform: process.platform,

  // ─── xterm.js Terminal Library ───────────────────────────────────────
  xterm: {
    getJS: () => ipcRenderer.invoke('xterm:getJS'),
    getCSS: () => ipcRenderer.invoke('xterm:getCSS'),
    getFitAddonJS: () => ipcRenderer.invoke('xterm:getFitAddonJS'),
  },

  // ─── Monaco Editor Library ────────────────────────────────────────────
  monaco: {
    getBaseUrl: () => 'monaco://resources/vs/',
  },

  // ─── Shared UI Components ───────────────────────────────────────────
  ui: {
    getSharedCSS: () => ipcRenderer.invoke('ui:getSharedCSS'),
  },
});

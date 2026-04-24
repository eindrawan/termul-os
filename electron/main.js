const { app, BrowserWindow, ipcMain, dialog, protocol, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

// ─── Paths ───────────────────────────────────────────────────────────
const SRC_DIR = path.join(__dirname, '..', 'src');
const PLUGINS_DIR = path.join(SRC_DIR, 'plugins');
const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');

// ─── Monaco Editor custom protocol ─────────────────────────────────
// Must be registered BEFORE app.whenReady()
protocol.registerSchemesAsPrivileged([{
  scheme: 'monaco',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: true,
  }
}]);

// ─── State ───────────────────────────────────────────────────────────
let mainWindow = null;
let sshConnections = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Sanitize a directory name to prevent path traversal.
 * Rejects anything with separators or parent refs.
 */
function sanitizeDirName(dirName) {
  if (!dirName || typeof dirName !== 'string') return null;
  // Reject path separators, dots, and control chars
  if (/[/\\:]/.test(dirName)) return null;
  if (dirName.includes('..')) return null;
  if (dirName.trim() !== dirName) return null;
  if (dirName.length === 0 || dirName.length > 255) return null;
  return dirName;
}

/**
 * Sanitize a filename to prevent path traversal.
 * Only allows alphanumeric, dash, underscore, dot.
 */
function sanitizeFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  // Must not contain path separators or parent refs
  if (/[/\\:]/.test(fileName)) return null;
  if (fileName.includes('..')) return null;
  // Only allow safe characters
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return null;
  return fileName;
}

/**
 * Resolve a safe plugin path. Returns null if path escapes PLUGINS_DIR.
 */
function safePluginPath(dirName, fileName) {
  const safeDir = sanitizeDirName(dirName);
  const safeFile = sanitizeFileName(fileName);
  if (!safeDir || !safeFile) return null;

  const resolved = path.resolve(PLUGINS_DIR, safeDir, safeFile);
  // Ensure the resolved path is inside PLUGINS_DIR
  if (!resolved.startsWith(path.resolve(PLUGINS_DIR))) return null;
  return resolved;
}

// ─── Ensure data files exist ─────────────────────────────────────────
function ensureDataFiles() {
  if (!fs.existsSync(PROFILES_FILE)) {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
  // Ensure plugins directory exists
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

// ─── Window Creation ─────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(SRC_DIR, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Fix: frameless transparent windows on Windows extend behind the taskbar
  // when maximized. Reduce height by 8px to keep the taskbar visible.
  mainWindow.on('maximize', () => {
    const { width } = mainWindow.getBounds();
    mainWindow.setSize(width, screen.getPrimaryDisplay().workAreaSize.height - 8);
  });

  mainWindow.on('closed', () => {
    // Close all SSH connections
    for (const [id, conn] of sshConnections) {
      if (conn && conn.end) conn.end();
    }
    sshConnections.clear();
    mainWindow = null;
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataFiles();

  // Register monaco:// protocol to serve Monaco Editor files from node_modules
  // Base URL format: monaco://resources/vs/ — "resources" is a dummy host
  // All paths resolve to: node_modules/monaco-editor/min/vs/<path>
  const MONACO_VS_DIR = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
  protocol.registerFileProtocol('monaco', (request, callback) => {
    try {
      const url = new URL(request.url);
      // url.pathname is like "/vs/loader.js" or "/vs/editor/editor.main.js"
      let relativePath = url.pathname;
      // Remove leading slash
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.substring(1);
      }
      // Remove "vs/" prefix since MONACO_VS_DIR already includes it
      if (relativePath.startsWith('vs/')) {
        relativePath = relativePath.substring(3);
      }
      const filePath = path.join(MONACO_VS_DIR, relativePath);
      callback({ path: filePath });
    } catch (e) {
      console.error('[monaco protocol] Error parsing URL:', request.url, e);
      callback({ error: -2 }); // net::FAILED
    }
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const [id, conn] of sshConnections) {
    if (conn && conn.end) conn.end();
  }
  sshConnections.clear();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Window Controls
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());

// ═══════════════════════════════════════════════════════════════════════
// IPC: Profiles
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('profiles:getAll', () => {
  try {
    const data = fs.readFileSync(PROFILES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
});

ipcMain.handle('profiles:save', (event, profile) => {
  let profiles = [];
  try {
    profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
  } catch {
    profiles = [];
  }

  const existingIdx = profiles.findIndex(p => p.id === profile.id);
  if (existingIdx >= 0) {
    profiles[existingIdx] = profile;
  } else {
    profiles.push(profile);
  }

  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('profiles:delete', (event, profileId) => {
  let profiles = [];
  try {
    profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
  } catch {
    profiles = [];
  }

  profiles = profiles.filter(p => p.id !== profileId);
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: SSH Connection
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('ssh:connect', (event, profile) => {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const connId = profile.id || Date.now().toString();

    const sshConfig = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
    };

    if (profile.authType === 'key' && profile.privateKey) {
      sshConfig.privateKey = fs.readFileSync(profile.privateKey);
      if (profile.passphrase) {
        sshConfig.passphrase = profile.passphrase;
      }
    } else if (profile.password) {
      sshConfig.password = profile.password;
    }

    conn.on('ready', () => {
      sshConnections.set(connId, conn);
      resolve({ success: true, connectionId: connId });
    });

    conn.on('error', (err) => {
      // If the connection was already established, this is a runtime error
      // (e.g. connection lost). Notify the renderer.
      if (sshConnections.has(connId)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ssh:connection-error', {
            connectionId: connId,
            error: err.message
          });
        }
        sshConnections.delete(connId);
      } else {
        reject({ success: false, error: err.message });
      }
    });

    conn.on('close', () => {
      const wasConnected = sshConnections.has(connId);
      sshConnections.delete(connId);

      // Notify the renderer if this was an established connection that closed
      if (wasConnected && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh:connection-closed', {
          connectionId: connId
        });
      }
    });

    conn.connect(sshConfig);
  });
});

ipcMain.handle('ssh:disconnect', (event, connectionId) => {
  const conn = sshConnections.get(connectionId);
  if (conn) {
    conn.end();
    sshConnections.delete(connectionId);
    return true;
  }
  return false;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: SSH Shell
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('ssh:createShell', (event, connectionId) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) {
    return { success: false, error: 'No active connection' };
  }

  return new Promise((resolve) => {
    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      const streamId = Date.now().toString();

      stream.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ssh:shell-data', {
            streamId,
            data: data.toString('utf-8')
          });
        }
      });

      stream.stderr.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ssh:shell-data', {
            streamId,
            data: data.toString('utf-8')
          });
        }
      });

      stream.on('close', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ssh:shell-closed', { streamId });
        }
      });

      if (!global.sshStreams) global.sshStreams = new Map();
      global.sshStreams.set(streamId, stream);

      resolve({ success: true, streamId });
    });
  });
});

ipcMain.handle('ssh:shell-write', (event, streamId, data) => {
  if (!global.sshStreams) return false;
  const stream = global.sshStreams.get(streamId);
  if (stream) {
    stream.write(data);
    return true;
  }
  return false;
});

ipcMain.handle('ssh:shell-resize', (event, streamId, cols, rows) => {
  if (!global.sshStreams) return false;
  const stream = global.sshStreams.get(streamId);
  if (stream && stream.setWindow) {
    stream.setWindow(rows, cols, 0, 0);
    return true;
  }
  return false;
});

ipcMain.handle('ssh:shell-close', (event, streamId) => {
  if (!global.sshStreams) return false;
  const stream = global.sshStreams.get(streamId);
  if (stream) {
    stream.close();
    global.sshStreams.delete(streamId);
    return true;
  }
  return false;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Plugins (with security hardening)
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET all plugins — reads all manifests from PLUGINS_DIR.
 */
ipcMain.handle('plugins:getAll', () => {
  const plugins = [];
  try {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!sanitizeDirName(entry.name)) continue; // skip suspicious dirs

      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);
        // Basic validation
        if (!manifest.name || !manifest.version) continue;

        plugins.push({
          ...manifest,
          dirName: entry.name,
          path: path.join(PLUGINS_DIR, entry.name)
        });
      } catch {
        // Skip invalid manifests silently
      }
    }
  } catch {
    // Plugins dir doesn't exist yet
  }
  return plugins;
});

/**
 * BATCHED file loading — single IPC call to load all plugin files.
 * Returns { html, css, js, icon } with null for missing files.
 */
ipcMain.handle('plugins:loadFiles', (event, dirName) => {
  if (!sanitizeDirName(dirName)) {
    return { error: 'Invalid plugin directory name' };
  }

  const pluginDir = path.join(PLUGINS_DIR, dirName);
  if (!fs.existsSync(pluginDir)) {
    return { error: 'Plugin not found' };
  }

  const result = { html: null, css: null, js: null, icon: null };

  const files = [
    { key: 'html', name: 'index.html' },
    { key: 'css',  name: 'style.css' },
    { key: 'js',   name: 'main.js' },
    { key: 'icon', name: 'icon.svg' },
  ];

  for (const file of files) {
    const filePath = safePluginPath(dirName, file.name);
    if (filePath && fs.existsSync(filePath)) {
      try {
        result[file.key] = fs.readFileSync(filePath, 'utf-8');
      } catch {
        // Skip unreadable files
      }
    }
  }

  return result;
});

/**
 * INSTALL a plugin — writes all files atomically.
 */
ipcMain.handle('plugins:install', async (event, pluginData) => {
  // Validate dirName
  if (!sanitizeDirName(pluginData.dirName)) {
    return { success: false, error: 'Invalid plugin directory name' };
  }

  const pluginDir = path.join(PLUGINS_DIR, pluginData.dirName);

  try {
    // Create directory
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }

    // Write manifest
    if (pluginData.manifest) {
      fs.writeFileSync(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify(pluginData.manifest, null, 2),
        'utf-8'
      );
    }

    // Write all optional files
    const files = [
      { data: pluginData.mainScript, name: 'main.js' },
      { data: pluginData.mainHtml,   name: 'index.html' },
      { data: pluginData.styles,     name: 'style.css' },
      { data: pluginData.icon,       name: 'icon.svg' },
    ];

    for (const file of files) {
      if (file.data) {
        const filePath = safePluginPath(pluginData.dirName, file.name);
        if (!filePath) {
          return { success: false, error: `Invalid file name: ${file.name}` };
        }
        fs.writeFileSync(filePath, file.data, 'utf-8');
      }
    }

    return { success: true, path: pluginDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * UNINSTALL a plugin — removes the entire directory.
 */
ipcMain.handle('plugins:uninstall', (event, dirName) => {
  if (!sanitizeDirName(dirName)) {
    return { success: false, error: 'Invalid plugin directory name' };
  }

  const pluginDir = path.join(PLUGINS_DIR, dirName);

  // Extra safety: verify resolved path is inside PLUGINS_DIR
  const resolved = path.resolve(pluginDir);
  if (!resolved.startsWith(path.resolve(PLUGINS_DIR))) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      return { success: true };
    }
    return { success: false, error: 'Plugin not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * READ a single file from a plugin directory.
 * Uses path validation to prevent traversal.
 */
ipcMain.handle('plugins:readFile', (event, pluginDir, fileName) => {
  const filePath = safePluginPath(pluginDir, fileName);
  if (!filePath) {
    return null; // Invalid path, return null silently
  }

  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  } catch {
    return null;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: xterm.js Terminal Library
// ═══════════════════════════════════════════════════════════════════════

const XTERM_DIR = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm');
const FIT_ADDON_DIR = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit');

ipcMain.handle('xterm:getJS', () => {
  try {
    return fs.readFileSync(path.join(XTERM_DIR, 'lib', 'xterm.js'), 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('xterm:getCSS', () => {
  try {
    return fs.readFileSync(path.join(XTERM_DIR, 'css', 'xterm.css'), 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('xterm:getFitAddonJS', () => {
  try {
    return fs.readFileSync(path.join(FIT_ADDON_DIR, 'lib', 'addon-fit.js'), 'utf-8');
  } catch {
    return null;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Shared UI Components
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('ui:getSharedCSS', () => {
  const cssPath = path.join(SRC_DIR, 'styles', 'plugin-components.css');
  try {
    if (fs.existsSync(cssPath)) {
      return fs.readFileSync(cssPath, 'utf-8');
    }
    return '';
  } catch {
    return '';
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: SFTP (SSH File Transfer)
// ═══════════════════════════════════════════════════════════════════════

/**
 * List remote directory via SFTP.
 * Returns array of { name, size, modifyTime, isDirectory, isFile, path }
 */
ipcMain.handle('ssh:sftpListDir', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          resolve({ success: false, error: err.message });
          return;
        }

        const entries = list.map(item => ({
          name: item.filename,
          size: item.attrs.size || 0,
          modifyTime: item.attrs.mtime ? item.attrs.mtime * 1000 : null,
          isDirectory: (item.attrs.mode & 0o40000) !== 0,
          isFile: (item.attrs.mode & 0o100000) !== 0,
          isSymlink: (item.attrs.mode & 0o120000) !== 0,
          path: remotePath === '/' ? '/' + item.filename : remotePath + '/' + item.filename,
        }));

        // Sort: directories first, then alphabetical
        entries.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        resolve({ success: true, entries });
      });
    });
  });
});

/**
 * Get remote file/directory stats via SFTP.
 */
ipcMain.handle('ssh:sftpStat', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          resolve({ success: false, error: err.message });
          return;
        }
        resolve({
          success: true,
          stat: {
            size: stats.size || 0,
            modifyTime: stats.mtime ? stats.mtime * 1000 : null,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
          }
        });
      });
    });
  });
});

/**
 * Download a remote file to a local path via SFTP.
 * Reports progress via IPC events.
 */
ipcMain.handle('ssh:sftpDownload', (event, connectionId, remotePath, localPath, transferId) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    let resolved = false;
    conn.sftp((err, sftp) => {
      if (err) {
        if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
        return;
      }

      // Get remote file size first for progress
      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) {
          if (!resolved) { resolved = true; resolve({ success: false, error: statErr.message }); }
          return;
        }

        const totalSize = stats.size;
        let transferred = 0;

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);

        readStream.on('data', (chunk) => {
          transferred += chunk.length;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ssh:sftp-progress', {
              transferId,
              transferred,
              total: totalSize,
              percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 0
            });
          }
        });

        readStream.on('error', (err) => {
          writeStream.destroy();
          if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
        });

        writeStream.on('error', (err) => {
          readStream.destroy();
          if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
        });

        writeStream.on('finish', () => {
          if (!resolved) { resolved = true; resolve({ success: true, transferred }); }
        });

        readStream.pipe(writeStream);
      });
    });
  });
});

/**
 * Upload a local file to a remote path via SFTP.
 * Reports progress via IPC events.
 */
ipcMain.handle('ssh:sftpUpload', (event, connectionId, localPath, remotePath, transferId) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  if (!fs.existsSync(localPath)) {
    return { success: false, error: 'Local file not found' };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const totalSize = fs.statSync(localPath).size;
    let transferred = 0;

    conn.sftp((err, sftp) => {
      if (err) {
        if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
        return;
      }

      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);

      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ssh:sftp-progress', {
            transferId,
            transferred,
            total: totalSize,
            percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 0
          });
        }
      });

      readStream.on('error', (err) => {
        writeStream.end();
        if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
      });

      writeStream.on('error', (err) => {
        readStream.destroy();
        if (!resolved) { resolved = true; resolve({ success: false, error: err.message }); }
      });

      writeStream.on('close', () => {
        if (!resolved) { resolved = true; resolve({ success: true, transferred }); }
      });

      readStream.pipe(writeStream);
    });
  });
});

/**
 * Create a remote directory via SFTP.
 */
ipcMain.handle('ssh:sftpMkdir', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      sftp.mkdir(remotePath, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  });
});

/**
 * Delete a remote file via SFTP.
 */
ipcMain.handle('ssh:sftpDelete', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      sftp.unlink(remotePath, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  });
});

/**
 * Remove a remote directory via SFTP.
 */
ipcMain.handle('ssh:sftpRmdir', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      sftp.rmdir(remotePath, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  });
});

/**
 * Rename a remote file/directory via SFTP.
 */
ipcMain.handle('ssh:sftpRename', (event, connectionId, oldPath, newPath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  });
});

/**
 * Resolve remote home directory via SSH command.
 */
ipcMain.handle('ssh:sftpHome', (event, connectionId) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.exec('echo ~', (err, stream) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      let output = '';
      stream.on('data', (data) => { output += data.toString(); });
      stream.stderr.on('data', (data) => {});
      stream.on('close', () => {
        resolve({ success: true, path: output.trim() || '/' });
      });
    });
  });
});

/**
 * Execute an arbitrary command over SSH.
 * Returns { success, stdout, stderr, exitCode }
 */
ipcMain.handle('ssh:exec', (event, connectionId, command) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        resolve({ success: false, error: err.message, stdout: '', stderr: err.message, exitCode: -1 });
        return;
      }
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        exitCode = code || 0;
        resolve({
          success: exitCode === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode,
          error: exitCode !== 0 ? stderr.trim() || 'Command failed (exit ' + exitCode + ')' : null,
        });
      });
    });
  });
});

/**
 * Read a remote file's text content via SFTP.
 * Returns { success, content } or { success: false, error }
 */
ipcMain.handle('ssh:sftpReadFile', (event, connectionId, remotePath) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      const chunks = [];
      const readStream = sftp.createReadStream(remotePath);

      readStream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      readStream.on('error', (readErr) => {
        resolve({ success: false, error: readErr.message });
      });

      readStream.on('close', () => {
        const content = Buffer.concat(chunks).toString('utf-8');
        resolve({ success: true, content: content });
      });
    });
  });
});

/**
 * Write text content to a remote file via SFTP.
 * Returns { success: true } or { success: false, error }
 */
ipcMain.handle('ssh:sftpWriteFile', (event, connectionId, remotePath, content) => {
  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active connection' };

  return new Promise((resolve) => {
    conn.sftp((err, sftp) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      const writeStream = sftp.createWriteStream(remotePath);

      writeStream.on('error', (writeErr) => {
        resolve({ success: false, error: writeErr.message });
      });

      writeStream.on('close', () => {
        resolve({ success: true });
      });

      writeStream.end(content, 'utf-8');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Local Filesystem
// ═══════════════════════════════════════════════════════════════════════

/**
 * List local directory contents.
 * Returns array of { name, size, modifyTime, isDirectory, isFile, path }
 */
ipcMain.handle('fs:listDir', (event, dirPath) => {
  try {
    const resolved = path.resolve(dirPath);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    const items = entries
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => {
        const fullPath = path.join(resolved, entry.name);
        let size = 0;
        let modifyTime = null;
        try {
          const stat = fs.statSync(fullPath);
          size = stat.size;
          modifyTime = stat.mtimeMs;
        } catch {}
        return {
          name: entry.name,
          size,
          modifyTime,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          path: fullPath,
        };
      });

    // Sort: directories first, then alphabetical
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return { success: true, entries: items, path: resolved };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Get common user directories.
 */
ipcMain.handle('fs:userDirs', () => {
  return {
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
  };
});

/**
 * Delete a local file.
 */
ipcMain.handle('fs:deleteFile', (event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    fs.unlinkSync(resolved);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Create a local directory.
 */
ipcMain.handle('fs:mkdir', (event, dirPath) => {
  try {
    const resolved = path.resolve(dirPath);
    fs.mkdirSync(resolved, { recursive: false });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Create an empty local file (like touch).
 */
ipcMain.handle('fs:createFile', (event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Close immediately to create empty file
    fs.closeSync(fs.openSync(resolved, 'w'));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Delete a local file or directory recursively.
 */
ipcMain.handle('fs:deletePath', (event, targetPath) => {
  try {
    const resolved = path.resolve(targetPath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Read a local file and return its content as text.
 */
ipcMain.handle('fs:readFile', (event, filePath, encoding) => {
  try {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, encoding || 'utf-8');
    return { success: true, content: content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Write text content to a local file.
 */
ipcMain.handle('fs:writeFile', (event, filePath, content, encoding) => {
  try {
    const resolved = path.resolve(filePath);
    fs.writeFileSync(resolved, content, encoding || 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Dialogs
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result;
});

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

// ─── Paths ───────────────────────────────────────────────────────────
const SRC_DIR = path.join(__dirname, '..', 'src');
const PLUGINS_DIR = path.join(SRC_DIR, 'plugins');
const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');

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
      reject({ success: false, error: err.message });
    });

    conn.on('close', () => {
      sshConnections.delete(connId);
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

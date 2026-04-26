const { app, BrowserWindow, ipcMain, dialog, protocol, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { Transform } = require('stream');
const { Client } = require('ssh2');
const ftp = require('basic-ftp');

// ─── Paths ───────────────────────────────────────────────────────────
const SRC_DIR = path.join(__dirname, '..', 'src');
const PLUGINS_DIR = path.join(SRC_DIR, 'plugins');
const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');
const PORT_FORWARD_FILE = path.join(USER_DATA, 'port-forward-rules.json');

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
}, {
  scheme: 'localfile',
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
let ftpConnections = new Map(); // connId → { client, profile }
let isManuallyMaximized = false;
let preMaximizeBounds = null;

// ─── Port Forwarding State ─────────────────────────────────────────────
let activeTunnels = new Map(); // ruleId → { server, sockets, rule, connectionId }
let tunnelRules = [];          // Persisted rules array

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

// ─── Port Forwarding Helpers ─────────────────────────────────────────

/**
 * Load port forwarding rules from disk.
 */
function loadPortForwardRules() {
  try {
    if (fs.existsSync(PORT_FORWARD_FILE)) {
      tunnelRules = JSON.parse(fs.readFileSync(PORT_FORWARD_FILE, 'utf-8'));
    }
  } catch {
    tunnelRules = [];
  }
  // Tunnels don't persist across restarts (SSH connections are lost),
  // so reset all enabled flags to false.
  for (const rule of tunnelRules) {
    rule.enabled = false;
  }
}

/**
 * Save port forwarding rules to disk.
 */
function savePortForwardRules() {
  try {
    fs.writeFileSync(PORT_FORWARD_FILE, JSON.stringify(tunnelRules, null, 2), 'utf-8');
  } catch (err) {
    console.error('[PortForward] Failed to save rules:', err);
  }
}

/**
 * Start a local port forward tunnel through an SSH connection.
 * Creates a net.Server on the local port that forwards connections via SSH forwardOut.
 */
async function startTunnel(ruleId, connectionId) {
  const rule = tunnelRules.find(r => r.id === ruleId);
  if (!rule) return { success: false, error: 'Rule not found' };

  const conn = sshConnections.get(connectionId);
  if (!conn) return { success: false, error: 'No active SSH connection' };

  if (activeTunnels.has(ruleId)) {
    return { success: false, error: 'Tunnel already active' };
  }

  const remoteHost = rule.remoteHost || 'localhost';

  return new Promise((resolve) => {
    const sockets = new Set();

    const server = net.createServer((socket) => {
      conn.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        remoteHost,
        rule.remotePort,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }

          const entry = { socket, stream };
          sockets.add(entry);

          socket.pipe(stream);
          stream.pipe(socket);

          const cleanup = () => {
            sockets.delete(entry);
            try { socket.destroy(); } catch (e) { /* ignore */ }
            try { stream.close(); } catch (e) { /* ignore */ }
          };

          socket.on('error', cleanup);
          stream.on('error', cleanup);
          socket.on('close', () => sockets.delete(entry));
          stream.on('close', () => sockets.delete(entry));
        }
      );
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ success: false, error: 'Port ' + rule.localPort + ' is already in use' });
      } else {
        resolve({ success: false, error: err.message });
      }
    });

    server.listen(rule.localPort, '127.0.0.1', () => {
      activeTunnels.set(ruleId, { server, sockets, rule, connectionId });
      rule.enabled = true;
      savePortForwardRules();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel:status-changed', { ruleId, active: true });
      }

      console.log('[PortForward] Started tunnel:', rule.name, 'localhost:' + rule.localPort, '→', remoteHost + ':' + rule.remotePort);
      resolve({ success: true });
    });
  });
}

/**
 * Stop an active port forward tunnel.
 */
function stopTunnel(ruleId) {
  const tunnel = activeTunnels.get(ruleId);
  if (!tunnel) {
    // Stale state: rule may say enabled but tunnel isn't running.
    // Just clean up the flag.
    const rule = tunnelRules.find(r => r.id === ruleId);
    if (rule && rule.enabled) {
      rule.enabled = false;
      savePortForwardRules();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel:status-changed', { ruleId, active: false });
      }
    }
    return { success: true };
  }

  // Close all active connections
  for (const entry of tunnel.sockets) {
    try { entry.socket.destroy(); } catch (e) { /* ignore */ }
    try { entry.stream.close(); } catch (e) { /* ignore */ }
  }
  tunnel.sockets.clear();

  // Close the listening server
  tunnel.server.close();
  activeTunnels.delete(ruleId);

  const rule = tunnelRules.find(r => r.id === ruleId);
  if (rule) rule.enabled = false;
  savePortForwardRules();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tunnel:status-changed', { ruleId, active: false });
  }

  console.log('[PortForward] Stopped tunnel:', ruleId);
  return { success: true };
}

/**
 * Stop all active tunnels associated with a specific SSH connection.
 */
function stopAllTunnelsForConnection(connectionId) {
  const ruleIds = [];
  for (const [ruleId, tunnel] of activeTunnels) {
    if (tunnel.connectionId === connectionId) {
      ruleIds.push(ruleId);
    }
  }
  for (const ruleId of ruleIds) {
    stopTunnel(ruleId);
  }
}

/**
 * Stop all active tunnels regardless of connection.
 */
function stopAllTunnels() {
  const ruleIds = Array.from(activeTunnels.keys());
  for (const ruleId of ruleIds) {
    stopTunnel(ruleId);
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

  // Keep isManuallyMaximized in sync with native maximize events
  // (e.g. Windows Snap, double-click on -webkit-app-region: drag)
  mainWindow.on('maximize', () => {
    if (!isManuallyMaximized) {
      preMaximizeBounds = null; // Native maximize — no saved bounds
    }
    isManuallyMaximized = true;
  });
  mainWindow.on('unmaximize', () => {
    isManuallyMaximized = false;
  });

  mainWindow.on('closed', () => {
    // Close all SSH connections and tunnels
    stopAllTunnels();
    for (const [id, conn] of sshConnections) {
      if (conn && conn.end) conn.end();
    }
    sshConnections.clear();
    // Close all FTP connections
    for (const [id, entry] of ftpConnections) {
      try { entry.client.close(); } catch (e) { /* ignore */ }
    }
    ftpConnections.clear();
    mainWindow = null;
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataFiles();
  loadPortForwardRules();

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

  // Register localfile:// protocol to serve local files (e.g. desktop backgrounds)
  // The URL format uses a hash fragment to carry the raw file path, avoiding
  // browser URL parsing issues with Windows drive letters (C: being treated as hostname).
  // Example: localfile://bg#/C:/Users/test/image.jpg
  protocol.handle('localfile', async (request) => {
    try {
      // Extract the hash fragment which contains the unmodified file path
      const hashIndex = request.url.indexOf('#');
      if (hashIndex === -1) {
        return new Response('Missing path', { status: 400 });
      }
      const filePath = decodeURIComponent(request.url.substring(hashIndex + 1));

      const data = await fs.promises.readFile(filePath);
      // Determine MIME type from extension
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return new Response(data, {
        headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
      });
    } catch (e) {
      console.error('[localfile protocol] Error:', request.url, e.message);
      return new Response('Not found', { status: 404 });
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
  stopAllTunnels();
  for (const [id, conn] of sshConnections) {
    if (conn && conn.end) conn.end();
  }
  sshConnections.clear();
  // Close all FTP connections
  for (const [id, entry] of ftpConnections) {
    try { entry.client.close(); } catch (e) { /* ignore */ }
  }
  ftpConnections.clear();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: Window Controls
// ═══════════════════════════════════════════════════════════════════════
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  if (isManuallyMaximized) {
    // Restore to previous bounds
    if (preMaximizeBounds) {
      mainWindow.setBounds(preMaximizeBounds);
    }
    isManuallyMaximized = false;
  } else {
    // Save current bounds before maximizing
    preMaximizeBounds = mainWindow.getBounds();
    // Use workArea which already accounts for the Windows taskbar
    const workArea = screen.getPrimaryDisplay().workArea;
    mainWindow.setBounds({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height
    });
    isManuallyMaximized = true;
  }
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => isManuallyMaximized);

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

      // Stop any tunnels using this connection
      stopAllTunnelsForConnection(connId);

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
 * Read a remote file's binary content via SFTP and return as base64.
 * Used by file-viewer to display images and PDFs.
 * Returns { success, content } or { success: false, error }
 */
ipcMain.handle('ssh:sftpReadFileBase64', (event, connectionId, remotePath) => {
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
        const content = Buffer.concat(chunks).toString('base64');
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
// IPC: FTP Connection
// ═══════════════════════════════════════════════════════════════════════

ipcMain.handle('ftp:connect', async (event, profile) => {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  const connId = profile.id || Date.now().toString();

  const ftpConfig = {
    host: profile.host,
    port: profile.port || 21,
    user: profile.username || 'anonymous',
    password: profile.password || '',
    secure: false, // Can be extended for FTPS
  };

  try {
    await client.access(ftpConfig);
    ftpConnections.set(connId, { client, profile });
    return { success: true, connectionId: connId };
  } catch (err) {
    return { success: false, error: err.message || 'FTP connection failed' };
  }
});

ipcMain.handle('ftp:disconnect', (event, connectionId) => {
  const entry = ftpConnections.get(connectionId);
  if (entry) {
    entry.client.close();
    ftpConnections.delete(connectionId);
    return true;
  }
  return false;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC: FTP File Operations
// ═══════════════════════════════════════════════════════════════════════

/**
 * List remote directory via FTP.
 * Returns array of { name, size, modifyTime, isDirectory, isFile, path }
 */
ipcMain.handle('ftp:listDir', async (event, connectionId, remotePath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    const list = await entry.client.list(remotePath);
    const entries = list.map(item => ({
      name: item.name,
      size: item.size || 0,
      modifyTime: item.modifiedAt ? new Date(item.modifiedAt).getTime() : null,
      isDirectory: item.isDirectory,
      isFile: item.isFile,
      isSymlink: item.isSymbolicLink,
      path: remotePath === '/' ? '/' + item.name : remotePath + '/' + item.name,
    }));

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return { success: true, entries };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to list directory' };
  }
});

/**
 * Download a remote file to a local path via FTP.
 * Reports progress via IPC events using a Transform stream.
 */
ipcMain.handle('ftp:download', async (event, connectionId, remotePath, localPath, transferId) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    // Get file size for progress tracking
    let totalSize = 0;
    try {
      const dirPath = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
      const fileName = remotePath.substring(remotePath.lastIndexOf('/') + 1);
      const list = await entry.client.list(dirPath);
      const fileInfo = list.find(f => f.name === fileName);
      if (fileInfo) totalSize = fileInfo.size || 0;
    } catch (e) {
      // Size detection is best-effort
    }

    const writeStream = fs.createWriteStream(localPath);
    let transferred = 0;

    // Use a Transform stream to intercept data and report progress
    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        transferred += chunk.length;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ftp:progress', {
            transferId,
            transferred,
            total: totalSize,
            percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 0
          });
        }
        callback(null, chunk);
      }
    });

    progressStream.pipe(writeStream);

    await entry.client.downloadTo(progressStream, remotePath);

    // Ensure final 100% progress is sent
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ftp:progress', {
        transferId,
        transferred: totalSize,
        total: totalSize,
        percent: 100
      });
    }

    return { success: true, transferred: totalSize };
  } catch (err) {
    return { success: false, error: err.message || 'Download failed' };
  }
});

/**
 * Upload a local file to a remote path via FTP.
 * Reports progress via IPC events.
 */
ipcMain.handle('ftp:upload', async (event, connectionId, localPath, remotePath, transferId) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  if (!fs.existsSync(localPath)) {
    return { success: false, error: 'Local file not found' };
  }

  try {
    const totalSize = fs.statSync(localPath).size;

    await entry.client.uploadFrom(localPath, remotePath);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ftp:progress', {
        transferId,
        transferred: totalSize,
        total: totalSize,
        percent: 100
      });
    }

    return { success: true, transferred: totalSize };
  } catch (err) {
    return { success: false, error: err.message || 'Upload failed' };
  }
});

/**
 * Create a remote directory via FTP.
 */
ipcMain.handle('ftp:mkdir', async (event, connectionId, remotePath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    await entry.client.ensureDir(remotePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Delete a remote file via FTP.
 */
ipcMain.handle('ftp:delete', async (event, connectionId, remotePath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    await entry.client.remove(remotePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Remove a remote directory via FTP.
 */
ipcMain.handle('ftp:rmdir', async (event, connectionId, remotePath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    await entry.client.removeEmptyDir(remotePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Rename a remote file/directory via FTP.
 */
ipcMain.handle('ftp:rename', async (event, connectionId, oldPath, newPath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    await entry.client.rename(oldPath, newPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Get the current working directory via FTP (resolves "home" directory).
 */
ipcMain.handle('ftp:home', async (event, connectionId) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  try {
    const pwd = await entry.client.pwd();
    return { success: true, path: pwd || '/' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Read a remote file's text content via FTP.
 * Downloads to a temp file, reads it, then deletes the temp file.
 */
ipcMain.handle('ftp:readFile', async (event, connectionId, remotePath) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  const tmpPath = path.join(os.tmpdir(), 'termulos_ftp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8));
  try {
    await entry.client.downloadTo(tmpPath, remotePath);
    const content = fs.readFileSync(tmpPath, 'utf-8');
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore cleanup error */ }
    return { success: true, content: content };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    return { success: false, error: err.message };
  }
});

/**
 * Write text content to a remote file via FTP.
 * Writes to a temp file, uploads it, then deletes the temp file.
 */
ipcMain.handle('ftp:writeFile', async (event, connectionId, remotePath, content) => {
  const entry = ftpConnections.get(connectionId);
  if (!entry) return { success: false, error: 'No active FTP connection' };

  const tmpPath = path.join(os.tmpdir(), 'termulos_ftp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8));
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    await entry.client.uploadFrom(tmpPath, remotePath);
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    return { success: false, error: err.message };
  }
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
// IPC: Settings Persistence
// ═══════════════════════════════════════════════════════════════════════

ipcMain.handle('settings:get', (event, key, defaultValue) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultValue !== undefined ? defaultValue : null;
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return data[key] !== undefined ? data[key] : (defaultValue !== undefined ? defaultValue : null);
  } catch {
    return defaultValue !== undefined ? defaultValue : null;
  }
});

ipcMain.handle('settings:set', (event, key, value) => {
  try {
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
    if (value === null || value === undefined) {
      delete data[key];
    } else {
      data[key] = value;
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[settings:set] Error:', err);
    return false;
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

// ═══════════════════════════════════════════════════════════════════════
// IPC: Port Forwarding Tunnels
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get all saved port forwarding rules.
 */
ipcMain.handle('tunnel:getRules', () => {
  return tunnelRules;
});

/**
 * Save the full set of port forwarding rules (replaces all).
 */
ipcMain.handle('tunnel:saveRules', (event, rules) => {
  tunnelRules = rules || [];
  savePortForwardRules();
  return true;
});

/**
 * Start a port forwarding tunnel.
 * @param {string} ruleId - The rule ID to start
 * @param {string} connectionId - The SSH connection ID to tunnel through
 */
ipcMain.handle('tunnel:start', async (event, ruleId, connectionId) => {
  return await startTunnel(ruleId, connectionId);
});

/**
 * Stop an active port forwarding tunnel.
 * @param {string} ruleId - The rule ID to stop
 */
ipcMain.handle('tunnel:stop', (event, ruleId) => {
  return stopTunnel(ruleId);
});

/**
 * Get the list of currently active tunnel rule IDs.
 */
ipcMain.handle('tunnel:listActive', () => {
  const active = [];
  for (const [ruleId, tunnel] of activeTunnels) {
    active.push({
      ruleId: ruleId,
      localPort: tunnel.rule.localPort,
      remoteHost: tunnel.rule.remoteHost || 'localhost',
      remotePort: tunnel.rule.remotePort,
      connectionId: tunnel.connectionId,
      activeConnections: tunnel.sockets.size
    });
  }
  return active;
});

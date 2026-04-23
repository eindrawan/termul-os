/**
 * App - Main application controller
 * Manages the OS lifecycle: connection dialog → desktop
 */
class TermulOS {
  constructor() {
    this.state = 'dialog'; // 'dialog' | 'connecting' | 'desktop'
    this.plugins = [];
    this.connectionId = null;
    this.currentProfile = null;
  }

  /**
   * Initialize the application
   */
  async init() {
    // Load xterm.js globally (needed before any terminal plugin mounts)
    await this.loadXterm();

    this.showConnectionDialog();

    // Setup window manager events
    window.WindowManager.onWindowClose = (windowId) => {
      this.updateTaskbar();
    };

    window.WindowManager.onWindowFocus = (windowId) => {
      this.updateTaskbar();
    };

    window.WindowManager.onWindowOpen = (windowId, plugin) => {
      this.updateTaskbar();
    };

    // Plugin change handler (v2 API uses on/off pattern)
    window.PluginLoader.onPluginChange(async (type, dirName) => {
      await this.loadPlugins();
      if (window.Desktop) window.Desktop.setPlugins(this.plugins);
      if (window.StartMenu) window.StartMenu.setPlugins(this.plugins);
    });

    // Setup IPC listeners for SSH
    window.termulAPI.ssh.onShellData((data) => {
      const event = new CustomEvent('termul:shell-data', { detail: data });
      document.dispatchEvent(event);
    });

    window.termulAPI.ssh.onShellClosed((data) => {
      const event = new CustomEvent('termul:shell-closed', { detail: data });
      document.dispatchEvent(event);
    });
  }

  /**
   * Show the connection profile dialog
   */
  async showConnectionDialog() {
    this.state = 'dialog';
    const container = document.getElementById('app');
    container.innerHTML = '';
    container.classList.remove('desktop-mode');
    container.classList.add('dialog-mode');

    const dialogView = document.createElement('div');
    dialogView.id = 'connection-dialog';
    dialogView.className = 'connection-dialog';
    dialogView.innerHTML = `
      <div class="dialog-backdrop"></div>
      <div class="dialog-container">
        <div class="dialog-sidebar">
          <div class="dialog-sidebar-header">
            <div class="dialog-logo">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 3h8.5v8.5H3V3zm9.5 0H21v8.5h-8.5V3zM3 12.5h8.5V21H3v-8.5zm9.5 0H21V21h-8.5v-8.5z"/>
              </svg>
            </div>
            <h1>TermulOS</h1>
            <p>SSH Client</p>
          </div>
          <div class="dialog-sidebar-profiles" id="dialog-profiles-list">
            <!-- Saved profiles injected here -->
          </div>
          <button class="dialog-new-profile-btn" id="dialog-new-profile">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Profile
          </button>
        </div>
        <div class="dialog-main" id="dialog-main">
          <div class="dialog-welcome">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>
            </svg>
            <h2>Welcome to TermulOS</h2>
            <p>Create a new connection profile or select a saved one to get started.</p>
          </div>
        </div>
      </div>
    `;

    container.appendChild(dialogView);

    // Load saved profiles
    await this.loadProfiles();

    // Event: new profile button
    document.getElementById('dialog-new-profile').addEventListener('click', () => {
      this.showProfileForm(window.ConnectionManager.createBlankProfile());
    });
  }

  /**
   * Load and display saved profiles
   */
  async loadProfiles() {
    const profiles = await window.ConnectionManager.getProfiles();
    const list = document.getElementById('dialog-profiles-list');

    if (!list) return;

    if (profiles.length === 0) {
      list.innerHTML = `
        <div class="dialog-no-profiles">
          <p>No saved profiles</p>
          <small>Create one to get started</small>
        </div>
      `;
      return;
    }

    list.innerHTML = profiles.map(profile => `
      <div class="dialog-profile-item" data-profile-id="${profile.id}">
        <div class="profile-color-dot" style="background: ${profile.color || '#0078D4'}"></div>
        <div class="profile-info">
          <span class="profile-name">${profile.name || profile.host}</span>
          <span class="profile-host">${profile.username}@${profile.host}</span>
        </div>
        <div class="profile-actions">
          <button class="profile-action-btn profile-connect-btn" data-action="connect" title="Connect">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </button>
          <button class="profile-action-btn profile-edit-btn" data-action="edit" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="profile-action-btn profile-delete-btn" data-action="delete" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Bind profile events
    list.querySelectorAll('.profile-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.dialog-profile-item');
        const profileId = item.dataset.profileId;
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return;

        const action = btn.dataset.action;
        switch (action) {
          case 'connect':
            await this.connectToProfile(profile);
            break;
          case 'edit':
            this.showProfileForm(profile);
            break;
          case 'delete':
            await window.ConnectionManager.deleteProfile(profileId);
            await this.loadProfiles();
            this.showWelcome();
            break;
        }
      });
    });

    // Double-click to connect
    list.querySelectorAll('.dialog-profile-item').forEach(item => {
      item.addEventListener('dblclick', async () => {
        const profileId = item.dataset.profileId;
        const profile = profiles.find(p => p.id === profileId);
        if (profile) {
          await this.connectToProfile(profile);
        }
      });
    });
  }

  /**
   * Show the profile creation/edit form
   */
  showProfileForm(profile) {
    const main = document.getElementById('dialog-main');
    if (!main) return;

    const isNew = !profile.name;
    main.innerHTML = `
      <div class="dialog-form">
        <div class="dialog-form-header">
          <h2>${isNew ? 'New Connection Profile' : 'Edit Profile'}</h2>
          <button class="dialog-form-close" id="dialog-form-close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="dialog-form-body">
          <div class="form-group">
            <label>Profile Name</label>
            <input type="text" id="form-name" placeholder="My Server" value="${profile.name || ''}" />
          </div>
          <div class="form-row">
            <div class="form-group flex-1">
              <label>Host</label>
              <input type="text" id="form-host" placeholder="192.168.1.100" value="${profile.host || ''}" />
            </div>
            <div class="form-group" style="width:100px">
              <label>Port</label>
              <input type="number" id="form-port" value="${profile.port || 22}" min="1" max="65535" />
            </div>
          </div>
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="form-username" placeholder="root" value="${profile.username || ''}" />
          </div>
          <div class="form-group">
            <label>Authentication</label>
            <div class="form-radio-group">
              <label class="form-radio">
                <input type="radio" name="authType" value="password" ${profile.authType !== 'key' ? 'checked' : ''} />
                <span>Password</span>
              </label>
              <label class="form-radio">
                <input type="radio" name="authType" value="key" ${profile.authType === 'key' ? 'checked' : ''} />
                <span>Private Key</span>
              </label>
            </div>
          </div>
          <div class="form-group auth-password" style="display:${profile.authType !== 'key' ? 'block' : 'none'}">
            <label>Password</label>
            <input type="password" id="form-password" placeholder="Enter password" value="${profile.password || ''}" />
          </div>
          <div class="form-group auth-key" style="display:${profile.authType === 'key' ? 'block' : 'none'}">
            <label>Private Key Path</label>
            <div class="form-file-input">
              <input type="text" id="form-keypath" placeholder="~/.ssh/id_rsa" value="${profile.privateKey || ''}" />
              <button class="form-file-btn" id="form-browse-key">Browse</button>
            </div>
          </div>
          <div class="form-group auth-key" style="display:${profile.authType === 'key' ? 'block' : 'none'}">
            <label>Passphrase (optional)</label>
            <input type="password" id="form-passphrase" placeholder="Key passphrase" value="${profile.passphrase || ''}" />
          </div>
          <div class="form-group">
            <label>Color Tag</label>
            <div class="form-color-picker" id="form-color-picker">
              ${['#0078D4','#0099BC','#7A7574','#767676','#FF8C00','#E81123','#0063B1','#6B69D6','#8E562E','#00B7C3','#038387','#00B294'].map(c =>
                `<button class="color-option ${profile.color === c ? 'selected' : ''}" data-color="${c}" style="background:${c}"></button>`
              ).join('')}
            </div>
          </div>
        </div>
        <div class="dialog-form-footer">
          <button class="btn btn-secondary" id="form-cancel">Cancel</button>
          <button class="btn btn-primary" id="form-save">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            Save Profile
          </button>
          <button class="btn btn-accent" id="form-save-connect">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
            Save & Connect
          </button>
        </div>
      </div>
    `;

    // State for color
    let selectedColor = profile.color || '#0078D4';

    // Auth type toggle
    main.querySelectorAll('input[name="authType"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        main.querySelector('.auth-password').style.display = e.target.value === 'password' ? 'block' : 'none';
        main.querySelector('.auth-key').style.display = e.target.value === 'key' ? 'block' : 'none';
      });
    });

    // Color picker
    main.querySelectorAll('.color-option').forEach(btn => {
      btn.addEventListener('click', () => {
        main.querySelectorAll('.color-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedColor = btn.dataset.color;
      });
    });

    // Browse for key file
    document.getElementById('form-browse-key')?.addEventListener('click', async () => {
      const result = await window.termulAPI.dialog.openFile({
        title: 'Select Private Key',
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });
      if (!result.canceled && result.filePaths.length > 0) {
        document.getElementById('form-keypath').value = result.filePaths[0];
      }
    });

    // Close / Cancel
    document.getElementById('dialog-form-close').addEventListener('click', () => this.showWelcome());
    document.getElementById('form-cancel').addEventListener('click', () => this.showWelcome());

    // Save
    document.getElementById('form-save').addEventListener('click', () => this.handleFormSave(profile, false, selectedColor));
    document.getElementById('form-save-connect').addEventListener('click', () => this.handleFormSave(profile, true, selectedColor));
  }

  /**
   * Handle form save action
   */
  async handleFormSave(originalProfile, connectAfter, selectedColor) {
    const name = document.getElementById('form-name').value.trim();
    const host = document.getElementById('form-host').value.trim();
    const port = parseInt(document.getElementById('form-port').value) || 22;
    const username = document.getElementById('form-username').value.trim();
    const authType = document.querySelector('input[name="authType"]:checked').value;
    const password = document.getElementById('form-password')?.value || '';
    const privateKey = document.getElementById('form-keypath')?.value || '';
    const passphrase = document.getElementById('form-passphrase')?.value || '';

    // Validation
    if (!host) {
      this.showFormError('Host is required');
      return;
    }
    if (!username) {
      this.showFormError('Username is required');
      return;
    }

    const profile = {
      ...originalProfile,
      name: name || host,
      host,
      port,
      username,
      authType,
      password: authType === 'password' ? password : '',
      privateKey: authType === 'key' ? privateKey : '',
      passphrase: authType === 'key' ? passphrase : '',
      color: selectedColor
    };

    await window.ConnectionManager.saveProfile(profile);
    await this.loadProfiles();

    if (connectAfter) {
      await this.connectToProfile(profile);
    } else {
      this.showWelcome();
    }
  }

  showFormError(message) {
    const existing = document.querySelector('.form-error-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'form-error-toast';
    toast.textContent = message;
    document.querySelector('.dialog-form-body')?.prepend(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  /**
   * Show welcome placeholder
   */
  showWelcome() {
    const main = document.getElementById('dialog-main');
    if (!main) return;
    main.innerHTML = `
      <div class="dialog-welcome">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>
        </svg>
        <h2>Welcome to TermulOS</h2>
        <p>Create a new connection profile or select a saved one to get started.</p>
      </div>
    `;
  }

  /**
   * Connect to a profile
   */
  async connectToProfile(profile) {
    this.showConnectingStatus(profile);

    try {
      const result = await window.ConnectionManager.connect(profile);
      if (result.success) {
        this.connectionId = result.connectionId;
        this.currentProfile = profile;
        await this.enterDesktop(profile);
      } else {
        this.showConnectionError(result.error || 'Connection failed');
      }
    } catch (err) {
      this.showConnectionError(err.error || err.message || 'Connection failed');
    }
  }

  /**
   * Show connecting spinner
   */
  showConnectingStatus(profile) {
    const main = document.getElementById('dialog-main');
    if (!main) return;
    main.innerHTML = `
      <div class="dialog-connecting">
        <div class="connecting-spinner">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="spin-animation">
            <path d="M12 2a10 10 0 0 1 10 10"/>
          </svg>
        </div>
        <h2>Connecting...</h2>
        <p>${profile.username}@${profile.host}:${profile.port}</p>
      </div>
    `;
  }

  /**
   * Show connection error
   */
  showConnectionError(message) {
    const main = document.getElementById('dialog-main');
    if (!main) return;
    main.innerHTML = `
      <div class="dialog-error">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E81123" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <h2>Connection Failed</h2>
        <p>${message}</p>
        <button class="btn btn-primary" id="error-retry">Try Again</button>
      </div>
    `;
    document.getElementById('error-retry')?.addEventListener('click', () => this.showWelcome());
  }

  /**
   * Enter the desktop environment after successful connection
   */
  async enterDesktop(profile) {
    this.state = 'desktop';
    const app = document.getElementById('app');
    app.classList.remove('dialog-mode');
    app.classList.add('desktop-mode');

    // Load plugins
    await this.loadPlugins();

    // Build desktop UI
    app.innerHTML = `
      <div class="os-titlebar" id="os-titlebar">
        <div class="os-titlebar-left">
          <span class="os-titlebar-app-name">TermulOS</span>
        </div>
        <div class="os-titlebar-controls">
          <button class="titlebar-btn" id="titlebar-minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
          <button class="titlebar-btn" id="titlebar-maximize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="0.5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
          <button class="titlebar-btn titlebar-btn-close" id="titlebar-close">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
      </div>
      <div id="os-desktop">
        <div id="desktop-icons"></div>
      </div>
      <div id="os-window-area"></div>
      <div id="os-start-menu" class="start-menu"></div>
      <div id="os-taskbar"></div>
    `;

    // Titlebar controls
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => window.termulAPI.window.minimize());
    document.getElementById('titlebar-maximize')?.addEventListener('click', () => window.termulAPI.window.maximize());
    document.getElementById('titlebar-close')?.addEventListener('click', () => window.termulAPI.window.close());

    // Initialize components
    window.Desktop.init();
    window.Desktop.setPlugins(this.plugins);
    window.Desktop.onAppLaunch = (plugin) => this.launchApp(plugin);

    window.WindowManager.init(document.getElementById('os-window-area'));

    window.Taskbar.init();
    window.Taskbar.onStartClick = () => window.StartMenu.toggle();
    window.Taskbar.onAppClick = (windowId) => {
      const win = window.WindowManager.windows.get(windowId);
      if (win) {
        if (win.minimized) {
          window.WindowManager.minimize(windowId);
        }
        window.WindowManager.focus(windowId);
      }
    };

    window.StartMenu.init();
    window.StartMenu.setPlugins(this.plugins);
    window.StartMenu.onAppLaunch = (plugin) => this.launchApp(plugin);
    window.StartMenu.onAppUninstall = async (dirName) => {
      const result = await window.PluginLoader.uninstall(dirName);
      if (!result.success) {
        alert(result.error);
      }
    };
    window.StartMenu.onClose = (action) => {
      if (action === 'power') {
        this.disconnectAndReturnToDialog();
      }
      window.StartMenu.close();
    };

    // Set username in start menu
    const usernameEl = document.querySelector('#start-menu-username');
    if (usernameEl) {
      usernameEl.textContent = profile.username || 'User';
    }

    // Auto-open terminal
    const terminalPlugin = this.plugins.find(p => p.dirName === 'terminal');
    if (terminalPlugin) {
      this.launchApp(terminalPlugin);
    }

    // Start taskbar update loop
    this.taskbarLoop = setInterval(() => this.updateTaskbar(), 500);
  }

  /**
   * Load plugins from the plugin loader
   */
  async loadPlugins() {
    this.plugins = await window.PluginLoader.loadAll();
    // Resolve icon SVGs
    for (const plugin of this.plugins) {
      plugin.icon = await window.PluginLoader.getPluginIcon(plugin);
    }
  }

  /**
   * Launch an app
   */
  launchApp(plugin) {
    window.WindowManager.open(plugin);
    window.StartMenu.close();
  }

  /**
   * Update taskbar items
   */
  updateTaskbar() {
    const items = window.WindowManager.getTaskbarItems();
    window.Taskbar.updateItems(items);
  }

  /**
   * Load xterm.js and FitAddon into the page scope.
   * Called once during init, before any plugins mount.
   * Stores the xterm CSS for injection into shadow DOMs.
   */
  async loadXterm() {
    try {
      const [js, css, fitJs] = await Promise.all([
        window.termulAPI.xterm.getJS(),
        window.termulAPI.xterm.getCSS(),
        window.termulAPI.xterm.getFitAddonJS(),
      ]);

      if (js) {
        // Eval xterm.js into the page scope — exposes window.Terminal
        const script = document.createElement('script');
        script.textContent = js;
        document.head.appendChild(script);
        script.remove();
      }

      if (fitJs) {
        // Eval FitAddon — exposes window.FitAddon
        const script = document.createElement('script');
        script.textContent = fitJs;
        document.head.appendChild(script);
        script.remove();
      }

      // Store CSS for shadow DOM injection (used by plugin-loader)
      if (css) {
        window.PluginLoader._xtermCSS = css;
      }
    } catch (err) {
      console.error('[TermulOS] Failed to load xterm.js:', err);
    }
  }

  /**
   * Disconnect and return to connection dialog
   */
  async disconnectAndReturnToDialog() {
    if (this.taskbarLoop) {
      clearInterval(this.taskbarLoop);
    }

    // Close all windows (triggers plugin unmount lifecycle)
    window.WindowManager.closeAll();

    await window.ConnectionManager.disconnect();

    window.Taskbar.destroy();

    this.showConnectionDialog();
  }
}

// ─── Boot ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const os = new TermulOS();
  os.init();

  // Expose OS reference for plugin system (used by PluginLoader.createPluginAPI)
  window.TermulOS = {
    os: os
  };
});

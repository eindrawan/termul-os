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

    // ─── Tab Management ──────────────────────────────────────────────
    /** @type {Array<{id:string, profile:Object, connectionId:string}>} */
    this.tabs = [];
    /** @type {string|null} Currently active tab ID */
    this.activeTabId = null;
  }

  /**
   * Initialize the application
   */
  async init() {
    // Load xterm.js globally (needed before any terminal plugin mounts)
    await this.loadXterm();

    // Load Monaco Editor globally (needed before file-editor plugin mounts)
    await this.loadMonaco();

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
      // Update tunnel indicator visibility (plugin may have been installed/uninstalled)
      this.updateTaskbarTunnel();
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

    // SFTP progress events — bridge IPC to DOM for plugins
    window.termulAPI.ssh.onSftpProgress((data) => {
      const event = new CustomEvent('termul:sftp-progress', { detail: data });
      document.dispatchEvent(event);
    });

    // FTP progress events — bridge IPC to DOM for plugins
    window.termulAPI.ftp.onFtpProgress((data) => {
      const event = new CustomEvent('termul:ftp-progress', { detail: data });
      document.dispatchEvent(event);
    });

    // SSH connection lifecycle — detect drops and errors
    window.termulAPI.ssh.onConnectionClosed((data) => {
      this.handleConnectionLost(data.connectionId, 'Connection closed by server');
    });

    window.termulAPI.ssh.onConnectionError((data) => {
      this.handleConnectionLost(data.connectionId, data.error || 'Connection error');
    });

    // Tunnel: open port forwarder plugin from system tray
    window.termulAPI.tunnel.onOpenPlugin(() => {
      const plugin = window.PluginLoader.plugins.get('port-forwarder');
      if (plugin) {
        this.launchApp(plugin);
      }
    });

    // Tunnel: status changed → refresh taskbar indicator
    window.termulAPI.tunnel.onStatusChanged(() => {
      this.updateTaskbarTunnel();
    });

    // Store reference for tunnel toggle from taskbar
    this._tunnelRules = [];

    // Listen for "open in editor" events from plugins (e.g. file-transfer)
    document.addEventListener('termul:open-in-editor', (e) => {
      this.openFileInEditor(e.detail);
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
            <p>SSH &amp; FTP Client</p>
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
          <span class="profile-name">${profile.name || profile.host}${profile.protocol === 'ftp' ? ' <small style="opacity:0.6">(FTP)</small>' : ''}</span>
          <span class="profile-host">${profile.username}@${profile.host}${profile.port && profile.port !== (profile.protocol === 'ftp' ? 21 : 22) ? ':' + profile.port : ''}</span>
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
    const protocol = profile.protocol || 'ssh';
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
          <div class="form-group">
            <label>Protocol</label>
            <div class="form-radio-group">
              <label class="form-radio">
                <input type="radio" name="protocol" value="ssh" ${protocol !== 'ftp' ? 'checked' : ''} />
                <span>SSH</span>
              </label>
              <label class="form-radio">
                <input type="radio" name="protocol" value="ftp" ${protocol === 'ftp' ? 'checked' : ''} />
                <span>FTP</span>
              </label>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group flex-1">
              <label>Host</label>
              <input type="text" id="form-host" placeholder="192.168.1.100" value="${profile.host || ''}" />
            </div>
            <div class="form-group" style="width:100px">
              <label>Port</label>
              <input type="number" id="form-port" value="${profile.port || (protocol === 'ftp' ? 21 : 22)}" min="1" max="65535" />
            </div>
          </div>
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="form-username" placeholder="${protocol === 'ftp' ? 'anonymous' : 'root'}" value="${profile.username || (protocol === 'ftp' ? 'anonymous' : '')}" />
          </div>
          <div class="form-group ssh-only" style="display:${protocol !== 'ftp' ? 'block' : 'none'}">
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
          <div class="form-group auth-password ssh-only" style="display:${protocol !== 'ftp' && profile.authType !== 'key' ? 'block' : 'none'}">
            <label>Password</label>
            <input type="password" id="form-password" placeholder="Enter password" value="${profile.password || ''}" />
          </div>
          <div class="form-group ftp-only" style="display:${protocol === 'ftp' ? 'block' : 'none'}">
            <label>Password</label>
            <input type="password" id="form-password-ftp" placeholder="Password (leave empty for anonymous)" value="${profile.password || ''}" />
          </div>
          <div class="form-group auth-key ssh-only" style="display:${protocol !== 'ftp' && profile.authType === 'key' ? 'block' : 'none'}">
            <label>Private Key Path</label>
            <div class="form-file-input">
              <input type="text" id="form-keypath" placeholder="~/.ssh/id_rsa" value="${profile.privateKey || ''}" />
              <button class="form-file-btn" id="form-browse-key">Browse</button>
            </div>
          </div>
          <div class="form-group auth-key ssh-only" style="display:${protocol !== 'ftp' && profile.authType === 'key' ? 'block' : 'none'}">
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
    let selectedProtocol = profile.protocol || 'ssh';

    // Protocol toggle
    main.querySelectorAll('input[name="protocol"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        selectedProtocol = e.target.value;
        // Toggle visibility of SSH-only and FTP-only fields
        const sshOnly = main.querySelectorAll('.ssh-only');
        const ftpOnly = main.querySelectorAll('.ftp-only');
        for (const el of sshOnly) {
          el.style.display = selectedProtocol === 'ftp' ? 'none' : '';
        }
        for (const el of ftpOnly) {
          el.style.display = selectedProtocol === 'ftp' ? '' : 'none';
        }
        // Update port default
        const portInput = document.getElementById('form-port');
        if (portInput && (portInput.value === '22' || portInput.value === '21')) {
          portInput.value = selectedProtocol === 'ftp' ? '21' : '22';
        }
        // Update username placeholder
        const usernameInput = document.getElementById('form-username');
        if (usernameInput && !usernameInput.value) {
          usernameInput.placeholder = selectedProtocol === 'ftp' ? 'anonymous' : 'root';
        }
      });
    });

    // Auth type toggle (SSH only)
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
    const protocol = document.querySelector('input[name="protocol"]:checked')?.value || 'ssh';
    const port = parseInt(document.getElementById('form-port').value) || (protocol === 'ftp' ? 21 : 22);
    const username = document.getElementById('form-username').value.trim();
    const authType = document.querySelector('input[name="authType"]:checked')?.value || 'password';
    // For SSH password, use form-password; for FTP password, use form-password-ftp
    const password = protocol === 'ftp'
      ? (document.getElementById('form-password-ftp')?.value || '')
      : (document.getElementById('form-password')?.value || '');
    const privateKey = document.getElementById('form-keypath')?.value || '';
    const passphrase = document.getElementById('form-passphrase')?.value || '';

    // Validation
    if (!host) {
      this.showFormError('Host is required');
      return;
    }
    if (!username && protocol !== 'ftp') {
      this.showFormError('Username is required');
      return;
    }

    const profile = {
      ...originalProfile,
      name: name || host,
      host,
      port,
      username: username || (protocol === 'ftp' ? 'anonymous' : ''),
      authType: protocol === 'ftp' ? 'password' : authType,
      password: password,
      privateKey: protocol === 'ftp' ? '' : (authType === 'key' ? privateKey : ''),
      passphrase: protocol === 'ftp' ? '' : (authType === 'key' ? passphrase : ''),
      protocol: protocol,
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
    // If first connection, build the full desktop shell
    if (this.state !== 'desktop') {
      await this.enterDesktopShell();
    }

    // Create tab for this connection
    this.addTab(profile, this.connectionId);
  }

  /**
   * Build the desktop shell (called once on first connection).
   * Subsequent connections just add tabs without rebuilding.
   */
  async enterDesktopShell() {
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
        <div class="os-titlebar-tabs" id="os-titlebar-tabs">
          <!-- Tab items rendered dynamically -->
          <button class="titlebar-tab-add" id="titlebar-tab-add" title="New Connection">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
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
        <div id="dashboard-widgets" class="dashboard-widgets"></div>
      </div>
      <div id="os-window-area"></div>
      <div id="os-start-menu" class="start-menu"></div>
      <div id="os-taskbar"></div>
    `;

    // Titlebar controls
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => window.termulAPI.window.minimize());
    document.getElementById('titlebar-maximize')?.addEventListener('click', () => window.termulAPI.window.maximize());
    document.getElementById('titlebar-close')?.addEventListener('click', () => window.termulAPI.window.close());

    // Tab add button
    document.getElementById('titlebar-tab-add')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showTabConnectionPicker();
    });

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
    window.Taskbar.onReconnectClick = () => {
      if (this.activeTabId) {
        this.reconnectTab(this.activeTabId);
      }
    };
    window.Taskbar.onTunnelToggle = (ruleId, enable) => {
      this.toggleTunnelFromTaskbar(ruleId, enable);
    };
    window.Taskbar.onTunnelOpenPlugin = () => {
      const plugin = window.PluginLoader.plugins.get('port-forwarder');
      if (plugin) {
        this.launchApp(plugin);
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
        this.disconnectAllAndReturnToDialog();
        window.StartMenu.close();
      }
    };

    // Initialize dashboard widgets
    if (window.DashboardWidgets) {
      window.DashboardWidgets.init();
    }

    // Start taskbar update loop
    this.taskbarLoop = setInterval(() => this.updateTaskbar(), 500);
  }

  /**
   * Load and apply the saved desktop background for a specific profile.
   * @param {Object} profile - The connection profile (must have .id)
   */
  async applyProfileBackground(profile) {
    const app = document.getElementById('app');
    if (!app || !profile || !profile.id) return;

    try {
      const key = 'desktopBackground:' + profile.id;
      const savedBg = await window.termulAPI.settings.get(key, null);
      if (savedBg) {
        const normalizedPath = savedBg.replace(/\\/g, '/');
        app.style.backgroundImage = "url('localfile://bg#" + encodeURIComponent(normalizedPath) + "')";
        app.style.backgroundSize = 'cover';
        app.style.backgroundPosition = 'center';
        app.style.animation = 'none';
      } else {
        // No custom background for this profile — restore default gradient
        app.style.backgroundImage = '';
        app.style.backgroundSize = '';
        app.style.backgroundPosition = '';
        app.style.animation = '';
      }
    } catch (e) {
      console.warn('[TermulOS] Failed to load desktop background for profile:', profile.id, e);
    }
  }

  /**
   * Reset desktop background to the default gradient.
   */
  resetDesktopBackground() {
    const app = document.getElementById('app');
    if (app) {
      app.style.backgroundImage = '';
      app.style.backgroundSize = '';
      app.style.backgroundPosition = '';
      app.style.animation = '';
    }
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
   * Open a file in the file-editor plugin.
   * Finds or launches the file-editor, then dispatches an event with the file info.
   * @param {Object} detail - { source: 'local'|'remote', path: string, name: string }
   */
  openFileInEditor(detail) {
    if (!detail || !detail.path) return;

    // Find the file-editor plugin manifest
    const editorPlugin = this.plugins.find(p => p.dirName === 'file-editor');
    if (!editorPlugin) {
      console.warn('[TermulOS] file-editor plugin not found');
      return;
    }

    // Check if a file-editor window is already open for this tab
    let existingWindowId = null;
    for (const [windowId, win] of window.WindowManager.windows) {
      if (win.plugin.dirName === 'file-editor' && win.tabId === window.WindowManager.currentTabId) {
        existingWindowId = windowId;
        break;
      }
    }

    if (existingWindowId) {
      // Focus existing editor window and tell it to open the file.
      // Use setTimeout to defer focus past the originating click event,
      // which bubbles out of the shadow DOM and re-focuses the source window.
      setTimeout(() => {
        window.WindowManager.focus(existingWindowId);
      }, 0);
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('termul:editor-open-file', { detail: detail }));
      }, 100);
    } else {
      // Open a new file-editor window
      const windowId = window.WindowManager.open(editorPlugin);
      // Re-focus after the current event finishes bubbling, otherwise the
      // originating click from file-transfer steals focus back.
      setTimeout(() => {
        window.WindowManager.focus(windowId);
      }, 0);
      // Wait for plugin to mount, then dispatch the open-file event
      const waitForMount = () => {
        const instance = window.PluginLoader.instances.get(windowId);
        if (instance && instance._lifecycle && instance._lifecycle.onMount) {
          // Plugin has mounted — give it a bit more time to init Monaco
          setTimeout(() => {
            document.dispatchEvent(new CustomEvent('termul:editor-open-file', { detail: detail }));
          }, 300);
        } else {
          // Not yet mounted, retry
          setTimeout(waitForMount, 100);
        }
      };
      setTimeout(waitForMount, 100);
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
   * Tab Management
   * ═════════════════════════════════════════════════════════════════════ */

  /**
   * Add a new connection tab.
   * @param {Object} profile - Connection profile
   * @param {string} connectionId - Active SSH connection ID
   */
  addTab(profile, connectionId) {
    const tabId = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);

    const tab = {
      id: tabId,
      profile: profile,
      connectionId: connectionId,
      status: 'connected', // 'connected' | 'disconnected' | 'reconnecting'
    };

    this.tabs.push(tab);

    // Notify plugins: new connection established
    document.dispatchEvent(new CustomEvent('termul:connection-status', {
      detail: {
        status: 'connected',
        connectionId: connectionId,
        profile: profile
      }
    }));

    // Switch to the new tab (also renders tabs and updates taskbar)
    this.switchTab(tabId);

    // Update username in start menu
    this.updateStartMenuUser(profile);
  }

  /**
   * Switch to a specific tab.
   * @param {string} tabId
   */
  switchTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Hide windows from previous tab
    if (this.activeTabId && this.activeTabId !== tabId) {
      window.WindowManager.hideWindowsForTab(this.activeTabId);
    }

    // Set active tab
    this.activeTabId = tabId;

    // Update WindowManager's current tab
    window.WindowManager.currentTabId = tabId;

    // Update connection references for plugins (live getters)
    this.connectionId = tab.connectionId;
    this.currentProfile = tab.profile;

    // Show windows for this tab
    const lastFocusedId = window.WindowManager.showWindowsForTab(tabId);
    if (lastFocusedId) {
      window.WindowManager.focus(lastFocusedId);
    }

    // Update start menu username
    this.updateStartMenuUser(tab.profile);

    // Apply this profile's desktop background
    this.applyProfileBackground(tab.profile);

    // Notify dashboard widgets of tab switch so they can follow the active connection
    document.dispatchEvent(new CustomEvent('termul:tab-switched', {
      detail: {
        tabId: tabId,
        connectionId: tab.connectionId,
        status: tab.status,
        profile: tab.profile,
      }
    }));

    // Re-render tabs to update active state
    this.renderTabs();

    // Update taskbar
    this.updateTaskbar();
  }

  /**
   * Close a specific tab and disconnect its SSH connection.
   * @param {string} tabId
   */
  async closeTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Close all windows for this tab
    window.WindowManager.closeWindowsForTab(tabId);

    // Disconnect (SSH or FTP)
    try {
      const protocol = (tab.profile && tab.profile.protocol) || 'ssh';
      await window.ConnectionManager.disconnectById(tab.connectionId, protocol);
    } catch (e) {
      console.warn('[TermulOS] Error disconnecting tab:', e);
    }

    // Remove tab
    this.tabs = this.tabs.filter(t => t.id !== tabId);

    // If no tabs left, go back to connection dialog
    if (this.tabs.length === 0) {
      this.disconnectAllAndReturnToDialog();
      return;
    }

    // If we closed the active tab, switch to the last tab
    if (this.activeTabId === tabId) {
      const newActiveTab = this.tabs[this.tabs.length - 1];
      this.switchTab(newActiveTab.id);
    }

    this.renderTabs();
    this.updateTaskbar();
  }

  /**
   * Render tabs in the titlebar.
   */
  renderTabs() {
    const tabsContainer = document.getElementById('os-titlebar-tabs');
    if (!tabsContainer) return;

    // Remove existing tab items (keep the add button)
    tabsContainer.querySelectorAll('.titlebar-tab').forEach(el => el.remove());

    const addButton = tabsContainer.querySelector('.titlebar-tab-add');

    this.tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      let tabClasses = 'titlebar-tab';
      if (tab.id === this.activeTabId) tabClasses += ' active';
      if (tab.status === 'disconnected') tabClasses += ' disconnected';
      if (tab.status === 'reconnecting') tabClasses += ' reconnecting';
      tabEl.className = tabClasses;
      tabEl.dataset.tabId = tab.id;

      const dotColor = tab.status === 'disconnected' ? '#E81123'
                     : tab.status === 'reconnecting' ? '#FF8C00'
                     : (tab.profile.color || '#0078D4');
      const colorDot = `<span class="titlebar-tab-dot" style="background:${dotColor}"></span>`;

      const tabName = tab.status === 'reconnecting' ? 'Reconnecting...' : (tab.profile.name || tab.profile.host);
      const name = `<span class="titlebar-tab-name">${tabName}</span>`;
      const closeBtn = `<button class="titlebar-tab-close" data-tab-close="${tab.id}" title="Close tab">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.2"/>
          <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>`;

      tabEl.innerHTML = colorDot + name + closeBtn;

      // Click tab to switch
      tabEl.addEventListener('click', (e) => {
        if (e.target.closest('.titlebar-tab-close')) return;
        this.switchTab(tab.id);
        // If this tab is disconnected, show the dialog
        if (tab.status === 'disconnected') {
          this.showDisconnectDialog(tab, 'Connection to server was lost');
        }
      });

      // Close button
      tabEl.querySelector('.titlebar-tab-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      tabsContainer.insertBefore(tabEl, addButton);
    });
  }

  /**
   * Show a connection picker popup for adding a new tab.
   */
  async showTabConnectionPicker() {
    // Remove existing picker
    document.getElementById('tab-connection-picker')?.remove();

    const profiles = await window.ConnectionManager.getProfiles();

    const picker = document.createElement('div');
    picker.id = 'tab-connection-picker';
    picker.className = 'tab-connection-picker';
    picker.innerHTML = `
      <div class="tab-picker-header">
        <span class="tab-picker-title">Connect to Server</span>
        <button class="tab-picker-close" id="tab-picker-close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="tab-picker-body">
        <div class="tab-picker-profiles" id="tab-picker-profiles">
          ${profiles.length === 0 ? `
            <div class="tab-picker-empty">
              <p>No saved profiles</p>
              <small>Create one below</small>
            </div>
          ` : profiles.map(p => `
            <div class="tab-picker-profile" data-profile-id="${p.id}">
              <span class="tab-picker-dot" style="background:${p.color || '#0078D4'}"></span>
              <div class="tab-picker-info">
                <span class="tab-picker-name">${p.name || p.host}${p.protocol === 'ftp' ? ' <small style="opacity:0.6">(FTP)</small>' : ''}</span>
                <span class="tab-picker-host">${p.username}@${p.host}</span>
              </div>
              <button class="tab-picker-connect" data-action="connect" title="Connect">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
        <div class="tab-picker-divider"></div>
        <div class="tab-picker-quick">
          <div class="tab-picker-quick-title">Quick Connect</div>
          <div class="tab-picker-form">
            <div class="form-radio-group" style="margin-bottom:8px">
              <label class="form-radio">
                <input type="radio" name="quick-protocol" value="ssh" checked />
                <span>SSH</span>
              </label>
              <label class="form-radio">
                <input type="radio" name="quick-protocol" value="ftp" />
                <span>FTP</span>
              </label>
            </div>
            <div class="tab-picker-form-row">
              <input type="text" id="tab-quick-host" placeholder="Host (e.g. 192.168.1.100)" />
              <input type="number" id="tab-quick-port" placeholder="22" value="22" style="width:70px" />
            </div>
            <input type="text" id="tab-quick-username" placeholder="Username" />
            <input type="password" id="tab-quick-password" placeholder="Password" />
            <button class="btn btn-accent tab-picker-connect-btn" id="tab-quick-connect">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
              Connect
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(picker);

    // Close picker
    document.getElementById('tab-picker-close')?.addEventListener('click', () => {
      picker.remove();
    });

    // Click outside to close
    const clickOutsideHandler = (e) => {
      if (!picker.contains(e.target) && !e.target.closest('#titlebar-tab-add')) {
        picker.remove();
        document.removeEventListener('click', clickOutsideHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', clickOutsideHandler), 10);

    // Quick connect protocol toggle
    picker.querySelectorAll('input[name="quick-protocol"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const portInput = document.getElementById('tab-quick-port');
        if (portInput && (portInput.value === '22' || portInput.value === '21')) {
          portInput.value = e.target.value === 'ftp' ? '21' : '22';
          portInput.placeholder = e.target.value === 'ftp' ? '21' : '22';
        }
        const usernameInput = document.getElementById('tab-quick-username');
        if (usernameInput && !usernameInput.value) {
          usernameInput.placeholder = e.target.value === 'ftp' ? 'anonymous' : 'Username';
        }
      });
    });

    // Saved profile connect buttons
    picker.querySelectorAll('.tab-picker-profile').forEach(item => {
      item.addEventListener('click', async (e) => {
        if (!e.target.closest('.tab-picker-connect')) return;
        const profileId = item.dataset.profileId;
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return;
        picker.remove();
        await this.connectToNewTab(profile);
      });

      // Double-click to connect
      item.addEventListener('dblclick', async () => {
        const profileId = item.dataset.profileId;
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return;
        picker.remove();
        await this.connectToNewTab(profile);
      });
    });

    // Quick connect form
    document.getElementById('tab-quick-connect')?.addEventListener('click', async () => {
      const quickProtocol = document.querySelector('input[name="quick-protocol"]:checked')?.value || 'ssh';
      const host = document.getElementById('tab-quick-host')?.value.trim();
      const port = parseInt(document.getElementById('tab-quick-port')?.value) || (quickProtocol === 'ftp' ? 21 : 22);
      const username = document.getElementById('tab-quick-username')?.value.trim() || (quickProtocol === 'ftp' ? 'anonymous' : '');
      const password = document.getElementById('tab-quick-password')?.value || '';

      if (!host) {
        const errEl = picker.querySelector('.tab-picker-form-error');
        if (errEl) errEl.remove();
        const err = document.createElement('div');
        err.className = 'tab-picker-form-error';
        err.textContent = 'Host is required';
        picker.querySelector('.tab-picker-form').prepend(err);
        setTimeout(() => err.remove(), 3000);
        return;
      }

      const profile = {
        id: window.ConnectionManager.generateId(),
        name: host,
        host,
        port,
        username,
        authType: 'password',
        password,
        protocol: quickProtocol,
        color: window.ConnectionManager.getRandomColor(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      picker.remove();
      await this.connectToNewTab(profile);
    });
  }

  /**
   * Connect to a profile as a new tab (from desktop mode).
   * @param {Object} profile
   */
  async connectToNewTab(profile) {
    // Show a brief connecting indicator on the tab bar
    const tabsContainer = document.getElementById('os-titlebar-tabs');
    if (tabsContainer) {
      const addBtn = tabsContainer.querySelector('.titlebar-tab-add');
      const connectingTab = document.createElement('div');
      connectingTab.className = 'titlebar-tab connecting';
      connectingTab.innerHTML = `
        <span class="titlebar-tab-name">Connecting...</span>
      `;
      tabsContainer.insertBefore(connectingTab, addBtn);
    }

    try {
      const result = await window.ConnectionManager.connect(profile);
      if (result.success) {
        this.connectionId = result.connectionId;
        this.currentProfile = profile;
        // Remove the temporary connecting indicator
        tabsContainer?.querySelector('.titlebar-tab.connecting')?.remove();
        this.addTab(profile, result.connectionId);
      } else {
        tabsContainer?.querySelector('.titlebar-tab.connecting')?.remove();
        alert('Connection failed: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      tabsContainer?.querySelector('.titlebar-tab.connecting')?.remove();
      alert('Connection failed: ' + (err.error || err.message || 'Unknown error'));
    }
  }

  /**
   * Update the start menu username display.
   * @param {Object} profile
   */
  updateStartMenuUser(profile) {
    const usernameEl = document.querySelector('#start-menu-username');
    if (usernameEl) {
      usernameEl.textContent = profile?.username || 'User';
    }
  }

  /**
   * Disconnect all tabs and return to connection dialog.
   */
  async disconnectAllAndReturnToDialog() {
    if (this.taskbarLoop) {
      clearInterval(this.taskbarLoop);
    }

    // Close all windows (all tabs)
    window.WindowManager.closeAll();

    // Disconnect all connections (SSH and FTP)
    for (const tab of this.tabs) {
      try {
        const protocol = (tab.profile && tab.profile.protocol) || 'ssh';
        await window.ConnectionManager.disconnectById(tab.connectionId, protocol);
      } catch (e) {
        console.warn('[TermulOS] Error disconnecting:', e);
      }
    }
    this.tabs = [];
    this.activeTabId = null;

    // Reset connection manager state
    window.ConnectionManager.connectionId = null;
    window.ConnectionManager.currentConnection = null;

    window.Taskbar.destroy();

    // Reset desktop background to default
    this.resetDesktopBackground();

    // Destroy dashboard widgets
    if (window.DashboardWidgets) {
      window.DashboardWidgets.destroy();
    }

    this.showConnectionDialog();
  }

  /* ═════════════════════════════════════════════════════════════════════
   * Connection Status & Reconnection
   * ═════════════════════════════════════════════════════════════════════ */

  /**
   * Called when an SSH connection is lost (closed by server or error).
   * @param {string} connectionId
   * @param {string} reason - Human-readable reason
   */
  handleConnectionLost(connectionId, reason) {
    // Find the tab that owns this connection
    const tab = this.tabs.find(t => t.connectionId === connectionId);
    if (!tab) return;

    // Avoid duplicate handling
    if (tab.status === 'disconnected') return;

    tab.status = 'disconnected';

    // Notify all plugins via the event bus
    document.dispatchEvent(new CustomEvent('termul:connection-status', {
      detail: {
        status: 'disconnected',
        connectionId: connectionId,
        profile: tab.profile,
        reason: reason
      }
    }));

    // If this is the active tab, show the disconnect dialog
    if (tab.id === this.activeTabId) {
      this.showDisconnectDialog(tab, reason);
    }

    // Update UI
    this.renderTabs();
    this.updateTaskbar();
  }

  /**
   * Show a centered modal dialog indicating the connection was lost.
   * @param {Object} tab - The tab whose connection dropped
   * @param {string} reason - Reason text
   */
  showDisconnectDialog(tab, reason) {
    // Remove existing dialog if any
    document.getElementById('connection-lost-dialog')?.remove();

    const profile = tab.profile;
    const dialog = document.createElement('div');
    dialog.id = 'connection-lost-dialog';
    dialog.className = 'connection-lost-overlay';
    dialog.innerHTML = `
      <div class="connection-lost-dialog">
        <div class="connection-lost-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E81123" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </div>
        <h2 class="connection-lost-title">Connection Lost</h2>
        <p class="connection-lost-detail">${profile.name || profile.host}</p>
        <p class="connection-lost-reason">${reason}</p>
        <div class="connection-lost-actions">
          <button class="btn btn-secondary" id="conn-lost-close">Close Tab</button>
          <button class="btn btn-accent" id="conn-lost-reconnect">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Reconnect
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    // Close tab button
    dialog.querySelector('#conn-lost-close')?.addEventListener('click', () => {
      dialog.remove();
      this.closeTab(tab.id);
    });

    // Reconnect button
    dialog.querySelector('#conn-lost-reconnect')?.addEventListener('click', async () => {
      dialog.remove();
      await this.reconnectTab(tab.id);
    });
  }

  /**
   * Reconnect a disconnected tab.
   * @param {string} tabId
   */
  async reconnectTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.status = 'reconnecting';

    // Notify plugins: reconnecting
    document.dispatchEvent(new CustomEvent('termul:connection-status', {
      detail: {
        status: 'reconnecting',
        connectionId: tab.connectionId,
        profile: tab.profile
      }
    }));

    this.renderTabs();
    this.updateTaskbar();

    try {
      const result = await window.ConnectionManager.connect(tab.profile);
      if (result.success) {
        const oldConnectionId = tab.connectionId;
        tab.connectionId = result.connectionId;
        tab.status = 'connected';

        // If this is the active tab, update the live connection references
        if (tab.id === this.activeTabId) {
          this.connectionId = tab.connectionId;
          this.currentProfile = tab.profile;
        }

        // Notify plugins: reconnected
        document.dispatchEvent(new CustomEvent('termul:connection-status', {
          detail: {
            status: 'connected',
            connectionId: tab.connectionId,
            previousConnectionId: oldConnectionId,
            profile: tab.profile
          }
        }));

        this.renderTabs();
        this.updateTaskbar();
      } else {
        tab.status = 'disconnected';

        // Notify plugins: reconnection failed
        document.dispatchEvent(new CustomEvent('termul:connection-status', {
          detail: {
            status: 'disconnected',
            connectionId: tab.connectionId,
            profile: tab.profile,
            reason: result.error || 'Reconnection failed'
          }
        }));

        this.renderTabs();
        this.updateTaskbar();
        this.showDisconnectDialog(tab, result.error || 'Reconnection failed');
      }
    } catch (err) {
      tab.status = 'disconnected';

      // Notify plugins: reconnection failed
      document.dispatchEvent(new CustomEvent('termul:connection-status', {
        detail: {
          status: 'disconnected',
          connectionId: tab.connectionId,
          profile: tab.profile,
          reason: err.error || err.message || 'Reconnection failed'
        }
      }));

      this.renderTabs();
      this.updateTaskbar();
      this.showDisconnectDialog(tab, err.error || err.message || 'Reconnection failed');
    }
  }

  /**
   * Get the connection status of the active tab.
   * @returns {{ status: string, profile: Object } | null}
   */
  getActiveTabConnectionStatus() {
    if (!this.activeTabId) return null;
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) return null;
    return { status: tab.status, profile: tab.profile };
  }

  /**
   * Update taskbar items
   */
  updateTaskbar() {
    const items = window.WindowManager.getTaskbarItems();
    window.Taskbar.updateItems(items);
    // Update connection status in tray
    window.Taskbar.updateConnectionStatus(this.getActiveTabConnectionStatus());
    // Update tunnel indicator in tray
    this.updateTaskbarTunnel();
  }

  /**
   * Refresh the tunnel indicator in the taskbar with current rules.
   */
  async updateTaskbarTunnel() {
    // Only show tunnel indicator if the port-forwarder plugin is installed
    if (!window.PluginLoader || !window.PluginLoader.plugins.has('port-forwarder')) {
      window.Taskbar.updateTunnelStatus([]);
      return;
    }
    try {
      const rules = await window.termulAPI.tunnel.getRules();
      this._tunnelRules = rules || [];
      window.Taskbar.updateTunnelStatus(this._tunnelRules);
    } catch (e) {
      // Ignore — may not be available yet
    }
  }

  /**
   * Toggle a tunnel rule on/off from the taskbar popup.
   */
  async toggleTunnelFromTaskbar(ruleId, enable) {
    if (enable) {
      const connectionId = this.connectionId;
      if (!connectionId) return;
      await window.termulAPI.tunnel.start(ruleId, connectionId);
    } else {
      await window.termulAPI.tunnel.stop(ruleId);
    }
    await this.updateTaskbarTunnel();
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
   * Load Monaco Editor via the monaco:// custom protocol.
   * The loader.js is fetched, then RequireJS loads the editor module.
   * Workers use the monaco:// protocol to load from node_modules.
   */
  async loadMonaco() {
    if (this._monacoLoaded) return;
    this._monacoLoaded = true;

    try {
      const baseUrl = window.termulAPI.monaco.getBaseUrl();

      // Set up Monaco Environment for web workers
      // The editor.worker file is at vs/assets/editor.worker-*.js
      // We point to it via the monaco:// protocol
      const editorWorkerUrl = baseUrl + 'assets/editor.worker-Be8ye1pW.js';
      window.MonacoEnvironment = {
        getWorkerUrl: function (workerId, label) {
          // All worker types use the editor.worker as base
          // Monaco's worker system handles the specific language workers
          return editorWorkerUrl;
        },
        getWorker: function (workerId, label) {
          const url = window.MonacoEnvironment.getWorkerUrl(workerId, label);
          return new Worker(url);
        }
      };

      // Load Monaco's AMD loader via a script tag using the custom protocol
      await new Promise((resolve, reject) => {
        const loaderScript = document.createElement('script');
        loaderScript.src = baseUrl + 'loader.js';
        loaderScript.onload = resolve;
        loaderScript.onerror = (e) => {
          console.error('[TermulOS] Monaco loader.js failed to load from:', loaderScript.src, e);
          reject(new Error('Monaco loader failed'));
        };
        document.head.appendChild(loaderScript);
      });

      // Configure RequireJS paths to use monaco:// protocol
      window.require.config({
        paths: { 'vs': baseUrl }
      });

      // Load the main editor module via RequireJS
      await new Promise((resolve, reject) => {
        window.require(['vs/editor/editor.main'], function () {
          if (window.monaco) {
            window.PluginLoader._monacoReady = true;
            resolve();
          } else {
            reject(new Error('Monaco loaded but window.monaco is undefined'));
          }
        }, function (err) {
          console.error('[TermulOS] Monaco editor.main failed to load:', err);
          reject(err);
        });
      });

      // Fetch Monaco's static CSS (editor.main.css) and store it for shadow DOM injection.
      // Monaco loads this CSS via a <link> element in the main document's <head>,
      // but <link> styles are NOT visible inside shadow DOMs. Plugins that use Monaco
      // (e.g. file-editor) need the CSS injected as a <style> inside their shadow root.
      // The monaco:// protocol supports fetch() (supportFetchAPI: true).
      try {
        const cssResponse = await fetch(baseUrl + 'editor/editor.main.css');
        if (cssResponse.ok) {
          window.PluginLoader._monacoCSS = await cssResponse.text();
        } else {
          console.warn('[TermulOS] Failed to fetch Monaco CSS:', cssResponse.status);
        }
      } catch (cssErr) {
        console.warn('[TermulOS] Failed to fetch Monaco CSS:', cssErr);
      }

    } catch (err) {
      console.error('[TermulOS] Failed to load Monaco Editor:', err);
    }
  }

  /**
   * Disconnect and return to connection dialog (legacy — disconnects all)
   */
  async disconnectAndReturnToDialog() {
    await this.disconnectAllAndReturnToDialog();
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

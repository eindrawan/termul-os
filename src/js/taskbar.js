/**
 * Taskbar - Bottom taskbar with running apps, connection status, and start button
 */
class Taskbar {
  constructor() {
    this.element = null;
    this.startMenu = null;
    this.onStartClick = null;
    this.onAppClick = null;
    this.onReconnectClick = null;
    this.onTunnelToggle = null;
    this.onTunnelOpenPlugin = null;
    this.onLaunchApp = null;
    this.clockInterval = null;
    this._tunnelPopupVisible = false;
    this._tunnelOutsideClickHandler = null;
    this._contextMenu = null;
    this._contextOutsideClickHandler = null;
    this.pinnedApps = [];
    this.currentProfileId = null;
  }

  async init(profileId = null) {
    this.element = document.getElementById('os-taskbar');
    this.currentProfileId = profileId;
    await this.loadPinnedApps();
    this.render();
    this.startClock();
    this.setupEvents();
  }

  /**
   * Load pinned apps from settings for the current profile.
   */
  async loadPinnedApps() {
    try {
      const key = this.currentProfileId ? `taskbar:pinnedApps:${this.currentProfileId}` : 'taskbar:pinnedApps';
      const saved = await window.termulAPI.settings.get(key, null);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) {
          this.pinnedApps = arr;
        }
      } else {
        this.pinnedApps = [];
      }
    } catch (e) {
      console.warn('[Taskbar] Failed to load pinned apps:', e);
      this.pinnedApps = [];
    }
  }

  /**
   * Persist pinned apps to settings for the current profile.
   */
  async savePinnedApps() {
    try {
      const key = this.currentProfileId ? `taskbar:pinnedApps:${this.currentProfileId}` : 'taskbar:pinnedApps';
      await window.termulAPI.settings.set(key, JSON.stringify(this.pinnedApps));
    } catch (e) {
      console.warn('[Taskbar] Failed to save pinned apps:', e);
    }
  }

  /**
   * Reload settings when switching profiles.
   */
  async reloadSettings(profileId) {
    this.currentProfileId = profileId;
    this._lastTaskbarFingerprint = null; // Invalidate cache
    await this.loadPinnedApps();
  }

  /**
   * Pin an app to the taskbar.
   */
  async pinApp(dirName) {
    if (!this.pinnedApps.includes(dirName)) {
      this.pinnedApps.push(dirName);
      this._lastTaskbarFingerprint = null; // Invalidate cache
      await this.savePinnedApps();
    }
  }

  /**
   * Unpin an app from the taskbar.
   */
  async unpinApp(dirName) {
    this.pinnedApps = this.pinnedApps.filter(id => id !== dirName);
    this._lastTaskbarFingerprint = null; // Invalidate cache
    await this.savePinnedApps();
  }

  /**
   * Check if an app is pinned.
   */
  isAppPinned(dirName) {
    return this.pinnedApps.includes(dirName);
  }

  render() {
    this.element.innerHTML = `
      <div class="taskbar-start" id="taskbar-start">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 3h8.5v8.5H3V3zm9.5 0H21v8.5h-8.5V3zM3 12.5h8.5V21H3v-8.5zm9.5 0H21V21h-8.5v-8.5z"/>
        </svg>
      </div>
      <div class="taskbar-search" id="taskbar-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <span>Search</span>
      </div>
      <div class="taskbar-apps" id="taskbar-apps">
        <!-- Running app icons injected here -->
      </div>
      <div class="taskbar-tray" id="taskbar-tray">
        <div class="taskbar-connection-status" id="taskbar-connection-status">
          <!-- Connection status injected dynamically -->
        </div>
        <div class="taskbar-tunnel-indicator" id="taskbar-tunnel-indicator" style="display:none" title="Port Forwarding">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1" y="4" width="4" height="8" rx="1" fill="currentColor" opacity="0.3"/>
            <rect x="11" y="4" width="4" height="8" rx="1" fill="currentColor" opacity="0.3"/>
            <rect x="1" y="4" width="4" height="8" rx="1"/>
            <rect x="11" y="4" width="4" height="8" rx="1"/>
            <line x1="5" y1="8" x2="11" y2="8"/>
            <polyline points="9,5.5 11.5,8 9,10.5"/>
          </svg>
          <span class="tunnel-count" id="taskbar-tunnel-count">0</span>
        </div>
        <!-- Tunnel popup (positioned above tray) -->
        <div class="taskbar-tunnel-popup" id="taskbar-tunnel-popup" style="display:none">
          <div class="tunnel-popup-header">Port Forward Rules</div>
          <div class="tunnel-popup-list" id="tunnel-popup-list"></div>
          <div class="tunnel-popup-footer">
            <button class="tunnel-popup-open-btn" id="tunnel-popup-open-btn">Open Port Forwarder</button>
          </div>
        </div>
        <div class="taskbar-clock" id="taskbar-clock">
          <span class="clock-time"></span>
          <span class="clock-date"></span>
        </div>
      </div>
    `;
  }

  setupEvents() {
    document.getElementById('taskbar-start').addEventListener('click', () => {
      if (this.onStartClick) this.onStartClick();
    });

    document.getElementById('taskbar-apps').addEventListener('click', (e) => {
      const appBtn = e.target.closest('.taskbar-app-btn');
      if (appBtn) {
        // Check if it's a pinned app or running app
        if (appBtn.dataset.pinned === 'true' && this.onLaunchApp) {
          // Pinned app - launch it
          const dirName = appBtn.dataset.pinnedDirName;
          if (dirName) {
            this.onLaunchApp(dirName);
          }
        } else if (this.onAppClick) {
          // Running app - focus it
          this.onAppClick(appBtn.dataset.windowId);
        }
      }
    });

    // Right-click on taskbar apps
    document.getElementById('taskbar-apps').addEventListener('contextmenu', (e) => {
      const appBtn = e.target.closest('.taskbar-app-btn');
      if (appBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.showTaskbarContextMenu(e, appBtn);
      }
    });

    // Tunnel indicator click → toggle popup
    document.getElementById('taskbar-tunnel-indicator').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTunnelPopup();
    });

    // Popup "Open Port Forwarder" button
    document.getElementById('tunnel-popup-open-btn').addEventListener('click', () => {
      this.closeTunnelPopup();
      if (this.onTunnelOpenPlugin) this.onTunnelOpenPlugin();
    });

    // Prevent popup from closing when clicking inside it
    document.getElementById('taskbar-tunnel-popup').addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  /**
   * Show context menu for taskbar items.
   */
  showTaskbarContextMenu(e, appBtn) {
    this._closeContextMenu();

    const isPinned = appBtn.dataset.pinned === 'true';
    const dirName = appBtn.dataset.pinnedDirName || appBtn.dataset.windowPlugin;
    const windowId = appBtn.dataset.windowId;

    const menu = document.createElement('div');
    menu.className = 'taskbar-context-menu';
    menu.innerHTML = isPinned ? `
      <button class="context-item context-unpin" data-dir-name="${dirName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 17v5M9 3h6l-1 7h3l-5 7-5-7h3z"/>
        </svg>
        Unpin from Taskbar
      </button>
    ` : `
      <button class="context-item context-pin" data-dir-name="${dirName}" data-window-id="${windowId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 17v5M9 3h6l-1 7h3l-5 7-5-7h3z"/>
        </svg>
        Pin to Taskbar
      </button>
      ${dirName ? `<div class="context-separator"></div>
      <button class="context-item context-close" data-window-id="${windowId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        Close Window
      </button>` : ''}
    `;

    this._positionContextMenu(menu, e.clientX, e.clientY);
    document.body.appendChild(menu);
    this._contextMenu = menu;

    // Bind actions
    if (isPinned) {
      menu.querySelector('.context-unpin').addEventListener('click', () => {
        this.unpinApp(dirName);
        this._closeContextMenu();
        // Trigger a taskbar update
        if (this.onRefreshTaskbar) this.onRefreshTaskbar();
      });
    } else {
      menu.querySelector('.context-pin').addEventListener('click', () => {
        this.pinApp(dirName);
        this._closeContextMenu();
        // Trigger a taskbar update
        if (this.onRefreshTaskbar) this.onRefreshTaskbar();
      });

      const closeBtn = menu.querySelector('.context-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          if (windowId && window.WindowManager) {
            window.WindowManager.close(windowId);
          }
          this._closeContextMenu();
        });
      }
    }

    // Close on outside click
    this._contextOutsideClickHandler = (ev) => {
      if (!menu.contains(ev.target)) {
        this._closeContextMenu();
      }
    };
    setTimeout(() => document.addEventListener('click', this._contextOutsideClickHandler), 10);
  }

  /**
   * Position a context menu at the given coordinates.
   */
  _positionContextMenu(menu, x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      }
    });
  }

  /**
   * Close any open context menu.
   */
  _closeContextMenu() {
    if (this._contextMenu) {
      this._contextMenu.remove();
      this._contextMenu = null;
    }
    if (this._contextOutsideClickHandler) {
      document.removeEventListener('click', this._contextOutsideClickHandler);
      this._contextOutsideClickHandler = null;
    }
  }

  /**
   * Update taskbar items - combines pinned apps and running windows.
   * Uses diffing to avoid unnecessary DOM rebuilds that cause flicker.
   * @param {Array} runningItems - Items from WindowManager.getTaskbarItems()
   * @param {Array} plugins - All available plugins (for pinned app icons)
   */
  updateItems(runningItems, plugins = []) {
    const container = document.getElementById('taskbar-apps');
    if (!container) return;

    // Build a map of running window plugin IDs
    const runningPluginIds = new Set();
    runningItems.forEach(item => {
      if (item.pluginDirName) {
        runningPluginIds.add(item.pluginDirName);
      }
    });

    // Build the desired list of items (order: pinned-not-running, then running)
    const desiredItems = [];

    // Pinned apps that are not currently running
    for (const dirName of this.pinnedApps) {
      if (!runningPluginIds.has(dirName)) {
        const plugin = plugins.find(p => p.dirName === dirName);
        if (plugin) {
          desiredItems.push({
            type: 'pinned',
            dirName: dirName,
            name: plugin.name,
            icon: plugin.icon || '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
            active: false,
            minimized: false,
          });
        }
      }
    }

    // Running items
    for (const item of runningItems) {
      const isPinned = item.pluginDirName && this.pinnedApps.includes(item.pluginDirName);
      desiredItems.push({
        type: 'running',
        id: item.id,
        name: item.name,
        icon: item.icon || '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
        pluginDirName: item.pluginDirName || '',
        active: item.active,
        minimized: item.minimized,
        isPinned: isPinned,
      });
    }

    // Build a fingerprint string for quick comparison
    const newFingerprint = desiredItems.map(d => {
      if (d.type === 'pinned') return `p:${d.dirName}`;
      return `r:${d.id}:${d.active ? 'a' : ''}${d.minimized ? 'm' : ''}${d.isPinned ? 'p' : ''}`;
    }).join('|');

    // Skip rebuild if nothing changed
    if (this._lastTaskbarFingerprint === newFingerprint) return;
    this._lastTaskbarFingerprint = newFingerprint;

    // Generate HTML
    const html = desiredItems.map(item => {
      if (item.type === 'pinned') {
        return `
          <button class="taskbar-app-btn taskbar-pinned-app" data-pinned="true" data-pinned-dir-name="${item.dirName}" title="${item.name}">
            <span class="taskbar-app-icon">${item.icon}</span>
            <span class="taskbar-app-pin-indicator"></span>
          </button>
        `;
      }
      const pinnedClass = item.isPinned ? ' taskbar-pinned-running' : '';
      return `
        <button class="taskbar-app-btn${pinnedClass} ${item.active ? 'active' : ''} ${item.minimized ? 'minimized' : ''}"
                data-window-id="${item.id}" data-window-plugin="${item.pluginDirName}" title="${item.name}">
          <span class="taskbar-app-icon">${item.icon}</span>
          <span class="taskbar-app-indicator"></span>
        </button>
      `;
    }).join('');

    container.innerHTML = html;
  }

  /**
   * Update the connection status display in the tray.
   * @param {{ status: string, profile: Object } | null} connStatus
   */
  updateConnectionStatus(connStatus) {
    const container = document.getElementById('taskbar-connection-status');
    if (!container) return;

    if (!connStatus) {
      container.innerHTML = '';
      return;
    }

    const { status, profile } = connStatus;
    const host = profile ? (profile.name || profile.host) : 'Unknown';

    if (status === 'connected') {
      container.innerHTML = `
        <div class="conn-indicator conn-connected" title="Connected to ${host}">
          <span class="conn-dot"></span>
          <span class="conn-label">${host}</span>
        </div>
      `;
    } else if (status === 'disconnected') {
      container.innerHTML = `
        <div class="conn-indicator conn-disconnected" title="Disconnected from ${host}">
          <span class="conn-dot"></span>
          <span class="conn-label">Disconnected</span>
          <button class="conn-reconnect-btn" id="taskbar-reconnect-btn" title="Reconnect to ${host}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      `;
      // Bind reconnect button
      container.querySelector('#taskbar-reconnect-btn')?.addEventListener('click', () => {
        if (this.onReconnectClick) this.onReconnectClick();
      });
    } else if (status === 'reconnecting') {
      container.innerHTML = `
        <div class="conn-indicator conn-reconnecting" title="Reconnecting to ${host}...">
          <span class="conn-dot pulse"></span>
          <span class="conn-label">Reconnecting...</span>
        </div>
      `;
    }
  }

  /**
   * Update the tunnel indicator in the taskbar tray.
   * @param {Array<{id:string, name:string, localPort:number, remotePort:number, remoteHost:string, enabled:boolean}>} rules
   */
  updateTunnelStatus(rules) {
    const indicator = document.getElementById('taskbar-tunnel-indicator');
    const countEl = document.getElementById('taskbar-tunnel-count');
    if (!indicator || !countEl) return;

    if (!rules || rules.length === 0) {
      indicator.style.display = 'none';
      this.closeTunnelPopup();
      return;
    }

    indicator.style.display = '';

    const activeCount = rules.filter(r => r.enabled).length;
    countEl.textContent = activeCount;

    if (activeCount > 0) {
      indicator.classList.add('has-active');
    } else {
      indicator.classList.remove('has-active');
    }

    // Update popup list content
    this._updateTunnelPopup(rules);
  }

  _updateTunnelPopup(rules) {
    const listEl = document.getElementById('tunnel-popup-list');
    if (!listEl) return;

    if (rules.length === 0) {
      listEl.innerHTML = '<div class="tunnel-popup-empty">No rules configured</div>';
      return;
    }

    listEl.innerHTML = rules.map(rule => {
      const remoteHost = rule.remoteHost || 'localhost';
      return `<div class="tunnel-popup-rule" data-rule-id="${rule.id}">
        <div class="tunnel-popup-rule-info">
          <div class="tunnel-popup-rule-name">${this._escapeHtml(rule.name)}</div>
          <div class="tunnel-popup-rule-ports">:${rule.localPort} → ${this._escapeHtml(remoteHost)}:${rule.remotePort}</div>
        </div>
        <button class="tui-toggle ${rule.enabled ? 'active' : ''}" data-tunnel-toggle="${rule.id}" role="switch" aria-checked="${rule.enabled}"></button>
      </div>`;
    }).join('');

    // Bind toggle buttons
    listEl.querySelectorAll('[data-tunnel-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ruleId = btn.dataset.tunnelToggle;
        const isActive = btn.classList.contains('active');
        if (this.onTunnelToggle) {
          this.onTunnelToggle(ruleId, !isActive);
        }
      });
    });
  }

  toggleTunnelPopup() {
    if (this._tunnelPopupVisible) {
      this.closeTunnelPopup();
    } else {
      this.openTunnelPopup();
    }
  }

  openTunnelPopup() {
    const popup = document.getElementById('taskbar-tunnel-popup');
    if (!popup) return;

    popup.style.display = '';
    this._tunnelPopupVisible = true;

    // Close on outside click
    this._tunnelOutsideClickHandler = (e) => {
      if (!popup.contains(e.target)) {
        this.closeTunnelPopup();
      }
    };
    setTimeout(() => document.addEventListener('click', this._tunnelOutsideClickHandler), 0);
  }

  closeTunnelPopup() {
    const popup = document.getElementById('taskbar-tunnel-popup');
    if (popup) popup.style.display = 'none';

    this._tunnelPopupVisible = false;

    if (this._tunnelOutsideClickHandler) {
      document.removeEventListener('click', this._tunnelOutsideClickHandler);
      this._tunnelOutsideClickHandler = null;
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text || ''));
    return div.innerHTML;
  }

  startClock() {
    const update = () => {
      const now = new Date();
      const timeEl = this.element?.querySelector('.clock-time');
      const dateEl = this.element?.querySelector('.clock-date');
      if (timeEl) {
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }
    };
    update();
    this.clockInterval = setInterval(update, 1000);
  }

  destroy() {
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
    }
  }
}

// Export as singleton
window.Taskbar = new Taskbar();

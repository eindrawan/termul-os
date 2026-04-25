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
    this.clockInterval = null;
    this._tunnelPopupVisible = false;
    this._tunnelOutsideClickHandler = null;
  }

  init() {
    this.element = document.getElementById('os-taskbar');
    this.render();
    this.startClock();
    this.setupEvents();
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
      if (appBtn && this.onAppClick) {
        this.onAppClick(appBtn.dataset.windowId);
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
   * Update taskbar items from the window manager
   */
  updateItems(items) {
    const container = document.getElementById('taskbar-apps');
    if (!container) return;

    container.innerHTML = items.map(item => `
      <button class="taskbar-app-btn ${item.active ? 'active' : ''} ${item.minimized ? 'minimized' : ''}"
              data-window-id="${item.id}" title="${item.name}">
        <span class="taskbar-app-icon">${item.icon || '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>'}</span>
        <span class="taskbar-app-indicator"></span>
      </button>
    `).join('');
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

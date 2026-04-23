/**
 * Window Manager — Handles creating, positioning, and managing app windows.
 * Integrates with PluginInstance for lifecycle management and Shadow DOM isolation.
 */
class WindowManager {
  constructor() {
    this.windows = new Map();
    this.activeWindowId = null;
    this.zIndex = 100;
    this.container = null;
    this.onWindowOpen = null;
    this.onWindowClose = null;
    this.onWindowFocus = null;
  }

  init(containerElement) {
    this.container = containerElement;
    this.setupDragHandlers();
  }

  /* ─── Open ───────────────────────────────────────────────────────── */

  /**
   * Open a new app window for a plugin.
   * @param {Object} plugin - Plugin manifest
   * @param {Object} options - Optional overrides { width, height }
   * @returns {string} windowId
   */
  open(plugin, options = {}) {
    const windowId = 'win_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    const width = options.width || plugin.window?.width || 800;
    const height = options.height || plugin.window?.height || 550;

    // Calculate center position with staggered offset
    const containerRect = this.container.getBoundingClientRect();
    const offset = this.windows.size * 30;
    const x = Math.max(50, (containerRect.width - width) / 2 + offset);
    const y = Math.max(20, (containerRect.height - height) / 2 + offset - 30);

    const win = {
      id: windowId,
      plugin,
      x, y, width, height,
      minimized: false,
      maximized: false,
      zIndex: ++this.zIndex,
      instance: null, // PluginInstance will be set after mount
    };

    this.windows.set(windowId, win);

    // Create DOM
    const el = this.createWindowElement(win);
    this.container.appendChild(el);

    // Mount plugin into the window body
    this.mountPlugin(windowId, plugin);

    // Focus
    this.focus(windowId);

    if (this.onWindowOpen) this.onWindowOpen(windowId, plugin);
    return windowId;
  }

  /* ─── DOM Creation ───────────────────────────────────────────────── */

  createWindowElement(win) {
    const el = document.createElement('div');
    el.id = win.id;
    el.className = 'os-window';
    el.style.left = win.x + 'px';
    el.style.top = win.y + 'px';
    el.style.width = win.width + 'px';
    el.style.height = win.height + 'px';
    el.style.zIndex = win.zIndex;

    const iconSvg = win.plugin.icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>`;

    el.innerHTML = `
      <div class="os-window-titlebar" data-window-id="${win.id}">
        <div class="os-window-titlebar-left">
          <div class="os-window-icon">${iconSvg}</div>
          <span class="os-window-title">${win.plugin.name || 'App'}</span>
        </div>
        <div class="os-window-controls">
          <button class="os-window-btn os-window-btn-minimize" data-action="minimize" title="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
          <button class="os-window-btn os-window-btn-maximize" data-action="maximize" title="Maximize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
          <button class="os-window-btn os-window-btn-close" data-action="close" title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </div>
      </div>
      <div class="os-window-body" id="${win.id}-body">
        <div class="os-window-loading">
          <div class="os-spinner"></div>
          <span>Loading...</span>
        </div>
      </div>
      <div class="os-window-resize-handle"></div>
    `;

    return el;
  }

  /* ─── Plugin Mounting ────────────────────────────────────────────── */

  async mountPlugin(windowId, plugin) {
    const body = document.getElementById(windowId + '-body');
    if (!body) return;

    try {
      // Batch-load all plugin files in one IPC call
      const files = await window.PluginLoader.loadPluginFiles(plugin.dirName);

      if (files.error) {
        body.innerHTML = `<div class="os-window-error"><p>Failed to load plugin</p><small>${files.error}</small></div>`;
        return;
      }

      // Clear loading indicator
      body.innerHTML = '';

      // Create a host element for the plugin's shadow DOM
      const host = document.createElement('div');
      host.className = 'plugin-host';
      host.style.cssText = 'width:100%;height:100%;overflow:auto;';
      body.appendChild(host);

      // Create the PluginInstance
      const instance = new PluginInstance(windowId, plugin, host);

      // Create scoped API for this instance
      const pluginAPI = window.PluginLoader.createPluginAPI(plugin.dirName, windowId);

      // Mount (creates shadow DOM, injects CSS/HTML, executes JS)
      instance.mount(files, pluginAPI);

      // Store references
      const win = this.windows.get(windowId);
      if (win) win.instance = instance;
      window.PluginLoader.registerInstance(windowId, instance);

    } catch (err) {
      body.innerHTML = `<div class="os-window-error">
        <p>Failed to load plugin</p>
        <small>${err.message}</small>
      </div>`;
    }
  }

  /* ─── Focus ──────────────────────────────────────────────────────── */

  focus(windowId) {
    const win = this.windows.get(windowId);
    if (!win) return;

    // Blur the previously focused window's plugin
    if (this.activeWindowId && this.activeWindowId !== windowId) {
      const prevWin = this.windows.get(this.activeWindowId);
      if (prevWin?.instance) {
        prevWin.instance.blur();
      }
    }

    // Remove active from all windows
    this.windows.forEach((w, id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    win.zIndex = ++this.zIndex;
    const el = document.getElementById(windowId);
    if (el) {
      el.style.zIndex = win.zIndex;
      el.classList.add('active');
    }
    this.activeWindowId = windowId;

    // Notify plugin of focus
    if (win.instance) {
      win.instance.focus();
    }

    if (this.onWindowFocus) this.onWindowFocus(windowId);
  }

  /* ─── Minimize ───────────────────────────────────────────────────── */

  minimize(windowId) {
    const win = this.windows.get(windowId);
    if (!win) return;

    win.minimized = !win.minimized;
    const el = document.getElementById(windowId);
    if (el) {
      if (win.minimized) {
        el.classList.add('minimized');
      } else {
        el.classList.remove('minimized');
        this.focus(windowId);
      }
    }
  }

  /* ─── Maximize / Restore ─────────────────────────────────────────── */

  maximize(windowId) {
    const win = this.windows.get(windowId);
    if (!win) return;

    const el = document.getElementById(windowId);
    if (!el) return;

    if (win.maximized) {
      // Restore
      el.classList.remove('maximized');
      el.style.left = win.prevX + 'px';
      el.style.top = win.prevY + 'px';
      el.style.width = win.prevWidth + 'px';
      el.style.height = win.prevHeight + 'px';
      win.x = win.prevX;
      win.y = win.prevY;
      win.width = win.prevWidth;
      win.height = win.prevHeight;
      win.maximized = false;
    } else {
      // Save current position
      win.prevX = win.x;
      win.prevY = win.y;
      win.prevWidth = win.width;
      win.prevHeight = win.height;
      el.classList.add('maximized');
      win.maximized = true;
    }
  }

  /* ─── Close ──────────────────────────────────────────────────────── */

  close(windowId) {
    const win = this.windows.get(windowId);
    if (!win) return;

    // Unmount the plugin FIRST (cleanup timers, listeners, etc.)
    if (win.instance) {
      win.instance.unmount();
      window.PluginLoader.unregisterInstance(windowId);
    }

    const el = document.getElementById(windowId);
    if (el) {
      el.classList.add('closing');
      setTimeout(() => {
        el.remove();
        this.windows.delete(windowId);
        if (this.onWindowClose) this.onWindowClose(windowId);
        if (this.activeWindowId === windowId) {
          this.activeWindowId = null;
        }
      }, 200);
    } else {
      this.windows.delete(windowId);
      if (this.onWindowClose) this.onWindowClose(windowId);
      if (this.activeWindowId === windowId) {
        this.activeWindowId = null;
      }
    }
  }

  /* ─── Drag & Resize Handlers ─────────────────────────────────────── */

  setupDragHandlers() {
    let isDragging = false;
    let dragWindowId = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // Drag start
    this.container.addEventListener('mousedown', (e) => {
      const titlebar = e.target.closest('.os-window-titlebar');
      if (!titlebar) return;
      if (e.target.closest('.os-window-controls')) return;

      const windowId = titlebar.dataset.windowId;
      const win = this.windows.get(windowId);
      if (!win || win.maximized) return;

      isDragging = true;
      dragWindowId = windowId;
      const el = document.getElementById(windowId);
      const rect = el.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;

      this.focus(windowId);
      e.preventDefault();
    });

    // Drag move
    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !dragWindowId) return;

      const win = this.windows.get(dragWindowId);
      const el = document.getElementById(dragWindowId);
      if (!el || !win) return;

      const containerRect = this.container.getBoundingClientRect();
      let x = e.clientX - containerRect.left - dragOffsetX;
      let y = e.clientY - containerRect.top - dragOffsetY;

      x = Math.max(-win.width + 100, Math.min(containerRect.width - 100, x));
      y = Math.max(0, Math.min(containerRect.height - 40, y));

      win.x = x;
      win.y = y;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });

    // Drag end
    document.addEventListener('mouseup', () => {
      isDragging = false;
      dragWindowId = null;
    });

    // Window button clicks
    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('.os-window-btn');
      if (!btn) {
        const windowEl = e.target.closest('.os-window');
        if (windowEl) this.focus(windowEl.id);
        return;
      }

      const action = btn.dataset.action;
      const windowEl = btn.closest('.os-window');
      if (!windowEl) return;

      switch (action) {
        case 'minimize': this.minimize(windowEl.id); break;
        case 'maximize': this.maximize(windowEl.id); break;
        case 'close':    this.close(windowEl.id); break;
      }
    });

    // Resize
    let isResizing = false;
    let resizeWindowId = null;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let resizeStartW = 0;
    let resizeStartH = 0;

    this.container.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.os-window-resize-handle');
      if (!handle) return;

      const windowEl = handle.closest('.os-window');
      if (!windowEl) return;

      isResizing = true;
      resizeWindowId = windowEl.id;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      const win = this.windows.get(resizeWindowId);
      resizeStartW = win.width;
      resizeStartH = win.height;

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing || !resizeWindowId) return;
      const win = this.windows.get(resizeWindowId);
      const el = document.getElementById(resizeWindowId);
      if (!el || !win) return;

      const newW = Math.max(400, resizeStartW + (e.clientX - resizeStartX));
      const newH = Math.max(300, resizeStartH + (e.clientY - resizeStartY));
      win.width = newW;
      win.height = newH;
      el.style.width = newW + 'px';
      el.style.height = newH + 'px';
    });

    document.addEventListener('mouseup', () => {
      isResizing = false;
      resizeWindowId = null;
    });

    // Double-click titlebar to maximize
    this.container.addEventListener('dblclick', (e) => {
      const titlebar = e.target.closest('.os-window-titlebar');
      if (!titlebar) return;
      if (e.target.closest('.os-window-controls')) return;
      const windowId = titlebar.dataset.windowId;
      this.maximize(windowId);
    });
  }

  /* ─── Taskbar Items ──────────────────────────────────────────────── */

  getTaskbarItems() {
    const items = [];
    this.windows.forEach((win, id) => {
      items.push({
        id: id,
        name: win.plugin.name,
        icon: win.plugin.icon,
        minimized: win.minimized,
        active: this.activeWindowId === id
      });
    });
    return items;
  }

  /**
   * Close all windows immediately (used during disconnect).
   * Performs synchronous cleanup — no animation delays.
   */
  closeAll() {
    const ids = Array.from(this.windows.keys());
    for (const id of ids) {
      const win = this.windows.get(id);
      if (!win) continue;

      // Unmount plugin (cleanup timers, listeners, DOM)
      if (win.instance) {
        win.instance.unmount();
        window.PluginLoader.unregisterInstance(id);
      }

      // Remove DOM immediately
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    this.windows.clear();
    this.activeWindowId = null;
  }
}

// Export as singleton
window.WindowManager = new WindowManager();

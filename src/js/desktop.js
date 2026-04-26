/**
 * Desktop - Main desktop environment with wallpaper, icons, etc.
 */
class Desktop {
  constructor() {
    this.element = null;
    this.plugins = [];
    this.onAppLaunch = null;
    this.onPinToTaskbar = null;
    this.hiddenIcons = new Set();
    this._contextMenu = null;
    this._contextOutsideClickHandler = null;
    this.currentProfileId = null;
  }

  async init(profileId = null) {
    this.element = document.getElementById('os-desktop');
    this.currentProfileId = profileId;
    await this.loadHiddenIcons();
    this.setupEvents();
  }

  /**
   * Load hidden desktop icons from settings for the current profile.
   */
  async loadHiddenIcons() {
    try {
      const key = this.currentProfileId ? `desktop:hiddenIcons:${this.currentProfileId}` : 'desktop:hiddenIcons';
      const saved = await window.termulAPI.settings.get(key, null);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) {
          this.hiddenIcons = new Set(arr);
        }
      } else {
        this.hiddenIcons.clear();
      }
    } catch (e) {
      console.warn('[Desktop] Failed to load hidden icons:', e);
      this.hiddenIcons.clear();
    }
  }

  /**
   * Persist hidden desktop icons to settings for the current profile.
   */
  async saveHiddenIcons() {
    try {
      const key = this.currentProfileId ? `desktop:hiddenIcons:${this.currentProfileId}` : 'desktop:hiddenIcons';
      await window.termulAPI.settings.set(key, JSON.stringify([...this.hiddenIcons]));
    } catch (e) {
      console.warn('[Desktop] Failed to save hidden icons:', e);
    }
  }

  /**
   * Reload settings when switching profiles.
   */
  async reloadSettings(profileId) {
    this.currentProfileId = profileId;
    await this.loadHiddenIcons();
    this.renderIcons();
  }

  setPlugins(plugins) {
    this.plugins = plugins;
    this.renderIcons();
  }

  setupEvents() {
    // Double-click on desktop background
    this.element?.addEventListener('dblclick', (e) => {
      if (e.target === this.element || e.target.id === 'desktop-icons') {
        // Could trigger a "desktop settings" or nothing
      }
    });

    // Right-click on desktop background
    this.element?.addEventListener('contextmenu', (e) => {
      if (e.target === this.element || e.target.id === 'desktop-icons') {
        e.preventDefault();
        this.showDesktopContextMenu(e);
      }
    });
  }

  /**
   * Render desktop icons, filtering out hidden ones.
   */
  renderIcons() {
    const iconContainer = document.getElementById('desktop-icons');
    if (!iconContainer) return;

    const visiblePlugins = this.plugins.filter(p => !this.hiddenIcons.has(p.dirName));

    iconContainer.innerHTML = visiblePlugins.map(plugin => {
      const iconSvg = plugin.icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`;
      return `
        <div class="desktop-icon" data-plugin="${plugin.dirName}" title="${plugin.name}">
          <div class="desktop-icon-image">${iconSvg}</div>
          <span class="desktop-icon-label">${plugin.name}</span>
        </div>
      `;
    }).join('');

    // Bind double-click to launch
    iconContainer.querySelectorAll('.desktop-icon').forEach(icon => {
      icon.addEventListener('dblclick', () => {
        const dirName = icon.dataset.plugin;
        const plugin = this.plugins.find(p => p.dirName === dirName);
        if (plugin && this.onAppLaunch) {
          this.onAppLaunch(plugin);
        }
      });

      // Right-click context menu on icons
      icon.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showIconContextMenu(e, icon.dataset.plugin);
      });
    });
  }

  /**
   * Show context menu for a desktop icon.
   */
  showIconContextMenu(e, dirName) {
    this._closeContextMenu();

    const plugin = this.plugins.find(p => p.dirName === dirName);
    if (!plugin) return;

    const menu = document.createElement('div');
    menu.className = 'desktop-context-menu';
    menu.innerHTML = `
      <button class="context-item context-open" data-plugin="${dirName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
        Open
      </button>
      <button class="context-item context-pin" data-plugin="${dirName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 17v5M9 3h6l-1 7h3l-5 7-5-7h3z"/>
        </svg>
        Pin to Taskbar
      </button>
      <div class="context-separator"></div>
      <button class="context-item context-remove" data-plugin="${dirName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        Remove from Desktop
      </button>
    `;

    this._positionContextMenu(menu, e.clientX, e.clientY);
    document.body.appendChild(menu);
    this._contextMenu = menu;

    // Bind actions
    menu.querySelector('.context-open').addEventListener('click', () => {
      if (plugin && this.onAppLaunch) this.onAppLaunch(plugin);
      this._closeContextMenu();
    });

    menu.querySelector('.context-pin').addEventListener('click', () => {
      if (this.onPinToTaskbar) this.onPinToTaskbar(plugin);
      this._closeContextMenu();
    });

    menu.querySelector('.context-remove').addEventListener('click', () => {
      this.removeIconFromDesktop(dirName);
      this._closeContextMenu();
    });

    // Close on outside click
    this._contextOutsideClickHandler = (ev) => {
      if (!menu.contains(ev.target)) {
        this._closeContextMenu();
      }
    };
    setTimeout(() => document.addEventListener('click', this._contextOutsideClickHandler), 10);
  }

  /**
   * Show context menu for desktop background.
   */
  showDesktopContextMenu(e) {
    this._closeContextMenu();

    const hasHidden = this.hiddenIcons.size > 0;

    const menu = document.createElement('div');
    menu.className = 'desktop-context-menu';
    menu.innerHTML = hasHidden ? `
      <button class="context-item context-restore">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
        Restore All Icons
      </button>
    ` : '';

    // Only show if there's something to display
    if (!menu.innerHTML.trim()) {
      return;
    }

    this._positionContextMenu(menu, e.clientX, e.clientY);
    document.body.appendChild(menu);
    this._contextMenu = menu;

    if (hasHidden) {
      menu.querySelector('.context-restore').addEventListener('click', () => {
        this.restoreAllIcons();
        this._closeContextMenu();
      });
    }

    this._contextOutsideClickHandler = (ev) => {
      if (!menu.contains(ev.target)) {
        this._closeContextMenu();
      }
    };
    setTimeout(() => document.addEventListener('click', this._contextOutsideClickHandler), 10);
  }

  /**
   * Remove an icon from the desktop.
   */
  async removeIconFromDesktop(dirName) {
    this.hiddenIcons.add(dirName);
    await this.saveHiddenIcons();
    this.renderIcons();
  }

  /**
   * Restore all hidden icons to the desktop.
   */
  async restoreAllIcons() {
    this.hiddenIcons.clear();
    await this.saveHiddenIcons();
    this.renderIcons();
  }

  /**
   * Show the desktop (minimize all windows)
   */
  showDesktop() {
    if (window.WindowManager) {
      window.WindowManager.windows.forEach((win, id) => {
        if (!win.minimized) {
          window.WindowManager.minimize(id);
        }
      });
    }
  }

  /**
   * Position a context menu at the given coordinates, adjusting for viewport bounds.
   */
  _positionContextMenu(menu, x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    // The menu will be repositioned after appending if it overflows
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
}

// Export as singleton
window.Desktop = new Desktop();

/**
 * Start Menu - App launcher menu
 */
class StartMenu {
  constructor() {
    this.element = null;
    this.isOpen = false;
    this.plugins = [];
    this.onAppLaunch = null;
    this.onAppUninstall = null;
    this.onClose = null;
  }

  init() {
    this.element = document.getElementById('os-start-menu');
    this.setupEvents();
  }

  setupEvents() {
    // Close on click outside
    document.addEventListener('click', (e) => {
      if (this.isOpen && !e.target.closest('#os-start-menu') && !e.target.closest('#taskbar-start')) {
        this.close();
      }
    });
  }

  /**
   * Load and display plugins in the menu
   */
  setPlugins(plugins) {
    this.plugins = plugins;
  }

  /**
   * Open the start menu
   */
  open() {
    if (!this.element) return;
    this.isOpen = true;
    this.render();
    this.element.classList.add('open');
  }

  /**
   * Close the start menu
   */
  close() {
    if (!this.element) return;
    this.isOpen = false;
    this.element.classList.remove('open');
    if (this.onClose) this.onClose();
  }

  /**
   * Toggle the start menu
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  render() {
    const pinnedApps = this.plugins.filter(p => !p.system);
    const systemApps = this.plugins.filter(p => p.system);

    this.element.innerHTML = `
      <div class="start-menu-header">
        <div class="start-menu-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input type="text" placeholder="Search apps..." id="start-menu-search-input" />
        </div>
      </div>
      <div class="start-menu-section">
        <div class="start-menu-section-title">
          <span>Pinned</span>
        </div>
        <div class="start-menu-grid" id="start-menu-pinned">
          ${pinnedApps.map(plugin => this.renderAppTile(plugin)).join('')}
        </div>
      </div>
      ${systemApps.length > 0 ? `
      <div class="start-menu-section">
        <div class="start-menu-section-title">
          <span>System</span>
        </div>
        <div class="start-menu-grid" id="start-menu-system">
          ${systemApps.map(plugin => this.renderAppTile(plugin)).join('')}
        </div>
      </div>
      ` : ''}
      <div class="start-menu-footer">
        <div class="start-menu-user">
          <div class="start-menu-user-avatar">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <span id="start-menu-username">User</span>
        </div>
        <button class="start-menu-power" id="start-menu-power" title="Disconnect">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>
          </svg>
        </button>
      </div>
    `;

    // Bind events
    this.element.querySelectorAll('.start-menu-app-tile').forEach(tile => {
      tile.addEventListener('click', (e) => {
        const dirName = tile.dataset.plugin;
        const plugin = this.plugins.find(p => p.dirName === dirName);
        if (plugin && this.onAppLaunch) {
          this.onAppLaunch(plugin);
          this.close();
        }
      });

      // Right-click for uninstall
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const dirName = tile.dataset.plugin;
        const plugin = this.plugins.find(p => p.dirName === dirName);
        if (plugin && plugin.system) return; // Can't uninstall system apps
        this.showContextMenu(e, tile.dataset.plugin);
      });
    });

    // Power button
    const powerBtn = document.getElementById('start-menu-power');
    if (powerBtn) {
      powerBtn.addEventListener('click', () => {
        if (this.onClose) this.onClose('power');
      });
    }

    // Search
    const searchInput = document.getElementById('start-menu-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.filterApps(e.target.value.toLowerCase());
      });
      setTimeout(() => searchInput.focus(), 100);
    }
  }

  renderAppTile(plugin) {
    const iconSvg = plugin.icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`;
    return `
      <div class="start-menu-app-tile" data-plugin="${plugin.dirName}" title="${plugin.name}">
        <div class="app-tile-icon">${iconSvg}</div>
        <span class="app-tile-name">${plugin.name}</span>
      </div>
    `;
  }

  filterApps(query) {
    const tiles = this.element.querySelectorAll('.start-menu-app-tile');
    tiles.forEach(tile => {
      const name = tile.querySelector('.app-tile-name').textContent.toLowerCase();
      tile.style.display = name.includes(query) ? '' : 'none';
    });
  }

  showContextMenu(e, dirName) {
    // Remove existing context menus
    document.querySelectorAll('.start-menu-context').forEach(el => el.remove());

    const menu = document.createElement('div');
    menu.className = 'start-menu-context';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = `
      <button class="context-item context-uninstall" data-plugin="${dirName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        Uninstall
      </button>
    `;

    document.body.appendChild(menu);

    menu.querySelector('.context-uninstall').addEventListener('click', () => {
      if (this.onAppUninstall) {
        this.onAppUninstall(dirName);
      }
      menu.remove();
      this.render(); // Re-render the menu
    });

    // Close on click outside
    const closeHandler = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
  }
}

// Export as singleton
window.StartMenu = new StartMenu();

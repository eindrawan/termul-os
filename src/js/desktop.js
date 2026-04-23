/**
 * Desktop - Main desktop environment with wallpaper, icons, etc.
 */
class Desktop {
  constructor() {
    this.element = null;
    this.plugins = [];
    this.onAppLaunch = null;
  }

  init() {
    this.element = document.getElementById('os-desktop');
    this.setupEvents();
  }

  setPlugins(plugins) {
    this.plugins = plugins;
    this.renderIcons();
  }

  setupEvents() {
    // Double-click on desktop to deselect
    this.element?.addEventListener('dblclick', (e) => {
      if (e.target === this.element) {
        // Could trigger a "desktop settings" or nothing
      }
    });
  }

  renderIcons() {
    const iconContainer = document.getElementById('desktop-icons');
    if (!iconContainer) return;

    iconContainer.innerHTML = this.plugins.map(plugin => {
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
    });
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
}

// Export as singleton
window.Desktop = new Desktop();

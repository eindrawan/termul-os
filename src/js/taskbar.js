/**
 * Taskbar - Bottom taskbar with running apps, system tray, and start button
 */
class Taskbar {
  constructor() {
    this.element = null;
    this.startMenu = null;
    this.onStartClick = null;
    this.onAppClick = null;
    this.clockInterval = null;
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
        <div class="taskbar-tray-icons">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
          </svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="1" y="6" width="22" height="12" rx="2"/><path d="M23 13v-2"/>
          </svg>
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

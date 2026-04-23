// Settings Plugin — System Settings (v2 lifecycle API)
(function() {
  const api = PLUGIN_API;

  // Elements
  let titleEl, contentEl;
  let currentSection = 'general';

  PLUGIN_LIFECYCLE.onMount(function() {
    titleEl = shadow.getElementById('settings-title');
    contentEl = shadow.getElementById('settings-content');

    if (!titleEl || !contentEl) return;

    // Navigation
    shadow.querySelectorAll('.settings-nav-item').forEach(item => {
      addEventListener(item, 'click', () => {
        showSection(item.dataset.section);
      });
    });

    showSection('general');
  });

  // ─── Section Templates ─────────────────────────────────────────────

  const sections = {
    general: `
      <div class="tui-section">
        <div class="tui-section-title">Behavior</div>
        <div class="tui-settings-item">
          <div class="tui-settings-item-info">
            <div class="tui-settings-item-label">Auto-connect on startup</div>
            <div class="tui-settings-item-desc">Connect to the last used profile automatically</div>
          </div>
          <div class="tui-settings-item-control">
            <div class="tui-toggle" data-setting="autoConnect"></div>
          </div>
        </div>
        <div class="tui-settings-item">
          <div class="tui-settings-item-info">
            <div class="tui-settings-item-label">Keep connection alive</div>
            <div class="tui-settings-item-desc">Send keep-alive packets to prevent timeouts</div>
          </div>
          <div class="tui-settings-item-control">
            <div class="tui-toggle active" data-setting="keepAlive"></div>
          </div>
        </div>
      </div>
      <div class="tui-section">
        <div class="tui-section-title">Data</div>
        <div class="tui-settings-item">
          <div class="tui-settings-item-info">
            <div class="tui-settings-item-label">Clear saved profiles</div>
            <div class="tui-settings-item-desc">Remove all saved connection profiles</div>
          </div>
          <div class="tui-settings-item-control">
            <button class="tui-btn tui-btn-danger" id="clear-profiles">Clear</button>
          </div>
        </div>
      </div>
    `,
    appearance: `
      <div class="tui-section">
        <div class="tui-section-title">Theme</div>
        <div class="tui-settings-item">
          <div class="tui-settings-item-info">
            <div class="tui-settings-item-label">Accent Color</div>
            <div class="tui-settings-item-desc">Choose your preferred accent color</div>
          </div>
          <div class="tui-settings-item-control">
            <select class="tui-select" id="accent-color">
              <option value="#0067C0">Blue</option>
              <option value="#60CDFF">Cyan</option>
              <option value="#7A7574">Gray</option>
              <option value="#E81123">Red</option>
              <option value="#0078D4">Windows Blue</option>
              <option value="#8E562E">Brown</option>
            </select>
          </div>
        </div>
        <div class="tui-settings-item">
          <div class="tui-settings-item-info">
            <div class="tui-settings-item-label">Blur effect</div>
            <div class="tui-settings-item-desc">Adjust the glassmorphism blur intensity</div>
          </div>
          <div class="tui-settings-item-control">
            <select class="tui-select" id="blur-intensity">
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
      </div>
    `,
    plugins: `
      <div class="tui-section">
        <div class="tui-section-title">Installed Plugins</div>
        <div id="plugin-list"></div>
      </div>
    `,
    about: `
      <div style="padding: 40px 20px; text-align: center;">
        <div class="about-logo">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h8.5v8.5H3V3zm9.5 0H21v8.5h-8.5V3zM3 12.5h8.5V21H3v-8.5zm9.5 0H21V21h-8.5v-8.5z"/>
          </svg>
        </div>
        <h2 class="about-title">TermulOS</h2>
        <p class="about-version">Version 1.0.0</p>
        <div class="about-info">
          <div class="about-info-row">
            <span class="about-info-label">Electron</span>
            <span class="about-info-value">28.0</span>
          </div>
          <div class="about-info-row">
            <span class="about-info-label">Platform</span>
            <span class="about-info-value">${api.platform || 'Unknown'}</span>
          </div>
          <div class="about-info-row">
            <span class="about-info-label">Node</span>
            <span class="about-info-value">18.x</span>
          </div>
          <div class="about-info-row">
            <span class="about-info-label">License</span>
            <span class="about-info-value">MIT</span>
          </div>
        </div>
      </div>
    `
  };

  function showSection(section) {
    currentSection = section;

    shadow.querySelectorAll('.settings-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === section);
    });

    titleEl.textContent = section.charAt(0).toUpperCase() + section.slice(1);
    contentEl.innerHTML = sections[section] || '<p>Section not found</p>';
    initSectionHandlers(section);
  }

  function initSectionHandlers(section) {
    switch (section) {
      case 'general':  initGeneralSection(); break;
      case 'appearance': initAppearanceSection(); break;
      case 'plugins':  initPluginsSection(); break;
    }
  }

  function initGeneralSection() {
    contentEl.querySelectorAll('.tui-toggle').forEach(toggle => {
      addEventListener(toggle, 'click', () => {
        toggle.classList.toggle('active');
      });
    });

    const clearBtn = shadow.getElementById('clear-profiles');
    if (clearBtn) {
      addEventListener(clearBtn, 'click', async () => {
        if (confirm('Are you sure you want to clear all saved profiles?')) {
          try {
            const profiles = await window.termulAPI.profiles.getAll();
            for (const profile of profiles) {
              await window.termulAPI.profiles.delete(profile.id);
            }
            alert('All profiles cleared');
          } catch (err) {
            alert('Failed to clear profiles: ' + err.message);
          }
        }
      });
    }
  }

  function initAppearanceSection() {
    const accentSelect = shadow.getElementById('accent-color');
    if (accentSelect) {
      addEventListener(accentSelect, 'change', (e) => {
        const color = e.target.value;
        document.documentElement.style.setProperty('--accent-primary', color);
        document.documentElement.style.setProperty('--accent-hover', adjustColor(color, -20));
      });
    }
  }

  async function initPluginsSection() {
    const pluginListEl = shadow.getElementById('plugin-list');
    if (!pluginListEl) return;

    const plugins = window.PluginLoader.getAll();

    if (plugins.length === 0) {
      pluginListEl.innerHTML = '';
      const empty = api.ui.emptyState({
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
        text: 'No plugins installed'
      });
      pluginListEl.appendChild(empty);
      return;
    }

    pluginListEl.innerHTML = plugins.map(plugin => {
      const iconSvg = plugin.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>';
      return `
        <div class="tui-card" style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
          <div class="tui-card-icon" style="width:48px;height:48px;border-radius:8px;">
            ${iconSvg}
          </div>
          <div class="tui-flex-1" style="min-width:0">
            <div class="tui-settings-item-label" style="margin-bottom:2px">${plugin.name}</div>
            <div class="tui-text-sm tui-text-tertiary" style="margin-bottom:4px">${plugin.description || 'No description'}</div>
            <div class="tui-flex tui-gap-md tui-text-sm tui-text-tertiary" style="font-size:11px">
              <span>v${plugin.version}</span>
              ${plugin.system ? '<span class="tui-badge">System</span>' : ''}
            </div>
          </div>
          ${!plugin.system ? `
          <div>
            <button class="tui-btn tui-btn-danger" data-plugin="${plugin.dirName}">Uninstall</button>
          </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // Uninstall buttons
    pluginListEl.querySelectorAll('.tui-btn-danger').forEach(btn => {
      addEventListener(btn, 'click', async () => {
        const dirName = btn.dataset.plugin;
        if (confirm('Are you sure you want to uninstall this plugin?')) {
          const result = await window.PluginLoader.uninstall(dirName);
          if (result.success) {
            initPluginsSection();
          } else {
            alert(result.error);
          }
        }
      });
    });
  }

  function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substring(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substring(2, 4), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substring(4, 6), 16) + amount));
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
  }
})();

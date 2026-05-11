// Settings Plugin — System Settings (v2 lifecycle API)
// Uses TuiSidebarNav for Windows 11-style sidebar navigation
// Uses TuiDropdown for Windows 11-style flyout select menus
(function() {
  const api = PLUGIN_API;

  // Elements
  let titleEl, contentEl, sidebarEl;
  let sidebarNav;
  let currentSection = 'general';

  // Track active dropdowns so they can be cleaned up on section change
  let activeDropdowns = [];

  // SVG icons for nav items (Fluent Design style)
  const icons = {
    general: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    appearance: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
    plugins: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
    about: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  // Chevron arrow SVG for custom selects
  const chevronSvg = '<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  PLUGIN_LIFECYCLE.onMount(function() {
    titleEl = shadow.getElementById('settings-title');
    contentEl = shadow.getElementById('settings-content');
    sidebarEl = shadow.getElementById('settings-sidebar');

    if (!titleEl || !contentEl || !sidebarEl) return;

    // Create Windows 11-style sidebar navigation using shared component
    sidebarNav = api.ui.sidebarNav({
      items: [
        { id: 'general', label: 'General', icon: icons.general, section: 'main' },
        { id: 'appearance', label: 'Appearance', icon: icons.appearance, section: 'main' },
        { id: 'plugins', label: 'Plugins', icon: icons.plugins, section: 'main' },
        { id: 'about', label: 'About', icon: icons.about, section: 'system', sectionLabel: 'System' }
      ],
      activeItem: 'general',
      width: 240,
      onNavigate: function(itemId) {
        showSection(itemId);
      }
    });

    sidebarEl.appendChild(sidebarNav.el);
    showSection('general');
  });

  // ─── Custom Select (TuiDropdown-backed) ──────────────────────────

  /**
   * Create a Windows 11-style flyout select using TuiDropdown.
   * @param {string} containerId - ID of the container element in the shadow DOM
   * @param {Array<{value:string, label:string}>} options - Select options
   * @param {string} selectedValue - Currently selected value
   * @param {Function} onChange - Called with the new value on selection
   */
  function createCustomSelect(containerId, options, selectedValue, onChange) {
    var container = shadow.getElementById(containerId);
    if (!container) return null;

    var selectedOption = options.find(function(o) { return o.value === selectedValue; }) || options[0];

    // Create wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'tui-custom-select';

    // Create trigger button
    var trigger = document.createElement('button');
    trigger.className = 'tui-custom-select-trigger';
    trigger.setAttribute('type', 'button');
    trigger.setAttribute('data-value', selectedValue);

    var labelSpan = document.createElement('span');
    labelSpan.textContent = selectedOption.label;
    trigger.appendChild(labelSpan);

    // Create arrow indicator
    var arrow = document.createElement('span');
    arrow.className = 'tui-custom-select-arrow';
    arrow.innerHTML = chevronSvg;

    wrapper.appendChild(trigger);
    wrapper.appendChild(arrow);
    container.appendChild(wrapper);

    // Create dropdown items
    var items = options.map(function(opt) {
      return {
        label: opt.label,
        onClick: function() {
          trigger.setAttribute('data-value', opt.value);
          labelSpan.textContent = opt.label;
          if (onChange) onChange(opt.value);
        }
      };
    });

    // Create TuiDropdown instance
    var dropdown = api.ui.dropdown({
      trigger: trigger,
      items: items,
      closeOnClick: true
    });

    // Toggle dropdown on trigger click
    addEventListener(trigger, 'click', function() {
      dropdown.toggle();
    });

    // Track for cleanup
    activeDropdowns.push(dropdown);

    return { wrapper: wrapper, dropdown: dropdown, trigger: trigger };
  }

  /**
   * Close and destroy all active custom select dropdowns.
   */
  function cleanupDropdowns() {
    for (var i = 0; i < activeDropdowns.length; i++) {
      activeDropdowns[i].close();
    }
    activeDropdowns = [];
  }

  // ─── Section Templates ─────────────────────────────────────────────

  var sections = {
    general: '<div class="tui-section">' +
      '<div class="tui-section-title">Behavior</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Auto-connect on startup</div>' +
          '<div class="tui-settings-item-desc">Connect to the last used profile automatically</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<div class="tui-toggle" data-setting="autoConnect"></div>' +
        '</div>' +
      '</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Keep connection alive</div>' +
          '<div class="tui-settings-item-desc">Send keep-alive packets to prevent timeouts</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<div class="tui-toggle active" data-setting="keepAlive"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tui-section">' +
      '<div class="tui-section-title">Data</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Clear saved profiles</div>' +
          '<div class="tui-settings-item-desc">Remove all saved connection profiles</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<button class="tui-btn tui-btn-danger" id="clear-profiles">Clear</button>' +
        '</div>' +
      '</div>' +
    '</div>',

    appearance: '<div class="tui-section">' +
      '<div class="tui-section-title">Theme</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Accent Color</div>' +
          '<div class="tui-settings-item-desc">Choose your preferred accent color</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<div id="accent-color-select"></div>' +
        '</div>' +
      '</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Blur effect</div>' +
          '<div class="tui-settings-item-desc">Adjust the glassmorphism blur intensity</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<div id="blur-intensity-select"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tui-section">' +
      '<div class="tui-section-title">Desktop Background</div>' +
      '<div class="tui-settings-item">' +
        '<div class="tui-settings-item-info">' +
          '<div class="tui-settings-item-label">Wallpaper</div>' +
          '<div class="tui-settings-item-desc" id="bg-filename">Default gradient</div>' +
        '</div>' +
        '<div class="tui-settings-item-control">' +
          '<div class="tui-bg-controls">' +
            '<button class="tui-btn tui-btn-default" id="bg-browse-btn">Browse</button>' +
            '<button class="tui-btn tui-btn-default" id="bg-reset-btn" style="display:none">Reset</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="tui-bg-preview-container">' +
        '<div class="tui-bg-preview" id="bg-preview"></div>' +
      '</div>' +
    '</div>',

    plugins: '<div class="tui-section">' +
      '<div class="tui-section-title">Installed Plugins</div>' +
      '<div id="plugin-list"></div>' +
    '</div>',

    about: '<div style="padding: 40px 20px; text-align: center;">' +
      '<div class="about-logo">' +
        '<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">' +
          '<path d="M3 3h8.5v8.5H3V3zm9.5 0H21v8.5h-8.5V3zM3 12.5h8.5V21H3v-8.5zm9.5 0H21V21h-8.5v-8.5z"/>' +
        '</svg>' +
      '</div>' +
      '<h2 class="about-title">TermulOS</h2>' +
      '<p class="about-version">Version 1.0.0</p>' +
      '<div class="about-info">' +
        '<div class="about-info-row">' +
          '<span class="about-info-label">Electron</span>' +
          '<span class="about-info-value">28.0</span>' +
        '</div>' +
        '<div class="about-info-row">' +
          '<span class="about-info-label">Platform</span>' +
          '<span class="about-info-value">' + (api.platform || 'Unknown') + '</span>' +
        '</div>' +
        '<div class="about-info-row">' +
          '<span class="about-info-label">Node</span>' +
          '<span class="about-info-value">18.x</span>' +
        '</div>' +
        '<div class="about-info-row">' +
          '<span class="about-info-label">License</span>' +
          '<span class="about-info-value">MIT</span>' +
        '</div>' +
      '</div>' +
    '</div>'
  };

  function showSection(section) {
    // Close any open dropdowns before switching sections
    cleanupDropdowns();

    currentSection = section;

    // Update sidebar active state
    if (sidebarNav) {
      sidebarNav.setActive(section);
    }

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
    contentEl.querySelectorAll('.tui-toggle').forEach(function(toggle) {
      addEventListener(toggle, 'click', function() {
        toggle.classList.toggle('active');
      });
    });

    var clearBtn = shadow.getElementById('clear-profiles');
    if (clearBtn) {
      addEventListener(clearBtn, 'click', function() {
        var modal = api.ui.modal({
          title: 'Clear Saved Profiles',
          content: '<p class="tui-modal-message">Are you sure you want to clear all saved profiles?</p>',
          buttons: [
            { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
            { label: 'Clear All', variant: 'danger', onClick: function(m) { m.close(); doClearProfiles(); } }
          ]
        });
        modal.open();
      });
    }
  }

  async function doClearProfiles() {
    try {
      var profiles = await window.termulAPI.profiles.getAll();
      for (var i = 0; i < profiles.length; i++) {
        await window.termulAPI.profiles.delete(profiles[i].id);
      }
      api.ui.toast().show('All profiles cleared', 'success');
    } catch (err) {
      api.ui.toast().show('Failed to clear profiles: ' + err.message, 'error');
    }
  }

  async function initAppearanceSection() {
    // Accent color custom select using TuiDropdown
    createCustomSelect(
      'accent-color-select',
      [
        { value: '#0067C0', label: 'Blue' },
        { value: '#60CDFF', label: 'Cyan' },
        { value: '#7A7574', label: 'Gray' },
        { value: '#E81123', label: 'Red' },
        { value: '#0078D4', label: 'Windows Blue' },
        { value: '#8E562E', label: 'Brown' }
      ],
      '#0067C0',
      function(color) {
        document.documentElement.style.setProperty('--accent-primary', color);
        document.documentElement.style.setProperty('--accent-hover', adjustColor(color, -20));
      }
    );

    // Blur intensity custom select using TuiDropdown
    createCustomSelect(
      'blur-intensity-select',
      [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ],
      'medium',
      function(value) {
        // Blur intensity change handler
        var blurMap = { low: '20px', medium: '40px', high: '60px' };
        var blur = blurMap[value] || '40px';
        document.documentElement.style.setProperty('--blur-intensity', blur);
      }
    );

    // Desktop background controls
    var bgBrowseBtn = shadow.getElementById('bg-browse-btn');
    var bgResetBtn = shadow.getElementById('bg-reset-btn');
    var bgFilename = shadow.getElementById('bg-filename');
    var bgPreview = shadow.getElementById('bg-preview');

    // Determine the per-profile settings key
    var profileId = api.profile ? api.profile.id : null;
    var bgSettingsKey = profileId ? 'desktopBackground:' + profileId : null;

    // If no profile context, disable background controls
    if (!bgSettingsKey) {
      if (bgBrowseBtn) bgBrowseBtn.disabled = true;
      if (bgFilename) bgFilename.textContent = 'No active profile';
      return;
    }

    // Load saved background setting for this profile
    try {
      var savedBg = await window.termulAPI.settings.get(bgSettingsKey, null);
      if (savedBg) {
        var normalizedBg = savedBg.replace(/\\/g, '/');
        bgFilename.textContent = savedBg.split(/[/\\]/).pop();
        bgPreview.style.backgroundImage = "url('localfile://bg#" + encodeURIComponent(normalizedBg) + "')";
        bgResetBtn.style.display = '';
      }
    } catch (e) {
      // Ignore errors loading saved background
    }

    // Browse button — open local file dialog
    if (bgBrowseBtn) {
      addEventListener(bgBrowseBtn, 'click', async function() {
        var result = await window.termulAPI.dialog.openFile({
          title: 'Select Desktop Background',
          filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'] },
            { name: 'All Files', extensions: ['*'] }
          ],
          properties: ['openFile']
        });
        if (!result.canceled && result.filePaths.length > 0) {
          var filePath = result.filePaths[0];
          applyDesktopBackground(filePath, bgSettingsKey);
          // Update UI in settings panel
          var normalized = filePath.replace(/\\/g, '/');
          bgFilename.textContent = filePath.split(/[/\\]/).pop();
          bgPreview.style.backgroundImage = "url('localfile://bg#" + encodeURIComponent(normalized) + "')";
          bgResetBtn.style.display = '';
        }
      });
    }

    // Reset button — restore default gradient
    if (bgResetBtn) {
      addEventListener(bgResetBtn, 'click', async function() {
        resetDesktopBackground(bgSettingsKey);
        bgFilename.textContent = 'Default gradient';
        bgPreview.style.backgroundImage = '';
        bgResetBtn.style.display = 'none';
      });
    }
  }

  /**
   * Apply a custom desktop background image for a specific profile.
   * Sets the background on the #app element and persists the path.
   */
  function applyDesktopBackground(filePath, settingsKey) {
    var app = document.getElementById('app');
    if (app) {
      var normalized = filePath.replace(/\\/g, '/');
      app.style.backgroundImage = "url('localfile://bg#" + encodeURIComponent(normalized) + "')";
      app.style.backgroundSize = 'cover';
      app.style.backgroundPosition = 'center';
      app.style.animation = 'none';
    }
    window.termulAPI.settings.set(settingsKey, filePath);
  }

  /**
   * Reset desktop background to the default gradient for a specific profile.
   */
  function resetDesktopBackground(settingsKey) {
    var app = document.getElementById('app');
    if (app) {
      app.style.backgroundImage = '';
      app.style.backgroundSize = '';
      app.style.backgroundPosition = '';
      app.style.animation = '';
    }
    window.termulAPI.settings.set(settingsKey, null);
  }

  async function initPluginsSection() {
    var pluginListEl = shadow.getElementById('plugin-list');
    if (!pluginListEl) return;

    var plugins = window.PluginLoader.getAll();

    if (plugins.length === 0) {
      pluginListEl.innerHTML = '';
      var empty = api.ui.emptyState({
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
        text: 'No plugins installed'
      });
      pluginListEl.appendChild(empty);
      return;
    }

    pluginListEl.innerHTML = plugins.map(function(plugin) {
      var iconSvg = plugin.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>';
      return '<div class="tui-card" style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">' +
        '<div class="tui-card-icon" style="width:48px;height:48px;border-radius:8px;">' +
          iconSvg +
        '</div>' +
        '<div class="tui-flex-1" style="min-width:0">' +
          '<div class="tui-settings-item-label" style="margin-bottom:2px">' + plugin.name + '</div>' +
          '<div class="tui-text-sm tui-text-tertiary" style="margin-bottom:4px">' + (plugin.description || 'No description') + '</div>' +
          '<div class="tui-flex tui-gap-md tui-text-sm tui-text-tertiary" style="font-size:11px">' +
            '<span>v' + plugin.version + '</span>' +
            (plugin.system ? '<span class="tui-badge">System</span>' : '') +
          '</div>' +
        '</div>' +
        (!plugin.system ? '<div><button class="tui-btn tui-btn-danger" data-plugin="' + plugin.dirName + '">Uninstall</button></div>' : '') +
      '</div>';
    }).join('');

    // Uninstall buttons
    pluginListEl.querySelectorAll('.tui-btn-danger').forEach(function(btn) {
      addEventListener(btn, 'click', function() {
        var dirName = btn.dataset.plugin;
        var modal = api.ui.modal({
          title: 'Uninstall Plugin',
          content: '<p class="tui-modal-message">Are you sure you want to uninstall this plugin?</p>',
          buttons: [
            { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
            { label: 'Uninstall', variant: 'danger', onClick: function(m) {
              m.close();
              doUninstallPlugin(dirName);
            }}
          ]
        });
        modal.open();
      });
    });
  }

  async function doUninstallPlugin(dirName) {
    var result = await window.PluginLoader.uninstall(dirName);
    if (result.success) {
      initPluginsSection();
    } else {
      api.ui.toast().show(result.error || 'Uninstall failed', 'error');
    }
  }

  function adjustColor(color, amount) {
    var hex = color.replace('#', '');
    var r = Math.max(0, Math.min(255, parseInt(hex.substring(0, 2), 16) + amount));
    var g = Math.max(0, Math.min(255, parseInt(hex.substring(2, 4), 16) + amount));
    var b = Math.max(0, Math.min(255, parseInt(hex.substring(4, 6), 16) + amount));
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
  }
})();

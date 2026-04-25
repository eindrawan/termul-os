// Plugin Store — Browse and install plugins from GitHub
// Uses the TermulOS plugin lifecycle API
(function() {
  var api = PLUGIN_API;

  // ─── Configuration ────────────────────────────────────────────────
  // Default store URL — user should change this to their published repo.
  // Format: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/store/
  var DEFAULT_STORE_URL = 'https://raw.githubusercontent.com/eindrawan/termul-os/refs/heads/main/store/';

  var storeUrl = DEFAULT_STORE_URL;
  var storePlugins = [];
  var installedPlugins = [];
  var isSettingsOpen = false;

  // ─── Elements ──────────────────────────────────────────────────────
  var contentEl;
  var searchInput;
  var refreshBtn;
  var settingsBtn;
  var settingsPanel;
  var settingsCloseBtn;
  var urlInput;
  var urlSaveBtn;
  var urlResetBtn;

  // ─── Initialization ────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function() {
    contentEl = shadow.getElementById('store-content');
    searchInput = shadow.getElementById('store-search');
    refreshBtn = shadow.getElementById('store-refresh-btn');
    settingsBtn = shadow.getElementById('store-settings-btn');
    settingsPanel = shadow.getElementById('store-settings-panel');
    settingsCloseBtn = shadow.getElementById('store-settings-close');
    urlInput = shadow.getElementById('store-url-input');
    urlSaveBtn = shadow.getElementById('store-url-save');
    urlResetBtn = shadow.getElementById('store-url-reset');

    if (!contentEl) return;

    // Bind events
    if (searchInput) {
      addEventListener(searchInput, 'input', function() {
        renderPluginList();
      });
    }

    if (refreshBtn) {
      addEventListener(refreshBtn, 'click', function() {
        loadStore();
      });
    }

    if (settingsBtn) {
      addEventListener(settingsBtn, 'click', function() {
        toggleSettings();
      });
    }

    if (settingsCloseBtn) {
      addEventListener(settingsCloseBtn, 'click', function() {
        closeSettings();
      });
    }

    if (urlSaveBtn) {
      addEventListener(urlSaveBtn, 'click', function() {
        saveStoreUrl();
      });
    }

    if (urlResetBtn) {
      addEventListener(urlResetBtn, 'click', function() {
        resetStoreUrl();
      });
    }

    // Load saved store URL from settings
    loadStoreUrl().then(function() {
      // Initial load
      loadStore();
    });
  });

  // ─── Store URL Management ──────────────────────────────────────────

  /**
   * Load the store URL from persistent settings.
   */
  async function loadStoreUrl() {
    try {
      var saved = await window.termulAPI.settings.get('store:url', null);
      if (saved && typeof saved === 'string' && saved.trim().length > 0) {
        storeUrl = saved.trim();
        // Ensure trailing slash
        if (!storeUrl.endsWith('/')) {
          storeUrl += '/';
        }
      }
      if (urlInput) {
        urlInput.value = storeUrl;
      }
    } catch (e) {
      console.warn('[PluginStore] Could not load store URL:', e);
      if (urlInput) {
        urlInput.value = storeUrl;
      }
    }
  }

  /**
   * Save the store URL to persistent settings and reload.
   */
  async function saveStoreUrl() {
    if (!urlInput) return;
    var newUrl = urlInput.value.trim();
    if (!newUrl) {
      showAlert('Invalid URL', 'Please enter a valid store URL.');
      return;
    }
    if (!newUrl.endsWith('/')) {
      newUrl += '/';
    }
    storeUrl = newUrl;
    try {
      await window.termulAPI.settings.set('store:url', storeUrl);
    } catch (e) {
      console.warn('[PluginStore] Could not save store URL:', e);
    }
    closeSettings();
    loadStore();
  }

  /**
   * Reset the store URL to the default value.
   */
  async function resetStoreUrl() {
    storeUrl = DEFAULT_STORE_URL;
    if (urlInput) {
      urlInput.value = storeUrl;
    }
    try {
      await window.termulAPI.settings.set('store:url', storeUrl);
    } catch (e) {
      console.warn('[PluginStore] Could not reset store URL:', e);
    }
    closeSettings();
    loadStore();
  }

  // ─── Settings Panel ────────────────────────────────────────────────

  function toggleSettings() {
    if (isSettingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  }

  function openSettings() {
    if (settingsPanel) {
      settingsPanel.style.display = 'flex';
      isSettingsOpen = true;
    }
  }

  function closeSettings() {
    if (settingsPanel) {
      settingsPanel.style.display = 'none';
      isSettingsOpen = false;
    }
  }

  // ─── Store Loading ─────────────────────────────────────────────────

  /**
   * Fetch the store index and render the plugin list.
   */
  async function loadStore() {
    if (!contentEl) return;

    // Show loading state
    showLoading();

    // Animate refresh button
    if (refreshBtn) {
      refreshBtn.classList.add('spinning');
    }

    try {
      // Fetch store index
      var indexUrl = storeUrl + 'index.json';
      var response = await fetch(indexUrl);

      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
      }

      var data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error('Invalid store index format — expected an array.');
      }

      storePlugins = data;

      // Get currently installed plugins
      installedPlugins = window.PluginLoader.getAll();

      // Render the list
      renderPluginList();

    } catch (err) {
      console.error('[PluginStore] Failed to load store:', err);
      showError(
        'Failed to Load Store',
        'Could not fetch the plugin store from: ' + storeUrl + '\n\nError: ' + err.message
      );
    } finally {
      if (refreshBtn) {
        refreshBtn.classList.remove('spinning');
      }
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  /**
   * Render the plugin list, applying search filter if active.
   */
  function renderPluginList() {
    if (!contentEl) return;

    installedPlugins = window.PluginLoader.getAll();

    // Get search query
    var query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    // Filter plugins by search query
    var filtered = storePlugins;
    if (query) {
      filtered = storePlugins.filter(function(p) {
        var name = (p.name || '').toLowerCase();
        var desc = (p.description || '').toLowerCase();
        var author = (p.author || '').toLowerCase();
        var tags = (p.tags || []).join(' ').toLowerCase();
        var category = (p.category || '').toLowerCase();
        return name.indexOf(query) >= 0 ||
               desc.indexOf(query) >= 0 ||
               author.indexOf(query) >= 0 ||
               tags.indexOf(query) >= 0 ||
               category.indexOf(query) >= 0;
      });
    }

    if (filtered.length === 0) {
      if (storePlugins.length === 0) {
        showEmpty('No plugins available in the store yet.');
      } else {
        showEmpty('No plugins match "' + (searchInput ? searchInput.value : '') + '".');
      }
      return;
    }

    var html = '<div class="store-count-badge">' + filtered.length + ' plugin' + (filtered.length !== 1 ? 's' : '') + ' available</div>';
    html += '<div class="store-grid">';

    for (var i = 0; i < filtered.length; i++) {
      var plugin = filtered[i];
      html += renderPluginCard(plugin);
    }

    html += '</div>';
    contentEl.innerHTML = html;

    // Bind install/update buttons
    contentEl.querySelectorAll('.tui-btn-primary[data-dir-name]').forEach(function(btn) {
      addEventListener(btn, 'click', function() {
        var dirName = btn.dataset.dirName;
        installPlugin(dirName, btn);
      });
    });

    // Bind uninstall buttons
    contentEl.querySelectorAll('.tui-btn-danger[data-dir-name]').forEach(function(btn) {
      addEventListener(btn, 'click', function() {
        var dirName = btn.dataset.dirName;
        uninstallPlugin(dirName, btn);
      });
    });
  }

  /**
   * Render a single plugin card.
   * @param {Object} plugin - Store plugin entry from index.json
   * @returns {string} HTML string
   */
  function renderPluginCard(plugin) {
    var isInstalled = isPluginInstalled(plugin.dirName);
    var installedVersion = getInstalledVersion(plugin.dirName);
    var hasUpdate = isInstalled && installedVersion && plugin.version && installedVersion !== plugin.version;

    var iconSvg = plugin.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>';

    var uninstallBtn = '<button class="tui-btn tui-btn-danger" data-dir-name="' + plugin.dirName + '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
      'Uninstall</button>';

    var actionHtml = '';
    if (isInstalled && !hasUpdate) {
      actionHtml = uninstallBtn;
    } else if (hasUpdate) {
      actionHtml = '<span class="store-status-badge update">v' + installedVersion + ' → v' + plugin.version + '</span>' +
        '<button class="tui-btn tui-btn-primary" data-dir-name="' + plugin.dirName + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        'Update</button>' + uninstallBtn;
    } else {
      actionHtml = '<button class="tui-btn tui-btn-primary" data-dir-name="' + plugin.dirName + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        'Install</button>';
    }

    return '<div class="store-plugin-card">' +
      '<div class="store-plugin-icon">' + iconSvg + '</div>' +
      '<div class="store-plugin-info">' +
        '<div class="store-plugin-name">' + escapeHtml(plugin.name || 'Unnamed Plugin') + '</div>' +
        '<div class="store-plugin-desc">' + escapeHtml(plugin.description || 'No description') + '</div>' +
        '<div class="store-plugin-meta">' +
          '<span class="store-plugin-version">v' + (plugin.version || '0.0.0') + '</span>' +
          (plugin.author ? '<span class="store-plugin-author">by ' + escapeHtml(plugin.author) + '</span>' : '') +
          (plugin.category ? '<span class="store-plugin-tag">' + escapeHtml(plugin.category) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="store-plugin-action">' + actionHtml + '</div>' +
    '</div>';
  }

  // ─── Install Logic ─────────────────────────────────────────────────

  /**
   * Install a plugin from the store by fetching its files from GitHub.
   * @param {string} dirName - The plugin directory name
   * @param {HTMLElement} btn - The install button element
   */
  async function installPlugin(dirName, btn) {
    if (!dirName) return;

    // Disable button and show installing state
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="tui-spinner" style="width:16px;height:16px;border-width:2px;"></div> Installing...';
    }

    try {
      // Find the plugin entry in the store index
      var storeEntry = storePlugins.find(function(p) { return p.dirName === dirName; });
      if (!storeEntry) {
        throw new Error('Plugin not found in store index.');
      }

      // Determine which files to fetch
      var filesToFetch = storeEntry.files || ['manifest.json', 'index.html', 'style.css', 'main.js', 'icon.svg'];

      // Fetch all plugin files in parallel
      var fetchPromises = {};
      for (var i = 0; i < filesToFetch.length; i++) {
        var fileName = filesToFetch[i];
        fetchPromises[fileName] = fetchFile(dirName, fileName);
      }

      // Wait for all fetches
      var results = {};
      var keys = Object.keys(fetchPromises);
      var values = await Promise.all(Object.values(fetchPromises));
      for (var j = 0; j < keys.length; j++) {
        results[keys[j]] = values[j];
      }

      // Parse manifest
      var manifestData = null;
      if (results['manifest.json']) {
        try {
          manifestData = JSON.parse(results['manifest.json']);
        } catch (e) {
          throw new Error('Invalid manifest.json: ' + e.message);
        }
      } else {
        throw new Error('manifest.json is missing.');
      }

      // Build the plugin install data matching PluginLoader.install() format
      var pluginData = {
        dirName: dirName,
        manifest: manifestData,
        mainScript: results['main.js'] || null,
        mainHtml: results['index.html'] || null,
        styles: results['style.css'] || results['styles.css'] || null,
        icon: results['icon.svg'] || null,
      };

      // Install via PluginLoader
      var installResult = await window.PluginLoader.install(pluginData);

      if (installResult.success) {
        // Re-render the plugin list to show updated status
        renderPluginList();
      } else {
        throw new Error(installResult.error || 'Installation failed.');
      }

    } catch (err) {
      console.error('[PluginStore] Install failed:', err);
      showAlert('Installation Failed', err.message);
      restoreInstallBtn(btn);
    }
  }

  /**
   * Uninstall a plugin via PluginLoader.
   * @param {string} dirName - The plugin directory name
   * @param {HTMLElement} btn - The uninstall button element
   */
  async function uninstallPlugin(dirName, btn) {
    if (!dirName) return;

    var pluginName = dirName;
    // Try to get friendly name from store index
    var storeEntry = storePlugins.find(function(p) { return p.dirName === dirName; });
    if (storeEntry && storeEntry.name) {
      pluginName = storeEntry.name;
    }

    showConfirm(
      'Uninstall Plugin',
      'Are you sure you want to uninstall "' + pluginName + '"?',
      function() {
        doUninstall(dirName, btn);
      }
    );
  }

  async function doUninstall(dirName, btn) {
    // Disable button during uninstall
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="tui-spinner" style="width:14px;height:14px;border-width:2px;"></div>';
    }

    try {
      var result = await window.PluginLoader.uninstall(dirName);
      if (result.success) {
        renderPluginList();
      } else {
        showAlert('Uninstall Failed', result.error || 'Unknown error.');
        restoreUninstallBtn(btn);
      }
    } catch (err) {
      showAlert('Uninstall Failed', err.message);
      restoreUninstallBtn(btn);
    }
  }

  function restoreUninstallBtn(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Uninstall';
  }

  function restoreInstallBtn(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Install';
  }

  /**
   * Show an alert modal using TuiModal component.
   */
  function showAlert(title, message) {
    var modal = api.ui.modal({
      title: title,
      content: '<p class="tui-modal-message">' + escapeHtml(message) + '</p>',
      buttons: [
        { label: 'OK', variant: 'primary', onClick: function(m) { m.close(); } }
      ]
    });
    modal.open();
  }

  /**
   * Show a confirmation modal using TuiModal component.
   * @param {string} title
   * @param {string} message
   * @param {Function} onConfirm - Called when user confirms
   */
  function showConfirm(title, message, onConfirm) {
    var modal = api.ui.modal({
      title: title,
      content: '<p class="tui-modal-message">' + escapeHtml(message) + '</p>',
      buttons: [
        { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
        { label: 'Confirm', variant: 'danger', onClick: function(m) { m.close(); if (onConfirm) onConfirm(); } }
      ]
    });
    modal.open();
  }

  /**
   * Fetch a single file from the store.
   * @param {string} dirName - Plugin directory name
   * @param {string} fileName - File name
   * @returns {Promise<string|null>} File content or null if not found
   */
  async function fetchFile(dirName, fileName) {
    try {
      var url = storeUrl + dirName + '/' + fileName;
      var response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      // 404 is okay — file is optional
      if (response.status === 404) {
        return null;
      }
      console.warn('[PluginStore] Failed to fetch ' + fileName + ': HTTP ' + response.status);
      return null;
    } catch (e) {
      console.warn('[PluginStore] Error fetching ' + fileName + ':', e);
      return null;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Check if a plugin with the given dirName is already installed.
   */
  function isPluginInstalled(dirName) {
    if (!installedPlugins) installedPlugins = window.PluginLoader.getAll();
    return installedPlugins.some(function(p) { return p.dirName === dirName; });
  }

  /**
   * Get the installed version of a plugin.
   * @returns {string|null}
   */
  function getInstalledVersion(dirName) {
    if (!installedPlugins) installedPlugins = window.PluginLoader.getAll();
    var installed = installedPlugins.find(function(p) { return p.dirName === dirName; });
    return installed ? installed.version : null;
  }

  /**
   * Escape HTML to prevent XSS.
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Show loading state.
   */
  function showLoading() {
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="store-loading">' +
      '<div class="store-spinner"></div>' +
      '<p>Loading store...</p>' +
    '</div>';
  }

  /**
   * Show error state.
   */
  function showError(title, message) {
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="store-error">' +
      '<div class="store-error-icon">' +
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' +
        '</svg>' +
      '</div>' +
      '<p class="store-error-title">' + escapeHtml(title) + '</p>' +
      '<p class="store-error-message">' + escapeHtml(message) + '</p>' +
      '<button class="tui-btn tui-btn-primary" id="store-retry-btn">Retry</button>' +
    '</div>';

    var retryBtn = shadow.getElementById('store-retry-btn');
    if (retryBtn) {
      addEventListener(retryBtn, 'click', function() {
        loadStore();
      });
    }
  }

  /**
   * Show empty state.
   */
  function showEmpty(message) {
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="store-empty">' +
      '<div class="store-empty-icon">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
          '<rect x="3" y="3" width="18" height="18" rx="4"/>' +
        '</svg>' +
      '</div>' +
      '<p class="store-empty-text">' + escapeHtml(message) + '</p>' +
    '</div>';
  }
})();

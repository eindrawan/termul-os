// Docker Plugin — Docker Container Management (v2 lifecycle API)
// Manages Docker containers, images, networks, and volumes via SSH
(function() {
  const api = PLUGIN_API;

  // ─── State ──────────────────────────────────────────────────────────
  const state = {
    currentTab: 'containers',
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    containerFilter: 'running',
    detailItem: null,  // { type, id, data }
    logContainerId: null,
    useSudo: null,       // null = unknown, true/false once detected
    sudoPassword: '',    // cached sudo password for this session
    passwordSaved: false, // whether the user chose to persist it
    lastError: ''        // last error message for display
  };

  // UI Elements
  let statusEl, containerListEl, containerFilterEl, containerCountEl;
  let _toast = null;

  /**
   * Lazy-initialize the toast instance. TuiToast needs the shadow root
   * which may not be available during onMount, so we defer creation
   * until the first actual use (user-triggered action).
   */
  function getToast() {
    if (!_toast) {
      _toast = api.ui.toast({ position: 'bottom-right', defaultDuration: 3000 });
    }
    return _toast;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function() {
    // Cache key elements
    statusEl = shadow.getElementById('docker-status');
    containerListEl = shadow.getElementById('container-list');
    containerCountEl = shadow.getElementById('container-count');

    // Create container filter using TUI select factory
    const filterWrapper = shadow.getElementById('container-filter-wrapper');
    if (filterWrapper) {
      containerFilterEl = api.ui.select({
        options: [
          { value: 'all', label: 'All' },
          { value: 'running', label: 'Running' },
          { value: 'stopped', label: 'Stopped' }
        ],
        value: 'running',
        onChange: (value) => {
          state.containerFilter = value;
          renderContainers();
        }
      });
      containerFilterEl.classList.add('docker-filter-select');
      filterWrapper.appendChild(containerFilterEl);
    }

    // Setup toolbar buttons
    shadow.getElementById('docker-refresh')?.addEventListener('click', refreshCurrentView);
    shadow.getElementById('docker-settings')?.addEventListener('click', showDockerInfo);

    // Setup tab switching
    const tabs = shadow.querySelectorAll('.docker-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Setup container run button
    shadow.getElementById('btn-run-container')?.addEventListener('click', showRunModal);

    // Setup panel buttons (will be used in later parts)
    shadow.getElementById('btn-pull-image')?.addEventListener('click', showPullModal);
    shadow.getElementById('btn-prune-images')?.addEventListener('click', () => pruneImages());
    shadow.getElementById('btn-create-network')?.addEventListener('click', showCreateNetworkModal);
    shadow.getElementById('btn-prune-networks')?.addEventListener('click', () => pruneNetworks());
    shadow.getElementById('btn-create-volume')?.addEventListener('click', showCreateVolumeModal);
    shadow.getElementById('btn-prune-volumes')?.addEventListener('click', () => pruneVolumes());

    // Setup detail panel close
    shadow.getElementById('detail-close')?.addEventListener('click', closeDetail);

    // Setup log panel
    shadow.getElementById('log-close')?.addEventListener('click', closeLogPanel);
    shadow.getElementById('log-refresh')?.addEventListener('click', refreshLogs);

    // Initial load — restore saved sudo password first, then detect
    loadSavedSudoPassword().then(function() {
      loadAllData();
    });
  });

  // ─── SSH / Docker Helper (with sudo support) ──────────────────────────

  async function rawExec(cmd) {
    const connectionId = api.connectionId;
    if (!connectionId) return null;
    try {
      return await api.ssh.exec(connectionId, cmd);
    } catch (err) {
      console.error('[Docker] exec failed:', err);
      return null;
    }
  }

  /**
   * Detect whether Docker requires sudo.
   * Sets state.useSudo = true|false.
   * Returns an error message string on failure, or null on success.
   */
  async function detectSudoRequirement() {
    if (state.useSudo !== null) return null; // already detected

    // 1. Check if docker binary exists
    var whichResult = await rawExec('which docker 2>/dev/null');
    if (!whichResult || !whichResult.stdout || whichResult.stdout.trim().length === 0) {
      updateStatus('error', 'Docker not installed on server');
      return 'Docker is not installed or not in PATH on this server';
    }

    // 2. Try plain docker info — if it works, no sudo needed
    var result = await rawExec('docker info >/dev/null 2>&1 && echo DOCKER_OK');
    if (result && result.success && result.stdout && result.stdout.trim().indexOf('DOCKER_OK') !== -1) {
      state.useSudo = false;
      return null;
    }

    // 3. Try sudo without password
    var sudoResult = await rawExec('sudo -n docker info >/dev/null 2>&1 && echo DOCKER_OK');
    if (sudoResult && sudoResult.success && sudoResult.stdout && sudoResult.stdout.trim().indexOf('DOCKER_OK') !== -1) {
      state.useSudo = true;
      return null;
    }

    // 4. Docker exists but needs sudo with password
    state.useSudo = true;
    return null;
  }

  /**
   * Run a docker command, automatically prefixing with sudo when needed.
   * On permission-denied, prompts for sudo password, optionally saves it.
   * Returns stdout string or null on failure.
   */
  async function dockerCommand(args) {
    var connectionId = api.connectionId;
    if (!connectionId) {
      updateStatus('error', 'No SSH connection');
      return null;
    }

    var detectError = await detectSudoRequirement();
    if (detectError) return null;

    var cmd = state.useSudo
      ? (state.sudoPassword
          ? 'echo ' + shellArg(state.sudoPassword) + ' | sudo -S docker ' + args + ' 2>&1'
          : 'sudo -n docker ' + args + ' 2>&1')
      : 'docker ' + args + ' 2>&1';

    try {
      var result = await rawExec(cmd);

      if (!result) {
        updateStatus('error', 'SSH exec returned no result');
        return null;
      }

      var out = result.stdout || '';

      // Check for permission denied — may need password
      var needsAuth = out.indexOf('permission denied') !== -1
                   || out.indexOf('Permission denied') !== -1
                   || out.indexOf('sudo: a password is required') !== -1
                   || out.indexOf('Sorry, try again') !== -1;

      if (needsAuth) {
        var password = await promptSudoPassword();
        if (!password) {
          updateStatus('error', 'Sudo password required');
          return null;
        }

        state.sudoPassword = password;
        state.useSudo = true;

        // Retry with password via sudo -S
        var retryCmd = 'echo ' + shellArg(password) + ' | sudo -S docker ' + args + ' 2>&1';
        result = await rawExec(retryCmd);
        out = (result && result.stdout) || '';

        if (out.indexOf('Sorry, try again') !== -1 ||
            out.indexOf('incorrect password') !== -1 ||
            out.indexOf('sudo: a password is required') !== -1 ||
            out.indexOf('Permission denied') !== -1) {
          state.sudoPassword = '';
          updateStatus('error', 'Incorrect sudo password');
          return null;
        }
      }

      // Check for "docker: command not found"
      if (out.indexOf('command not found') !== -1) {
        updateStatus('error', 'Docker not found on server');
        return null;
      }

      // Check for "Cannot connect to the Docker daemon"
      if (out.indexOf('Cannot connect to the Docker daemon') !== -1) {
        updateStatus('error', 'Docker daemon not running');
        return null;
      }

      if (result.success) {
        updateStatus('connected');
        return out;
      } else {
        // Generic error — show first meaningful line
        var errLines = out.trim().split('\n').filter(function(l) {
          return l.trim().length > 0;
        });
        var firstErr = errLines.length > 0 ? errLines[0].trim() : 'Command failed';
        if (firstErr.length > 80) firstErr = firstErr.substring(0, 80) + '...';
        updateStatus('error', firstErr);
        return null;
      }
    } catch (err) {
      updateStatus('error', err.message || 'Command failed');
      console.error('[Docker] Command failed:', err);
      return null;
    }
  }

  /**
   * Shell-escape a string so it's safe inside single-quotes.
   */
  function shellArg(str) {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
  }

  /**
   * Prompt the user for a sudo password using an in-DOM modal.
   * Returns the password string, or null if cancelled.
   */
  async function promptSudoPassword() {
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'docker-modal-overlay';
      overlay.innerHTML = '<div class="docker-modal">'
        + '<div class="docker-modal-header">'
        + '  <span class="docker-modal-title">Sudo Password Required</span>'
        + '</div>'
        + '<div class="docker-modal-body">'
        + '  <p style="margin:0 0 12px;font-size:13px;color:var(--tui-text-secondary,rgba(255,255,255,0.7))">'
        + '    Docker requires elevated privileges on this server. '
        + '    Enter the sudo password for <strong>'
        +    escapeHtml(api.profile ? api.profile.username : 'user')
        + '  </strong>.'
        + '  </p>'
        + '  <div class="docker-form-group">'
        + '    <label class="docker-form-label">Password</label>'
        + '    <input type="password" class="tui-input" id="sudo-pw-input" placeholder="Enter sudo password">'
        + '  </div>'
        + '  <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--tui-text-secondary,rgba(255,255,255,0.7));cursor:pointer;margin-top:8px">'
        + '    <input type="checkbox" id="sudo-save-check" style="accent-color:var(--tui-accent-primary,#0067C0)">'
        + '    Remember password for this server'
        + '  </label>'
        + '</div>'
        + '<div class="docker-modal-footer">'
        + '  <button class="tui-btn tui-btn-default" id="sudo-cancel">Cancel</button>'
        + '  <button class="tui-btn tui-btn-primary" id="sudo-submit">Authenticate</button>'
        + '</div>'
        + '</div>';

      shadow.querySelector('.docker-container').appendChild(overlay);

      var pwInput = overlay.querySelector('#sudo-pw-input');
      var saveCheck = overlay.querySelector('#sudo-save-check');
      if (pwInput) pwInput.focus();

      // Pre-check save box if we previously saved
      if (state.passwordSaved && saveCheck) saveCheck.checked = true;

      function close(val) {
        overlay.remove();
        resolve(val);
      }

      overlay.querySelector('#sudo-cancel').addEventListener('click', function() { close(null); });

      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) close(null);
      });

      overlay.querySelector('#sudo-submit').addEventListener('click', function() {
        var pw = pwInput ? pwInput.value : '';
        if (!pw) { if (pwInput) pwInput.focus(); return; }

        var shouldSave = saveCheck ? saveCheck.checked : false;
        state.passwordSaved = shouldSave;

        if (shouldSave) {
          saveSudoPassword(pw);
        } else {
          clearSavedSudoPassword();
        }

        close(pw);
      });

      // Enter key submits
      if (pwInput) {
        pwInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') overlay.querySelector('#sudo-submit').click();
        });
      }
    });
  }

  // ─── Sudo Password Persistence ──────────────────────────────────────

  function getSudoPasswordKey() {
    var profile = api.profile;
    if (!profile || !profile.id) return null;
    return 'docker:sudo-pw:' + profile.id;
  }

  async function loadSavedSudoPassword() {
    var key = getSudoPasswordKey();
    if (!key) return;

    try {
      var saved = await window.termulAPI.settings.get(key, null);
      if (saved && typeof saved === 'string' && saved.length > 0) {
        state.sudoPassword = saved;
        state.passwordSaved = true;
      }
    } catch (e) {
      // Ignore — settings not available
    }
  }

  async function saveSudoPassword(pw) {
    var key = getSudoPasswordKey();
    if (!key) return;
    try {
      await window.termulAPI.settings.set(key, pw);
      state.passwordSaved = true;
    } catch (e) {
      console.warn('[Docker] Failed to save sudo password:', e);
    }
  }

  async function clearSavedSudoPassword() {
    var key = getSudoPasswordKey();
    if (!key) return;
    try {
      await window.termulAPI.settings.set(key, '');
      state.passwordSaved = false;
    } catch (e) {
      // Ignore
    }
  }

  // ─── Status Update ─────────────────────────────────────────────────

  function updateStatus(status, detail) {
    if (!statusEl) return;
    var dot = statusEl.querySelector('.tui-status-dot');
    var text = statusEl.querySelector('.status-text');
    if (dot) {
      dot.classList.remove('success', 'error', 'pulse', 'warning');
      if (status === 'connected') {
        dot.classList.add('success', 'pulse');
        text.textContent = 'Connected' + (state.useSudo ? ' (sudo)' : '');
      } else if (status === 'loading') {
        dot.classList.add('pulse');
        text.textContent = 'Loading...';
      } else if (status === 'error') {
        dot.classList.add('error');
        state.lastError = detail || 'Unknown error';
        text.textContent = state.lastError;
        text.title = state.lastError;
        text.style.cursor = 'pointer';
      } else if (status === 'warning') {
        dot.classList.add('warning');
        text.textContent = detail || 'Warning';
      }
    }
  }

  // ─── Tab Switching ──────────────────────────────────────────────────

  function switchTab(tabName) {
    state.currentTab = tabName;

    // Update tab buttons
    shadow.querySelectorAll('.docker-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update panels
    shadow.querySelectorAll('.docker-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === 'panel-' + tabName);
    });

    // Load data for the tab
    loadTabData(tabName);
  }

  async function loadTabData(tab) {
    switch (tab) {
      case 'containers':
        await loadContainers();
        break;
      case 'images':
        await loadImages();
        break;
      case 'networks':
        await loadNetworks();
        break;
      case 'volumes':
        await loadVolumes();
        break;
    }
  }

  async function loadAllData() {
    await loadContainers();
    await loadImages();
    await loadNetworks();
    await loadVolumes();
  }

  async function refreshCurrentView() {
    await loadTabData(state.currentTab);
  }

  // ─── Container Management ───────────────────────────────────────────

  /**
   * Show a loading spinner inside a list element, replacing its current content.
   * @param {string} listId - The id of the .docker-list element
   * @param {string} label - Text to show next to the spinner
   */
  function showListLoading(listId, label) {
    var el = shadow.getElementById(listId);
    if (el) {
      el.innerHTML = '<div class="docker-loading"><div class="docker-spinner"></div><span>' + escapeHtml(label) + '</span></div>';
    }
  }

  async function loadContainers() {
    updateStatus('loading');
    showListLoading('container-list', 'Loading containers...');
    const output = await dockerCommand('ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"');
    if (!output) {
      state.containers = [];
      renderContainers();
      return;
    }

    const lines = output.trim().split('\n');
    state.containers = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length >= 4) {
        const status = parts[3];
        const stateStr = status.includes('Up') ? 'running' :
                        status.includes('Exited') ? 'stopped' :
                        status.includes('Paused') ? 'paused' : 'created';

        state.containers.push({
          id: parts[0],
          name: parts[1],
          image: parts[2],
          status: status,
          state: stateStr,
          ports: parts[4] || ''
        });
      }
    }

    renderContainers();
  }

  function renderContainers() {
    if (!containerListEl) return;

    let filtered = state.containers;
    if (state.containerFilter === 'running') {
      filtered = state.containers.filter(c => c.state === 'running');
    } else if (state.containerFilter === 'stopped') {
      filtered = state.containers.filter(c => c.state === 'stopped');
    }

    if (containerCountEl) {
      containerCountEl.textContent = filtered.length + ' container' + (filtered.length !== 1 ? 's' : '');
    }

    if (filtered.length === 0) {
      containerListEl.innerHTML = `
        <div class="docker-empty">
          <div class="docker-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
              <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v3"/>
            </svg>
          </div>
          <p class="docker-empty-text">No containers found</p>
          <p class="docker-empty-subtext">Click "Run" to create a new container</p>
        </div>
      `;
      return;
    }

    let html = '';
    for (const c of filtered) {
      const statusClass = c.state;
      html += `
        <div class="docker-row" data-id="${c.id}" data-type="container">
          <div class="docker-row-status ${statusClass}"></div>
          <div class="docker-row-info">
            <div class="docker-row-name">${escapeHtml(c.name)}</div>
            <div class="docker-row-detail">${escapeHtml(c.image)}</div>
          </div>
          <div class="docker-row-actions">
            <button class="docker-action-btn" data-action="logs" title="Logs">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
              </svg>
            </button>
            <button class="docker-action-btn" data-action="shell" title="Shell">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
            </button>
            ${c.state === 'running' ? `
              <button class="docker-action-btn" data-action="restart" title="Restart">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </button>
              <button class="docker-action-btn" data-action="stop" title="Stop">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
              </button>
            ` : c.state === 'stopped' ? `
              <button class="docker-action-btn" data-action="start" title="Start">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
            ` : ''}
            <button class="docker-action-btn danger" data-action="remove" title="Remove">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    containerListEl.innerHTML = html;

    // Attach click handlers
    containerListEl.querySelectorAll('.docker-row').forEach(row => {
      const id = row.dataset.id;

      // Row click = show details
      row.addEventListener('click', (e) => {
        if (!e.target.closest('.docker-action-btn')) {
          showContainerDetail(id);
        }
      });

      // Action buttons
      row.querySelectorAll('.docker-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleContainerAction(id, btn.dataset.action);
        });
      });
    });
  }

  function handleContainerAction(id, action) {
    switch (action) {
      case 'start':
        startContainer(id);
        break;
      case 'stop':
        stopContainer(id);
        break;
      case 'restart':
        restartContainer(id);
        break;
      case 'remove':
        removeContainer(id);
        break;
      case 'logs':
        showLogs(id);
        break;
      case 'shell':
        openShell(id);
        break;
    }
  }

  // ─── Utility ────────────────────────────────────────────────────────

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Part 2: Container Actions ────────────────────────────────────────

  /**
   * Visually mark a container row as transitioning (loading).
   * Disables action buttons and shows a spinning indicator.
   */
  function setRowLoading(id, isLoading) {
    const row = containerListEl?.querySelector('.docker-row[data-id="' + id + '"]');
    if (!row) return;

    if (isLoading) {
      row.classList.add('transitioning');
      // Disable all action buttons on the row
      row.querySelectorAll('.docker-action-btn').forEach(function(btn) {
        btn.disabled = true;
      });
      // Swap the status dot to a spinner
      var statusDot = row.querySelector('.docker-row-status');
      if (statusDot) {
        statusDot.classList.add('transitioning');
      }
    } else {
      row.classList.remove('transitioning');
      row.querySelectorAll('.docker-action-btn').forEach(function(btn) {
        btn.disabled = false;
      });
      var statusDot = row.querySelector('.docker-row-status');
      if (statusDot) {
        statusDot.classList.remove('transitioning');
      }
    }
  }

  async function startContainer(id) {
    var container = state.containers.find(function(c) { return c.id === id; });
    var name = container ? container.name : id.substring(0, 12);

    setRowLoading(id, true);
    updateStatus('loading');
    getToast().show('Starting ' + name + '...', 'info');

    var result = await dockerCommand('start ' + id);
    setRowLoading(id, false);

    if (result !== null) {
      getToast().show(name + ' started', 'success');
      await loadContainers();
    } else {
      getToast().show('Failed to start ' + name, 'error');
      await loadContainers();
    }
  }

  async function stopContainer(id) {
    var container = state.containers.find(function(c) { return c.id === id; });
    var name = container ? container.name : id.substring(0, 12);

    setRowLoading(id, true);
    updateStatus('loading');
    getToast().show('Stopping ' + name + '...', 'info');

    var result = await dockerCommand('stop ' + id);
    setRowLoading(id, false);

    if (result !== null) {
      getToast().show(name + ' stopped', 'success');
      await loadContainers();
    } else {
      getToast().show('Failed to stop ' + name, 'error');
      await loadContainers();
    }
  }

  async function restartContainer(id) {
    var container = state.containers.find(function(c) { return c.id === id; });
    var name = container ? container.name : id.substring(0, 12);

    setRowLoading(id, true);
    updateStatus('loading');
    getToast().show('Restarting ' + name + '...', 'info');

    var result = await dockerCommand('restart ' + id);
    setRowLoading(id, false);

    if (result !== null) {
      getToast().show(name + ' restarted', 'success');
      await loadContainers();
    } else {
      getToast().show('Failed to restart ' + name, 'error');
      await loadContainers();
    }
  }

  async function removeContainer(id) {
    var container = state.containers.find(function(c) { return c.id === id; });
    var name = container ? container.name : id;

    // Use TUI modal for confirmation
    var confirmed = await new Promise(function(resolve) {
      var modal = api.ui.modal({
        title: 'Remove Container',
        content: '<p class="tui-modal-message">Remove container "' + escapeHtml(name) + '"? This cannot be undone.</p>',
        buttons: [
          { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); resolve(false); } },
          { label: 'Remove', variant: 'danger', onClick: function(m) { m.close(); resolve(true); } }
        ]
      });
      modal.open();
    });

    if (!confirmed) return;

    setRowLoading(id, true);
    updateStatus('loading');
    getToast().show('Removing ' + name + '...', 'info');

    // Stop if running
    if (container && container.state === 'running') {
      await dockerCommand('stop ' + id);
    }

    var result = await dockerCommand('rm ' + id);
    setRowLoading(id, false);

    if (result !== null) {
      getToast().show(name + ' removed', 'success');
      closeDetail();
      await loadContainers();
    } else {
      getToast().show('Failed to remove ' + name, 'error');
      await loadContainers();
    }
  }

  // ─── Part 2: Open Shell in Terminal Plugin ────────────────────────────

  function openShell(id) {
    const container = state.containers.find(c => c.id === id);
    if (!container) return;

    // Build the docker exec command, respecting sudo if needed
    const dockerBin = state.useSudo ? 'sudo docker' : 'docker';
    const shellCmd = dockerBin + ' exec -it ' + id + ' sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"';

    // Dispatch event that app.js handles by opening a terminal window
    document.dispatchEvent(new CustomEvent('termul:docker-open-shell', {
      detail: { containerId: id, containerName: container.name, command: shellCmd }
    }));
  }

  // ─── Part 2: Run Container Modal ───────────────────────────────────────

  function showRunModal() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'docker-modal-overlay';
    overlay.innerHTML = `
      <div class="docker-modal">
        <div class="docker-modal-header">
          <span class="docker-modal-title">Run Container</span>
        </div>
        <div class="docker-modal-body">
          <div class="docker-form-group">
            <label class="docker-form-label">Image</label>
            <input type="text" class="tui-input" id="run-image" placeholder="nginx:alpine" value="">
          </div>
          <div class="docker-form-group">
            <label class="docker-form-label">Container Name (optional)</label>
            <input type="text" class="tui-input" id="run-name" placeholder="my-container">
          </div>
          <div class="docker-form-row">
            <div class="docker-form-group">
              <label class="docker-form-label">Ports (e.g. 8080:80)</label>
              <input type="text" class="tui-input" id="run-ports" placeholder="8080:80">
            </div>
          </div>
          <div class="docker-form-group">
            <label class="docker-form-label">Command (optional)</label>
            <input type="text" class="tui-input" id="run-cmd" placeholder="">
          </div>
        </div>
        <div class="docker-modal-footer">
          <button class="tui-btn tui-btn-default" id="run-cancel">Cancel</button>
          <button class="tui-btn tui-btn-primary" id="run-submit">Run</button>
        </div>
      </div>
    `;

    shadow.querySelector('.docker-container').appendChild(overlay);

    // Handle buttons
    overlay.querySelector('#run-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.docker-modal-overlay').addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#run-submit').addEventListener('click', async () => {
      const image = overlay.querySelector('#run-image').value.trim();
      const name = overlay.querySelector('#run-name').value.trim();
      const ports = overlay.querySelector('#run-ports').value.trim();
      const cmd = overlay.querySelector('#run-cmd').value.trim();

      if (!image) {
        alert('Please enter an image name');
        return;
      }

      overlay.remove();

      // Build docker run command
      let runCmd = 'docker run -d';
      if (name) runCmd += ' --name ' + shellArg(name);
      if (ports) {
        const portParts = ports.split(',');
        for (const p of portParts) {
          runCmd += ' -p ' + p.trim();
        }
      }
      runCmd += ' ' + image;
      if (cmd) runCmd += ' ' + cmd;

      await dockerCommand(runCmd);
      await loadContainers();
    });
  }

  // reuse shellArg defined earlier in the file

  // ─── Part 2: Logs Panel ────────────────────────────────────────────────

  function showLogs(id) {
    state.logContainerId = id;
    const container = state.containers.find(c => c.id === id);
    if (!container) return;

    const panel = shadow.getElementById('docker-log-panel');
    const title = shadow.getElementById('log-title');
    if (title) title.textContent = 'Logs: ' + container.name;
    panel?.classList.add('open');

    refreshLogs();
  }

  async function refreshLogs() {
    const id = state.logContainerId;
    if (!id) return;

    const pre = shadow.getElementById('log-content');
    if (pre) pre.textContent = 'Loading...';

    const output = await dockerCommand('logs --tail 100 ' + id);
    if (pre) pre.textContent = output || 'No logs available';
  }

  function closeLogPanel() {
    state.logContainerId = null;
    shadow.getElementById('docker-log-panel')?.classList.remove('open');
  }

  // ─── Part 3: Image Management ───────────────────────────────────────────

  async function loadImages() {
    updateStatus('loading');
    showListLoading('image-list', 'Loading images...');
    const output = await dockerCommand('images --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}"');
    if (!output) {
      state.images = [];
      renderImages();
      return;
    }

    const lines = output.trim().split('\n');
    state.images = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length >= 3) {
        state.images.push({
          id: parts[0],
          repository: parts[1],
          tag: parts[2],
          size: parts[3] || ''
        });
      }
    }

    renderImages();
  }

  function renderImages() {
    const listEl = shadow.getElementById('image-list');
    const countEl = shadow.getElementById('image-count');
    if (!listEl) return;

    if (countEl) {
      countEl.textContent = state.images.length + ' image' + (state.images.length !== 1 ? 's' : '');
    }

    if (state.images.length === 0) {
      listEl.innerHTML = `
        <div class="docker-empty">
          <div class="docker-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
            </svg>
          </div>
          <p class="docker-empty-text">No images found</p>
          <p class="docker-empty-subtext">Pull an image to get started</p>
        </div>
      `;
      return;
    }

    let html = '';
    for (const img of state.images) {
      const fullName = img.repository + ':' + img.tag;
      html += `
        <div class="docker-row docker-row-image" data-id="${img.id}" data-type="image">
          <div class="docker-row-info">
            <div class="docker-row-name">${escapeHtml(fullName)}</div>
            <div class="docker-row-detail">${escapeHtml(img.id.substring(0, 12))}</div>
          </div>
          <div class="docker-row-size">${escapeHtml(img.size)}</div>
          <div class="docker-row-actions">
            <button class="docker-action-btn" data-action="run" title="Run container">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </button>
            <button class="docker-action-btn danger" data-action="remove" title="Remove">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    listEl.innerHTML = html;

    // Attach click handlers
    listEl.querySelectorAll('.docker-row').forEach(row => {
      const id = row.dataset.id;

      row.querySelectorAll('.docker-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'remove') {
            removeImage(id);
          } else if (action === 'run') {
            runFromImage(id);
          }
        });
      });
    });
  }

  function showPullModal() {
    const overlay = document.createElement('div');
    overlay.className = 'docker-modal-overlay';
    overlay.innerHTML = `
      <div class="docker-modal">
        <div class="docker-modal-header">
          <span class="docker-modal-title">Pull Image</span>
        </div>
        <div class="docker-modal-body">
          <div class="docker-form-group">
            <label class="docker-form-label">Image</label>
            <input type="text" class="tui-input" id="pull-image" placeholder="nginx:alpine" value="">
          </div>
        </div>
        <div class="docker-modal-footer">
          <button class="tui-btn tui-btn-default" id="pull-cancel">Cancel</button>
          <button class="tui-btn tui-btn-primary" id="pull-submit">Pull</button>
        </div>
      </div>
    `;

    shadow.querySelector('.docker-container').appendChild(overlay);

    overlay.querySelector('#pull-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#pull-submit').addEventListener('click', async () => {
      const image = overlay.querySelector('#pull-image').value.trim();
      if (!image) {
        alert('Please enter an image name');
        return;
      }

      overlay.remove();
      await dockerCommand('pull ' + image);
      await loadImages();
    });
  }

  async function removeImage(id) {
    if (!confirm('Remove this image?')) return;

    // Check if image is in use
    const containersUsing = state.containers.filter(c => c.image.includes(id.substring(0, 12)));
    if (containersUsing.length > 0) {
      alert('Cannot remove: image is in use by ' + containersUsing.length + ' container(s)');
      return;
    }

    await dockerCommand('rmi ' + id);
    await loadImages();
  }

  function runFromImage(id) {
    const image = state.images.find(img => img.id === id);
    if (!image) return;

    const fullName = image.repository + ':' + image.tag;

    // Switch to containers tab and show run modal pre-filled
    switchTab('containers');
    setTimeout(() => {
      showRunModal();
      // Pre-fill the image input
      setTimeout(() => {
        const input = shadow.querySelector('#run-image');
        if (input) input.value = fullName;
      }, 50);
    }, 100);
  }

  async function pruneImages() {
    if (!confirm('Remove all unused (dangling) images?')) return;
    await dockerCommand('image prune -f');
    await loadImages();
  }

  // ─── Part 4: Network Management ────────────────────────────────────────

  async function loadNetworks() {
    updateStatus('loading');
    showListLoading('network-list', 'Loading networks...');
    const output = await dockerCommand('network ls --format "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}"');
    if (!output) {
      state.networks = [];
      renderNetworks();
      return;
    }

    const lines = output.trim().split('\n');
    state.networks = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length >= 3) {
        state.networks.push({
          id: parts[0],
          name: parts[1],
          driver: parts[2],
          scope: parts[3] || ''
        });
      }
    }

    renderNetworks();
  }

  function renderNetworks() {
    const listEl = shadow.getElementById('network-list');
    const countEl = shadow.getElementById('network-count');
    if (!listEl) return;

    if (countEl) {
      countEl.textContent = state.networks.length + ' network' + (state.networks.length !== 1 ? 's' : '');
    }

    if (state.networks.length === 0) {
      listEl.innerHTML = `
        <div class="docker-empty">
          <div class="docker-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
              <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
              <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
            </svg>
          </div>
          <p class="docker-empty-text">No networks found</p>
        </div>
      `;
      return;
    }

    let html = '';
    for (const net of state.networks) {
      const isBuiltIn = net.name === 'bridge' || net.name === 'host' || net.name === 'none';
      html += `
        <div class="docker-row docker-row-network" data-id="${net.id}" data-type="network">
          <div class="docker-row-info">
            <div class="docker-row-name">${escapeHtml(net.name)}</div>
            <div class="docker-row-detail">${escapeHtml(net.driver)}</div>
          </div>
          <div class="docker-row-actions">
            ${!isBuiltIn ? `
              <button class="docker-action-btn danger" data-action="remove" title="Remove">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }

    listEl.innerHTML = html;

    // Attach click handlers
    listEl.querySelectorAll('.docker-row').forEach(row => {
      const id = row.dataset.id;

      row.querySelectorAll('.docker-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.dataset.action === 'remove') {
            removeNetwork(id);
          }
        });
      });
    });
  }

  function showCreateNetworkModal() {
    const overlay = document.createElement('div');
    overlay.className = 'docker-modal-overlay';
    overlay.innerHTML = `
      <div class="docker-modal">
        <div class="docker-modal-header">
          <span class="docker-modal-title">Create Network</span>
        </div>
        <div class="docker-modal-body">
          <div class="docker-form-group">
            <label class="docker-form-label">Network Name</label>
            <input type="text" class="tui-input" id="network-name" placeholder="my-network" value="">
          </div>
          <div class="docker-form-group">
            <label class="docker-form-label">Driver</label>
            <div id="network-driver-wrapper"></div>
          </div>
        </div>
        <div class="docker-modal-footer">
          <button class="tui-btn tui-btn-default" id="network-cancel">Cancel</button>
          <button class="tui-btn tui-btn-primary" id="network-submit">Create</button>
        </div>
      </div>
    `;

    shadow.querySelector('.docker-container').appendChild(overlay);

    // Create driver select using TUI select factory
    const driverWrapper = overlay.querySelector('#network-driver-wrapper');
    const driverSelect = api.ui.select({
      options: [
        { value: 'bridge', label: 'bridge' },
        { value: 'overlay', label: 'overlay' },
        { value: 'macvlan', label: 'macvlan' },
        { value: 'ipvlan', label: 'ipvlan' }
      ],
      value: 'bridge'
    });
    driverWrapper.appendChild(driverSelect);

    overlay.querySelector('#network-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#network-submit').addEventListener('click', async () => {
      const name = overlay.querySelector('#network-name').value.trim();
      const driver = driverSelect.value;

      if (!name) {
        alert('Please enter a network name');
        return;
      }

      overlay.remove();
      await dockerCommand('network create --driver ' + driver + ' ' + shellArg(name));
      await loadNetworks();
    });
  }

  async function removeNetwork(id) {
    if (!confirm('Remove this network?')) return;
    await dockerCommand('network rm ' + id);
    await loadNetworks();
  }

  async function pruneNetworks() {
    if (!confirm('Remove all unused networks?')) return;
    await dockerCommand('network prune -f');
    await loadNetworks();
  }

  // ─── Part 4: Volume Management ─────────────────────────────────────────

  async function loadVolumes() {
    updateStatus('loading');
    showListLoading('volume-list', 'Loading volumes...');
    const output = await dockerCommand('volume ls --format "{{.Name}}|{{.Driver}}|{{.Mountpoint}}"');
    if (!output) {
      state.volumes = [];
      renderVolumes();
      return;
    }

    const lines = output.trim().split('\n');
    state.volumes = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length >= 2) {
        state.volumes.push({
          name: parts[0],
          driver: parts[1],
          mountpoint: parts[2] || ''
        });
      }
    }

    renderVolumes();
  }

  function renderVolumes() {
    const listEl = shadow.getElementById('volume-list');
    const countEl = shadow.getElementById('volume-count');
    if (!listEl) return;

    if (countEl) {
      countEl.textContent = state.volumes.length + ' volume' + (state.volumes.length !== 1 ? 's' : '');
    }

    if (state.volumes.length === 0) {
      listEl.innerHTML = `
        <div class="docker-empty">
          <div class="docker-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <p class="docker-empty-text">No volumes found</p>
        </div>
      `;
      return;
    }

    let html = '';
    for (const vol of state.volumes) {
      html += `
        <div class="docker-row docker-row-volume" data-name="${vol.name}" data-type="volume">
          <div class="docker-row-info">
            <div class="docker-row-name">${escapeHtml(vol.name)}</div>
            <div class="docker-row-detail">${escapeHtml(vol.driver)}</div>
          </div>
          <div class="docker-row-actions">
            <button class="docker-action-btn danger" data-action="remove" title="Remove">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    listEl.innerHTML = html;

    // Attach click handlers
    listEl.querySelectorAll('.docker-row').forEach(row => {
      const name = row.dataset.name;

      row.querySelectorAll('.docker-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.dataset.action === 'remove') {
            removeVolume(name);
          }
        });
      });
    });
  }

  function showCreateVolumeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'docker-modal-overlay';
    overlay.innerHTML = `
      <div class="docker-modal">
        <div class="docker-modal-header">
          <span class="docker-modal-title">Create Volume</span>
        </div>
        <div class="docker-modal-body">
          <div class="docker-form-group">
            <label class="docker-form-label">Volume Name</label>
            <input type="text" class="tui-input" id="volume-name" placeholder="my-volume" value="">
          </div>
        </div>
        <div class="docker-modal-footer">
          <button class="tui-btn tui-btn-default" id="volume-cancel">Cancel</button>
          <button class="tui-btn tui-btn-primary" id="volume-submit">Create</button>
        </div>
      </div>
    `;

    shadow.querySelector('.docker-container').appendChild(overlay);

    overlay.querySelector('#volume-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#volume-submit').addEventListener('click', async () => {
      const name = overlay.querySelector('#volume-name').value.trim();

      if (!name) {
        alert('Please enter a volume name');
        return;
      }

      overlay.remove();
      await dockerCommand('volume create ' + shellArg(name));
      await loadVolumes();
    });
  }

  async function removeVolume(name) {
    if (!confirm('Remove this volume?')) return;
    await dockerCommand('volume rm ' + shellArg(name));
    await loadVolumes();
  }

  async function pruneVolumes() {
    if (!confirm('Remove all unused volumes?')) return;
    await dockerCommand('volume prune -f');
    await loadVolumes();
  }

  // ─── Part 5: Detail Panel ───────────────────────────────────────────────

  async function showContainerDetail(id) {
    const container = state.containers.find(c => c.id === id);
    if (!container) return;

    state.detailItem = { type: 'container', id: id, data: container };

    const panel = shadow.getElementById('docker-detail');
    const title = shadow.getElementById('detail-title');
    const body = shadow.getElementById('detail-body');

    if (title) title.textContent = container.name;
    panel?.classList.add('open');

    if (body) {
      body.innerHTML = '<div class="docker-loading"><div class="docker-spinner"></div> Loading...</div>';
    }

    // Get detailed container info
    const inspectOutput = await dockerCommand('inspect ' + id);
    let inspectData = null;
    if (inspectOutput) {
      try {
        inspectData = JSON.parse(inspectOutput);
      } catch (e) {
        // Invalid JSON
      }
    }

    if (body) {
      body.innerHTML = '';

      // Basic info section
      body.innerHTML += `
        <div class="docker-detail-section">
          <div class="docker-detail-section-title">Container Info</div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">ID</span>
            <span class="docker-detail-value">${escapeHtml(container.id)}</span>
          </div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">Image</span>
            <span class="docker-detail-value">${escapeHtml(container.image)}</span>
          </div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">Status</span>
            <span class="docker-detail-value">
              <span class="docker-badge docker-badge-${container.state}">${escapeHtml(container.state)}</span>
            </span>
          </div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">Created</span>
            <span class="docker-detail-value">${escapeHtml(container.status)}</span>
          </div>
        </div>
      `;

      // Ports section
      if (container.ports) {
        body.innerHTML += `
          <div class="docker-detail-section">
            <div class="docker-detail-section-title">Ports</div>
            <div class="docker-detail-row">
              <span class="docker-detail-value">${escapeHtml(container.ports || 'None')}</span>
            </div>
          </div>
        `;
      }

      // Actions section
      body.innerHTML += `
        <div class="docker-detail-section">
          <div class="docker-detail-section-title">Actions</div>
          <div class="docker-detail-actions">
            ${container.state === 'running' ? `
              <button class="tui-btn tui-btn-default" data-action="stop">Stop</button>
              <button class="tui-btn tui-btn-default" data-action="restart">Restart</button>
            ` : `
              <button class="tui-btn tui-btn-primary" data-action="start">Start</button>
            `}
            <button class="tui-btn tui-btn-default" data-action="logs">View Logs</button>
            <button class="tui-btn tui-btn-default" data-action="shell">Open Shell</button>
            <button class="tui-btn tui-btn-danger" data-action="remove">Remove</button>
          </div>
        </div>
      `;

      // Environment variables from inspect
      if (inspectData && inspectData[0] && inspectData[0].Config && inspectData[0].Config.Env) {
        const env = inspectData[0].Config.Env;
        body.innerHTML += `
          <div class="docker-detail-section">
            <div class="docker-detail-section-title">Environment</div>
            ${env.map(e => `
              <div class="docker-detail-row">
                <span class="docker-detail-value" style="font-size:11px">${escapeHtml(e)}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    }

    // Attach action handlers
    body.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        handleContainerAction(id, btn.dataset.action);
      });
    });
  }

  function closeDetail() {
    state.detailItem = null;
    shadow.getElementById('docker-detail')?.classList.remove('open');
  }

  // ─── Part 5: Docker Info ───────────────────────────────────────────────

  async function showDockerInfo() {
    const output = await dockerCommand('version --format "{{.Server.Version}}|{{.Server.Os}}"');
    if (!output) {
      alert('Failed to get Docker info');
      return;
    }

    const parts = output.split('|');
    const version = parts[0] || 'Unknown';
    const os = parts[1] || 'Unknown';

    const overlay = document.createElement('div');
    overlay.className = 'docker-modal-overlay';
    overlay.innerHTML = `
      <div class="docker-modal" style="width: 500px;">
        <div class="docker-modal-header">
          <span class="docker-modal-title">Docker Information</span>
        </div>
        <div class="docker-modal-body">
          <div class="docker-detail-row">
            <span class="docker-detail-label">Docker Version</span>
            <span class="docker-detail-value">${escapeHtml(version)}</span>
          </div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">Server OS</span>
            <span class="docker-detail-value">${escapeHtml(os)}</span>
          </div>
          <div class="docker-detail-row">
            <span class="docker-detail-label">Connected As</span>
            <span class="docker-detail-value">${escapeHtml(api.profile?.username || 'N/A')}@${escapeHtml(api.profile?.host || 'N/A')}</span>
          </div>
        </div>
        <div class="docker-modal-footer">
          <button class="tui-btn tui-btn-primary" id="info-close">Close</button>
        </div>
      </div>
    `;

    shadow.querySelector('.docker-container').appendChild(overlay);

    overlay.querySelector('#info-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  // ─── End of Docker Plugin ───────────────────────────────────────────────

})();


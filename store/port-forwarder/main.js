// Port Forwarder Plugin (v2 lifecycle API)
// Manages SSH local port forwarding rules with system tray integration
(function() {
  var api = PLUGIN_API;

  // State
  var rules = [];
  var showAddForm = false;
  var editingRuleId = null;

  // DOM element references
  var rulesListEl, addFormEl, emptyStateEl, errorEl;
  var nameInput, localPortInput, remoteHostInput, remotePortInput;
  var connectionStatusEl, ruleCountEl, formTitleEl;

  PLUGIN_LIFECYCLE.onMount(async function() {
    // Grab element references from shadow DOM
    rulesListEl = shadow.getElementById('pf-rules-list');
    addFormEl = shadow.getElementById('pf-add-form');
    emptyStateEl = shadow.getElementById('pf-empty-state');
    errorEl = shadow.getElementById('pf-error');
    nameInput = shadow.getElementById('pf-name');
    localPortInput = shadow.getElementById('pf-local-port');
    remoteHostInput = shadow.getElementById('pf-remote-host');
    remotePortInput = shadow.getElementById('pf-remote-port');
    connectionStatusEl = shadow.getElementById('pf-connection-status');
    ruleCountEl = shadow.getElementById('pf-rule-count');
    formTitleEl = shadow.getElementById('pf-form-title');

    // Bind static buttons
    addEventListener(shadow.getElementById('pf-add-btn'), 'click', function() {
      openAddForm();
    });
    addEventListener(shadow.getElementById('pf-save-btn'), 'click', function() {
      saveRule();
    });
    addEventListener(shadow.getElementById('pf-cancel-btn'), 'click', function() {
      closeForm();
    });

    // Listen for tunnel status changes from main process
    api.tunnel.onStatusChanged(function(data) {
      updateRuleInList(data.ruleId, data.active);
    });

    // Update connection status
    updateConnectionStatus();

    // Load rules from persistent storage
    await loadRules();
  });

  PLUGIN_LIFECYCLE.onUnmount(function() {
    api.tunnel.removeStatusChangedListener();
  });

  // ─── Connection Status ─────────────────────────────────────────────

  function updateConnectionStatus() {
    if (!connectionStatusEl) return;
    var dot = connectionStatusEl.querySelector('.tui-status-dot');
    var textEl = connectionStatusEl.querySelector('.status-text');
    var connId = api.connectionId;
    var profile = api.profile;

    if (dot) {
      if (connId) {
        dot.classList.add('success');
        dot.classList.remove('error');
      } else {
        dot.classList.add('error');
        dot.classList.remove('success');
      }
    }
    if (textEl) {
      if (connId && profile) {
        textEl.textContent = profile.host || 'Connected';
      } else {
        textEl.textContent = 'No Connection';
      }
    }
  }

  // ─── Rules CRUD ────────────────────────────────────────────────────

  async function loadRules() {
    try {
      rules = await api.tunnel.getRules();
      renderRules();
    } catch (e) {
      showError('Failed to load rules: ' + (e.message || e));
    }
  }

  function renderRules() {
    if (!rulesListEl || !emptyStateEl || !ruleCountEl) return;

    // Update count
    var activeCount = 0;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].enabled) activeCount++;
    }
    ruleCountEl.textContent = rules.length + ' rule' + (rules.length !== 1 ? 's' : '') +
      (activeCount > 0 ? ' (' + activeCount + ' active)' : '');

    // Show/hide empty state
    if (rules.length === 0) {
      emptyStateEl.style.display = '';
      rulesListEl.innerHTML = '';
      return;
    }
    emptyStateEl.style.display = 'none';

    // Build rule cards
      var html = '';
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      var isActive = rule.enabled;
      var remoteHost = rule.remoteHost || 'localhost';

      html += '<div class="pf-rule ' + (isActive ? 'active' : '') + '" data-rule-id="' + rule.id + '">' +
        '<div class="pf-rule-icon">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="2" y="8" width="6" height="8" rx="1"/>' +
            '<rect x="16" y="8" width="6" height="8" rx="1"/>' +
            '<path d="M8 12h8"/><path d="M13 9l3 3-3 3"/>' +
          '</svg>' +
        '</div>' +
        '<div class="pf-rule-info">' +
          '<div class="pf-rule-name">' + escapeHtml(rule.name || 'Untitled') + '</div>' +
          '<div class="pf-rule-ports">' +
            '<span>localhost:' + rule.localPort + '</span>' +
            '<span class="pf-arrow">&rarr;</span>' +
            '<span>' + escapeHtml(remoteHost) + ':' + rule.remotePort + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="pf-rule-right">' +
          '<button class="tui-toggle ' + (isActive ? 'active' : '') + '" data-toggle="' + rule.id + '" role="switch" aria-checked="' + isActive + '"></button>' +
          '<button class="tui-btn tui-btn-danger tui-btn-sm pf-rule-delete" data-delete="' + rule.id + '" title="Delete rule">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<polyline points="3 6 5 6 21 6"/>' +
              '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    rulesListEl.innerHTML = html;

    // Bind toggle buttons
    var toggleBtns = rulesListEl.querySelectorAll('[data-toggle]');
    for (var t = 0; t < toggleBtns.length; t++) {
      addEventListener(toggleBtns[t], 'click', createToggleHandler(toggleBtns[t].dataset.toggle));
    }

    // Bind delete buttons
    var deleteBtns = rulesListEl.querySelectorAll('[data-delete]');
    for (var d = 0; d < deleteBtns.length; d++) {
      addEventListener(deleteBtns[d], 'click', createDeleteHandler(deleteBtns[d].dataset.delete));
    }
  }

  // Factory functions to avoid closure issues in loops
  function createToggleHandler(ruleId) {
    return function() { toggleRule(ruleId); };
  }

  function createDeleteHandler(ruleId) {
    return function() { deleteRule(ruleId); };
  }

  async function toggleRule(ruleId) {
    var rule = null;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === ruleId) { rule = rules[i]; break; }
    }
    if (!rule) return;

    if (rule.enabled) {
      // Stop the tunnel
      try {
        var result = await api.tunnel.stop(ruleId);
        if (!result.success) {
          showError('Failed to stop: ' + (result.error || 'Unknown error'));
        }
      } catch (e) {
        showError('Stop error: ' + (e.message || e));
      }
    } else {
      // Start the tunnel
      var connectionId = api.connectionId;
      if (!connectionId) {
        showError('No active SSH connection. Connect to a server first.');
        return;
      }
      try {
        var result = await api.tunnel.start(ruleId, connectionId);
        if (!result.success) {
          showError('Failed to start: ' + (result.error || 'Unknown error'));
        }
      } catch (e) {
        showError('Start error: ' + (e.message || e));
      }
    }

    // Reload rules to reflect the new state
    await loadRules();
  }

  async function deleteRule(ruleId) {
    // Stop the tunnel if active
    try {
      await api.tunnel.stop(ruleId);
    } catch (e) {
      // Ignore stop errors when deleting
    }

    // Remove from local array
    var newRules = [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id !== ruleId) newRules.push(rules[i]);
    }
    rules = newRules;

    // Persist
    try {
      await api.tunnel.saveRules(rules);
    } catch (e) {
      showError('Failed to save: ' + (e.message || e));
    }

    renderRules();
  }

  // ─── Form Management ───────────────────────────────────────────────

  function openAddForm() {
    editingRuleId = null;
    if (formTitleEl) formTitleEl.textContent = 'New Forwarding Rule';
    clearForm();
    if (addFormEl) addFormEl.style.display = '';
    if (nameInput) nameInput.focus();
  }

  function openEditForm(ruleId) {
    var rule = null;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === ruleId) { rule = rules[i]; break; }
    }
    if (!rule) return;

    editingRuleId = ruleId;
    if (formTitleEl) formTitleEl.textContent = 'Edit Forwarding Rule';
    if (nameInput) nameInput.value = rule.name || '';
    if (localPortInput) localPortInput.value = rule.localPort;
    if (remoteHostInput) remoteHostInput.value = rule.remoteHost || 'localhost';
    if (remotePortInput) remotePortInput.value = rule.remotePort;
    if (addFormEl) addFormEl.style.display = '';
    if (nameInput) nameInput.focus();
  }

  function closeForm() {
    editingRuleId = null;
    if (addFormEl) addFormEl.style.display = 'none';
    clearForm();
  }

  function clearForm() {
    if (nameInput) nameInput.value = '';
    if (localPortInput) localPortInput.value = '';
    if (remoteHostInput) remoteHostInput.value = 'localhost';
    if (remotePortInput) remotePortInput.value = '';
  }

  async function saveRule() {
    var name = nameInput ? nameInput.value.trim() : '';
    var localPort = parseInt(localPortInput ? localPortInput.value : '0', 10);
    var remoteHost = remoteHostInput ? remoteHostInput.value.trim() || 'localhost' : 'localhost';
    var remotePort = parseInt(remotePortInput ? remotePortInput.value : '0', 10);

    // Validate
    if (!localPort || localPort < 1 || localPort > 65535) {
      showError('Local port must be between 1 and 65535');
      if (localPortInput) localPortInput.focus();
      return;
    }
    if (!remotePort || remotePort < 1 || remotePort > 65535) {
      showError('Remote port must be between 1 and 65535');
      if (remotePortInput) remotePortInput.focus();
      return;
    }

    if (editingRuleId) {
      // Edit existing rule
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].id === editingRuleId) {
          // Stop tunnel before modifying
          try { await api.tunnel.stop(editingRuleId); } catch (e) {}

          rules[i].name = name || ('Port ' + localPort);
          rules[i].localPort = localPort;
          rules[i].remoteHost = remoteHost;
          rules[i].remotePort = remotePort;
          rules[i].enabled = false; // Reset to inactive after edit
          break;
        }
      }
    } else {
      // Check for duplicate local port
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].localPort === localPort) {
          showError('Local port ' + localPort + ' is already in use by "' + rules[j].name + '"');
          return;
        }
      }

      // Create new rule
      var rule = {
        id: 'pf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: name || ('Port ' + localPort),
        localPort: localPort,
        remoteHost: remoteHost,
        remotePort: remotePort,
        enabled: false
      };
      rules.push(rule);
    }

    // Persist
    try {
      await api.tunnel.saveRules(rules);
    } catch (e) {
      showError('Failed to save: ' + (e.message || e));
      return;
    }

    closeForm();
    renderRules();
  }

  // ─── Status Update (from IPC events) ───────────────────────────────

  function updateRuleInList(ruleId, active) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === ruleId) {
        rules[i].enabled = active;
        break;
      }
    }
    renderRules();
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.style.display = '';
    setTimeout(function() {
      if (errorEl) errorEl.style.display = 'none';
    }, 4000);
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }
})();

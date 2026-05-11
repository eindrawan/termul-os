// iptables GUI Plugin — Visual Firewall Management
// Manages iptables rules across tables and chains via SSH
(function () {
  var api = PLUGIN_API;

  // ─── State ──────────────────────────────────────────────────────────
  var state = {
    currentTable: "filter", // filter | nat | mangle | raw
    currentChain: "INPUT", // active chain
    chains: {}, // { tableName: [ { name, policy, packets, bytes } ] }
    rules: [], // rules for current chain
    useSudo: null, // null = unknown, true/false once detected
    sudoPassword: "",
    passwordSaved: false,
    detailRule: null, // selected rule for detail view
    iptablesBin: "iptables", // resolved binary path
  };

  // UI element references
  var statusEl, ruleListEl, ruleCountEl;
  var _toast = null;

  // Known chains per table
  var DEFAULT_CHAINS = {
    filter: ["INPUT", "FORWARD", "OUTPUT"],
    nat: ["PREROUTING", "OUTPUT", "POSTROUTING"],
    mangle: ["PREROUTING", "INPUT", "FORWARD", "OUTPUT", "POSTROUTING"],
    raw: ["PREROUTING", "OUTPUT"],
  };

  function getToast() {
    if (!_toast) {
      _toast = api.ui.toast({
        position: "bottom-right",
        defaultDuration: 3000,
      });
    }
    return _toast;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    statusEl = shadow.getElementById("ipt-status");
    ruleListEl = shadow.getElementById("rule-list");
    ruleCountEl = shadow.getElementById("rule-count");

    // Table tabs
    var tableTabs = shadow.querySelectorAll(".ipt-tab");
    tableTabs.forEach(function (tab) {
      addEventListener(tab, "click", function () {
        switchTable(tab.dataset.table);
      });
    });

    // Toolbar buttons
    addEventListener(
      shadow.getElementById("ipt-refresh"),
      "click",
      refreshView,
    );
    addEventListener(
      shadow.getElementById("ipt-apply"),
      "click",
      applyIptables,
    );
    addEventListener(shadow.getElementById("ipt-save"), "click", saveRules);

    // Panel buttons
    addEventListener(
      shadow.getElementById("btn-add-rule"),
      "click",
      showAddRuleModal,
    );
    addEventListener(
      shadow.getElementById("btn-flush-chain"),
      "click",
      flushChain,
    );

    // Detail panel
    addEventListener(
      shadow.getElementById("detail-close"),
      "click",
      closeDetail,
    );

    // Output panel
    addEventListener(
      shadow.getElementById("output-close"),
      "click",
      closeOutputPanel,
    );

    // Modal buttons
    addEventListener(
      shadow.getElementById("modal-close-btn"),
      "click",
      closeModal,
    );
    addEventListener(
      shadow.getElementById("modal-cancel"),
      "click",
      closeModal,
    );
    addEventListener(
      shadow.getElementById("modal-save"),
      "click",
      saveRuleFromModal,
    );

    // Load saved password then fetch data
    loadSavedSudoPassword().then(function () {
      loadAllData();
    });
  });

  // ─── SSH Helpers ──────────────────────────────────────────────────────

  async function rawExec(cmd) {
    var connectionId = api.connectionId;
    if (!connectionId) return null;
    try {
      return await api.ssh.exec(connectionId, cmd);
    } catch (err) {
      console.error("[iptables] exec failed:", err);
      return null;
    }
  }

  function shellArg(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  async function detectSudoRequirement() {
    if (state.useSudo !== null) return null; // already detected

    // 1. Locate iptables binary — try which first, then common sbin paths
    var iptBin = "";
    var whichResult = await rawExec("which iptables 2>/dev/null");
    if (
      whichResult &&
      whichResult.stdout &&
      whichResult.stdout.trim().length > 0
    ) {
      iptBin = whichResult.stdout.trim();
    }
    if (!iptBin) {
      // iptables is often in sbin which may not be in PATH for SSH sessions
      var searchPaths = [
        "/usr/sbin/iptables",
        "/sbin/iptables",
        "/usr/local/sbin/iptables",
      ];
      for (var i = 0; i < searchPaths.length; i++) {
        var checkResult = await rawExec(
          "test -x " + searchPaths[i] + " && echo FOUND",
        );
        if (
          checkResult &&
          checkResult.stdout &&
          checkResult.stdout.trim() === "FOUND"
        ) {
          iptBin = searchPaths[i];
          break;
        }
      }
    }

    if (!iptBin) {
      updateStatus("error", "iptables not installed");
      return "iptables is not installed or not in PATH on this server";
    }

    state.iptablesBin = iptBin;

    // 2. Try plain iptables — if it works, no sudo needed
    var result = await rawExec(
      iptBin + " -L -n >/dev/null 2>&1 && echo IPT_OK",
    );
    if (
      result &&
      result.success &&
      result.stdout &&
      result.stdout.trim().indexOf("IPT_OK") !== -1
    ) {
      state.useSudo = false;
      return null;
    }

    // 3. Try sudo without password
    var sudoResult = await rawExec(
      "sudo -n " + iptBin + " -L -n >/dev/null 2>&1 && echo IPT_OK",
    );
    if (
      sudoResult &&
      sudoResult.success &&
      sudoResult.stdout &&
      sudoResult.stdout.trim().indexOf("IPT_OK") !== -1
    ) {
      state.useSudo = true;
      return null;
    }

    // 4. iptables exists but needs sudo with password
    state.useSudo = true;
    return null;
  }

  async function iptablesCommand(args) {
    var connectionId = api.connectionId;
    if (!connectionId) {
      updateStatus("error", "No SSH connection");
      return null;
    }

    var detectError = await detectSudoRequirement();
    if (detectError) return null;

    var bin = state.iptablesBin || "iptables";
    var cmd = state.useSudo
      ? state.sudoPassword
        ? "echo " +
          shellArg(state.sudoPassword) +
          " | sudo -S " +
          bin +
          " " +
          args +
          " 2>&1"
        : "sudo -n " + bin + " " + args + " 2>&1"
      : bin + " " + args + " 2>&1";

    try {
      var result = await rawExec(cmd);
      if (!result) {
        updateStatus("error", "SSH exec returned no result");
        return null;
      }

      var out = result.stdout || "";

      // Check for permission denied
      var needsAuth =
        out.indexOf("permission denied") !== -1 ||
        out.indexOf("Permission denied") !== -1 ||
        out.indexOf("sudo: a password is required") !== -1 ||
        out.indexOf("Sorry, try again") !== -1;

      if (needsAuth) {
        var password = await promptSudoPassword();
        if (!password) {
          updateStatus("error", "Sudo password required");
          return null;
        }

        state.sudoPassword = password;
        state.useSudo = true;

        var retryBin = state.iptablesBin || "iptables";
        var retryCmd =
          "echo " +
          shellArg(password) +
          " | sudo -S " +
          retryBin +
          " " +
          args +
          " 2>&1";
        result = await rawExec(retryCmd);
        out = (result && result.stdout) || "";

        if (
          out.indexOf("Sorry, try again") !== -1 ||
          out.indexOf("incorrect password") !== -1 ||
          out.indexOf("sudo: a password is required") !== -1 ||
          out.indexOf("Permission denied") !== -1
        ) {
          state.sudoPassword = "";
          updateStatus("error", "Incorrect sudo password");
          return null;
        }
      }

      if (out.indexOf("command not found") !== -1) {
        updateStatus("error", "iptables not found");
        return null;
      }

      // Check for "iptables: Permission denied" (raw, not via sudo)
      if (
        out.indexOf("Operation not permitted") !== -1 ||
        out.indexOf("requires root") !== -1 ||
        out.indexOf("Maybe iptables or your kernel needs to be upgraded") !== -1
      ) {
        // Force sudo and retry if we weren't already using it
        if (!state.useSudo) {
          state.useSudo = true;
          return iptablesCommand(args);
        }
        updateStatus("error", "Permission denied — try running with sudo");
        return null;
      }

      if (result.success) {
        updateStatus("connected");
        return out;
      } else {
        // Generic error — show first meaningful line
        var errLines = out
          .trim()
          .split("\n")
          .filter(function (l) {
            return l.trim().length > 0;
          });
        var firstErr =
          errLines.length > 0 ? errLines[0].trim() : "Command failed";
        if (firstErr.length > 80) firstErr = firstErr.substring(0, 80) + "...";
        updateStatus("error", firstErr);
        return null;
      }
    } catch (err) {
      updateStatus("error", err.message || "Command failed");
      console.error("[iptables] Command failed:", err);
      return null;
    }
  }

  // ─── Sudo Password Management ───────────────────────────────────────

  async function promptSudoPassword() {
    return new Promise(function (resolve) {
      var modal = api.ui.modal({
        title: "Sudo Password Required",
        content:
          '<p class="tui-modal-message">iptables requires elevated privileges. Enter your sudo password:</p>' +
          '<input type="password" id="ipt-sudo-input" class="ipt-form-input" placeholder="Sudo password" style="width:100%;margin-top:8px;box-sizing:border-box;">',
        buttons: [
          {
            label: "Cancel",
            variant: "default",
            onClick: function (m) {
              m.close();
              resolve(null);
            },
          },
          {
            label: "Authenticate",
            variant: "primary",
            onClick: function (m) {
              var input = shadow.getElementById("ipt-sudo-input");
              var pwd = input ? input.value : "";
              m.close();
              resolve(pwd || null);
            },
          },
        ],
      });
      modal.open();
    });
  }

  function getSudoPasswordKey() {
    var profileId = api.profile && api.profile.id ? api.profile.id : "default";
    return "iptables:sudoPassword:" + profileId;
  }

  async function loadSavedSudoPassword() {
    try {
      var key = getSudoPasswordKey();
      var saved = await window.termulAPI.settings.get(key, null);
      if (saved) {
        state.sudoPassword = saved;
        state.passwordSaved = true;
      }
    } catch (e) {
      // Ignore
    }
  }

  async function saveSudoPassword(pwd) {
    try {
      var key = getSudoPasswordKey();
      await window.termulAPI.settings.set(key, pwd);
      state.passwordSaved = true;
    } catch (e) {
      // Ignore
    }
  }

  // ─── Status ─────────────────────────────────────────────────────────

  function updateStatus(type, text) {
    if (!statusEl) return;
    var dot = statusEl.querySelector(".tui-status-dot");
    var label = statusEl.querySelector(".status-text");
    if (dot) {
      dot.className = "tui-status-dot";
      if (type === "connected") dot.classList.add("connected");
      else if (type === "error") dot.classList.add("error");
      else dot.classList.add("pulse");
    }
    if (label) {
      label.textContent =
        text || (type === "connected" ? "Connected" : "Loading...");
    }
  }

  // ─── Table / Chain Navigation ───────────────────────────────────────

  function switchTable(tableName) {
    state.currentTable = tableName;

    // Update tab UI
    var tabs = shadow.querySelectorAll(".ipt-tab");
    tabs.forEach(function (t) {
      t.classList.toggle("active", t.dataset.table === tableName);
    });

    // Default to first chain in the table
    var chains = state.chains[tableName] || [];
    var defaultChains = DEFAULT_CHAINS[tableName] || [];
    var firstChain =
      chains.length > 0 ? chains[0].name : defaultChains[0] || "INPUT";
    state.currentChain = firstChain;

    renderChainBar();
    loadRules();
  }

  function switchChain(chainName) {
    state.currentChain = chainName;

    // Update chain tab UI
    var chainTabs = shadow.querySelectorAll(".ipt-chain-tab");
    chainTabs.forEach(function (t) {
      t.classList.toggle("active", t.dataset.chain === chainName);
    });

    updatePolicyDisplay();
    loadRules();
  }

  function renderChainBar() {
    var chainTabsEl = shadow.getElementById("ipt-chain-tabs");
    if (!chainTabsEl) return;

    var chains = state.chains[state.currentTable] || [];
    var defaultChains = DEFAULT_CHAINS[state.currentTable] || [];

    // Merge detected chains with defaults
    var chainNames = [];
    var seen = {};
    chains.forEach(function (c) {
      if (!seen[c.name]) {
        chainNames.push(c.name);
        seen[c.name] = true;
      }
    });
    defaultChains.forEach(function (c) {
      if (!seen[c]) {
        chainNames.push(c);
        seen[c] = true;
      }
    });

    var html = "";
    chainNames.forEach(function (name) {
      var isActive = name === state.currentChain ? " active" : "";
      html +=
        '<button class="ipt-chain-tab' +
        isActive +
        '" data-chain="' +
        escapeHtml(name) +
        '">' +
        escapeHtml(name) +
        "</button>";
    });
    chainTabsEl.innerHTML = html;

    // Attach click handlers
    chainTabsEl.querySelectorAll(".ipt-chain-tab").forEach(function (tab) {
      addEventListener(tab, "click", function () {
        switchChain(tab.dataset.chain);
      });
    });

    updatePolicyDisplay();
  }

  function updatePolicyDisplay() {
    var policyEl = shadow.getElementById("ipt-chain-policy");
    if (!policyEl) return;

    var chains = state.chains[state.currentTable] || [];
    var current = chains.find(function (c) {
      return c.name === state.currentChain;
    });
    var policy = current ? current.policy || "—" : "—";

    var policyClass = policy.toLowerCase();
    var allowed = ["accept", "drop", "queue", "return"];
    if (allowed.indexOf(policyClass) === -1) policyClass = "";

    policyEl.innerHTML =
      '<span class="ipt-policy-label">Policy:</span>' +
      '<span class="ipt-policy-value ' +
      policyClass +
      '">' +
      escapeHtml(policy) +
      "</span>" +
      '<button class="ipt-policy-toggle" id="ipt-policy-cycle" title="Cycle policy (ACCEPT → DROP → QUEUE → RETURN)">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' +
      "</svg>" +
      "</button>";

    addEventListener(
      shadow.getElementById("ipt-policy-cycle"),
      "click",
      function () {
        cyclePolicy(policy);
      },
    );
  }

  var POLICY_CYCLE = ["ACCEPT", "DROP", "QUEUE", "RETURN"];

  async function cyclePolicy(currentPolicy) {
    var idx = POLICY_CYCLE.indexOf((currentPolicy || "").toUpperCase());
    var next = POLICY_CYCLE[(idx + 1) % POLICY_CYCLE.length];

    var confirmModal = api.ui.modal({
      title: "Change Default Policy",
      content:
        '<p class="tui-modal-message">Change default policy for chain <strong>' +
        escapeHtml(state.currentChain) +
        "</strong> from <strong>" +
        escapeHtml(currentPolicy) +
        "</strong> to <strong>" +
        escapeHtml(next) +
        "</strong>?</p>",
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
          },
        },
        {
          label: "Change Policy",
          variant: "danger",
          onClick: function (m) {
            m.close();
            doSetPolicy(next);
          },
        },
      ],
    });
    confirmModal.open();
  }

  async function doSetPolicy(policy) {
    getToast().show("Setting policy to " + policy + "...", "info");
    var result = await iptablesCommand(
      "-t " + state.currentTable + " -P " + state.currentChain + " " + policy,
    );
    if (result !== null) {
      getToast().show("Policy updated to " + policy, "success");
      await loadChains();
      renderChainBar();
    } else {
      getToast().show("Failed to set policy", "error");
    }
  }

  // ─── Data Loading ───────────────────────────────────────────────────

  async function loadAllData() {
    await loadChains();
    renderChainBar();
    await loadRules();
  }

  async function refreshView() {
    getToast().show("Refreshing...", "info");
    await loadAllData();
    getToast().show("Rules refreshed", "success");
  }

  async function loadChains() {
    // Get chain info for the current table
    var output = await iptablesCommand(
      "-t " + state.currentTable + " -L -n --line-numbers",
    );
    if (output === null) return;

    // Parse chains from the output
    var chains = [];
    var chainRegex =
      /^Chain\s+(\S+)\s+\(policy\s+(\S+)\s+(\d+)\s+packets,\s+(\d+)\s+bytes\)/gm;
    var match;
    while ((match = chainRegex.exec(output)) !== null) {
      chains.push({
        name: match[1],
        policy: match[2],
        packets: match[3],
        bytes: match[4],
      });
    }

    // Also handle chains without policy (user-defined chains)
    var chainRegexNoPolicy = /^Chain\s+(\S+)\s+\((\d+)\s+references\)/gm;
    while ((match = chainRegexNoPolicy.exec(output)) !== null) {
      var existing = chains.find(function (c) {
        return c.name === match[1];
      });
      if (!existing) {
        chains.push({
          name: match[1],
          policy: "—",
          packets: "0",
          bytes: "0",
          references: match[2],
        });
      }
    }

    state.chains[state.currentTable] = chains;
  }

  async function loadRules() {
    if (!ruleListEl) return;

    ruleListEl.innerHTML =
      '<div class="ipt-loading"><div class="ipt-spinner"></div><span>Loading rules...</span></div>';

    var output = await iptablesCommand(
      "-t " +
        state.currentTable +
        " -L " +
        state.currentChain +
        " -n -v --line-numbers",
    );
    if (output === null) {
      ruleListEl.innerHTML =
        '<div class="ipt-empty"><div class="ipt-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div><p class="ipt-empty-text">Failed to load rules</p><p class="ipt-empty-subtext">Check connection and permissions</p></div>';
      return;
    }

    // Parse rules
    state.rules = parseRulesOutput(output);
    renderRules();
  }

  function parseRulesOutput(output) {
    var rules = [];
    var lines = output.split("\n");
    var dataStarted = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();

      // Skip chain header lines
      if (line.indexOf("Chain ") === 0) continue;

      // Skip header line (starts with "num" or "pkts")
      if (line.indexOf("num ") === 0 || line.indexOf("pkts ") === 0) {
        dataStarted = true;
        continue;
      }

      if (!dataStarted) continue;
      if (line.length === 0) continue;

      // Parse verbose line-numbered output
      // Format: num  pkts bytes target prot opt in out source destination [extra]
      var parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      var num = parts[0];
      if (isNaN(parseInt(num))) continue;

      var pkts = parts[1];
      var bytes = parts[2];
      var target = parts[3];
      var prot = parts[4];
      var opt = parts[5];
      var inputIface = parts[6];
      var outputIface = parts[7];
      var source = parts[8];

      // Destination is typically parts[9], rest is extra
      var destination = parts.length > 9 ? parts[9] : "";
      var extraParts = parts.length > 10 ? parts.slice(10) : [];
      var extra = extraParts.join(" ");

      rules.push({
        num: parseInt(num),
        pkts: pkts,
        bytes: bytes,
        target: target,
        prot: prot,
        opt: opt,
        inputIface: inputIface,
        outputIface: outputIface,
        source: source,
        destination: destination,
        extra: extra,
      });
    }

    return rules;
  }

  // ─── Rendering ──────────────────────────────────────────────────────

  function renderRules() {
    if (!ruleListEl) return;

    var count = state.rules.length;
    if (ruleCountEl) {
      ruleCountEl.textContent = count + " rule" + (count !== 1 ? "s" : "");
    }

    if (count === 0) {
      ruleListEl.innerHTML =
        '<div class="ipt-empty">' +
        '<div class="ipt-empty-icon">' +
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
        "</svg>" +
        "</div>" +
        '<p class="ipt-empty-text">No rules in ' +
        escapeHtml(state.currentChain) +
        "</p>" +
        '<p class="ipt-empty-subtext">Click "Add Rule" to create a new firewall rule</p>' +
        "</div>";
      return;
    }

    var html = "";
    state.rules.forEach(function (rule) {
      var targetClass = getTargetBadgeClass(rule.target);
      var optsText = buildOptionsText(rule);

      html +=
        '<div class="ipt-row" data-num="' +
        rule.num +
        '">' +
        '<span class="ipt-row-num">' +
        rule.num +
        "</span>" +
        '<span class="ipt-row-target"><span class="ipt-badge ' +
        targetClass +
        '">' +
        escapeHtml(rule.target) +
        "</span></span>" +
        '<span class="ipt-row-proto">' +
        escapeHtml(rule.prot) +
        "</span>" +
        '<span class="ipt-row-source" title="' +
        escapeHtml(rule.source) +
        '">' +
        escapeHtml(rule.source) +
        "</span>" +
        '<span class="ipt-row-dest" title="' +
        escapeHtml(rule.destination) +
        '">' +
        escapeHtml(rule.destination) +
        "</span>" +
        '<span class="ipt-row-options" title="' +
        escapeHtml(optsText) +
        '">' +
        escapeHtml(optsText) +
        "</span>" +
        '<span class="ipt-row-actions">' +
        '<button class="ipt-action-btn move" data-action="up" data-num="' +
        rule.num +
        '" title="Move Up">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' +
        "</button>" +
        '<button class="ipt-action-btn move" data-action="down" data-num="' +
        rule.num +
        '" title="Move Down">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' +
        "</button>" +
        '<button class="ipt-action-btn" data-action="edit" data-num="' +
        rule.num +
        '" title="Edit Rule">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        "</button>" +
        '<button class="ipt-action-btn danger" data-action="delete" data-num="' +
        rule.num +
        '" title="Delete Rule">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        "</button>" +
        "</span>" +
        "</div>";
    });

    ruleListEl.innerHTML = html;

    // Attach event handlers
    ruleListEl.querySelectorAll(".ipt-row").forEach(function (row) {
      addEventListener(row, "click", function (e) {
        // If clicking an action button, handle actions
        var actionBtn = e.target.closest(".ipt-action-btn");
        if (actionBtn) {
          var action = actionBtn.dataset.action;
          var num = parseInt(actionBtn.dataset.num);
          handleRuleAction(action, num);
          return;
        }
        // Otherwise show detail
        var num = parseInt(row.dataset.num);
        showRuleDetail(num);
      });
    });
  }

  function getTargetBadgeClass(target) {
    var t = (target || "").toUpperCase();
    if (t === "ACCEPT") return "ipt-badge-accept";
    if (t === "DROP") return "ipt-badge-drop";
    if (t === "REJECT") return "ipt-badge-reject";
    if (t === "MASQUERADE") return "ipt-badge-masquerade";
    if (t === "DNAT") return "ipt-badge-dnat";
    if (t === "SNAT") return "ipt-badge-snat";
    if (t === "RETURN") return "ipt-badge-return";
    if (t === "LOG") return "ipt-badge-log";
    return "ipt-badge-custom";
  }

  function buildOptionsText(rule) {
    var parts = [];
    if (rule.inputIface && rule.inputIface !== "*")
      parts.push("in:" + rule.inputIface);
    if (rule.outputIface && rule.outputIface !== "*")
      parts.push("out:" + rule.outputIface);
    if (rule.opt && rule.opt !== "--") parts.push(rule.opt);
    if (rule.extra) parts.push(rule.extra);
    return parts.join(" ");
  }

  // ─── Rule Actions ───────────────────────────────────────────────────

  async function handleRuleAction(action, num) {
    if (action === "delete") {
      deleteRule(num);
    } else if (action === "up") {
      moveRule(num, "up");
    } else if (action === "down") {
      moveRule(num, "down");
    } else if (action === "edit") {
      editRule(num);
    }
  }

  async function deleteRule(num) {
    var confirmModal = api.ui.modal({
      title: "Delete Rule #" + num,
      content:
        '<p class="tui-modal-message">Are you sure you want to delete rule #' +
        num +
        " from chain " +
        escapeHtml(state.currentChain) +
        "?</p>",
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
          },
        },
        {
          label: "Delete",
          variant: "danger",
          onClick: function (m) {
            m.close();
            doDeleteRule(num);
          },
        },
      ],
    });
    confirmModal.open();
  }

  async function doDeleteRule(num) {
    getToast().show("Deleting rule #" + num + "...", "info");
    var result = await iptablesCommand(
      "-t " + state.currentTable + " -D " + state.currentChain + " " + num,
    );
    if (result !== null) {
      getToast().show("Rule #" + num + " deleted", "success");
      await loadRules();
    } else {
      getToast().show("Failed to delete rule", "error");
    }
  }

  async function moveRule(num, direction) {
    if (direction === "up" && num <= 1) {
      getToast().show("Rule is already at the top", "warning");
      return;
    }
    if (direction === "down" && num >= state.rules.length) {
      getToast().show("Rule is already at the bottom", "warning");
      return;
    }

    // Get the current rule data to re-insert
    var rule = state.rules.find(function (r) {
      return r.num === num;
    });
    if (!rule) return;

    getToast().show("Moving rule #" + num + " " + direction + "...", "info");

    // Delete the rule first
    var delResult = await iptablesCommand(
      "-t " + state.currentTable + " -D " + state.currentChain + " " + num,
    );
    if (delResult === null) {
      getToast().show("Failed to move rule", "error");
      return;
    }

    // Calculate new position
    var newPos = direction === "up" ? num - 1 : num + 1;

    // Rebuild the rule from stored data and insert at new position
    var ruleCmd = buildRuleCommand(rule);
    var insertResult = await iptablesCommand(
      "-t " +
        state.currentTable +
        " -I " +
        state.currentChain +
        " " +
        newPos +
        " " +
        ruleCmd,
    );

    if (insertResult !== null) {
      getToast().show("Rule moved " + direction, "success");
      await loadRules();
    } else {
      getToast().show("Failed to insert rule at new position", "error");
      await loadRules(); // Reload to show current state
    }
  }

  function buildRuleCommand(rule) {
    var parts = [];
    // Target
    if (
      rule.target &&
      rule.target !== "ACCEPT" &&
      rule.target !== "DROP" &&
      rule.target !== "RETURN"
    ) {
      parts.push("-j " + rule.target);
    } else if (rule.target) {
      parts.push("-j " + rule.target);
    }

    // Protocol
    if (rule.prot && rule.prot !== "all") {
      parts.push("-p " + rule.prot);
    }

    // Interface
    if (rule.inputIface && rule.inputIface !== "*") {
      parts.push("-i " + rule.inputIface);
    }
    if (rule.outputIface && rule.outputIface !== "*") {
      parts.push("-o " + rule.outputIface);
    }

    // Source / Destination
    if (rule.source && rule.source !== "0.0.0.0/0") {
      parts.push("-s " + rule.source);
    }
    if (rule.destination && rule.destination !== "0.0.0.0/0") {
      parts.push("-d " + rule.destination);
    }

    // Extra options (port, dport, sport, etc.)
    if (rule.extra) {
      parts.push(rule.extra);
    }

    return parts.join(" ");
  }

  // ─── Add/Edit Rule Modal ────────────────────────────────────────────

  function showAddRuleModal() {
    var modal = shadow.getElementById("ipt-modal");
    var title = shadow.getElementById("modal-title");
    var body = shadow.getElementById("modal-body");
    var saveBtn = shadow.getElementById("modal-save");

    title.textContent = "Add Rule — " + state.currentChain;
    saveBtn.textContent = "Add Rule";
    saveBtn.dataset.mode = "add";

    body.innerHTML = buildRuleFormHTML();

    modal.style.display = "flex";
  }

  function editRule(num) {
    var rule = state.rules.find(function (r) {
      return r.num === num;
    });
    if (!rule) return;

    var modal = shadow.getElementById("ipt-modal");
    var title = shadow.getElementById("modal-title");
    var body = shadow.getElementById("modal-body");
    var saveBtn = shadow.getElementById("modal-save");

    title.textContent = "Edit Rule #" + num + " — " + state.currentChain;
    saveBtn.textContent = "Save Changes";
    saveBtn.dataset.mode = "edit";
    saveBtn.dataset.editNum = num;

    body.innerHTML = buildRuleFormHTML(rule);

    modal.style.display = "flex";
  }

  function buildRuleFormHTML(existingRule) {
    var r = existingRule || {};
    return (
      "" +
      '<div class="ipt-form-section-label">Target</div>' +
      '<div class="ipt-form-row">' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Action (Target)</label>' +
      '<select class="ipt-form-select" id="rule-target">' +
      '<option value="ACCEPT"' +
      (r.target === "ACCEPT" ? " selected" : "") +
      ">ACCEPT — Allow traffic</option>" +
      '<option value="DROP"' +
      (r.target === "DROP" ? " selected" : "") +
      ">DROP — Silently block</option>" +
      '<option value="REJECT"' +
      (r.target === "REJECT" ? " selected" : "") +
      ">REJECT — Block with error</option>" +
      '<option value="LOG"' +
      (r.target === "LOG" ? " selected" : "") +
      ">LOG — Log packet</option>" +
      '<option value="MASQUERADE"' +
      (r.target === "MASQUERADE" ? " selected" : "") +
      ">MASQUERADE — Source NAT</option>" +
      '<option value="SNAT"' +
      (r.target === "SNAT" ? " selected" : "") +
      ">SNAT — Static Source NAT</option>" +
      '<option value="DNAT"' +
      (r.target === "DNAT" ? " selected" : "") +
      ">DNAT — Destination NAT</option>" +
      '<option value="RETURN"' +
      (r.target === "RETURN" ? " selected" : "") +
      ">RETURN — Return to calling chain</option>" +
      '<option value="custom"' +
      (r.target &&
      [
        "ACCEPT",
        "DROP",
        "REJECT",
        "LOG",
        "MASQUERADE",
        "SNAT",
        "DNAT",
        "RETURN",
      ].indexOf(r.target) === -1
        ? " selected"
        : "") +
      ">Custom chain...</option>" +
      "</select>" +
      "</div>" +
      '<div class="ipt-form-group" id="custom-target-group" style="display:none">' +
      '<label class="ipt-form-label">Custom Target</label>' +
      '<input class="ipt-form-input" id="rule-custom-target" placeholder="e.g. MYCHAIN" value="' +
      (r.target &&
      [
        "ACCEPT",
        "DROP",
        "REJECT",
        "LOG",
        "MASQUERADE",
        "SNAT",
        "DNAT",
        "RETURN",
      ].indexOf(r.target) === -1
        ? escapeHtml(r.target)
        : "") +
      '">' +
      "</div>" +
      "</div>" +
      '<hr class="ipt-form-separator">' +
      '<div class="ipt-form-section-label">Protocol</div>' +
      '<div class="ipt-form-row">' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Protocol</label>' +
      '<select class="ipt-form-select" id="rule-protocol">' +
      '<option value="all"' +
      (r.prot === "all" || !r.prot ? " selected" : "") +
      ">All (any)</option>" +
      '<option value="tcp"' +
      (r.prot === "tcp" ? " selected" : "") +
      ">TCP</option>" +
      '<option value="udp"' +
      (r.prot === "udp" ? " selected" : "") +
      ">UDP</option>" +
      '<option value="icmp"' +
      (r.prot === "icmp" ? " selected" : "") +
      ">ICMP</option>" +
      '<option value="ipv6-icmp"' +
      (r.prot === "ipv6-icmp" ? " selected" : "") +
      ">IPv6-ICMP</option>" +
      "</select>" +
      "</div>" +
      "</div>" +
      '<hr class="ipt-form-separator">' +
      '<div class="ipt-form-section-label">Network</div>' +
      '<div class="ipt-form-row">' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Source IP / CIDR</label>' +
      '<input class="ipt-form-input mono" id="rule-source" placeholder="0.0.0.0/0 (any)" value="' +
      escapeHtml(r.source && r.source !== "0.0.0.0/0" ? r.source : "") +
      '">' +
      '<span class="ipt-form-hint">Leave empty for any source</span>' +
      "</div>" +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Destination IP / CIDR</label>' +
      '<input class="ipt-form-input mono" id="rule-dest" placeholder="0.0.0.0/0 (any)" value="' +
      escapeHtml(
        r.destination && r.destination !== "0.0.0.0/0" ? r.destination : "",
      ) +
      '">' +
      '<span class="ipt-form-hint">Leave empty for any destination</span>' +
      "</div>" +
      "</div>" +
      '<hr class="ipt-form-separator">' +
      '<div class="ipt-form-section-label">Ports</div>' +
      '<div class="ipt-form-row">' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Destination Port(s)</label>' +
      '<input class="ipt-form-input mono" id="rule-dport" placeholder="e.g. 80, 443, 8000:9000">' +
      "</div>" +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Source Port(s)</label>' +
      '<input class="ipt-form-input mono" id="rule-sport" placeholder="e.g. 53, 1024:65535">' +
      "</div>" +
      "</div>" +
      '<hr class="ipt-form-separator">' +
      '<div class="ipt-form-section-label">Interface</div>' +
      '<div class="ipt-form-row">' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">In Interface</label>' +
      '<input class="ipt-form-input mono" id="rule-iface-in" placeholder="e.g. eth0 (leave empty for any)" value="' +
      escapeHtml(r.inputIface && r.inputIface !== "*" ? r.inputIface : "") +
      '">' +
      "</div>" +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Out Interface</label>' +
      '<input class="ipt-form-input mono" id="rule-iface-out" placeholder="e.g. eth0 (leave empty for any)" value="' +
      escapeHtml(r.outputIface && r.outputIface !== "*" ? r.outputIface : "") +
      '">' +
      "</div>" +
      "</div>" +
      '<hr class="ipt-form-separator">' +
      '<div class="ipt-form-section-label">Extra Options</div>' +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Additional iptables options</label>' +
      '<input class="ipt-form-input mono" id="rule-extra" placeholder="e.g. --dport 8080:8081 -m state --state NEW">' +
      '<span class="ipt-form-hint">Advanced: any extra iptables match/target options</span>' +
      "</div>" +
      '<div class="ipt-form-group">' +
      '<label class="ipt-form-label">Insert Position</label>' +
      '<input class="ipt-form-input mono" id="rule-position" type="number" min="1" placeholder="1 (top)" value="1">' +
      '<span class="ipt-form-hint">Rule number where this should be inserted (1 = top of chain)</span>' +
      "</div>"
    );
  }

  function closeModal() {
    var modal = shadow.getElementById("ipt-modal");
    if (modal) modal.style.display = "none";
  }

  async function saveRuleFromModal() {
    var saveBtn = shadow.getElementById("modal-save");
    var mode = saveBtn.dataset.mode;
    var editNum = saveBtn.dataset.editNum;

    // Collect form values
    var targetSelect = shadow.getElementById("rule-target");
    var target = targetSelect ? targetSelect.value : "ACCEPT";
    if (target === "custom") {
      var customTarget = shadow.getElementById("rule-custom-target");
      target = customTarget ? customTarget.value.trim() : "";
      if (!target) {
        getToast().show("Please enter a custom target name", "warning");
        return;
      }
    }

    var protocol = shadow.getElementById("rule-protocol")
      ? shadow.getElementById("rule-protocol").value
      : "all";
    var source = shadow.getElementById("rule-source")
      ? shadow.getElementById("rule-source").value.trim()
      : "";
    var dest = shadow.getElementById("rule-dest")
      ? shadow.getElementById("rule-dest").value.trim()
      : "";
    var dport = shadow.getElementById("rule-dport")
      ? shadow.getElementById("rule-dport").value.trim()
      : "";
    var sport = shadow.getElementById("rule-sport")
      ? shadow.getElementById("rule-sport").value.trim()
      : "";
    var ifaceIn = shadow.getElementById("rule-iface-in")
      ? shadow.getElementById("rule-iface-in").value.trim()
      : "";
    var ifaceOut = shadow.getElementById("rule-iface-out")
      ? shadow.getElementById("rule-iface-out").value.trim()
      : "";
    var extra = shadow.getElementById("rule-extra")
      ? shadow.getElementById("rule-extra").value.trim()
      : "";
    var position = shadow.getElementById("rule-position")
      ? shadow.getElementById("rule-position").value.trim()
      : "1";

    // Build iptables command arguments
    var args = [];

    // Protocol
    if (protocol && protocol !== "all") {
      args.push("-p " + protocol);
    }

    // Source
    if (source) {
      args.push("-s " + source);
    }

    // Destination
    if (dest) {
      args.push("-d " + dest);
    }

    // Destination port
    if (dport) {
      args.push("--dport " + dport);
    }

    // Source port
    if (sport) {
      args.push("--sport " + sport);
    }

    // In interface
    if (ifaceIn) {
      args.push("-i " + ifaceIn);
    }

    // Out interface
    if (ifaceOut) {
      args.push("-o " + ifaceOut);
    }

    // Target
    args.push("-j " + target);

    // Extra options
    if (extra) {
      args.push(extra);
    }

    var ruleArgs = args.join(" ");

    if (mode === "edit" && editNum) {
      // Delete old rule, insert new one at same position
      getToast().show("Updating rule #" + editNum + "...", "info");

      var delResult = await iptablesCommand(
        "-t " +
          state.currentTable +
          " -D " +
          state.currentChain +
          " " +
          editNum,
      );
      if (delResult === null) {
        getToast().show("Failed to delete old rule", "error");
        return;
      }

      var insertResult = await iptablesCommand(
        "-t " +
          state.currentTable +
          " -I " +
          state.currentChain +
          " " +
          editNum +
          " " +
          ruleArgs,
      );
      if (insertResult !== null) {
        getToast().show("Rule updated successfully", "success");
      } else {
        getToast().show("Failed to insert updated rule", "error");
      }
    } else {
      // Insert new rule at position
      var pos = parseInt(position) || 1;
      if (pos < 1) pos = 1;

      getToast().show("Adding rule at position " + pos + "...", "info");
      var result = await iptablesCommand(
        "-t " +
          state.currentTable +
          " -I " +
          state.currentChain +
          " " +
          pos +
          " " +
          ruleArgs,
      );
      if (result !== null) {
        getToast().show("Rule added successfully", "success");
      } else {
        getToast().show("Failed to add rule", "error");
      }
    }

    closeModal();
    await loadRules();
  }

  // ─── Flush Chain ────────────────────────────────────────────────────

  async function flushChain() {
    var confirmModal = api.ui.modal({
      title: "Flush Chain: " + state.currentChain,
      content:
        '<p class="tui-modal-message">This will delete <strong>ALL</strong> rules in the <strong>' +
        escapeHtml(state.currentChain) +
        "</strong> chain of the <strong>" +
        escapeHtml(state.currentTable) +
        "</strong> table. This cannot be undone.</p>",
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
          },
        },
        {
          label: "Flush All Rules",
          variant: "danger",
          onClick: function (m) {
            m.close();
            doFlushChain();
          },
        },
      ],
    });
    confirmModal.open();
  }

  async function doFlushChain() {
    getToast().show("Flushing " + state.currentChain + "...", "info");
    var result = await iptablesCommand(
      "-t " + state.currentTable + " -F " + state.currentChain,
    );
    if (result !== null) {
      getToast().show("Chain " + state.currentChain + " flushed", "success");
      await loadRules();
    } else {
      getToast().show("Failed to flush chain", "error");
    }
  }

  // ─── Apply / Save ───────────────────────────────────────────────────

  async function applyIptables() {
    getToast().show("Restarting iptables...", "info");

    // Try common service restart commands
    var commands = [
      "service iptables restart 2>/dev/null || systemctl restart iptables 2>/dev/null || echo NO_SERVICE",
    ];

    var result = await rawExec(commands[0]);
    if (
      result &&
      result.stdout &&
      result.stdout.trim().indexOf("NO_SERVICE") !== -1
    ) {
      // No service found - show a note
      showOutputPanel(
        "Apply Rules",
        'No iptables service found.\nRules are applied in real-time when using iptables commands.\n\nIf you need persistence, click "Save Rules" to save to /etc/iptables/rules.v4',
      );
    } else {
      showOutputPanel("Apply Rules", result ? result.stdout : "Done");
      getToast().show("iptables service restarted", "success");
    }

    await loadAllData();
  }

  async function saveRules() {
    getToast().show("Saving rules persistently...", "info");

    // Try iptables-save and write to file
    var saveCmd = state.useSudo
      ? state.sudoPassword
        ? "echo " +
          shellArg(state.sudoPassword) +
          " | sudo -S sh -c 'iptables-save > /etc/iptables/rules.v4 2>/dev/null || iptables-save > /etc/sysconfig/iptables 2>/dev/null || echo SAVE_MANUAL' 2>&1"
        : "sudo sh -c 'iptables-save > /etc/iptables/rules.v4 2>/dev/null || iptables-save > /etc/sysconfig/iptables 2>/dev/null || echo SAVE_MANUAL' 2>&1"
      : "sh -c 'iptables-save > /etc/iptables/rules.v4 2>/dev/null || iptables-save > /etc/sysconfig/iptables 2>/dev/null || echo SAVE_MANUAL' 2>&1";

    var result = await rawExec(saveCmd);
    if (result && result.stdout) {
      var out = result.stdout.trim();
      if (out.indexOf("SAVE_MANUAL") !== -1) {
        showOutputPanel(
          "Save Rules",
          "Could not auto-save to standard locations.\n\nManual save:\n  sudo iptables-save > /etc/iptables/rules.v4\n  sudo iptables-save > /etc/sysconfig/iptables\n\nInstall iptables-persistent for auto-load:\n  sudo apt install iptables-persistent",
        );
      } else {
        showOutputPanel("Save Rules", "Rules saved successfully!\n\n" + out);
        getToast().show("Rules saved persistently", "success");
      }
    } else {
      getToast().show("Failed to save rules", "error");
    }
  }

  // ─── Rule Detail ────────────────────────────────────────────────────

  function showRuleDetail(num) {
    var rule = state.rules.find(function (r) {
      return r.num === num;
    });
    if (!rule) return;

    state.detailRule = rule;
    var panel = shadow.getElementById("ipt-detail");
    var title = shadow.getElementById("detail-title");
    var body = shadow.getElementById("detail-body");

    title.textContent = "Rule #" + num + " — " + state.currentChain;

    var targetClass = getTargetBadgeClass(rule.target);
    var optsText = buildOptionsText(rule);

    body.innerHTML =
      '<div class="ipt-detail-section">' +
      '<div class="ipt-detail-section-title">General</div>' +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Number</span><span class="ipt-detail-value">#' +
      rule.num +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Target</span><span class="ipt-detail-value"><span class="ipt-badge ' +
      targetClass +
      '">' +
      escapeHtml(rule.target) +
      "</span></span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Protocol</span><span class="ipt-detail-value">' +
      escapeHtml(rule.prot) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Table</span><span class="ipt-detail-value">' +
      escapeHtml(state.currentTable) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Chain</span><span class="ipt-detail-value">' +
      escapeHtml(state.currentChain) +
      "</span></div>" +
      "</div>" +
      '<div class="ipt-detail-section">' +
      '<div class="ipt-detail-section-title">Traffic Matching</div>' +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Source</span><span class="ipt-detail-value">' +
      escapeHtml(rule.source) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Destination</span><span class="ipt-detail-value">' +
      escapeHtml(rule.destination) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">In Interface</span><span class="ipt-detail-value">' +
      escapeHtml(rule.inputIface) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Out Interface</span><span class="ipt-detail-value">' +
      escapeHtml(rule.outputIface) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Options</span><span class="ipt-detail-value">' +
      escapeHtml(optsText) +
      "</span></div>" +
      "</div>" +
      '<div class="ipt-detail-section">' +
      '<div class="ipt-detail-section-title">Statistics</div>' +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Packets</span><span class="ipt-detail-value">' +
      formatNumber(rule.pkts) +
      "</span></div>" +
      '<div class="ipt-detail-row"><span class="ipt-detail-label">Bytes</span><span class="ipt-detail-value">' +
      formatBytes(rule.bytes) +
      "</span></div>" +
      "</div>" +
      '<div class="ipt-detail-section">' +
      '<div class="ipt-detail-section-title">iptables Command</div>' +
      '<div class="ipt-detail-row"><span class="ipt-detail-value" style="text-align:left;font-size:11px;word-break:break-all;">iptables -t ' +
      state.currentTable +
      " -I " +
      state.currentChain +
      " " +
      rule.num +
      " " +
      escapeHtml(buildRuleCommand(rule)) +
      "</span></div>" +
      "</div>" +
      '<div class="ipt-detail-section">' +
      '<div class="ipt-detail-actions">' +
      "<button class=\"tui-btn tui-btn-default\" onclick=\"this.closest('.ipt-detail').querySelector('[id=detail-edit-btn]')?.click()\">" +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit' +
      "</button>" +
      '<button class="tui-btn tui-btn-danger" id="detail-delete-btn">Delete</button>' +
      '<button class="tui-btn tui-btn-default" id="detail-edit-btn" style="display:none">edit</button>' +
      "</div>" +
      "</div>";

    // Attach detail button handlers
    var editBtn = body.querySelector("#detail-edit-btn");
    var delBtn = body.querySelector("#detail-delete-btn");
    var editBtnVisible = body.querySelector(
      ".ipt-detail-actions .tui-btn-default",
    );

    if (editBtnVisible) {
      addEventListener(editBtnVisible, "click", function () {
        closeDetail();
        editRule(num);
      });
    }

    if (delBtn) {
      addEventListener(delBtn, "click", function () {
        closeDetail();
        deleteRule(num);
      });
    }

    panel.classList.add("open");
  }

  function closeDetail() {
    var panel = shadow.getElementById("ipt-detail");
    if (panel) panel.classList.remove("open");
  }

  // ─── Output Panel ───────────────────────────────────────────────────

  function showOutputPanel(title, content) {
    var panel = shadow.getElementById("ipt-output-panel");
    var titleEl = shadow.getElementById("output-title");
    var contentEl = shadow.getElementById("output-content");

    if (titleEl) titleEl.textContent = title || "Output";
    if (contentEl) contentEl.textContent = content || "";
    if (panel) panel.style.display = "flex";
  }

  function closeOutputPanel() {
    var panel = shadow.getElementById("ipt-output-panel");
    if (panel) panel.style.display = "none";
  }

  // ─── Utility ────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatNumber(n) {
    if (!n) return "0";
    var num = parseInt(n);
    if (isNaN(num)) return n;
    return num.toLocaleString();
  }

  function formatBytes(b) {
    if (!b) return "0 B";
    var bytes = parseInt(b);
    if (isNaN(bytes)) return b;
    if (bytes === 0) return "0 B";
    var sizes = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + sizes[i];
  }
})();

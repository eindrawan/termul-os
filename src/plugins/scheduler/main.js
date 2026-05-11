// Scheduler Plugin — Crontab GUI Editor
// Parses, displays, and modifies user or root crontab entries via SSH.
// Ignores pure comment lines; treats commented-out valid cron lines as "disabled".
// Supports switching between user crontab and root crontab (via sudo).
// Root crontab password can be saved per-profile for convenience.
(function () {
  var api = PLUGIN_API;
  var _toast = null;

  // Lazy toast — the plugin instance is not registered in the global map
  // until after mount() returns, so api.ui.toast() fails if called in onMount.
  // Creating it lazily ensures the instance exists by the time we need it.
  function getToast() {
    if (!_toast) _toast = api.ui.toast();
    return _toast;
  }

  // State
  var cronEntries = []; // Array of { minute, hour, dom, month, dow, command, disabled, raw }
  var editingIndex = -1; // -1 = adding new, >= 0 = editing existing
  var crontabMode = "user"; // 'user' or 'root'
  var sudoPassword = ""; // cached sudo password for this session
  var passwordSaved = false; // whether the user chose to persist it

  // DOM references
  var toolbarActions, cronListEl, emptyStateEl, modeSelect;
  var formOverlay, formTitle, formClose, formCancel, formSave;
  var inputMinute, inputHour, inputDom, inputMonth, inputDow, inputCommand;

  // ─── Crontab Parsing ──────────────────────────────────────────────

  // Regex for a valid crontab schedule line (5 fields + command).
  // Supports: *, numbers, ranges (1-5), steps like */2 or 1-5/2, lists (1,3,5)
  // Also supports named shortcuts: @hourly, @daily, @weekly, @monthly, @yearly, @reboot, @annually
  var CRON_FIELD = "[*/0-9,a-zA-Z\\-]+";
  var CRON_LINE_REGEX = new RegExp(
    "^\\s*(" +
      CRON_FIELD +
      ")\\s+(" +
      CRON_FIELD +
      ")\\s+(" +
      CRON_FIELD +
      ")\\s+(" +
      CRON_FIELD +
      ")\\s+(" +
      CRON_FIELD +
      ")\\s+(.+)$",
  );
  var AT_REGEX =
    /^\s*@(hourly|daily|weekly|monthly|yearly|annually|reboot)\s+(.+)$/i;

  function parseCrontab(stdout) {
    var entries = [];
    var lines = stdout.split("\n");

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip empty lines
      if (/^\s*$/.test(line)) continue;

      // Strip leading # and optional trailing space for commented-out lines
      var stripped = line.replace(/^\s*#\s*/, "");

      // Try matching as a regular cron line (possibly commented out)
      var match = stripped.match(CRON_LINE_REGEX);
      if (!match) {
        // Try @-style entries
        match = stripped.match(AT_REGEX);
        if (match) {
          entries.push({
            minute: "@" + match[1].toLowerCase(),
            hour: "",
            dom: "",
            month: "",
            dow: "",
            command: match[2].trim(),
            disabled: /^\s*#/.test(line),
            raw: line,
          });
        }
        continue;
      }

      entries.push({
        minute: match[1],
        hour: match[2],
        dom: match[3],
        month: match[4],
        dow: match[5],
        command: match[6].trim(),
        disabled: /^\s*#/.test(line),
        raw: line,
      });
    }

    return entries;
  }

  function buildCrontabContent() {
    var lines = [];
    for (var i = 0; i < cronEntries.length; i++) {
      var entry = cronEntries[i];
      var scheduleLine;

      if (entry.minute.startsWith("@")) {
        scheduleLine = entry.minute + " " + entry.command;
      } else {
        scheduleLine =
          entry.minute +
          "\t" +
          entry.hour +
          "\t" +
          entry.dom +
          "\t" +
          entry.month +
          "\t" +
          entry.dow +
          "\t" +
          entry.command;
      }

      if (entry.disabled) {
        scheduleLine = "# " + scheduleLine;
      }

      lines.push(scheduleLine);
    }
    return lines.join("\n") + "\n";
  }

  function formatSchedule(entry) {
    if (entry.minute.startsWith("@")) {
      return entry.minute;
    }
    return (
      entry.minute +
      " " +
      entry.hour +
      " " +
      entry.dom +
      " " +
      entry.month +
      " " +
      entry.dow
    );
  }

  // ─── Shell Helpers ────────────────────────────────────────────────

  function shellArg(str) {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
  }

  // ─── Sudo Detection (matches Docker plugin pattern) ───────────────

  /**
   * Check if output indicates sudo needs a password or the password was wrong.
   * IMPORTANT: Do NOT check for "[sudo]" — that is the normal password prompt
   * that sudo -S outputs even on successful authentication.
   */
  function isSudoPasswordError(text) {
    var lower = text.toLowerCase();
    return (
      lower.indexOf("a password is required") !== -1 ||
      lower.indexOf("sorry, try again") !== -1 ||
      lower.indexOf("incorrect password") !== -1 ||
      lower.indexOf("permission denied") !== -1 ||
      lower.indexOf("sudo: no tty") !== -1 ||
      lower.indexOf("__scheduler_needs_password__") !== -1
    );
  }

  /**
   * Clean sudo prompt noise from crontab output.
   * sudo -S outputs "[sudo] password for user:" to stderr merged into stdout.
   */
  function cleanSudoOutput(stdout) {
    return stdout
      .split("\n")
      .filter(function (l) {
        return (
          l.indexOf("[sudo]") !== 0 &&
          l !== "Password:" &&
          l.indexOf("__scheduler_needs_password__") === -1
        );
      })
      .join("\n");
  }

  // ─── SSH Commands ─────────────────────────────────────────────────

  function fetchCrontab() {
    var connectionId = api.connectionId;
    if (!connectionId) {
      showError("No active connection");
      return;
    }

    var cmd;

    if (crontabMode === "root") {
      if (sudoPassword) {
        // Pipe password to sudo -S; crontab -l does not need stdin
        cmd = "echo " + shellArg(sudoPassword) + " | sudo -S crontab -l 2>&1";
      } else {
        // Try passwordless sudo; emit sentinel on failure so we can detect it
        cmd = 'sudo -n crontab -l 2>&1 || echo "__SCHEDULER_NEEDS_PASSWORD__"';
      }
    } else {
      cmd = "crontab -l 2>/dev/null || true";
    }

    return api.ssh
      .exec(connectionId, cmd)
      .then(function (result) {
        var stdout = (result && result.stdout) || "";
        var stderr = (result && result.stderr) || "";
        var combined = (stdout + "\n" + stderr).trim();

        // Check for sudo password requirement
        if (crontabMode === "root" && isSudoPasswordError(combined)) {
          // If we had a saved password that failed, clear it
          if (sudoPassword) {
            sudoPassword = "";
            clearSavedSudoPassword();
          }
          return promptSudoPassword().then(function (pw) {
            if (!pw) {
              showError("Root crontab requires sudo password");
              return;
            }
            sudoPassword = pw;
            return fetchCrontab();
          });
        }

        if (!result || !result.success) {
          showError(
            "Failed to read crontab" +
              (stderr ? ": " + stderr.split("\n")[0] : ""),
          );
          return;
        }

        var cleanOutput = cleanSudoOutput(stdout);
        cronEntries = parseCrontab(cleanOutput);
        renderList();
      })
      .catch(function (err) {
        showError("SSH error: " + (err.message || err));
      });
  }

  function saveCrontab() {
    var connectionId = api.connectionId;
    if (!connectionId) {
      getToast().show("No active connection", "error");
      return;
    }

    var content = buildCrontabContent();
    var cmd;

    if (crontabMode === "root") {
      // Cannot pipe both password (for sudo -S) and content (for crontab -)
      // through the same stdin. Use a temp file approach instead:
      //   1. Write content to temp file
      //   2. sudo -S crontab <tmpfile> (password via echo, content via file)
      //   3. Clean up temp file
      var tmpFile = "/tmp/.scheduler_cron_" + Date.now();
      var escapedContent = content
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\\''")
        .replace(/\n/g, "\\n");

      if (sudoPassword) {
        cmd =
          "printf '%b' '" +
          escapedContent +
          "' > " +
          tmpFile +
          " && echo " +
          shellArg(sudoPassword) +
          " | sudo -S crontab " +
          tmpFile +
          " 2>&1" +
          "; rm -f " +
          tmpFile;
      } else {
        cmd =
          "printf '%b' '" +
          escapedContent +
          "' > " +
          tmpFile +
          " && sudo -n crontab " +
          tmpFile +
          " 2>&1" +
          "; rm -f " +
          tmpFile;
      }
    } else {
      // User mode — simple pipe
      var escapedUser = content
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\\''")
        .replace(/\n/g, "\\n");
      cmd = "printf '%b' '" + escapedUser + "' | crontab -";
    }

    return api.ssh
      .exec(connectionId, cmd)
      .then(function (result) {
        var stdout = (result && result.stdout) || "";
        var stderr = (result && result.stderr) || "";
        var combined = (stdout + "\n" + stderr).trim();

        // Check if sudo password is needed or the saved password was rejected
        if (crontabMode === "root" && isSudoPasswordError(combined)) {
          if (sudoPassword) {
            sudoPassword = "";
            clearSavedSudoPassword();
          }
          return promptSudoPassword().then(function (pw) {
            if (!pw) {
              getToast().show("Root crontab requires sudo password", "error");
              return;
            }
            sudoPassword = pw;
            return saveCrontab();
          });
        }

        if (!result || !result.success) {
          getToast().show(
            "Failed to save crontab: " + (stderr || stdout || "Unknown error"),
            "error",
          );
          return;
        }

        getToast().show("Crontab saved successfully", "success");
        return fetchCrontab();
      })
      .catch(function (err) {
        getToast().show("SSH error: " + (err.message || err), "error");
      });
  }

  // ─── Sudo Password Persistence ────────────────────────────────────

  function getSudoPasswordKey() {
    var profile = api.profile;
    if (!profile || !profile.id) return null;
    return "scheduler:sudo-pw:" + profile.id;
  }

  async function loadSavedSudoPassword() {
    var key = getSudoPasswordKey();
    if (!key) return;

    try {
      var saved = await window.termulAPI.settings.get(key, null);
      if (saved && typeof saved === "string" && saved.length > 0) {
        sudoPassword = saved;
        passwordSaved = true;
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
      passwordSaved = true;
    } catch (e) {
      console.warn("[Scheduler] Failed to save sudo password:", e);
    }
  }

  async function clearSavedSudoPassword() {
    var key = getSudoPasswordKey();
    if (!key) return;
    try {
      await window.termulAPI.settings.set(key, "");
      passwordSaved = false;
    } catch (e) {
      // Ignore
    }
  }

  // ─── Sudo Password Modal ──────────────────────────────────────────

  function promptSudoPassword() {
    return new Promise(function (resolve) {
      var modal = api.ui.modal({
        title: "Sudo Password Required",
        closeOnBackdrop: false,
        content:
          '<p style="margin:0 0 12px;font-size:13px;color:var(--tui-text-secondary)">' +
          "Root crontab requires elevated privileges. Enter the sudo password for <strong>" +
          escapeHtml(api.profile ? api.profile.username : "user") +
          "</strong>." +
          "</p>" +
          '<div style="margin-bottom:8px;">' +
          '<label style="display:block;margin-bottom:4px;font-size:13px;color:var(--tui-text-secondary);">Password</label>' +
          '<div style="position:relative;">' +
          '<input type="password" class="tui-input" id="cron-sudo-pw-input" placeholder="Enter sudo password" style="width:100%;padding-right:36px;">' +
          '<button class="tui-btn-icon" id="cron-sudo-pw-toggle" title="Toggle visibility" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
          "</button>" +
          "</div>" +
          "</div>" +
          '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--tui-text-secondary);cursor:pointer;">' +
          '<input type="checkbox" id="cron-sudo-save-check" style="accent-color:var(--tui-accent-primary)">' +
          "Remember password for this server" +
          "</label>",
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
              var pwInput = m.el.querySelector("#cron-sudo-pw-input");
              var saveCheck = m.el.querySelector("#cron-sudo-save-check");
              var pw = pwInput ? pwInput.value : "";
              if (!pw) {
                if (pwInput) pwInput.focus();
                return;
              }
              var shouldSave = saveCheck ? saveCheck.checked : false;
              passwordSaved = shouldSave;
              if (shouldSave) {
                saveSudoPassword(pw);
              } else {
                clearSavedSudoPassword();
              }
              m.close();
              resolve(pw);
            },
          },
        ],
      });
      modal.open();
      // Setup after render
      setTimeout(function () {
        var pwInput = modal.el.querySelector("#cron-sudo-pw-input");
        var saveCheck = modal.el.querySelector("#cron-sudo-save-check");
        var toggleBtn = modal.el.querySelector("#cron-sudo-pw-toggle");

        if (pwInput) pwInput.focus();
        if (passwordSaved && saveCheck) saveCheck.checked = true;

        // Toggle password visibility
        if (toggleBtn) {
          toggleBtn.addEventListener("click", function () {
            if (pwInput)
              pwInput.type = pwInput.type === "password" ? "text" : "password";
          });
        }

        // Enter key submits
        if (pwInput) {
          pwInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              var submitBtn = modal.el.querySelector(".tui-btn-primary");
              if (submitBtn) submitBtn.click();
            }
          });
        }
      }, 50);
    });
  }

  // ─── UI Rendering ─────────────────────────────────────────────────

  function renderList() {
    cronListEl.innerHTML = "";

    if (cronEntries.length === 0) {
      emptyStateEl.style.display = "flex";
      return;
    }

    emptyStateEl.style.display = "none";

    for (var i = 0; i < cronEntries.length; i++) {
      var entry = cronEntries[i];
      var row = createEntryRow(entry, i);
      cronListEl.appendChild(row);
    }
  }

  function createEntryRow(entry, index) {
    var row = document.createElement("div");
    row.className = "cron-entry" + (entry.disabled ? " disabled" : "");

    // Status indicator bar (left side)
    var status = document.createElement("div");
    status.className = "cron-entry-status";
    row.appendChild(status);

    // Info (center)
    var info = document.createElement("div");
    info.className = "cron-info";

    var scheduleText = document.createElement("div");
    scheduleText.className = "cron-schedule-text";
    scheduleText.textContent = formatSchedule(entry);
    info.appendChild(scheduleText);

    var commandText = document.createElement("div");
    commandText.className = "cron-command-text";
    commandText.textContent = entry.command;
    info.appendChild(commandText);

    row.appendChild(info);

    // Right-side controls
    var rightControls = document.createElement("div");
    rightControls.className = "cron-right-controls";

    // Enable/disable toggle switch
    var toggle = api.ui.toggle({
      active: !entry.disabled,
      onChange: function (isActive) {
        if (isActive === entry.disabled) {
          toggleEntry(index);
        }
      },
    });
    toggle.title = entry.disabled ? "Enable this entry" : "Disable this entry";
    rightControls.appendChild(toggle);

    // Triple-dot menu button
    var menuBtn = document.createElement("button");
    menuBtn.className = "tui-btn-icon cron-menu-trigger";
    menuBtn.title = "More actions";
    menuBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>';

    var dropdown = api.ui.dropdown({
      trigger: menuBtn,
      placement: "bottom-end",
      items: [
        {
          label: "Run",
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
          onClick: function () {
            runEntryInTerminal(entry);
          },
        },
        {
          label: "Edit",
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
          onClick: function () {
            openEditForm(index);
          },
        },
        { separator: true },
        {
          label: "Remove",
          variant: "danger",
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
          onClick: function () {
            confirmRemoveEntry(index);
          },
        },
      ],
    });

    addEventListener(menuBtn, "click", function (e) {
      e.stopPropagation();
      dropdown.toggle();
    });

    rightControls.appendChild(menuBtn);
    row.appendChild(rightControls);

    return row;
  }

  // ─── Actions ──────────────────────────────────────────────────────

  function toggleEntry(index) {
    cronEntries[index].disabled = !cronEntries[index].disabled;
    saveCrontab();
  }

  function confirmRemoveEntry(index) {
    var entry = cronEntries[index];
    var schedule = formatSchedule(entry);
    var modal = api.ui.modal({
      title: "Remove Crontab Entry",
      content:
        '<p class="tui-modal-message">Remove this scheduled task?</p>' +
        '<div style="margin-top:8px;padding:8px;background:rgba(255,255,255,0.04);border-radius:6px;font-family:var(--tui-font-mono);font-size:12px;">' +
        '<div style="color:var(--tui-accent-secondary);">' +
        escapeHtml(schedule) +
        "</div>" +
        '<div style="color:var(--tui-text-secondary);margin-top:4px;">' +
        escapeHtml(entry.command) +
        "</div>" +
        "</div>",
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
          },
        },
        {
          label: "Remove",
          variant: "danger",
          onClick: function (m) {
            m.close();
            removeEntry(index);
          },
        },
      ],
    });
    modal.open();
  }

  function removeEntry(index) {
    cronEntries.splice(index, 1);
    saveCrontab();
  }

  function runEntryInTerminal(entry) {
    if (!entry || !entry.command) {
      getToast().show("No command to run", "warning");
      return;
    }
    document.dispatchEvent(
      new CustomEvent("termul:open-terminal-command", {
        detail: { command: entry.command },
      }),
    );
  }

  function openAddForm() {
    editingIndex = -1;
    formTitle.textContent = "Add Crontab Entry";
    clearForm();
    formOverlay.classList.add("active");
    inputMinute.focus();
  }

  function openEditForm(index) {
    editingIndex = index;
    formTitle.textContent = "Edit Crontab Entry";
    var entry = cronEntries[index];

    if (entry.minute.startsWith("@")) {
      inputMinute.value = entry.minute;
      inputHour.value = "";
      inputDom.value = "";
      inputMonth.value = "";
      inputDow.value = "";
    } else {
      inputMinute.value = entry.minute;
      inputHour.value = entry.hour;
      inputDom.value = entry.dom;
      inputMonth.value = entry.month;
      inputDow.value = entry.dow;
    }
    inputCommand.value = entry.command;

    formOverlay.classList.add("active");
    inputMinute.focus();
  }

  function closeForm() {
    formOverlay.classList.remove("active");
    clearForm();
    editingIndex = -1;
  }

  function clearForm() {
    inputMinute.value = "*";
    inputHour.value = "*";
    inputDom.value = "*";
    inputMonth.value = "*";
    inputDow.value = "*";
    inputCommand.value = "";
  }

  function saveForm() {
    var minute = inputMinute.value.trim();
    var hour = inputHour.value.trim();
    var dom = inputDom.value.trim();
    var month = inputMonth.value.trim();
    var dow = inputDow.value.trim();
    var command = inputCommand.value.trim();

    if (!command) {
      getToast().show("Command is required", "warning");
      inputCommand.focus();
      return;
    }

    var entry;

    if (minute.startsWith("@")) {
      var validShortcuts = [
        "@hourly",
        "@daily",
        "@weekly",
        "@monthly",
        "@yearly",
        "@annually",
        "@reboot",
      ];
      if (validShortcuts.indexOf(minute.toLowerCase()) === -1) {
        getToast().show(
          "Invalid schedule shortcut. Use: @hourly, @daily, @weekly, @monthly, @yearly, @reboot",
          "warning",
        );
        inputMinute.focus();
        return;
      }
      entry = {
        minute: minute.toLowerCase(),
        hour: "",
        dom: "",
        month: "",
        dow: "",
        command: command,
        disabled: false,
        raw: "",
      };
    } else {
      if (!minute || !hour || !dom || !month || !dow) {
        getToast().show("All schedule fields are required", "warning");
        return;
      }

      entry = {
        minute: minute,
        hour: hour,
        dom: dom,
        month: month,
        dow: dow,
        command: command,
        disabled: false,
        raw: "",
      };
    }

    if (editingIndex >= 0) {
      entry.disabled = cronEntries[editingIndex].disabled;
      cronEntries[editingIndex] = entry;
    } else {
      cronEntries.push(entry);
    }

    closeForm();
    saveCrontab();
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function showError(message) {
    cronListEl.innerHTML = "";
    var errorDiv = document.createElement("div");
    errorDiv.className = "scheduler-error";
    errorDiv.textContent = message;
    cronListEl.appendChild(errorDiv);
    emptyStateEl.style.display = "none";
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Get DOM references
    toolbarActions = shadow.getElementById("toolbar-actions");
    cronListEl = shadow.getElementById("cron-list");
    emptyStateEl = shadow.getElementById("empty-state");
    formOverlay = shadow.getElementById("cron-form-overlay");
    formTitle = shadow.getElementById("form-title");
    formClose = shadow.getElementById("form-close");
    formCancel = shadow.getElementById("form-cancel");
    formSave = shadow.getElementById("form-save");
    inputMinute = shadow.getElementById("cron-minute");
    inputHour = shadow.getElementById("cron-hour");
    inputDom = shadow.getElementById("cron-dom");
    inputMonth = shadow.getElementById("cron-month");
    inputDow = shadow.getElementById("cron-dow");
    inputCommand = shadow.getElementById("cron-command");
    // Create mode selector using TermulUI component
    var modePlaceholder = shadow.getElementById("crontab-mode");
    modeSelect = api.ui.select({
      options: [
        { value: "user", label: "User Crontab" },
        { value: "root", label: "Root Crontab" },
      ],
      value: crontabMode,
      onChange: function (newMode) {
        if (newMode === crontabMode) return;

        crontabMode = newMode;
        sudoPassword = "";
        passwordSaved = false;
        cronEntries = [];
        renderList();

        if (crontabMode === "root") {
          loadSavedSudoPassword().then(function () {
            fetchCrontab();
          });
        } else {
          fetchCrontab();
        }
      },
    });
    // Replace placeholder with the TermulUI select
    if (modePlaceholder && modePlaceholder.parentNode) {
      modePlaceholder.parentNode.replaceChild(modeSelect, modePlaceholder);
    }

    // Toolbar buttons — insert before the mode selector
    var refreshBtn = api.ui.button({
      label: "Refresh",
      variant: "ghost",
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      onClick: function () {
        fetchCrontab();
      },
    });

    var addBtn = api.ui.button({
      label: "Add Entry",
      variant: "primary",
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      onClick: function () {
        openAddForm();
      },
    });

    toolbarActions.insertBefore(refreshBtn, modeSelect);
    toolbarActions.insertBefore(addBtn, modeSelect);

    // Form events
    addEventListener(formClose, "click", closeForm);
    addEventListener(formCancel, "click", closeForm);
    addEventListener(formSave, "click", saveForm);

    // Don't close form on backdrop click — user must use Cancel/Close/Save buttons
    // This prevents accidental dismissal when clicking outside the form.

    addEventListener(shadow.ownerDocument || document, "keydown", function (e) {
      if (e.key === "Escape" && formOverlay.classList.contains("active")) {
        closeForm();
      }
    });

    addEventListener(inputCommand, "keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        saveForm();
      }
    });

    // Initial load
    fetchCrontab();
  });

  PLUGIN_LIFECYCLE.onUnmount(function () {
    // All tracked listeners, timers, and components are auto-cleaned by the sandbox
  });
})();

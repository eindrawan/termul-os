// Terminal Plugin — SSH Terminal Emulator using xterm.js (v2 lifecycle API)
//
// Available globals from the sandbox:
//   PLUGIN_API       — scoped API with live ssh, profile, events, etc.
//   PLUGIN_LIFECYCLE — register onInit, onMount, onUnmount, onFocus, onBlur
//   PLUGIN_EXPORTS   — object to expose anything to the host
//   shadow           — the ShadowRoot (same as shadowDoc)
//   addEventListener — scoped version tracked for auto-cleanup
//   setTimeout / setInterval / clearTimeout / clearInterval — tracked for auto-cleanup
//
// Global dependencies (loaded by app.js before plugin mounts):
//   window.Terminal    — xterm.js Terminal class
//   window.FitAddon    — xterm.js FitAddon class
//   xterm.css          — injected into shadow DOM by plugin-loader

(function() {
  var api = PLUGIN_API;

  // ─── State ──────────────────────────────────────────────────────────
  var shellStreamId = null;
  var isConnected = false;
  var term = null;         // xterm.js Terminal instance
  var fitAddon = null;     // FitAddon instance
  var resizeObserver = null;

  // Elements (resolved after mount)
  var container, termContainer, statusEl;

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function() {
    container = shadow.querySelector('.terminal-container');
    termContainer = shadow.getElementById('terminal-xterm');
    statusEl = shadow.getElementById('terminal-status');

    if (!container || !termContainer) {
      console.error('[Terminal] Failed to find root elements in shadow DOM');
      return;
    }

    // Check that xterm.js was loaded
    if (!window.Terminal) {
      console.error('[Terminal] xterm.js not loaded — cannot create terminal');
      termContainer.innerHTML = '<div style="padding:20px;color:#ff6b6b;font-family:monospace;">Error: xterm.js library not loaded</div>';
      return;
    }

    // Setup toolbar buttons
    shadow.getElementById('terminal-clear')?.addEventListener('click', clearTerminal);
    shadow.getElementById('terminal-disconnect')?.addEventListener('click', closeShell);

    // Set profile name in toolbar
    var profileNameEl = container.querySelector('.terminal-profile-name');
    var profile = api.profile;
    if (profileNameEl && profile) {
      profileNameEl.textContent = profile.name || profile.host;
    }

    // Create xterm.js Terminal instance
    initTerminal();

    // Start SSH shell
    startShell();
  });

  PLUGIN_LIFECYCLE.onUnmount(function() {
    closeShell();
    destroyTerminal();
  });

  PLUGIN_LIFECYCLE.onFocus(function() {
    if (term) term.focus();
  });

  // ─── xterm.js Initialization ────────────────────────────────────────

  function initTerminal() {
    term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      theme: {
        background: '#0c0c0c',
        foreground: '#cccccc',
        cursor: '#60cdff',
        cursorAccent: '#0c0c0c',
        selectionBackground: '#264f78',
        black: '#0c0c0c',
        red: '#cd3131',
        green: '#00bc00',
        yellow: '#949800',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#555555',
        brightBlack: '#666666',
        brightRed: '#cd3131',
        brightGreen: '#14ce14',
        brightYellow: '#b5ba00',
        brightBlue: '#0451a5',
        brightMagenta: '#bc05bc',
        brightCyan: '#0598bc',
        brightWhite: '#a5a5a5',
      },
      allowProposedApi: true,
    });

    // Create and load FitAddon
    if (window.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }

    // Open the terminal in our container element within the shadow DOM
    term.open(termContainer);

    // Fit to container
    if (fitAddon) {
      fitAddon.fit();
    }

    // Auto-fit on resize using ResizeObserver
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(function() {
        if (fitAddon && term) {
          try { fitAddon.fit(); } catch (e) { /* ignore during teardown */ }
        }
      });
      resizeObserver.observe(termContainer);
    }

    // Wire terminal input → SSH shell
    term.onData(function(data) {
      if (shellStreamId && isConnected) {
        api.ssh.shellWrite(shellStreamId, data);
      }
    });

    // Notify remote shell when terminal dimensions change (e.g. window resize)
    term.onResize(function() {
      resizeShell();
    });
  }

  function destroyTerminal() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (term) {
      term.dispose();
      term = null;
      fitAddon = null;
    }
  }

  // ─── Shell Management ──────────────────────────────────────────────

  async function startShell() {
    var connectionId = api.connectionId;
    if (!connectionId) {
      if (term) term.writeln('\x1b[31mNo active connection\x1b[0m');
      updateStatus(false);
      return;
    }

    try {
      var result = await api.ssh.createShell(connectionId);
      if (result.success) {
        shellStreamId = result.streamId;
        isConnected = true;
        updateStatus(true);

        // Notify xterm of initial terminal size
        resizeShell();

        // Listen for shell data via scoped events
        api.events.on('shell-data', handleShellData);
        api.events.on('shell-closed', handleShellClosed);

        // Fit after shell is ready
        if (fitAddon) {
          setTimeout(function() {
            try { fitAddon.fit(); resizeShell(); } catch (e) {}
          }, 100);
        }

        term.focus();
      } else {
        if (term) term.writeln('\x1b[31mFailed to create shell: ' + result.error + '\x1b[0m');
        updateStatus(false);
      }
    } catch (err) {
      if (term) term.writeln('\x1b[31mFailed to create shell: ' + err.message + '\x1b[0m');
      updateStatus(false);
    }
  }

  function handleShellData(data) {
    if (data.streamId === shellStreamId && isConnected && term) {
      term.write(data.data);
    }
  }

  function handleShellClosed(data) {
    if (data.streamId === shellStreamId) {
      isConnected = false;
      shellStreamId = null;
      updateStatus(false);
      if (term) {
        term.writeln('\r\n\x1b[31mConnection closed\x1b[0m');
      }
    }
  }

  /**
   * Tell the remote shell about the terminal's current dimensions.
   */
  function resizeShell() {
    if (shellStreamId && term) {
      api.ssh.shellResize(shellStreamId, term.cols, term.rows);
    }
  }

  function updateStatus(connected) {
    if (!statusEl) return;
    var dot = statusEl.querySelector('.tui-status-dot');
    var text = statusEl.querySelector('.status-text');
    if (connected) {
      statusEl.classList.remove('disconnected');
      if (dot) { dot.classList.remove('disconnected'); dot.classList.add('connected'); }
      if (text) text.textContent = 'Connected';
    } else {
      statusEl.classList.add('disconnected');
      if (dot) { dot.classList.remove('connected'); dot.classList.add('disconnected'); }
      if (text) text.textContent = 'Disconnected';
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────

  function clearTerminal() {
    if (term) term.clear();
  }

  function closeShell() {
    if (shellStreamId) {
      api.ssh.shellClose(shellStreamId);
    }
    isConnected = false;
    shellStreamId = null;
  }
})();

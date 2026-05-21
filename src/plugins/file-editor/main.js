// File Editor Plugin — Code editor using Monaco Editor
//
// Available globals from the sandbox:
//   PLUGIN_API, PLUGIN_LIFECYCLE, PLUGIN_EXPORTS,
//   shadow, shadowDoc, addEventListener,
//   setTimeout, setInterval, clearTimeout, clearInterval
//
// Global dependencies (loaded by app.js):
//   window.monaco — Monaco Editor object (loaded via monaco:// protocol)

(function () {
  var api = PLUGIN_API;

  // ─── State ──────────────────────────────────────────────────────────
  var openFiles = []; // { id, source, path, name, content, originalContent, language, modified }
  var activeFileId = null;
  var editor = null;
  var resizeObserver = null;

  // Source type: 'local', 'remote', or 'docker'
  var SOURCE_LOCAL = "local";
  var SOURCE_REMOTE = "remote";
  var SOURCE_DOCKER = "docker";

  // Language mapping for file extensions
  var LANGUAGE_MAP = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    pyw: "python",
    css: "css",
    scss: "css",
    less: "css",
    html: "html",
    htm: "html",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    xml: "xml",
    xaml: "xml",
    svg: "xml",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    sql: "sql",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    cs: "csharp",
    go: "go",
    rs: "rust",
    java: "java",
    php: "php",
    rb: "ruby",
    lua: "lua",
    dockerfile: "dockerfile",
    containerfile: "dockerfile",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    txt: "plaintext",
  };

  // ─── Protocol Helper ──────────────────────────────────────────────

  function isFtp() {
    var profile = api.profile;
    return (profile && profile.protocol) === "ftp";
  }

  /**
   * Shell-escape a string for use inside single-quotes in a shell command.
   */
  function dockerShellArg(str) {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
  }

  /**
   * Run a docker exec command via ssh:exec to read/write files inside a container.
   * Handles sudo if needed.
   * @param {string} containerId
   * @param {string} cmd - The command to run inside the container
   * @param {Object} [sudoMeta] - Optional sudo metadata { useSudo, sudoPassword }
   * @returns {Object|null} { success: boolean, stdout: string } or null on failure
   */
  async function dockerExec(containerId, cmd, sudoMeta) {
    if (!api.connectionId) return null;
    var prefix = "docker exec ";
    // Check sudo: first from explicit meta, then from openFiles
    var useSudo = (sudoMeta && sudoMeta.useSudo) || false;
    var sudoPassword = (sudoMeta && sudoMeta.sudoPassword) || "";
    if (!useSudo) {
      var file = openFiles.find(function (f) {
        return f.dockerContainerId === containerId;
      });
      if (file && file.dockerUseSudo) {
        useSudo = true;
        sudoPassword = file.dockerSudoPassword || "";
      }
    }
    if (useSudo) {
      if (sudoPassword) {
        prefix = "echo " + dockerShellArg(sudoPassword) + " | sudo -S docker exec ";
      } else {
        prefix = "sudo -n docker exec ";
      }
    }
    // Append 2>&1 at the docker exec level (not inside the container command)
    // so stderr from both docker and the container command are captured in stdout.
    // This mirrors the docker plugin's dockerCommand() pattern.
    var fullCmd = prefix + containerId + " sh -c " + dockerShellArg(cmd) + " 2>&1";
    try {
      var result = await window.termulAPI.ssh.exec(api.connectionId, fullCmd);
      return result;
    } catch (err) {
      console.error("[FileEditor] docker exec failed:", err);
      return null;
    }
  }

  // DOM element cache
  var els = {};

  // ─── Icons ───────────────────────────────────────────────────────────
  var ICON_LOCAL =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var ICON_REMOTE =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  var ICON_DOCKER =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Cache DOM elements
    els.openLocalBtn = shadow.getElementById("fe-open-local");
    els.openRemoteBtn = shadow.getElementById("fe-open-remote");
    els.saveBtn = shadow.getElementById("fe-save");
    els.languageSelect = shadow.getElementById("fe-language");
    els.tabsScroll = shadow.getElementById("fe-tabs-scroll");
    els.editorArea = shadow.getElementById("fe-editor-area");
    els.editorWrapper = shadow.getElementById("fe-editor-wrapper");
    els.empty = shadow.getElementById("fe-empty");
    els.emptyOpenLocal = shadow.getElementById("fe-empty-open-local");
    els.emptyOpenRemote = shadow.getElementById("fe-empty-open-remote");

    // Status bar elements
    els.statusFile = shadow.getElementById("fe-status-file");
    els.statusModified = shadow.getElementById("fe-status-modified");
    els.statusSource = shadow.getElementById("fe-status-source");
    els.statusLang = shadow.getElementById("fe-status-lang");
    els.statusEncoding = shadow.getElementById("fe-status-encoding");
    els.eolSelect = shadow.getElementById("fe-eol");
    els.statusPosition = shadow.getElementById("fe-status-position");

    // Bind event listeners
    addEventListener(els.openLocalBtn, "click", openLocalFileDialog);
    addEventListener(els.openRemoteBtn, "click", showRemoteFileDialog);
    addEventListener(els.saveBtn, "click", saveCurrentFile);
    addEventListener(els.languageSelect, "change", onLanguageChange);
    addEventListener(els.eolSelect, "change", onEolChange);

    // Empty state buttons
    addEventListener(els.emptyOpenLocal, "click", openLocalFileDialog);
    addEventListener(els.emptyOpenRemote, "click", showRemoteFileDialog);

    // Remote modal events
    // (remote file dialog now uses api.ui.modal — no HTML modal needed)

    // Keyboard shortcut: Ctrl+S to save
    shadow.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        saveCurrentFile();
      }
    });

    // Listen for external "open file" requests (e.g. from file-transfer plugin, docker plugin)
    api.events.on("editor-open-file", function (detail) {
      if (!detail || !detail.path) return;
      externalMeta = detail || null;
      openFileFromExternal(detail.path, detail.source || "local");
    });

    // Also listen for the dedicated Docker file-open event (from Docker plugin file browser)
    addEventListener(document, "termul:editor-open-docker-file", function (e) {
      var detail = e.detail;
      if (!detail || !detail.path) return;
      externalMeta = {
        containerId: detail.containerId,
        containerName: detail.containerName || detail.name || "",
        useSudo: detail.useSudo || false,
        sudoPassword: detail.sudoPassword || ""
      };
      openFileFromExternal(detail.path, "docker");
    });

    // Initialize Monaco when ready
    initMonacoEditor();
  });

  PLUGIN_LIFECYCLE.onFocus(function () {
    // Re-focus the Monaco editor when the window gains focus.
    // Without this, clicking on the editor area does not activate keyboard input.
    // However, we must NOT steal focus if an overlay widget (e.g. the find widget
    // input box) is currently focused, otherwise the user can't type in it.
    if (editor) {
      var activeEl = shadow.activeElement;
      if (activeEl) {
        // Check if the active element is inside a Monaco overlay widget
        // (find widget, replace widget, suggestion list, etc.)
        var widgetHost = activeEl.closest(
          ".editor-widget, .monaco-editor .overlayWidget",
        );
        if (widgetHost) return; // Don't steal focus from overlay widgets
        // Also check for input/textarea inside the find widget by class
        if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")
          return;
      }
      editor.focus();
    }
  });

  PLUGIN_LIFECYCLE.onBlur(function () {
    // No special handling needed on blur — Monaco handles this internally.
  });

  PLUGIN_LIFECYCLE.onUnmount(function () {
    // Cleanup Monaco editor
    if (editor) {
      editor.dispose();
      editor = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  });

  // ─── Monaco Editor Initialization ─────────────────────────────────────

  async function initMonacoEditor() {
    // Wait for Monaco to be loaded by app.js (loaded via IPC during init)
    var maxWait = 100;
    var waited = 0;
    while (!window.monaco && waited < maxWait) {
      await new Promise(function (r) {
        return setTimeout(r, 100);
      });
      waited++;
    }

    if (!window.monaco) {
      els.empty.innerHTML =
        '<div class="fe-loading"><span class="fe-loading-text" style="color:#ff6b6b">Failed to load Monaco Editor</span></div>';
      return;
    }

    // Inject Monaco's static CSS (editor.main.css) into the shadow DOM.
    // Monaco loads its CSS via a <link> in the main document's <head>, but <link>
    // styles are invisible inside shadow DOMs. The CSS is fetched by app.js and
    // stored in PluginLoader._monacoCSS. This includes critical rules for:
    //   - cursor positioning and styling (.cursors-layer .cursor)
    //   - selection highlighting (.selected-text, background-color)
    //   - editor layout (position, overflow, scrolling)
    //   - minimap, scrollbar, and other UI elements
    //
    // Monaco's DYNAMIC theme CSS (CSS custom properties like --vscode-*) is
    // handled automatically — Monaco detects the shadow DOM and injects
    // <style class="monaco-colors"> directly into the shadow root.
    var monacoCSS = window.PluginLoader._monacoCSS;
    if (monacoCSS) {
      var existingStyle = shadow.querySelector("style[data-monaco]");
      if (!existingStyle) {
        var monacoStyle = document.createElement("style");
        monacoStyle.setAttribute("data-monaco", "true");
        monacoStyle.textContent = monacoCSS;
        shadow.insertBefore(monacoStyle, shadow.firstChild);
      }
    } else {
      // Fallback: if the CSS wasn't fetched by app.js, inject a <link> element.
      // This is less reliable (race condition with editor creation) but works
      // as a safety net.
      var baseUrl =
        window.termulAPI && window.termulAPI.monaco
          ? window.termulAPI.monaco.getBaseUrl()
          : "";
      if (baseUrl) {
        var cssLink = document.createElement("link");
        cssLink.rel = "stylesheet";
        cssLink.href = baseUrl + "editor/editor.main.css";
        shadow.insertBefore(cssLink, shadow.firstChild);
      }
    }

    // Create Monaco editor
    editor = window.monaco.editor.create(els.editorArea, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      automaticLayout: false,
      fontSize: 14,
      fontFamily:
        "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      lineNumbers: "on",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: true,
      folding: true,
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true,
      },
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      formatOnPaste: true,
      formatOnType: true,
    });

    // Track content changes for modification detection
    editor.onDidChangeModelContent(function () {
      onContentChanged();
    });

    // Track cursor position for status bar
    editor.onDidChangeCursorPosition(function (e) {
      updateCursorPosition(e.position);
    });

    // Auto-resize on container resize
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(function () {
        if (editor) editor.layout();
      });
      resizeObserver.observe(els.editorArea);
    }

    // Initial layout
    editor.layout();

    // Ensure Monaco's overlay widgets (find/replace input, suggestions, etc.)
    // don't lose focus when clicked. The window manager listens for click events
    // on the container and calls focus() on the window, which triggers our
    // onFocus hook -> editor.focus(). We stop propagation of mousedown AND click
    // events originating from Monaco overlay widgets so the window manager never
    // receives them and doesn't steal focus.
    function shouldStopPropagation(target) {
      // Stop for any input/textarea inside the editor area (find widget, replace, etc.)
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
        return true;
      if (target.closest("input, textarea")) return true;
      // Also stop for clicks on codicon buttons inside the find widget
      if (target.closest(".editor-widget")) return true;
      return false;
    }

    els.editorArea.addEventListener("mousedown", function (e) {
      if (shouldStopPropagation(e.target)) e.stopPropagation();
    });
    els.editorArea.addEventListener("click", function (e) {
      if (shouldStopPropagation(e.target)) e.stopPropagation();
    });
  }

  // ─── File Operations ──────────────────────────────────────────────────

  async function openLocalFileDialog() {
    var result = await window.termulAPI.dialog.openFile({
      title: "Open File",
      filters: [
        { name: "All Files", extensions: ["*"] },
        { name: "Text Files", extensions: ["txt", "md", "csv"] },
        {
          name: "Code",
          extensions: ["js", "ts", "py", "cpp", "c", "go", "rs", "java"],
        },
        { name: "Web", extensions: ["html", "css", "js", "json"] },
        {
          name: "Config",
          extensions: ["yaml", "yml", "json", "ini", "conf", "xml"],
        },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return;

    var filePath = result.filePaths[0];
    await openFile(filePath, SOURCE_LOCAL);
  }

  function showRemoteFileDialog() {
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show("Not connected to SSH server", "error");
      return;
    }
    var modal = api.ui.modal({
      title: "Open Remote File",
      content:
        '<label style="display:block;margin-bottom:6px;font-size:13px;color:var(--tui-text-secondary);">File path on remote server:</label>' +
        '<input type="text" class="tui-input" id="fe-remote-path-input" placeholder="/etc/config.yml" style="width:100%;">',
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
          },
        },
        {
          label: "Open",
          variant: "primary",
          onClick: function (m) {
            var remotePath = m.el
              .querySelector("#fe-remote-path-input")
              .value.trim();
            if (!remotePath) return;
            m.close();
            openFile(remotePath, SOURCE_REMOTE);
          },
        },
      ],
    });
    modal.open();
    setTimeout(function () {
      var input = modal.el.querySelector("#fe-remote-path-input");
      if (input) {
        input.focus();
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            var openBtn = modal.el.querySelector(".tui-btn-primary");
            if (openBtn) openBtn.click();
          }
        });
      }
    }, 50);
  }

  async function openFile(path, source, dockerMeta) {
    // Show loading state
    els.empty.style.display = "flex";
    els.empty.innerHTML =
      '<div class="fe-loading"><div class="tui-spinner"></div><span class="fe-loading-text">Loading file...</span></div>';
    els.editorArea.style.display = "none";

    try {
      var content, language;

      if (source === SOURCE_LOCAL) {
        var result = await window.termulAPI.fs.readFile(path);
        if (!result.success) {
          showError("Failed to read file: " + result.error);
          restoreEditorState();
          return;
        }
        content = result.content;
      } else if (source === SOURCE_DOCKER) {
        // Read file from inside a Docker container via ssh exec
        if (!api.connectionId) {
          showError("Not connected to remote server");
          restoreEditorState();
          return;
        }
        if (!dockerMeta || !dockerMeta.containerId) {
          showError("Missing container ID for Docker file");
          restoreEditorState();
          return;
        }
        var sudoMeta = { useSudo: dockerMeta.useSudo, sudoPassword: dockerMeta.sudoPassword };
        // Read file content using cat (universally available in containers)
        var execResult = await dockerExec(
          dockerMeta.containerId,
          "cat " + dockerShellArg(path),
          sudoMeta
        );
        if (!execResult || !execResult.success) {
          var errMsg = "unknown error";
          if (execResult) {
            // With 2>&1 at docker exec level, stderr is captured in stdout
            if (execResult.stdout) {
              // Filter out sudo password prompts from error display
              var lines = execResult.stdout.split('\n');
              var filtered = lines.filter(function(l) {
                return l.indexOf('[sudo]') === -1 && l.trim().length > 0;
              });
              errMsg = filtered.join('\n').substring(0, 300).trim() || "unknown error";
            }
          }
          showError("Failed to read file from container: " + errMsg);
          restoreEditorState();
          return;
        }
        content = execResult.stdout || "";
        // Strip sudo password prompts that may appear when using sudo -S with 2>&1.
        // These always appear at the beginning of the output before the actual content.
        while (content.indexOf("[sudo]") === 0) {
          var nlIdx = content.indexOf("\n");
          content = nlIdx >= 0 ? content.substring(nlIdx + 1) : "";
        }
      } else {
        if (!api.connectionId) {
          showError("Not connected to remote server");
          restoreEditorState();
          return;
        }
        var result;
        if (isFtp()) {
          result = await window.termulAPI.ftp.readFile(api.connectionId, path);
        } else {
          result = await window.termulAPI.ssh.sftpReadFile(
            api.connectionId,
            path,
          );
        }
        if (!result.success) {
          showError("Failed to read remote file: " + result.error);
          restoreEditorState();
          return;
        }
        content = result.content;
      }

      language = detectLanguage(path);

      var fileName = getFileName(path);
      var fileId = generateFileId();

      var fileData = {
        id: fileId,
        source: source,
        path: path,
        name: fileName,
        content: content,
        originalContent: content,
        language: language,
        eol: detectEol(content),
        modified: false,
        viewState: null,
      };

      // Store Docker metadata for save operations
      if (source === SOURCE_DOCKER && dockerMeta) {
        fileData.dockerContainerId = dockerMeta.containerId;
        fileData.dockerContainerName = dockerMeta.containerName || dockerMeta.name || "";
        fileData.dockerUseSudo = dockerMeta.useSudo || false;
        fileData.dockerSudoPassword = dockerMeta.sudoPassword || "";
      }

      openFiles.push(fileData);
      setActiveFile(fileId);
      renderTabs();
    } catch (err) {
      showError("Failed to open file: " + err.message);
      restoreEditorState();
    }
  }

  /**
   * Open a file from an external request (e.g. file-transfer plugin, docker plugin).
   * Waits for Monaco to be ready before opening.
   */
  async function openFileFromExternal(path, source) {
    // Wait for Monaco editor to be initialized
    if (!editor) {
      // Retry up to 50 times (5 seconds)
      for (var i = 0; i < 50; i++) {
        await new Promise(function (r) {
          return setTimeout(r, 100);
        });
        if (editor) break;
      }
      if (!editor) {
        showError("Editor failed to initialize");
        return;
      }
    }
    // source may be 'docker' or a plain string
    // The detail object is available via the event; use the stored externalMeta
    await openFile(path, source, externalMeta);
  }

  /**
   * Stored metadata from external open-file events (e.g. Docker container info).
   */
  var externalMeta = null;

  async function saveCurrentFile() {
    if (!activeFileId) return;

    var file = openFiles.find(function (f) {
      return f.id === activeFileId;
    });
    if (!file || !file.modified) return;

    try {
      var content = convertEol(editor.getValue(), file.eol);

      if (file.source === SOURCE_LOCAL) {
        var result = await window.termulAPI.fs.writeFile(file.path, content);
        if (!result.success) {
          showError("Failed to save file: " + result.error);
          return;
        }
      } else if (file.source === SOURCE_DOCKER) {
        // Save file inside Docker container via ssh exec
        if (!api.connectionId) {
          showError("Not connected to remote server");
          return;
        }
        if (!file.dockerContainerId) {
          showError("Missing container ID for Docker file");
          return;
        }
        var sudoMeta = { useSudo: file.dockerUseSudo, sudoPassword: file.dockerSudoPassword };
        // Write file content using base64 encoding (avoids shell escaping issues)
        // UTF-8 safe: encode to bytes first, then base64
        var b64Content = btoa(unescape(encodeURIComponent(content)));
        // Note: no 2>&1 here — we don't want base64 errors written INTO the file.
        // The dockerExec-level 2>&1 captures stderr from docker itself.
        var writeCmd = "printf '%s' " + dockerShellArg(b64Content) + " | base64 -d > " + dockerShellArg(file.path);
        var execResult = await dockerExec(file.dockerContainerId, writeCmd, sudoMeta);
        if (!execResult || !execResult.success) {
          // Fallback: try using cat with heredoc if base64 is not available
          var fallbackCmd = "cat > " + dockerShellArg(file.path) + " << 'DOCKERFILEEOF'\n" + content + "\nDOCKERFILEEOF";
          var fallbackResult = await dockerExec(file.dockerContainerId, fallbackCmd, sudoMeta);
          if (!fallbackResult || !fallbackResult.success) {
            showError("Failed to save file in container: " + (execResult && execResult.stdout ? execResult.stdout.substring(0, 200) : "unknown error"));
            return;
          }
        }
      } else {
        if (!api.connectionId) {
          showError("Not connected to remote server");
          return;
        }
        var result;
        if (isFtp()) {
          result = await window.termulAPI.ftp.writeFile(
            api.connectionId,
            file.path,
            content,
          );
        } else {
          result = await window.termulAPI.ssh.sftpWriteFile(
            api.connectionId,
            file.path,
            content,
          );
        }
        if (!result.success) {
          showError("Failed to save remote file: " + result.error);
          return;
        }
      }

      // Update file state
      file.originalContent = content;
      file.modified = false;
      file.content = content;

      // Update UI
      updateTabModified(file.id, false);
      updateStatusBar();

      var toast = api.ui.toast();
      toast.show("File saved: " + file.name, "success");
    } catch (err) {
      showError("Failed to save file: " + err.message);
    }
  }

  function closeFile(fileId) {
    var file = openFiles.find(function (f) {
      return f.id === fileId;
    });
    if (!file) return;

    // Check for unsaved changes
    if (file.modified) {
      confirmCloseFile(file, function (proceed) {
        if (!proceed) return;
        doCloseFile(fileId);
      });
      return;
    }

    doCloseFile(fileId);
  }

  function doCloseFile(fileId) {
    var file = openFiles.find(function (f) {
      return f.id === fileId;
    });
    if (!file) return;
    var idx = openFiles.indexOf(file);
    openFiles.splice(idx, 1);

    if (activeFileId === fileId) {
      if (openFiles.length > 0) {
        var newIdx = Math.min(idx, openFiles.length - 1);
        setActiveFile(openFiles[newIdx].id);
      } else {
        activeFileId = null;
        if (editor) editor.setValue("");
        restoreEmptyState();
      }
    }

    renderTabs();
    updateStatusBar();
  }

  function confirmCloseFile(file, onResult) {
    var modal = api.ui.modal({
      title: "Unsaved Changes",
      content:
        '<p class="tui-modal-message">Save changes to "' +
        escapeHtml(file.name) +
        '" before closing?</p>',
      buttons: [
        {
          label: "Cancel",
          variant: "default",
          onClick: function (m) {
            m.close();
            onResult(false);
          },
        },
        {
          label: "Don't Save",
          variant: "default",
          onClick: function (m) {
            m.close();
            onResult(true);
          },
        },
        {
          label: "Save",
          variant: "primary",
          onClick: function (m) {
            m.close();
            saveCurrentFile().then(function () {
              // Only proceed if save succeeded (file.modified will be false on success)
              var f = openFiles.find(function (x) {
                return x.id === file.id;
              });
              onResult(f ? !f.modified : true);
            });
          },
        },
      ],
    });
    modal.open();
  }

  /**
   * Restore the empty/welcome state after all files are closed or on error.
   */
  function restoreEmptyState() {
    els.editorArea.style.display = "none";
    els.empty.style.display = "flex";
    els.empty.innerHTML =
      '<div class="fe-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div><p class="fe-empty-text">Open a file to start editing</p><div class="fe-empty-shortcuts"><button class="tui-btn tui-btn-default" id="fe-empty-open-local">Open Local File</button><button class="tui-btn tui-btn-default" id="fe-empty-open-remote">Open Remote File</button></div>';
    // Re-bind buttons after innerHTML change
    els.emptyOpenLocal = shadow.getElementById("fe-empty-open-local");
    els.emptyOpenRemote = shadow.getElementById("fe-empty-open-remote");
    addEventListener(els.emptyOpenLocal, "click", openLocalFileDialog);
    addEventListener(els.emptyOpenRemote, "click", showRemoteFileDialog);
  }

  /**
   * Restore the correct editor view after a failed operation.
   * If files are still open, re-show the active file; otherwise show empty state.
   */
  function restoreEditorState() {
    if (openFiles.length > 0 && activeFileId) {
      var file = openFiles.find(function (f) {
        return f.id === activeFileId;
      });
      if (file) {
        els.empty.style.display = "none";
        els.editorArea.style.display = "block";
        if (editor) {
          editor.layout();
        }
        return;
      }
    }
    restoreEmptyState();
  }

  // ─── Tab Management ──────────────────────────────────────────────────

  function renderTabs() {
    var html = "";
    for (var i = 0; i < openFiles.length; i++) {
      var file = openFiles[i];
      var isActive = file.id === activeFileId ? " active" : "";
      var isModified = file.modified ? " modified" : "";
      var sourceIcon = file.source === SOURCE_LOCAL ? ICON_LOCAL : file.source === SOURCE_DOCKER ? ICON_DOCKER : ICON_REMOTE;
      var sourceClass = file.source;

      html +=
        '<div class="fe-tab' +
        isActive +
        isModified +
        '" data-file-id="' +
        file.id +
        '">';
      html +=
        '<div class="fe-tab-icon ' + sourceClass + '">' + sourceIcon + "</div>";
      html += '<span class="fe-tab-name">' + escapeHtml(file.name) + "</span>";
      html += '<span class="fe-tab-dot"></span>';
      html +=
        '<button class="fe-tab-close" title="Close">' +
        ICON_CLOSE +
        "</button>";
      html += "</div>";
    }

    els.tabsScroll.innerHTML = html;

    // Bind tab click events
    var tabs = els.tabsScroll.querySelectorAll(".fe-tab");
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var fileId = tab.getAttribute("data-file-id");

      addEventListener(
        tab,
        "click",
        (function (fid) {
          return function (e) {
            if (!e.target.closest(".fe-tab-close")) {
              setActiveFile(fid);
            }
          };
        })(fileId),
      );

      var closeBtn = tab.querySelector(".fe-tab-close");
      addEventListener(
        closeBtn,
        "click",
        (function (fid) {
          return function (e) {
            e.stopPropagation();
            closeFile(fid);
          };
        })(fileId),
      );
    }
  }

  function setActiveFile(fileId) {
    if (activeFileId === fileId) return;

    // Save scroll/cursor state of the current file before switching away
    if (activeFileId && editor) {
      var prevFile = openFiles.find(function (f) {
        return f.id === activeFileId;
      });
      if (prevFile) {
        prevFile.viewState = editor.saveViewState();
        prevFile.content = editor.getValue();
      }
    }

    activeFileId = fileId;
    var file = openFiles.find(function (f) {
      return f.id === fileId;
    });

    if (!file) {
      els.editorArea.style.display = "none";
      els.empty.style.display = "flex";
      return;
    }

    // Update editor
    els.empty.style.display = "none";
    els.editorArea.style.display = "block";

    if (editor) {
      var model = editor.getModel();
      if (model) {
        window.monaco.editor.setModelLanguage(model, file.language);
      }
      editor.setValue(file.content);

      // Apply EOL setting for this file
      applyEolToModel(file.eol);

      // Restore scroll position and cursor for this file
      if (file.viewState) {
        editor.restoreViewState(file.viewState);
      }
    }

    // Update language selector
    els.languageSelect.value = file.language;

    // Update EOL selector
    els.eolSelect.value = file.eol;
    els.eolSelect.disabled = false;

    // Update tabs
    renderTabs();

    // Update status bar
    updateStatusBar();

    // Layout and focus the editor after the browser has rendered the display change.
    // The editor was created while the container was hidden (display:none), so
    // an explicit layout() is required after showing it.
    setTimeout(function () {
      if (editor) {
        editor.layout();
        editor.focus();
      }
    }, 50);
  }

  function updateTabModified(fileId, modified) {
    var file = openFiles.find(function (f) {
      return f.id === fileId;
    });
    if (file) {
      file.modified = modified;
      var tab = els.tabsScroll.querySelector(
        '.fe-tab[data-file-id="' + fileId + '"]',
      );
      if (tab) {
        if (modified) {
          tab.classList.add("modified");
        } else {
          tab.classList.remove("modified");
        }
      }
    }
  }

  // ─── Editor Event Handlers ────────────────────────────────────────────

  function onContentChanged() {
    if (!activeFileId) return;

    var file = openFiles.find(function (f) {
      return f.id === activeFileId;
    });
    if (!file) return;

    var currentContent = editor.getValue();
    var isModified = currentContent !== file.originalContent;

    if (file.modified !== isModified) {
      updateTabModified(file.id, isModified);
      updateStatusBar();
    }
  }

  function onLanguageChange() {
    if (!activeFileId) return;

    var newLanguage = els.languageSelect.value;
    var file = openFiles.find(function (f) {
      return f.id === activeFileId;
    });

    if (file && file.language !== newLanguage) {
      file.language = newLanguage;
      if (editor) {
        var model = editor.getModel();
        window.monaco.editor.setModelLanguage(model, newLanguage);
      }
      updateStatusBar();
    }
  }

  function onEolChange() {
    if (!activeFileId) return;

    var newEol = els.eolSelect.value;
    var file = openFiles.find(function (f) {
      return f.id === activeFileId;
    });

    if (file && file.eol !== newEol) {
      file.eol = newEol;
      applyEolToModel(newEol);
      updateStatusBar();
    }
  }

  function updateCursorPosition(position) {
    if (els.statusPosition) {
      els.statusPosition.textContent =
        "Ln " + position.lineNumber + ", Col " + position.column;
    }
  }

  // ─── Status Bar ──────────────────────────────────────────────────────

  function updateStatusBar() {
    if (!activeFileId) {
      els.statusFile.textContent = "No file open";
      els.statusModified.textContent = "";
      els.statusSource.textContent = "—";
      els.statusLang.textContent = "Plain Text";
      els.eolSelect.value = "lf";
      els.eolSelect.disabled = true;
      return;
    }

    var file = openFiles.find(function (f) {
      return f.id === activeFileId;
    });
    if (!file) return;

    els.statusFile.textContent = file.name;
    els.statusModified.textContent = file.modified ? "● Modified" : "";
    els.statusSource.textContent =
      file.source === SOURCE_LOCAL ? "Local" : file.source === SOURCE_DOCKER ? "Docker: " + (file.dockerContainerName || file.dockerContainerId || "").substring(0, 20) : "Remote";
    els.statusLang.textContent = getLanguageDisplayName(file.language);
    els.eolSelect.value = file.eol;
    els.eolSelect.disabled = false;
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  function detectLanguage(filePath) {
    var ext = getFileExtension(filePath);
    return LANGUAGE_MAP[ext] || "plaintext";
  }

  function detectEol(content) {
    if (!content) return "lf";
    if (content.indexOf("\r\n") !== -1) return "crlf";
    return "lf";
  }

  function applyEolToModel(eol) {
    if (!editor || !window.monaco) return;
    var model = editor.getModel();
    if (!model) return;
    var eolValue =
      eol === "crlf"
        ? window.monaco.editor.EndOfLineSequence.CRLF
        : window.monaco.editor.EndOfLineSequence.LF;
    model.setEOL(eolValue);
  }

  function convertEol(content, targetEol) {
    // Normalize to LF first, then convert to target
    var normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (targetEol === "crlf") {
      return normalized.replace(/\n/g, "\r\n");
    }
    return normalized;
  }

  function getFileExtension(filePath) {
    var parts = filePath.split(".");
    if (parts.length < 2) return "";
    return parts[parts.length - 1].toLowerCase();
  }

  function getFileName(filePath) {
    var parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  function generateFileId() {
    return "file_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  function getLanguageDisplayName(lang) {
    var names = {
      plaintext: "Plain Text",
      javascript: "JavaScript",
      typescript: "TypeScript",
      python: "Python",
      css: "CSS",
      html: "HTML",
      json: "JSON",
      markdown: "Markdown",
      xml: "XML",
      yaml: "YAML",
      shell: "Shell",
      sql: "SQL",
      c: "C",
      cpp: "C++",
      csharp: "C#",
      go: "Go",
      rust: "Rust",
      java: "Java",
      php: "PHP",
      ruby: "Ruby",
      lua: "Lua",
      dockerfile: "Dockerfile",
      ini: "INI",
    };
    return names[lang] || lang;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showError(message) {
    var toast = api.ui.toast();
    toast.show(message, "error");
  }
})();

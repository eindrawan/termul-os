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
  var openFiles = [];           // { id, source, path, name, content, originalContent, language, modified }
  var activeFileId = null;
  var editor = null;
  var resizeObserver = null;

  // Source type: 'local' or 'remote'
  var SOURCE_LOCAL = 'local';
  var SOURCE_REMOTE = 'remote';

  // Language mapping for file extensions
  var LANGUAGE_MAP = {
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'pyw': 'python',
    'css': 'css', 'scss': 'css', 'less': 'css',
    'html': 'html', 'htm': 'html',
    'json': 'json',
    'md': 'markdown', 'markdown': 'markdown',
    'xml': 'xml', 'xaml': 'xml', 'svg': 'xml',
    'yaml': 'yaml', 'yml': 'yaml',
    'sh': 'shell', 'bash': 'shell', 'zsh': 'shell', 'fish': 'shell',
    'sql': 'sql',
    'c': 'c', 'h': 'c',
    'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'php': 'php',
    'rb': 'ruby',
    'lua': 'lua',
    'dockerfile': 'dockerfile', 'containerfile': 'dockerfile',
    'ini': 'ini', 'cfg': 'ini', 'conf': 'ini',
    'txt': 'plaintext',
  };

  // DOM element cache
  var els = {};

  // ─── Icons ───────────────────────────────────────────────────────────
  var ICON_LOCAL = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var ICON_REMOTE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  var ICON_CLOSE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Cache DOM elements
    els.openLocalBtn = shadow.getElementById('fe-open-local');
    els.openRemoteBtn = shadow.getElementById('fe-open-remote');
    els.saveBtn = shadow.getElementById('fe-save');
    els.languageSelect = shadow.getElementById('fe-language');
    els.tabsScroll = shadow.getElementById('fe-tabs-scroll');
    els.editorArea = shadow.getElementById('fe-editor-area');
    els.editorWrapper = shadow.getElementById('fe-editor-wrapper');
    els.empty = shadow.getElementById('fe-empty');
    els.emptyOpenLocal = shadow.getElementById('fe-empty-open-local');
    els.emptyOpenRemote = shadow.getElementById('fe-empty-open-remote');

    // Status bar elements
    els.statusFile = shadow.getElementById('fe-status-file');
    els.statusModified = shadow.getElementById('fe-status-modified');
    els.statusSource = shadow.getElementById('fe-status-source');
    els.statusLang = shadow.getElementById('fe-status-lang');
    els.statusEncoding = shadow.getElementById('fe-status-encoding');
    els.statusPosition = shadow.getElementById('fe-status-position');

    // Remote modal elements
    els.remoteModal = shadow.getElementById('fe-remote-modal');
    els.remotePathInput = shadow.getElementById('fe-remote-path');
    els.remoteOk = shadow.getElementById('fe-remote-ok');
    els.remoteCancel = shadow.getElementById('fe-remote-cancel');
    els.remoteClose = shadow.getElementById('fe-remote-modal-close');

    // Bind event listeners
    addEventListener(els.openLocalBtn, 'click', openLocalFileDialog);
    addEventListener(els.openRemoteBtn, 'click', showRemoteFileDialog);
    addEventListener(els.saveBtn, 'click', saveCurrentFile);
    addEventListener(els.languageSelect, 'change', onLanguageChange);

    // Empty state buttons
    addEventListener(els.emptyOpenLocal, 'click', openLocalFileDialog);
    addEventListener(els.emptyOpenRemote, 'click', showRemoteFileDialog);

    // Remote modal events
    addEventListener(els.remoteOk, 'click', openRemoteFile);
    addEventListener(els.remoteCancel, 'click', hideRemoteFileDialog);
    addEventListener(els.remoteClose, 'click', hideRemoteFileDialog);
    addEventListener(els.remotePathInput, 'keydown', function (e) {
      if (e.key === 'Enter') openRemoteFile();
      if (e.key === 'Escape') hideRemoteFileDialog();
    });

    // Keyboard shortcut: Ctrl+S to save
    shadow.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
      }
    });

    // Listen for external "open file" requests (e.g. from file-transfer plugin)
    api.events.on('editor-open-file', function (detail) {
      if (!detail || !detail.path) return;
      openFileFromExternal(detail.path, detail.source || 'local');
    });

    // Initialize Monaco when ready
    initMonacoEditor();
  });

  PLUGIN_LIFECYCLE.onFocus(function () {
    // Re-focus the Monaco editor when the window gains focus.
    // Without this, clicking on the editor area does not activate keyboard input.
    if (editor) editor.focus();
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
      await new Promise(function (r) { return setTimeout(r, 100); });
      waited++;
    }

    if (!window.monaco) {
      els.empty.innerHTML = '<div class="fe-loading"><span class="fe-loading-text" style="color:#ff6b6b">Failed to load Monaco Editor</span></div>';
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
      var existingStyle = shadow.querySelector('style[data-monaco]');
      if (!existingStyle) {
        var monacoStyle = document.createElement('style');
        monacoStyle.setAttribute('data-monaco', 'true');
        monacoStyle.textContent = monacoCSS;
        shadow.insertBefore(monacoStyle, shadow.firstChild);
      }
    } else {
      // Fallback: if the CSS wasn't fetched by app.js, inject a <link> element.
      // This is less reliable (race condition with editor creation) but works
      // as a safety net.
      var baseUrl = window.termulAPI && window.termulAPI.monaco
        ? window.termulAPI.monaco.getBaseUrl()
        : '';
      if (baseUrl) {
        var cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = baseUrl + 'editor/editor.main.css';
        shadow.insertBefore(cssLink, shadow.firstChild);
      }
    }

    // Create Monaco editor
    editor = window.monaco.editor.create(els.editorArea, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: false,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      lineNumbers: 'on',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
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
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
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
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(function () {
        if (editor) editor.layout();
      });
      resizeObserver.observe(els.editorArea);
    }

    // Initial layout
    editor.layout();
  }

  // ─── File Operations ──────────────────────────────────────────────────

  async function openLocalFileDialog() {
    var result = await window.termulAPI.dialog.openFile({
      title: 'Open File',
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Text Files', extensions: ['txt', 'md', 'csv'] },
        { name: 'Code', extensions: ['js', 'ts', 'py', 'cpp', 'c', 'go', 'rs', 'java'] },
        { name: 'Web', extensions: ['html', 'css', 'js', 'json'] },
        { name: 'Config', extensions: ['yaml', 'yml', 'json', 'ini', 'conf', 'xml'] },
      ]
    });

    if (result.canceled || result.filePaths.length === 0) return;

    var filePath = result.filePaths[0];
    await openFile(filePath, SOURCE_LOCAL);
  }

  function showRemoteFileDialog() {
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show('Not connected to SSH server', 'error');
      return;
    }
    els.remotePathInput.value = '';
    els.remoteModal.classList.add('open');
    els.remotePathInput.focus();
  }

  function hideRemoteFileDialog() {
    els.remoteModal.classList.remove('open');
  }

  async function openRemoteFile() {
    var remotePath = els.remotePathInput.value.trim();
    if (!remotePath) return;

    hideRemoteFileDialog();
    await openFile(remotePath, SOURCE_REMOTE);
  }

  async function openFile(path, source) {
    // Show loading state
    els.empty.style.display = 'flex';
    els.empty.innerHTML = '<div class="fe-loading"><div class="tui-spinner"></div><span class="fe-loading-text">Loading file...</span></div>';
    els.editorArea.style.display = 'none';

    try {
      var content, language;

      if (source === SOURCE_LOCAL) {
        var result = await window.termulAPI.fs.readFile(path);
        if (!result.success) {
          showError('Failed to read file: ' + result.error);
          restoreEditorState();
          return;
        }
        content = result.content;
      } else {
        if (!api.connectionId) {
          showError('Not connected to SSH server');
          restoreEditorState();
          return;
        }
        var result = await window.termulAPI.ssh.sftpReadFile(api.connectionId, path);
        if (!result.success) {
          showError('Failed to read remote file: ' + result.error);
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
        modified: false
      };

      openFiles.push(fileData);
      setActiveFile(fileId);
      renderTabs();

    } catch (err) {
      showError('Failed to open file: ' + err.message);
      restoreEditorState();
    }
  }

  /**
   * Open a file from an external request (e.g. file-transfer plugin).
   * Waits for Monaco to be ready before opening.
   */
  async function openFileFromExternal(path, source) {
    // Wait for Monaco editor to be initialized
    if (!editor) {
      // Retry up to 50 times (5 seconds)
      for (var i = 0; i < 50; i++) {
        await new Promise(function (r) { return setTimeout(r, 100); });
        if (editor) break;
      }
      if (!editor) {
        showError('Editor failed to initialize');
        return;
      }
    }
    await openFile(path, source);
  }

  async function saveCurrentFile() {
    if (!activeFileId) return;

    var file = openFiles.find(function (f) { return f.id === activeFileId; });
    if (!file || !file.modified) return;

    try {
      var content = editor.getValue();

      if (file.source === SOURCE_LOCAL) {
        var result = await window.termulAPI.fs.writeFile(file.path, content);
        if (!result.success) {
          showError('Failed to save file: ' + result.error);
          return;
        }
      } else {
        if (!api.connectionId) {
          showError('Not connected to SSH server');
          return;
        }
        var result = await window.termulAPI.ssh.sftpWriteFile(api.connectionId, file.path, content);
        if (!result.success) {
          showError('Failed to save remote file: ' + result.error);
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
      toast.show('File saved: ' + file.name, 'success');

    } catch (err) {
      showError('Failed to save file: ' + err.message);
    }
  }

  function closeFile(fileId) {
    var file = openFiles.find(function (f) { return f.id === fileId; });
    if (!file) return;

    // Check for unsaved changes
    if (file.modified) {
      var confirmed = confirmCloseFile(file);
      if (!confirmed) return;
    }

    var idx = openFiles.indexOf(file);
    openFiles.splice(idx, 1);

    if (activeFileId === fileId) {
      if (openFiles.length > 0) {
        var newIdx = Math.min(idx, openFiles.length - 1);
        setActiveFile(openFiles[newIdx].id);
      } else {
        activeFileId = null;
        if (editor) editor.setValue('');
        restoreEmptyState();
      }
    }

    renderTabs();
    updateStatusBar();
  }

  function confirmCloseFile(file) {
    // Simple implementation - could be a modal dialog
    return window.confirm('Save changes to "' + file.name + '" before closing?');
  }

  /**
   * Restore the empty/welcome state after all files are closed or on error.
   */
  function restoreEmptyState() {
    els.editorArea.style.display = 'none';
    els.empty.style.display = 'flex';
    els.empty.innerHTML = '<div class="fe-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div><p class="fe-empty-text">Open a file to start editing</p><div class="fe-empty-shortcuts"><button class="tui-btn tui-btn-default" id="fe-empty-open-local">Open Local File</button><button class="tui-btn tui-btn-default" id="fe-empty-open-remote">Open Remote File</button></div>';
    // Re-bind buttons after innerHTML change
    els.emptyOpenLocal = shadow.getElementById('fe-empty-open-local');
    els.emptyOpenRemote = shadow.getElementById('fe-empty-open-remote');
    addEventListener(els.emptyOpenLocal, 'click', openLocalFileDialog);
    addEventListener(els.emptyOpenRemote, 'click', showRemoteFileDialog);
  }

  /**
   * Restore the correct editor view after a failed operation.
   * If files are still open, re-show the active file; otherwise show empty state.
   */
  function restoreEditorState() {
    if (openFiles.length > 0 && activeFileId) {
      var file = openFiles.find(function (f) { return f.id === activeFileId; });
      if (file) {
        els.empty.style.display = 'none';
        els.editorArea.style.display = 'block';
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
    var html = '';
    for (var i = 0; i < openFiles.length; i++) {
      var file = openFiles[i];
      var isActive = file.id === activeFileId ? ' active' : '';
      var isModified = file.modified ? ' modified' : '';
      var sourceIcon = file.source === SOURCE_LOCAL ? ICON_LOCAL : ICON_REMOTE;

      html += '<div class="fe-tab' + isActive + isModified + '" data-file-id="' + file.id + '">';
      html += '<div class="fe-tab-icon ' + file.source + '">' + sourceIcon + '</div>';
      html += '<span class="fe-tab-name">' + escapeHtml(file.name) + '</span>';
      html += '<span class="fe-tab-dot"></span>';
      html += '<button class="fe-tab-close" title="Close">' + ICON_CLOSE + '</button>';
      html += '</div>';
    }

    els.tabsScroll.innerHTML = html;

    // Bind tab click events
    var tabs = els.tabsScroll.querySelectorAll('.fe-tab');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var fileId = tab.getAttribute('data-file-id');

      addEventListener(tab, 'click', function (fid) {
        return function (e) {
          if (!e.target.closest('.fe-tab-close')) {
            setActiveFile(fid);
          }
        };
      }(fileId));

      var closeBtn = tab.querySelector('.fe-tab-close');
      addEventListener(closeBtn, 'click', function (fid) {
        return function (e) {
          e.stopPropagation();
          closeFile(fid);
        };
      }(fileId));
    }
  }

  function setActiveFile(fileId) {
    if (activeFileId === fileId) return;

    activeFileId = fileId;
    var file = openFiles.find(function (f) { return f.id === fileId; });

    if (!file) {
      els.editorArea.style.display = 'none';
      els.empty.style.display = 'flex';
      return;
    }

    // Update editor
    els.empty.style.display = 'none';
    els.editorArea.style.display = 'block';

    if (editor) {
      var model = editor.getModel();
      if (model) {
        window.monaco.editor.setModelLanguage(model, file.language);
      }
      editor.setValue(file.content);
    }

    // Update language selector
    els.languageSelect.value = file.language;

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
    var file = openFiles.find(function (f) { return f.id === fileId; });
    if (file) {
      file.modified = modified;
      var tab = els.tabsScroll.querySelector('.fe-tab[data-file-id="' + fileId + '"]');
      if (tab) {
        if (modified) {
          tab.classList.add('modified');
        } else {
          tab.classList.remove('modified');
        }
      }
    }
  }

  // ─── Editor Event Handlers ────────────────────────────────────────────

  function onContentChanged() {
    if (!activeFileId) return;

    var file = openFiles.find(function (f) { return f.id === activeFileId; });
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
    var file = openFiles.find(function (f) { return f.id === activeFileId; });

    if (file && file.language !== newLanguage) {
      file.language = newLanguage;
      if (editor) {
        var model = editor.getModel();
        window.monaco.editor.setModelLanguage(model, newLanguage);
      }
      updateStatusBar();
    }
  }

  function updateCursorPosition(position) {
    if (els.statusPosition) {
      els.statusPosition.textContent = 'Ln ' + position.lineNumber + ', Col ' + position.column;
    }
  }

  // ─── Status Bar ──────────────────────────────────────────────────────

  function updateStatusBar() {
    if (!activeFileId) {
      els.statusFile.textContent = 'No file open';
      els.statusModified.textContent = '';
      els.statusSource.textContent = '—';
      els.statusLang.textContent = 'Plain Text';
      return;
    }

    var file = openFiles.find(function (f) { return f.id === activeFileId; });
    if (!file) return;

    els.statusFile.textContent = file.name;
    els.statusModified.textContent = file.modified ? '● Modified' : '';
    els.statusSource.textContent = file.source === SOURCE_LOCAL ? 'Local' : 'Remote';
    els.statusLang.textContent = getLanguageDisplayName(file.language);
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  function detectLanguage(filePath) {
    var ext = getFileExtension(filePath);
    return LANGUAGE_MAP[ext] || 'plaintext';
  }

  function getFileExtension(filePath) {
    var parts = filePath.split('.');
    if (parts.length < 2) return '';
    return parts[parts.length - 1].toLowerCase();
  }

  function getFileName(filePath) {
    var parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  function generateFileId() {
    return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function getLanguageDisplayName(lang) {
    var names = {
      'plaintext': 'Plain Text',
      'javascript': 'JavaScript',
      'typescript': 'TypeScript',
      'python': 'Python',
      'css': 'CSS',
      'html': 'HTML',
      'json': 'JSON',
      'markdown': 'Markdown',
      'xml': 'XML',
      'yaml': 'YAML',
      'shell': 'Shell',
      'sql': 'SQL',
      'c': 'C',
      'cpp': 'C++',
      'csharp': 'C#',
      'go': 'Go',
      'rust': 'Rust',
      'java': 'Java',
      'php': 'PHP',
      'ruby': 'Ruby',
      'lua': 'Lua',
      'dockerfile': 'Dockerfile',
      'ini': 'INI'
    };
    return names[lang] || lang;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showError(message) {
    var toast = api.ui.toast();
    toast.show(message, 'error');
  }

})();

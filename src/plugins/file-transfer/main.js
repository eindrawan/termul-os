// File Transfer Plugin — WinSCP-like dual-pane SFTP/FTP manager
//
// Available globals from the sandbox:
//   PLUGIN_API, PLUGIN_LIFECYCLE, PLUGIN_EXPORTS,
//   shadow, shadowDoc, addEventListener,
//   setTimeout, setInterval, clearTimeout, clearInterval
//
// Additional APIs used via PLUGIN_API (termulAPI):
//   SSH: api.ssh.sftpListDir, sftpDownload, sftpUpload, sftpMkdir, sftpDelete,
//        sftpRmdir, sftpRename, sftpHome, sftpStat
//   FTP: api.ftp.listDir, ftp.download, ftp.upload, ftp.mkdir, ftp.delete,
//        ftp.rmdir, ftp.rename, ftp.home
//   api.events.on('sftp-progress', ...) / api.events.on('ftp-progress', ...)
//   (exposed via preload: termulAPI.ssh.sftp*, termulAPI.ftp.*, termulAPI.fs.*)

(function () {
  var api = PLUGIN_API;

  // ─── State ──────────────────────────────────────────────────────────
  var localPath = '';
  var remotePath = '';
  var localEntries = [];
  var remoteEntries = [];
  var selectedLocal = {};   // name → true
  var selectedRemote = {};  // name → true
  var lastClickedLocal = null;
  var lastClickedRemote = null;
  var userDirs = null;
  var transferQueue = [];
  var transferCounter = 0;
  var isTransferring = false;
  var activePane = 'local';  // 'local' or 'remote' - last focused pane

  // Sort state per pane: { key: 'name'|'size'|'date', dir: 'asc'|'desc' }
  var localSort = { key: 'name', dir: 'asc' };
  var remoteSort = { key: 'name', dir: 'asc' };

  // Cached sorted arrays (updated on each render, used for range selection)
  var localSorted = [];
  var remoteSorted = [];

  // ─── SVG Icons ──────────────────────────────────────────────────────
  var ICONS = {
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    parent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
    upload: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    download: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 16 12 21 17 16"/><line x1="12" y1="21" x2="12" y2="9"/></svg>',
  };

  // ─── Protocol Detection ──────────────────────────────────────────────

  /**
   * Detect the protocol ('ssh' or 'ftp') from the current profile.
   */
  function getProtocol() {
    var profile = api.profile;
    return (profile && profile.protocol) || 'ssh';
  }

  /**
   * Check if current connection is FTP.
   */
  function isFtp() {
    return getProtocol() === 'ftp';
  }

  // ─── DOM References (resolved in onMount) ───────────────────────────
  var els = {};

  // ─── Prompt Modal ───────────────────────────────────────────────────
  var modalResolve = null;

  // ─── Context Menu ────────────────────────────────────────────────────
  var ctxVisible = false;
  var ctxPane = 'local'; // which pane the context menu was opened on

  // ─── Text File Detection ────────────────────────────────────────────
  var TEXT_EXTENSIONS = {
    'txt': true, 'md': true, 'markdown': true, 'rst': true, 'adoc': true, 'org': true,
    'json': true, 'jsonc': true, 'json5': true, 'yaml': true, 'yml': true, 'toml': true,
    'xml': true, 'xaml': true, 'svg': true, 'html': true, 'htm': true, 'xhtml': true,
    'css': true, 'scss': true, 'less': true, 'sass': true, 'styl': true,
    'js': true, 'jsx': true, 'mjs': true, 'cjs': true, 'ts': true, 'tsx': true,
    'py': true, 'pyw': true, 'rb': true, 'rbw': true,
    'go': true, 'rs': true, 'java': true, 'kt': true, 'kts': true, 'scala': true,
    'c': true, 'h': true, 'cpp': true, 'cc': true, 'cxx': true, 'hpp': true, 'hxx': true,
    'cs': true, 'vb': true, 'fs': true, 'fsx': true,
    'php': true, 'phtml': true, 'blade': true,
    'sh': true, 'bash': true, 'zsh': true, 'fish': true, 'ps1': true, 'psm1': true, 'bat': true, 'cmd': true,
    'sql': true, 'plsql': true, 'pgsql': true,
    'lua': true, 'r': true, 'jl': true, 'ex': true, 'exs': true, 'erl': true, 'hrl': true,
    'dart': true, 'swift': true, 'm': true, 'mm': true,
    'vim': true, 'el': true, 'clj': true, 'cljs': true, 'hs': true, 'ml': true, 'mli': true,
    'dockerfile': true, 'containerfile': true, 'makefile': true, 'cmake': true,
    'gitignore': true, 'editorconfig': true, 'env': true, 'properties': true,
    'ini': true, 'cfg': true, 'conf': true, 'config': true,
    'log': true, 'csv': true, 'tsv': true,
    'npmrc': true, 'babelrc': true, 'eslintrc': true, 'prettierrc': true,
  };

  function isTextFile(entry) {
    if (!entry || !entry.isFile) return false;
    var name = entry.name || '';
    // Check by extension
    var dotIdx = name.lastIndexOf('.');
    if (dotIdx >= 0) {
      var ext = name.substring(dotIdx + 1).toLowerCase();
      if (TEXT_EXTENSIONS[ext]) return true;
    }
    // Check filenames without extensions (common config files)
    var lower = name.toLowerCase();
    var TEXT_FILENAMES = [
      'readme', 'license', 'copying', 'authors', 'contributors', 'changelog',
      'makefile', 'dockerfile', 'containerfile', 'vagrantfile', 'gemfile',
      'rakefile', 'procfile', 'brewfile', 'podfile', 'fastfile',
      'cmakelists', 'cmakelist', 'jenkinsfile', '.gitignore', '.editorconfig',
      '.env', '.npmrc', '.babelrc', '.eslintrc', '.prettierrc', '.eslintrc.js',
      '.prettierrc.js', '.gitattributes', '.gitmodules',
    ];
    for (var i = 0; i < TEXT_FILENAMES.length; i++) {
      if (lower === TEXT_FILENAMES[i]) return true;
    }
    return false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Cache all DOM references
    els.localPane = shadow.getElementById('ft-local-pane');
    els.remotePane = shadow.getElementById('ft-remote-pane');
    els.localPath = shadow.getElementById('ft-local-path');
    els.remotePath = shadow.getElementById('ft-remote-path');
    els.localBody = shadow.getElementById('ft-local-body');
    els.remoteBody = shadow.getElementById('ft-remote-body');
    els.localStatus = shadow.getElementById('ft-local-status');
    els.remoteStatus = shadow.getElementById('ft-remote-status');
    els.localGo = shadow.getElementById('ft-local-go');
    els.remoteGo = shadow.getElementById('ft-remote-go');
    els.localUp = shadow.getElementById('ft-local-up');
    els.remoteUp = shadow.getElementById('ft-remote-up');
    els.localHome = shadow.getElementById('ft-local-home');
    els.remoteHome = shadow.getElementById('ft-remote-home');
    els.refreshAll = shadow.getElementById('ft-refresh-all');
    els.uploadBtn = shadow.getElementById('ft-upload-btn');
    els.downloadBtn = shadow.getElementById('ft-download-btn');
    els.addFileBtn = shadow.getElementById('ft-add-file-btn');
    els.addFolderBtn = shadow.getElementById('ft-add-folder-btn');
    els.deleteBtn = shadow.getElementById('ft-delete-btn');
    els.queueToggle = shadow.getElementById('ft-queue-toggle');
    els.queueList = shadow.getElementById('ft-queue-list');
    els.queueCount = shadow.getElementById('ft-queue-count');

    // Modal elements
    els.modalBackdrop = shadow.getElementById('ft-modal-backdrop');
    els.modalTitle = shadow.getElementById('ft-modal-title');
    els.modalLabel = shadow.getElementById('ft-modal-label');
    els.modalInput = shadow.getElementById('ft-modal-input');
    els.modalOk = shadow.getElementById('ft-modal-ok');
    els.modalCancel = shadow.getElementById('ft-modal-cancel');

    // Context menu elements
    els.ctx = shadow.getElementById('ft-ctx');
    els.ctxOpen = shadow.getElementById('ft-ctx-open');
    els.ctxUpload = shadow.getElementById('ft-ctx-upload');
    els.ctxDownload = shadow.getElementById('ft-ctx-download');
    els.ctxNewFile = shadow.getElementById('ft-ctx-new-file');
    els.ctxNewFolder = shadow.getElementById('ft-ctx-new-folder');
    els.ctxDelete = shadow.getElementById('ft-ctx-delete');

    // Bind events
    addEventListener(els.localGo, 'click', function () { navigateLocal(els.localPath.value.trim()); });
    addEventListener(els.remoteGo, 'click', function () { navigateRemote(els.remotePath.value.trim()); });
    addEventListener(els.localUp, 'click', goUpLocal);
    addEventListener(els.remoteUp, 'click', goUpRemote);
    addEventListener(els.localHome, 'click', goHomeLocal);
    addEventListener(els.remoteHome, 'click', goHomeRemote);
    addEventListener(els.refreshAll, 'click', refreshBoth);
    addEventListener(els.uploadBtn, 'click', uploadSelected);
    addEventListener(els.downloadBtn, 'click', downloadSelected);
    addEventListener(els.addFileBtn, 'click', addNewFile);
    addEventListener(els.addFolderBtn, 'click', addNewFolder);
    addEventListener(els.deleteBtn, 'click', deleteSelected);
    addEventListener(els.queueToggle, 'click', toggleQueue);

    // Enter key on path inputs
    addEventListener(els.localPath, 'keydown', function (e) {
      if (e.key === 'Enter') navigateLocal(els.localPath.value.trim());
    });
    addEventListener(els.remotePath, 'keydown', function (e) {
      if (e.key === 'Enter') navigateRemote(els.remotePath.value.trim());
    });

    // Bind sortable column header clicks
    var sortHeaders = shadow.querySelectorAll('.ft-sortable');
    for (var h = 0; h < sortHeaders.length; h++) {
      addEventListener(sortHeaders[h], 'click', handleSortClick);
    }

    // Pane focus tracking
    addEventListener(els.localPane, 'click', function () { setActivePane('local'); });
    addEventListener(els.remotePane, 'click', function () { setActivePane('remote'); });

    // Modal events
    addEventListener(els.modalOk, 'click', modalOk);
    addEventListener(els.modalCancel, 'click', modalCancel);
    addEventListener(els.modalInput, 'keydown', function (e) {
      if (e.key === 'Enter') modalOk();
      if (e.key === 'Escape') modalCancel();
    });

    // Context menu — right-click on file body areas
    addEventListener(els.localBody, 'contextmenu', function (e) { handleContextMenu(e, 'local'); });
    addEventListener(els.remoteBody, 'contextmenu', function (e) { handleContextMenu(e, 'remote'); });

    // Context menu — item clicks
    addEventListener(els.ctxOpen, 'click', function () { hideCtx(); openSelectedFile(); });
    addEventListener(els.ctxUpload, 'click', function () { hideCtx(); uploadSelected(); });
    addEventListener(els.ctxDownload, 'click', function () { hideCtx(); downloadSelected(); });
    addEventListener(els.ctxNewFile, 'click', function () { hideCtx(); addNewFile(); });
    addEventListener(els.ctxNewFolder, 'click', function () { hideCtx(); addNewFolder(); });
    addEventListener(els.ctxDelete, 'click', function () { hideCtx(); deleteSelected(); });

    // Dismiss context menu on any click outside
    addEventListener(shadow.querySelector('.ft-container'), 'click', function (e) {
      if (ctxVisible && !els.ctx.contains(e.target)) hideCtx();
    });

    // Dismiss context menu on Escape
    addEventListener(shadow.querySelector('.ft-container'), 'keydown', function (e) {
      if (e.key === 'Escape' && ctxVisible) { hideCtx(); e.preventDefault(); }
    });

    // Listen for SFTP progress
    api.events.on('sftp-progress', handleProgress);

    // Listen for FTP progress
    api.events.on('ftp-progress', handleProgress);

    // Set initial active pane
    setActivePane('local');

    // Initialize
    initLocal();
    initRemote();
  });

  PLUGIN_LIFECYCLE.onUnmount(function () {
    // Cleanup is handled automatically by the plugin system
  });

  // ─── Sorting ────────────────────────────────────────────────────────

  /**
   * Handle click on a sortable column header.
   */
  function handleSortClick(e) {
    var el = e.currentTarget;
    var pane = el.getAttribute('data-pane');
    var key = el.getAttribute('data-sort');

    if (pane === 'local') {
      if (localSort.key === key) {
        localSort.dir = localSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        localSort.key = key;
        localSort.dir = 'asc';
      }
      renderLocalList();
    } else if (pane === 'remote') {
      if (remoteSort.key === key) {
        remoteSort.dir = remoteSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        remoteSort.key = key;
        remoteSort.dir = 'asc';
      }
      renderRemoteList();
    }
  }

  /**
   * Sort an entries array: directories always first, then by the given key/direction.
   * Returns a new sorted array (does not mutate original).
   */
  function sortEntries(entries, sort) {
    var sorted = entries.slice();
    var key = sort.key;
    var dirMul = sort.dir === 'asc' ? 1 : -1;

    sorted.sort(function (a, b) {
      // Directories always come first regardless of sort key
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      var aVal, bVal;

      if (key === 'name') {
        aVal = (a.name || '').toLowerCase();
        bVal = (b.name || '').toLowerCase();
        var cmp = aVal.localeCompare(bVal);
        return cmp * dirMul;
      } else if (key === 'size') {
        aVal = a.size || 0;
        bVal = b.size || 0;
        return (aVal - bVal) * dirMul;
      } else if (key === 'date') {
        aVal = a.modifyTime || 0;
        bVal = b.modifyTime || 0;
        return (aVal - bVal) * dirMul;
      }

      return 0;
    });

    return sorted;
  }

  /**
   * Update sort indicator CSS classes on column headers.
   */
  function updateSortIndicators(pane) {
    var sort = pane === 'local' ? localSort : remoteSort;
    var headers = shadow.querySelectorAll('.ft-sortable[data-pane="' + pane + '"]');

    for (var i = 0; i < headers.length; i++) {
      var el = headers[i];
      el.classList.remove('ft-sort-asc', 'ft-sort-desc', 'ft-sort-active');
      if (el.getAttribute('data-sort') === sort.key) {
        el.classList.add('ft-sort-' + sort.dir);
        el.classList.add('ft-sort-active');
      }
    }
  }

  // ─── Active Pane ─────────────────────────────────────────────────────

  function setActivePane(pane) {
    activePane = pane;
    if (pane === 'local') {
      els.localPane.classList.add('ft-active');
      els.remotePane.classList.remove('ft-active');
    } else {
      els.localPane.classList.remove('ft-active');
      els.remotePane.classList.add('ft-active');
    }
    updateActionButtons();
  }

  function updateActionButtons() {
    // Update delete button based on selection in active pane
    var selection = activePane === 'local' ? selectedLocal : selectedRemote;
    var hasSelection = Object.keys(selection).length > 0;
    els.deleteBtn.disabled = !hasSelection;
  }

  // ─── Prompt Modal ───────────────────────────────────────────────────

  function promptUser(title, label, defaultValue) {
    return new Promise(function (resolve) {
      modalResolve = resolve;
      els.modalTitle.textContent = title;
      els.modalLabel.textContent = label;
      els.modalInput.value = defaultValue || '';
      els.modalInput.style.display = '';
      els.modalLabel.style.display = '';
      els.modalBackdrop.classList.add('tui-modal-open');
      els.modalInput.focus();
      els.modalInput.select();
    });
  }

  function confirmUser(title, message) {
    return new Promise(function (resolve) {
      modalResolve = resolve;
      els.modalTitle.textContent = title;
      els.modalLabel.textContent = message;
      els.modalInput.style.display = 'none';
      els.modalBackdrop.classList.add('tui-modal-open');
      els.modalOk.focus();
    });
  }

  function modalOk() {
    var isConfirm = els.modalInput.style.display === 'none';
    els.modalBackdrop.classList.remove('tui-modal-open');
    if (modalResolve) {
      modalResolve(isConfirm ? true : els.modalInput.value.trim());
      modalResolve = null;
    }
  }

  function modalCancel() {
    els.modalBackdrop.classList.remove('tui-modal-open');
    if (modalResolve) {
      modalResolve(null);
      modalResolve = null;
    }
  }

  // ─── Context Menu ────────────────────────────────────────────────────

  function handleContextMenu(e, pane) {
    e.preventDefault();
    e.stopPropagation();

    ctxPane = pane;
    setActivePane(pane);

    // If right-clicked on a row that is not selected, select it first
    var row = e.target.closest('.ft-row');
    if (row && row.getAttribute('data-name')) {
      var name = row.getAttribute('data-name');
      var selection = pane === 'local' ? selectedLocal : selectedRemote;
      if (!selection[name]) {
        if (pane === 'local') {
          clearLocalSelection();
          toggleLocalSelection(name, row);
        } else {
          clearRemoteSelection();
          toggleRemoteSelection(name, row);
        }
      }
    }

    updateCtxItems();
    showCtx(e.clientX, e.clientY);
  }

  function updateCtxItems() {
    var selection = ctxPane === 'local' ? selectedLocal : selectedRemote;
    var entries = ctxPane === 'local' ? localEntries : remoteEntries;
    var hasSelection = Object.keys(selection).length > 0;
    var hasLocalFiles = hasSelection && ctxPane === 'local' && getSelectedLocalFiles().length > 0;
    var hasRemoteFiles = hasSelection && ctxPane === 'remote' && getSelectedRemoteFiles().length > 0;

    // "Open" — only show when exactly one text file is selected
    var canOpen = false;
    var selectedNames = Object.keys(selection);
    if (selectedNames.length === 1) {
      var entry = findEntryByName(entries, selectedNames[0]);
      if (entry && isTextFile(entry)) {
        canOpen = true;
      }
    }
    els.ctxOpen.disabled = !canOpen;
    els.ctxOpen.style.display = '';

    els.ctxUpload.disabled = !hasLocalFiles;
    els.ctxDownload.disabled = !hasRemoteFiles;
    els.ctxDelete.disabled = !hasSelection;

    // Show/hide transfer items based on pane
    var isLocal = ctxPane === 'local';
    els.ctxUpload.style.display = isLocal ? '' : 'none';
    els.ctxDownload.style.display = isLocal ? 'none' : '';
  }

  function findEntryByName(entries, name) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === name) return entries[i];
    }
    return null;
  }

  function showCtx(x, y) {
    hideCtx();

    // Position the menu, ensuring it stays within bounds
    var container = shadow.querySelector('.ft-container');
    var rect = container.getBoundingClientRect();
    var menuW = 200;
    var menuH = 200; // estimated

    var left = x - rect.left;
    var top = y - rect.top;

    if (left + menuW > rect.width) left = rect.width - menuW - 4;
    if (top + menuH > rect.height) top = rect.height - menuH - 4;
    if (left < 0) left = 4;
    if (top < 0) top = 4;

    els.ctx.style.left = left + 'px';
    els.ctx.style.top = top + 'px';
    els.ctx.classList.add('ft-ctx-open');
    ctxVisible = true;
  }

  function hideCtx() {
    if (els.ctx) els.ctx.classList.remove('ft-ctx-open');
    ctxVisible = false;
  }

  // ─── Local FS Operations ────────────────────────────────────────────

  async function initLocal() {
    try {
      userDirs = await window.termulAPI.fs.userDirs();
      localPath = userDirs.home || '/';
    } catch (e) {
      localPath = '/';
    }
    await loadLocalDir(localPath);
  }

  async function loadLocalDir(dirPath) {
    setLocalStatus('Loading...');
    els.localBody.innerHTML = '<div class="ft-loading"><div class="tui-spinner"></div><span>Loading...</span></div>';

    try {
      var result = await window.termulAPI.fs.listDir(dirPath);
      if (!result.success) {
        showLocalError(result.error);
        return;
      }
      localPath = result.path;
      localEntries = result.entries;
      els.localPath.value = localPath;
      renderLocalList();
      var fileCount = localEntries.filter(function (e) { return e.isFile; }).length;
      var dirCount = localEntries.filter(function (e) { return e.isDirectory; }).length;
      setLocalStatus(dirCount + ' folders, ' + fileCount + ' files');
    } catch (e) {
      showLocalError(e.message);
    }
  }

  function renderLocalList() {
    selectedLocal = {};
    lastClickedLocal = null;
    localSorted = sortEntries(localEntries, localSort);
    var html = '';

    // Parent directory entry
    html += '<div class="ft-row ft-parent-dir" data-action="parent-local">' +
      '<div class="ft-row-name"><div class="ft-icon ft-icon-parent">' + ICONS.parent + '</div><span class="ft-row-name-text">..</span></div>' +
      '<div class="ft-row-size"></div><div class="ft-row-date"></div></div>';

    for (var i = 0; i < localSorted.length; i++) {
      var entry = localSorted[i];
      var iconClass = entry.isDirectory ? 'ft-icon-folder' : 'ft-icon-file';
      var iconSvg = entry.isDirectory ? ICONS.folder : ICONS.file;
      var sizeStr = entry.isFile ? formatSize(entry.size) : '';
      var dateStr = entry.modifyTime ? formatDate(entry.modifyTime) : '';

      html += '<div class="ft-row" data-name="' + escapeAttr(entry.name) + '" data-index="' + i + '">' +
        '<div class="ft-row-name"><div class="ft-icon ' + iconClass + '">' + iconSvg + '</div>' +
        '<span class="ft-row-name-text">' + escapeHtml(entry.name) + '</span></div>' +
        '<div class="ft-row-size">' + sizeStr + '</div>' +
        '<div class="ft-row-date">' + dateStr + '</div></div>';
    }

    els.localBody.innerHTML = html;
    updateSortIndicators('local');
    updateActionButtons();

    // Bind click events on rows
    var rows = els.localBody.querySelectorAll('.ft-row');
    for (var r = 0; r < rows.length; r++) {
      addEventListener(rows[r], 'click', handleLocalRowClick);
      addEventListener(rows[r], 'dblclick', handleLocalRowDblClick);
    }
  }

  function handleLocalRowClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute('data-action') === 'parent-local') return;

    var name = row.getAttribute('data-name');
    if (!name) return;

    if (e.ctrlKey || e.metaKey) {
      // Toggle selection
      toggleLocalSelection(name, row);
    } else if (e.shiftKey && lastClickedLocal) {
      // Range selection — uses sorted display order
      var startIdx = findLocalSortedIndex(lastClickedLocal);
      var endIdx = findLocalSortedIndex(name);
      if (startIdx >= 0 && endIdx >= 0) {
        var lo = Math.min(startIdx, endIdx);
        var hi = Math.max(startIdx, endIdx);
        clearLocalSelection();
        for (var i = lo; i <= hi; i++) {
          toggleLocalSelection(localSorted[i].name, getLocalRowByName(localSorted[i].name));
        }
      }
    } else {
      clearLocalSelection();
      toggleLocalSelection(name, row);
    }
    lastClickedLocal = name;
    setActivePane('local');
  }

  function handleLocalRowDblClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute('data-action') === 'parent-local') {
      goUpLocal();
      return;
    }
    var name = row.getAttribute('data-name');
    if (!name) return;
    var entry = findLocalEntry(name);
    if (!entry) return;
    if (entry.isDirectory) {
      loadLocalDir(entry.path);
    } else if (isTextFile(entry)) {
      // Open text files in the editor
      ctxPane = 'local';
      clearLocalSelection();
      toggleLocalSelection(name, row);
      openSelectedFile();
    }
  }

  function findLocalEntry(name) {
    for (var i = 0; i < localEntries.length; i++) {
      if (localEntries[i].name === name) return localEntries[i];
    }
    return null;
  }

  function findLocalIndex(name) {
    for (var i = 0; i < localEntries.length; i++) {
      if (localEntries[i].name === name) return i;
    }
    return -1;
  }

  function findLocalSortedIndex(name) {
    for (var i = 0; i < localSorted.length; i++) {
      if (localSorted[i].name === name) return i;
    }
    return -1;
  }

  function getLocalRowByName(name) {
    return els.localBody.querySelector('.ft-row[data-name="' + CSS.escape(name) + '"]');
  }

  function toggleLocalSelection(name, row) {
    if (selectedLocal[name]) {
      delete selectedLocal[name];
      if (row) row.classList.remove('ft-selected');
    } else {
      selectedLocal[name] = true;
      if (row) row.classList.add('ft-selected');
    }
  }

  function clearLocalSelection() {
    selectedLocal = {};
    var sel = els.localBody.querySelectorAll('.ft-row.ft-selected');
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove('ft-selected');
  }

  function navigateLocal(path) {
    if (path) loadLocalDir(path);
  }

  function goUpLocal() {
    if (!localPath) return;
    // Use ".." segment — backend path.resolve handles both Unix and Windows
    loadLocalDir(localPath + '/..');
  }

  function goHomeLocal() {
    if (userDirs && userDirs.home) {
      loadLocalDir(userDirs.home);
    }
  }

  function showLocalError(msg) {
    els.localBody.innerHTML = '<div class="ft-error">' + escapeHtml(msg || 'Error') + '</div>';
    setLocalStatus('Error');
  }

  function setLocalStatus(msg) {
    if (els.localStatus) els.localStatus.textContent = msg;
  }

  // ─── Remote FS Operations ───────────────────────────────────────────

  async function initRemote() {
    if (!api.connectionId) {
      showRemoteError(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server');
      els.remotePath.value = '';
      return;
    }
    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.home(api.connectionId);
      } else {
        result = await window.termulAPI.ssh.sftpHome(api.connectionId);
      }
      if (result.success) {
        remotePath = result.path;
      } else {
        remotePath = '/';
      }
    } catch (e) {
      remotePath = '/';
    }
    await loadRemoteDir(remotePath);
  }

  async function loadRemoteDir(dirPath) {
    if (!api.connectionId) {
      showRemoteError('Not connected');
      return;
    }
    setRemoteStatus('Loading...');
    els.remoteBody.innerHTML = '<div class="ft-loading"><div class="tui-spinner"></div><span>Loading...</span></div>';

    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.listDir(api.connectionId, dirPath);
      } else {
        result = await window.termulAPI.ssh.sftpListDir(api.connectionId, dirPath);
      }
      if (!result.success) {
        showRemoteError(result.error);
        return;
      }
      remotePath = dirPath;
      remoteEntries = result.entries;
      els.remotePath.value = remotePath;
      renderRemoteList();
      var fileCount = remoteEntries.filter(function (e) { return e.isFile; }).length;
      var dirCount = remoteEntries.filter(function (e) { return e.isDirectory; }).length;
      setRemoteStatus(dirCount + ' folders, ' + fileCount + ' files');
    } catch (e) {
      showRemoteError(e.message);
    }
  }

  function renderRemoteList() {
    selectedRemote = {};
    lastClickedRemote = null;
    remoteSorted = sortEntries(remoteEntries, remoteSort);
    var html = '';

    // Parent directory entry
    html += '<div class="ft-row ft-parent-dir" data-action="parent-remote">' +
      '<div class="ft-row-name"><div class="ft-icon ft-icon-parent">' + ICONS.parent + '</div><span class="ft-row-name-text">..</span></div>' +
      '<div class="ft-row-size"></div><div class="ft-row-date"></div></div>';

    for (var i = 0; i < remoteSorted.length; i++) {
      var entry = remoteSorted[i];
      var iconClass = entry.isDirectory ? 'ft-icon-folder' : 'ft-icon-file';
      var iconSvg = entry.isDirectory ? ICONS.folder : ICONS.file;
      var sizeStr = entry.isFile ? formatSize(entry.size) : '';
      var dateStr = entry.modifyTime ? formatDate(entry.modifyTime) : '';

      html += '<div class="ft-row" data-name="' + escapeAttr(entry.name) + '" data-index="' + i + '">' +
        '<div class="ft-row-name"><div class="ft-icon ' + iconClass + '">' + iconSvg + '</div>' +
        '<span class="ft-row-name-text">' + escapeHtml(entry.name) + '</span></div>' +
        '<div class="ft-row-size">' + sizeStr + '</div>' +
        '<div class="ft-row-date">' + dateStr + '</div></div>';
    }

    els.remoteBody.innerHTML = html;
    updateSortIndicators('remote');
    updateActionButtons();

    // Bind click events on rows
    var rows = els.remoteBody.querySelectorAll('.ft-row');
    for (var r = 0; r < rows.length; r++) {
      addEventListener(rows[r], 'click', handleRemoteRowClick);
      addEventListener(rows[r], 'dblclick', handleRemoteRowDblClick);
    }
  }

  function handleRemoteRowClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute('data-action') === 'parent-remote') return;

    var name = row.getAttribute('data-name');
    if (!name) return;

    if (e.ctrlKey || e.metaKey) {
      toggleRemoteSelection(name, row);
    } else if (e.shiftKey && lastClickedRemote) {
      // Range selection — uses sorted display order
      var startIdx = findRemoteSortedIndex(lastClickedRemote);
      var endIdx = findRemoteSortedIndex(name);
      if (startIdx >= 0 && endIdx >= 0) {
        var lo = Math.min(startIdx, endIdx);
        var hi = Math.max(startIdx, endIdx);
        clearRemoteSelection();
        for (var i = lo; i <= hi; i++) {
          toggleRemoteSelection(remoteSorted[i].name, getRemoteRowByName(remoteSorted[i].name));
        }
      }
    } else {
      clearRemoteSelection();
      toggleRemoteSelection(name, row);
    }
    lastClickedRemote = name;
    setActivePane('remote');
  }

  function handleRemoteRowDblClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute('data-action') === 'parent-remote') {
      goUpRemote();
      return;
    }
    var name = row.getAttribute('data-name');
    if (!name) return;
    var entry = findRemoteEntry(name);
    if (!entry) return;
    if (entry.isDirectory) {
      loadRemoteDir(entry.path);
    } else if (isTextFile(entry)) {
      // Open text files in the editor
      ctxPane = 'remote';
      clearRemoteSelection();
      toggleRemoteSelection(name, row);
      openSelectedFile();
    }
  }

  function findRemoteEntry(name) {
    for (var i = 0; i < remoteEntries.length; i++) {
      if (remoteEntries[i].name === name) return remoteEntries[i];
    }
    return null;
  }

  function findRemoteIndex(name) {
    for (var i = 0; i < remoteEntries.length; i++) {
      if (remoteEntries[i].name === name) return i;
    }
    return -1;
  }

  function findRemoteSortedIndex(name) {
    for (var i = 0; i < remoteSorted.length; i++) {
      if (remoteSorted[i].name === name) return i;
    }
    return -1;
  }

  function getRemoteRowByName(name) {
    return els.remoteBody.querySelector('.ft-row[data-name="' + CSS.escape(name) + '"]');
  }

  function toggleRemoteSelection(name, row) {
    if (selectedRemote[name]) {
      delete selectedRemote[name];
      if (row) row.classList.remove('ft-selected');
    } else {
      selectedRemote[name] = true;
      if (row) row.classList.add('ft-selected');
    }
  }

  function clearRemoteSelection() {
    selectedRemote = {};
    var sel = els.remoteBody.querySelectorAll('.ft-row.ft-selected');
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove('ft-selected');
  }

  function navigateRemote(path) {
    if (path) loadRemoteDir(path);
  }

  function goUpRemote() {
    if (!remotePath || remotePath === '/') return;
    var parts = remotePath.split('/');
    parts.pop();
    var parent = parts.join('/') || '/';
    loadRemoteDir(parent);
  }

  async function goHomeRemote() {
    if (!api.connectionId) return;
    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.home(api.connectionId);
      } else {
        result = await window.termulAPI.ssh.sftpHome(api.connectionId);
      }
      if (result.success) loadRemoteDir(result.path);
    } catch (e) {}
  }

  function showRemoteError(msg) {
    els.remoteBody.innerHTML = '<div class="ft-error">' + escapeHtml(msg || 'Error') + '</div>';
    setRemoteStatus('Error');
  }

  function setRemoteStatus(msg) {
    if (els.remoteStatus) els.remoteStatus.textContent = msg;
  }

  // ─── Transfer Operations ────────────────────────────────────────────

  function updateTransferButtons() {
    var hasLocalSelection = Object.keys(selectedLocal).length > 0;
    var hasRemoteSelection = Object.keys(selectedRemote).length > 0;
    // Only enable if we have file selections (not dirs)
    var hasLocalFiles = hasLocalSelection && getSelectedLocalFiles().length > 0;
    var hasRemoteFiles = hasRemoteSelection && getSelectedRemoteFiles().length > 0;
    els.uploadBtn.disabled = !hasLocalFiles;
    els.downloadBtn.disabled = !hasRemoteFiles;
  }

  function getSelectedLocalFiles() {
    var files = [];
    var names = Object.keys(selectedLocal);
    for (var i = 0; i < names.length; i++) {
      var entry = findLocalEntry(names[i]);
      if (entry && entry.isFile) files.push(entry);
    }
    return files;
  }

  function getSelectedRemoteFiles() {
    var files = [];
    var names = Object.keys(selectedRemote);
    for (var i = 0; i < names.length; i++) {
      var entry = findRemoteEntry(names[i]);
      if (entry && entry.isFile) files.push(entry);
    }
    return files;
  }

  function getSelectedItems() {
    var selection = activePane === 'local' ? selectedLocal : selectedRemote;
    var entries = activePane === 'local' ? localEntries : remoteEntries;
    var items = [];
    var names = Object.keys(selection);
    for (var i = 0; i < names.length; i++) {
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].name === names[i]) {
          items.push(entries[j]);
          break;
        }
      }
    }
    return items;
  }

  function uploadSelected() {
    var files = getSelectedLocalFiles();
    if (files.length === 0) return;
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server', 'error');
      return;
    }

    for (var i = 0; i < files.length; i++) {
      var remoteFilePath = joinRemotePath(remotePath, files[i].name);
      addTransfer('upload', files[i].name, files[i].path, remoteFilePath, files[i].size);
    }

    clearLocalSelection();
    updateTransferButtons();
    processQueue();
  }

  function downloadSelected() {
    var files = getSelectedRemoteFiles();
    if (files.length === 0) return;
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server', 'error');
      return;
    }

    for (var i = 0; i < files.length; i++) {
      var localFilePath = joinLocalPath(localPath, files[i].name);
      addTransfer('download', files[i].name, files[i].path, localFilePath, files[i].size);
    }

    clearRemoteSelection();
    updateTransferButtons();
    processQueue();
  }

  function addTransfer(type, name, sourcePath, destPath, size) {
    transferCounter++;
    var transfer = {
      id: 'xfer_' + transferCounter,
      type: type,
      name: name,
      source: sourcePath,
      dest: destPath,
      size: size || 0,
      percent: 0,
      status: 'pending',
      error: null,
    };
    transferQueue.push(transfer);
    renderQueueItem(transfer);
    updateQueueCount();
  }

  function renderQueueItem(transfer) {
    var iconClass = transfer.type === 'upload' ? 'ft-icon-upload' : 'ft-icon-download';
    var iconSvg = transfer.type === 'upload' ? ICONS.upload : ICONS.download;
    var statusText = 'Queued';

    var html = '<div class="ft-queue-item" id="queue-' + transfer.id + '">' +
      '<div class="ft-queue-item-icon ' + iconClass + '">' + iconSvg + '</div>' +
      '<div class="ft-queue-item-info">' +
      '<div class="ft-queue-item-name">' + escapeHtml(transfer.name) + '</div>' +
      '<div class="ft-queue-item-progress">' +
      '<div class="ft-queue-item-bar"><div class="ft-queue-item-bar-fill" id="bar-' + transfer.id + '" style="width:0%"></div></div>' +
      '<span class="ft-queue-item-percent" id="pct-' + transfer.id + '">0%</span>' +
      '</div></div>' +
      '<div class="ft-queue-item-status" id="status-' + transfer.id + '">' + statusText + '</div>' +
      '</div>';

    // Remove empty message if present
    var emptyMsg = els.queueList.querySelector('.ft-queue-empty');
    if (emptyMsg) emptyMsg.remove();

    els.queueList.insertAdjacentHTML('beforeend', html);
  }

  async function processQueue() {
    if (isTransferring) return;
    isTransferring = true;

    while (transferQueue.length > 0) {
      var transfer = transferQueue[0];

      // Update status to active
      updateQueueItemStatus(transfer.id, 'Transferring...', '');

      try {
        var result;
        if (transfer.type === 'upload') {
          if (isFtp()) {
            result = await window.termulAPI.ftp.upload(
              api.connectionId, transfer.source, transfer.dest, transfer.id
            );
          } else {
            result = await window.termulAPI.ssh.sftpUpload(
              api.connectionId, transfer.source, transfer.dest, transfer.id
            );
          }
        } else {
          if (isFtp()) {
            result = await window.termulAPI.ftp.download(
              api.connectionId, transfer.source, transfer.dest, transfer.id
            );
          } else {
            result = await window.termulAPI.ssh.sftpDownload(
              api.connectionId, transfer.source, transfer.dest, transfer.id
            );
          }
        }

        if (result.success) {
          updateQueueItemStatus(transfer.id, 'Complete', 'ft-complete');
          updateQueueItemBar(transfer.id, 100, 'ft-complete');
          updateQueueItemPercent(transfer.id, '100%');
        } else {
          updateQueueItemStatus(transfer.id, result.error || 'Failed', 'ft-error');
          updateQueueItemBar(transfer.id, transfer.percent, 'ft-error');
        }
      } catch (e) {
        updateQueueItemStatus(transfer.id, e.message || 'Error', 'ft-error');
        updateQueueItemBar(transfer.id, transfer.percent, 'ft-error');
      }

      transferQueue.shift();
      updateQueueCount();
    }

    isTransferring = false;

    // Refresh both panes after all transfers complete
    refreshBoth();
  }

  function handleProgress(data) {
    // Find the transfer in the queue by transferId
    for (var i = 0; i < transferQueue.length; i++) {
      if (transferQueue[i].id === data.transferId) {
        transferQueue[i].percent = data.percent;
        updateQueueItemPercent(data.transferId, data.percent + '%');
        updateQueueItemBar(data.transferId, data.percent, '');
        break;
      }
    }
  }

  function updateQueueItemStatus(id, text, cls) {
    var el = shadow.getElementById('status-' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'ft-queue-item-status';
    if (cls) el.classList.add(cls);
  }

  function updateQueueItemBar(id, percent, cls) {
    var el = shadow.getElementById('bar-' + id);
    if (!el) return;
    el.style.width = Math.min(100, Math.max(0, percent)) + '%';
    el.className = 'ft-queue-item-bar-fill';
    if (cls) el.classList.add(cls);
  }

  function updateQueueItemPercent(id, text) {
    var el = shadow.getElementById('pct-' + id);
    if (el) el.textContent = text;
  }

  function updateQueueCount() {
    var count = transferQueue.length;
    if (els.queueCount) {
      els.queueCount.textContent = count + ' transfer' + (count !== 1 ? 's' : '');
    }
    if (count === 0 && els.queueList) {
      var emptyMsg = els.queueList.querySelector('.ft-queue-empty');
      if (!emptyMsg) {
        els.queueList.innerHTML = '<div class="ft-queue-empty">No active transfers</div>';
      }
    }
  }

  function toggleQueue() {
    var section = shadow.querySelector('.ft-queue-section');
    if (section) section.classList.toggle('ft-collapsed');
  }

  // ─── File Operations (Add File, Add Folder, Delete) ────────────────

  async function addNewFile() {
    if (activePane === 'remote' && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server', 'error');
      return;
    }

    var name = await promptUser(
      activePane === 'local' ? 'Create New File (Local)' : 'Create New File (Remote)',
      'File name:',
      'new_file.txt'
    );
    if (!name) return;

    if (activePane === 'local') {
      var targetPath = joinLocalPath(localPath, name);
      try {
        var result = await window.termulAPI.fs.createFile(targetPath);
        if (!result.success) {
          toast = api.ui.toast();
          toast.show(result.error || 'Failed to create file', 'error');
        } else {
          loadLocalDir(localPath);
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || 'Failed to create file', 'error');
      }
    } else {
      // Remote
      var remoteFilePath = joinRemotePath(remotePath, name);
      if (isFtp()) {
        // FTP: write empty content to create file
        try {
          var result = await window.termulAPI.ftp.writeFile(api.connectionId, remoteFilePath, '');
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || 'Failed to create file', 'error');
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || 'Failed to create file', 'error');
        }
      } else {
        // SSH: use touch via ssh:exec
        var remotePathEsc = shellQuote(remoteFilePath);
        try {
          var result = await window.termulAPI.ssh.exec(api.connectionId, 'touch ' + remotePathEsc);
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || 'Failed to create file', 'error');
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || 'Failed to create file', 'error');
        }
      }
    }
  }

  async function addNewFolder() {
    if (activePane === 'remote' && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server', 'error');
      return;
    }

    var name = await promptUser(
      activePane === 'local' ? 'Create New Folder (Local)' : 'Create New Folder (Remote)',
      'Folder name:',
      'new_folder'
    );
    if (!name) return;

    if (activePane === 'local') {
      var targetPath = joinLocalPath(localPath, name);
      try {
        var result = await window.termulAPI.fs.mkdir(targetPath);
        if (!result.success) {
          toast = api.ui.toast();
          toast.show(result.error || 'Failed to create folder', 'error');
        } else {
          loadLocalDir(localPath);
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || 'Failed to create folder', 'error');
      }
    } else {
      // Remote
      var remoteFolderPath = joinRemotePath(remotePath, name);
      if (isFtp()) {
        // FTP: use FTP mkdir
        try {
          var result = await window.termulAPI.ftp.mkdir(api.connectionId, remoteFolderPath);
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || 'Failed to create folder', 'error');
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || 'Failed to create folder', 'error');
        }
      } else {
        // SSH: use mkdir -p via ssh:exec
        var remotePathEsc = shellQuote(remoteFolderPath);
        try {
          var result = await window.termulAPI.ssh.exec(api.connectionId, 'mkdir -p ' + remotePathEsc);
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || 'Failed to create folder', 'error');
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || 'Failed to create folder', 'error');
        }
      }
    }
  }

  async function deleteSelected() {
    var items = getSelectedItems();
    if (items.length === 0) return;

    var names = items.map(function (it) { return it.name; });
    var preview = names.length <= 5
      ? names.join(', ')
      : names.slice(0, 5).join(', ') + ' and ' + (names.length - 5) + ' more';

    var confirmed = await confirmUser(
      'Delete ' + items.length + ' item' + (items.length !== 1 ? 's' : '') + '?',
      preview
    );

    if (!confirmed) return;

    if (activePane === 'local') {
      // Delete local files/dirs one by one
      for (var i = 0; i < items.length; i++) {
        try {
          var result = await window.termulAPI.fs.deletePath(items[i].path);
          if (!result.success) {
            var toast = api.ui.toast();
            toast.show('Failed to delete ' + items[i].name + ': ' + (result.error || 'Unknown error'), 'error');
          }
        } catch (e) {}
      }
      loadLocalDir(localPath);
    } else {
      if (!api.connectionId) {
        var toast = api.ui.toast();
        toast.show(isFtp() ? 'Not connected to FTP server' : 'Not connected to SSH server', 'error');
        return;
      }

      if (isFtp()) {
        // FTP: delete items one by one (FTP doesn't support batch commands)
        for (var j = 0; j < items.length; j++) {
          try {
            if (items[j].isDirectory) {
              var result = await window.termulAPI.ftp.rmdir(api.connectionId, items[j].path);
            } else {
              var result = await window.termulAPI.ftp.delete(api.connectionId, items[j].path);
            }
            if (!result.success) {
              toast = api.ui.toast();
              toast.show('Failed to delete ' + items[j].name + ': ' + (result.error || 'Unknown error'), 'error');
            }
          } catch (e) {
            toast = api.ui.toast();
            toast.show('Failed to delete ' + items[j].name + ': ' + (e.message || 'Unknown error'), 'error');
          }
        }
      } else {
        // SSH: batch delete using single rm -rf with all paths
        var paths = [];
        for (var j = 0; j < items.length; j++) {
          paths.push(shellQuote(items[j].path));
        }

        var cmd = 'rm -rf ' + paths.join(' ');
        try {
          var result = await window.termulAPI.ssh.exec(api.connectionId, cmd);
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || 'Failed to delete items', 'error');
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || 'Failed to delete items', 'error');
        }
      }
      loadRemoteDir(remotePath);
    }
  }

  // ─── Open in Editor ────────────────────────────────────────────────

  function openSelectedFile() {
    var selection = ctxPane === 'local' ? selectedLocal : selectedRemote;
    var names = Object.keys(selection);
    if (names.length !== 1) return;

    var entries = ctxPane === 'local' ? localEntries : remoteEntries;
    var entry = findEntryByName(entries, names[0]);
    if (!entry || !isTextFile(entry)) return;

    var filePath = entry.path;
    var source = ctxPane; // 'local' or 'remote'

    // Emit event for app.js to pick up and open the file-editor plugin
    api.events.emit('open-in-editor', {
      source: source,
      path: filePath,
      name: entry.name,
    });
  }

  // ─── Refresh ────────────────────────────────────────────────────────

  async function refreshBoth() {
    loadLocalDir(localPath);
    if (api.connectionId && remotePath) {
      loadRemoteDir(remotePath);
    }
  }

  // ─── Utility Functions ──────────────────────────────────────────────

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp);
    var year = d.getFullYear();
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    var hours = String(d.getHours()).padStart(2, '0');
    var mins = String(d.getMinutes()).padStart(2, '0');
    return year + '-' + month + '-' + day + ' ' + hours + ':' + mins;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function joinRemotePath(dir, name) {
    if (dir === '/') return '/' + name;
    return dir + '/' + name;
  }

  function joinLocalPath(dir, name) {
    // Handle both Unix and Windows paths
    if (dir.indexOf('/') !== -1 && dir.indexOf('\\') === -1) {
      return dir + '/' + name;
    }
    return dir + '\\' + name;
  }

  /**
   * Shell-quote a path for safe use in SSH exec commands.
   * Wraps in single quotes and escapes any embedded single quotes.
   */
  function shellQuote(str) {
    if (!str) return "''";
    // Replace ' with '\'' (end quote, escaped quote, start quote)
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
})();

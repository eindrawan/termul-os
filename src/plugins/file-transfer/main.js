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
  var localPath = "";
  var remotePath = "";
  var localEntries = [];
  var remoteEntries = [];
  var selectedLocal = {}; // name → true
  var selectedRemote = {}; // name → true
  var lastClickedLocal = null;
  var lastClickedRemote = null;
  var userDirs = null;
  var transferQueue = [];
  var transferCounter = 0;
  var isTransferring = false;
  var activePane = "local"; // 'local' or 'remote' - last focused pane

  // Breadcrumb mode state
  var localPathMode = "breadcrumb"; // 'breadcrumb' or 'input'
  var remotePathMode = "breadcrumb";
  var localBcClickTimer = null;
  var remoteBcClickTimer = null;
  var localBlurTimer = null;
  var remoteBlurTimer = null;

  // Sort state per pane: { key: 'name'|'size'|'date', dir: 'asc'|'desc' }
  var localSort = { key: "name", dir: "asc" };
  var remoteSort = { key: "name", dir: "asc" };

  // Cached sorted arrays (updated on each render, used for range selection)
  var localSorted = [];
  var remoteSorted = [];

  // ─── SVG Icons ──────────────────────────────────────────────────────
  var ICONS = {
    folder:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    parent:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
    upload:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    download:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 16 12 21 17 16"/><line x1="12" y1="21" x2="12" y2="9"/></svg>',
  };

  // ─── Protocol Detection ──────────────────────────────────────────────

  /**
   * Detect the protocol ('ssh' or 'ftp') from the current profile.
   */
  function getProtocol() {
    var profile = api.profile;
    return (profile && profile.protocol) || "ssh";
  }

  /**
   * Check if current connection is FTP.
   */
  function isFtp() {
    return getProtocol() === "ftp";
  }

  // ─── Path Persistence (Profile-Specific Settings) ───────────────────────

  /**
   * Get profile-specific settings key for local path.
   */
  function getLocalPathKey() {
    var profile = api.profile;
    if (profile && profile.id) {
      return "fileTransfer:lastLocalPath:" + profile.id;
    }
    return "fileTransfer:lastLocalPath";
  }

  /**
   * Get profile-specific settings key for remote path.
   */
  function getRemotePathKey() {
    var profile = api.profile;
    if (profile && profile.id) {
      return "fileTransfer:lastRemotePath:" + profile.id;
    }
    return "fileTransfer:lastRemotePath";
  }

  /**
   * Save the last local path to settings.
   */
  async function saveLocalPath(path) {
    try {
      await window.termulAPI.settings.set(getLocalPathKey(), path);
    } catch (e) {
      console.warn("[FileTransfer] Failed to save local path:", e);
    }
  }

  /**
   * Save the last remote path to settings.
   */
  async function saveRemotePath(path) {
    try {
      await window.termulAPI.settings.set(getRemotePathKey(), path);
    } catch (e) {
      console.warn("[FileTransfer] Failed to save remote path:", e);
    }
  }

  /**
   * Load the last local path from settings.
   */
  async function loadSavedLocalPath() {
    try {
      var saved = await window.termulAPI.settings.get(getLocalPathKey(), null);
      return saved;
    } catch (e) {
      console.warn("[FileTransfer] Failed to load local path:", e);
      return null;
    }
  }

  /**
   * Load the last remote path from settings.
   */
  async function loadSavedRemotePath() {
    try {
      var saved = await window.termulAPI.settings.get(getRemotePathKey(), null);
      return saved;
    } catch (e) {
      console.warn("[FileTransfer] Failed to load remote path:", e);
      return null;
    }
  }

  // ─── DOM References (resolved in onMount) ───────────────────────────
  var els = {};

  // ─── Prompt Modal (TuiModal-based) ──────────────────────────────────

  function promptUser(title, label, defaultValue) {
    return new Promise(function (resolve) {
      var modal = api.ui.modal({
        title: title,
        content:
          '<div class="tui-modal-message">' +
          escapeHtml(label) +
          "</div>" +
          '<input type="text" class="tui-input" id="ft-prompt-input" style="width:100%;margin-top:8px;">',
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
            label: "OK",
            variant: "primary",
            onClick: function (m) {
              var input = m.el.querySelector("#ft-prompt-input");
              m.close();
              resolve(input ? input.value.trim() : "");
            },
          },
        ],
      });
      modal.open();
      setTimeout(function () {
        var input = modal.el.querySelector("#ft-prompt-input");
        if (input) {
          input.value = defaultValue || "";
          input.focus();
          input.select();
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              var okBtn = modal.el.querySelector(".tui-btn-primary");
              if (okBtn) okBtn.click();
            }
            if (e.key === "Escape") {
              var cancelBtn = modal.el.querySelector(".tui-btn-default");
              if (cancelBtn) cancelBtn.click();
            }
          });
        }
      }, 50);
    });
  }

  function confirmUser(title, message) {
    return new Promise(function (resolve) {
      var modal = api.ui.modal({
        title: title,
        content: '<p class="tui-modal-message">' + escapeHtml(message) + "</p>",
        buttons: [
          {
            label: "Cancel",
            variant: "default",
            onClick: function (m) {
              m.close();
              resolve(false);
            },
          },
          {
            label: "Confirm",
            variant: "danger",
            onClick: function (m) {
              m.close();
              resolve(true);
            },
          },
        ],
      });
      modal.open();
    });
  }

  // ─── Context Menu ────────────────────────────────────────────────────
  var ctxVisible = false;
  var ctxPane = "local"; // which pane the context menu was opened on

  // ─── Text File Detection ────────────────────────────────────────────
  var TEXT_EXTENSIONS = {
    txt: true,
    md: true,
    markdown: true,
    rst: true,
    adoc: true,
    org: true,
    json: true,
    jsonc: true,
    json5: true,
    yaml: true,
    yml: true,
    toml: true,
    xml: true,
    xaml: true,
    svg: true,
    html: true,
    htm: true,
    xhtml: true,
    css: true,
    scss: true,
    less: true,
    sass: true,
    styl: true,
    js: true,
    jsx: true,
    mjs: true,
    cjs: true,
    ts: true,
    tsx: true,
    py: true,
    pyw: true,
    rb: true,
    rbw: true,
    go: true,
    rs: true,
    java: true,
    kt: true,
    kts: true,
    scala: true,
    c: true,
    h: true,
    cpp: true,
    cc: true,
    cxx: true,
    hpp: true,
    hxx: true,
    cs: true,
    vb: true,
    fs: true,
    fsx: true,
    php: true,
    phtml: true,
    blade: true,
    sh: true,
    bash: true,
    zsh: true,
    fish: true,
    ps1: true,
    psm1: true,
    bat: true,
    cmd: true,
    sql: true,
    plsql: true,
    pgsql: true,
    lua: true,
    r: true,
    jl: true,
    ex: true,
    exs: true,
    erl: true,
    hrl: true,
    dart: true,
    swift: true,
    m: true,
    mm: true,
    vim: true,
    el: true,
    clj: true,
    cljs: true,
    hs: true,
    ml: true,
    mli: true,
    dockerfile: true,
    containerfile: true,
    makefile: true,
    cmake: true,
    gitignore: true,
    editorconfig: true,
    env: true,
    properties: true,
    ini: true,
    cfg: true,
    conf: true,
    config: true,
    log: true,
    csv: true,
    tsv: true,
    npmrc: true,
    babelrc: true,
    eslintrc: true,
    prettierrc: true,
  };

  function isTextFile(entry) {
    if (!entry || !entry.isFile) return false;
    var name = entry.name || "";
    // Check by extension
    var dotIdx = name.lastIndexOf(".");
    if (dotIdx >= 0) {
      var ext = name.substring(dotIdx + 1).toLowerCase();
      if (TEXT_EXTENSIONS[ext]) return true;
    }
    // Check filenames without extensions (common config files)
    var lower = name.toLowerCase();
    var TEXT_FILENAMES = [
      "readme",
      "license",
      "copying",
      "authors",
      "contributors",
      "changelog",
      "makefile",
      "dockerfile",
      "containerfile",
      "vagrantfile",
      "gemfile",
      "rakefile",
      "procfile",
      "brewfile",
      "podfile",
      "fastfile",
      "cmakelists",
      "cmakelist",
      "jenkinsfile",
      ".gitignore",
      ".editorconfig",
      ".env",
      ".npmrc",
      ".babelrc",
      ".eslintrc",
      ".prettierrc",
      ".eslintrc.js",
      ".prettierrc.js",
      ".gitattributes",
      ".gitmodules",
    ];
    for (var i = 0; i < TEXT_FILENAMES.length; i++) {
      if (lower === TEXT_FILENAMES[i]) return true;
    }
    return false;
  }

  // ─── Viewable File Detection (images & PDFs) ────────────────────────

  var VIEWABLE_EXTENSIONS = {
    png: true,
    jpg: true,
    jpeg: true,
    gif: true,
    bmp: true,
    svg: true,
    webp: true,
    ico: true,
    tiff: true,
    tif: true,
    avif: true,
    pdf: true,
  };

  function isViewableFile(entry) {
    if (!entry || !entry.isFile) return false;
    var name = entry.name || "";
    var dotIdx = name.lastIndexOf(".");
    if (dotIdx >= 0) {
      var ext = name.substring(dotIdx + 1).toLowerCase();
      if (VIEWABLE_EXTENSIONS[ext]) return true;
    }
    return false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Cache all DOM references
    els.localPane = shadow.getElementById("ft-local-pane");
    els.remotePane = shadow.getElementById("ft-remote-pane");
    els.localPath = shadow.getElementById("ft-local-path");
    els.remotePath = shadow.getElementById("ft-remote-path");
    els.localBreadcrumb = shadow.getElementById("ft-local-breadcrumb");
    els.remoteBreadcrumb = shadow.getElementById("ft-remote-breadcrumb");
    els.localBody = shadow.getElementById("ft-local-body");
    els.remoteBody = shadow.getElementById("ft-remote-body");
    els.localStatus = shadow.getElementById("ft-local-status");
    els.remoteStatus = shadow.getElementById("ft-remote-status");
    els.localGo = shadow.getElementById("ft-local-go");
    els.remoteGo = shadow.getElementById("ft-remote-go");
    els.localUp = shadow.getElementById("ft-local-up");
    els.remoteUp = shadow.getElementById("ft-remote-up");
    els.localHome = shadow.getElementById("ft-local-home");
    els.remoteHome = shadow.getElementById("ft-remote-home");
    els.refreshAll = shadow.getElementById("ft-refresh-all");
    els.uploadBtn = shadow.getElementById("ft-upload-btn");
    els.downloadBtn = shadow.getElementById("ft-download-btn");
    els.addFileBtn = shadow.getElementById("ft-add-file-btn");
    els.addFolderBtn = shadow.getElementById("ft-add-folder-btn");
    els.deleteBtn = shadow.getElementById("ft-delete-btn");
    els.queueToggle = shadow.getElementById("ft-queue-toggle");
    els.queueList = shadow.getElementById("ft-queue-list");
    els.queueCount = shadow.getElementById("ft-queue-count");

    // Modal events — no longer needed (using api.ui.modal)

    // Context menu elements
    els.ctx = shadow.getElementById("ft-ctx");
    els.ctxOpen = shadow.getElementById("ft-ctx-open");
    els.ctxUpload = shadow.getElementById("ft-ctx-upload");
    els.ctxDownload = shadow.getElementById("ft-ctx-download");
    els.ctxNewFile = shadow.getElementById("ft-ctx-new-file");
    els.ctxNewFolder = shadow.getElementById("ft-ctx-new-folder");
    els.ctxRename = shadow.getElementById("ft-ctx-rename");
    els.ctxDuplicate = shadow.getElementById("ft-ctx-duplicate");
    els.ctxDelete = shadow.getElementById("ft-ctx-delete");

    // Bind events
    addEventListener(els.localGo, "click", function () {
      clearTimeout(localBlurTimer);
      navigateLocal(els.localPath.value.trim());
    });
    addEventListener(els.remoteGo, "click", function () {
      clearTimeout(remoteBlurTimer);
      navigateRemote(els.remotePath.value.trim());
    });
    addEventListener(els.localUp, "click", goUpLocal);
    addEventListener(els.remoteUp, "click", goUpRemote);
    addEventListener(els.localHome, "click", goHomeLocal);
    addEventListener(els.remoteHome, "click", goHomeRemote);
    addEventListener(els.refreshAll, "click", refreshBoth);
    addEventListener(els.uploadBtn, "click", uploadSelected);
    addEventListener(els.downloadBtn, "click", downloadSelected);
    addEventListener(els.addFileBtn, "click", addNewFile);
    addEventListener(els.addFolderBtn, "click", addNewFolder);
    addEventListener(els.deleteBtn, "click", deleteSelected);
    addEventListener(els.queueToggle, "click", toggleQueue);

    // Enter / Escape key on path inputs
    addEventListener(els.localPath, "keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(localBlurTimer);
        navigateLocal(els.localPath.value.trim());
      } else if (e.key === "Escape") {
        clearTimeout(localBlurTimer);
        switchToBreadcrumb("local");
      }
    });
    addEventListener(els.remotePath, "keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(remoteBlurTimer);
        navigateRemote(els.remotePath.value.trim());
      } else if (e.key === "Escape") {
        clearTimeout(remoteBlurTimer);
        switchToBreadcrumb("remote");
      }
    });

    // Blur on path inputs — switch back to breadcrumb after short delay
    addEventListener(els.localPath, "blur", function () {
      localBlurTimer = setTimeout(function () {
        switchToBreadcrumb("local");
      }, 150);
    });
    addEventListener(els.remotePath, "blur", function () {
      remoteBlurTimer = setTimeout(function () {
        switchToBreadcrumb("remote");
      }, 150);
    });

    // Prevent Go button mousedown from stealing focus in input mode
    addEventListener(els.localGo, "mousedown", function (e) {
      if (localPathMode === "input") e.preventDefault();
    });
    addEventListener(els.remoteGo, "mousedown", function (e) {
      if (remotePathMode === "input") e.preventDefault();
    });

    // Breadcrumb single-click — navigate to segment (delayed for dblclick detection)
    addEventListener(els.localBreadcrumb, "click", function (e) {
      var target = e.target.closest(".ft-bc-segment");
      if (!target || target.classList.contains("ft-bc-current")) return;
      var path = target.getAttribute("data-path");
      clearTimeout(localBcClickTimer);
      localBcClickTimer = setTimeout(function () {
        loadLocalDir(path);
      }, 250);
    });
    addEventListener(els.remoteBreadcrumb, "click", function (e) {
      var target = e.target.closest(".ft-bc-segment");
      if (!target || target.classList.contains("ft-bc-current")) return;
      var path = target.getAttribute("data-path");
      clearTimeout(remoteBcClickTimer);
      remoteBcClickTimer = setTimeout(function () {
        loadRemoteDir(path);
      }, 250);
    });

    // Breadcrumb double-click — switch to editable input mode
    addEventListener(els.localBreadcrumb, "dblclick", function () {
      clearTimeout(localBcClickTimer);
      switchToInput("local");
    });
    addEventListener(els.remoteBreadcrumb, "dblclick", function () {
      clearTimeout(remoteBcClickTimer);
      switchToInput("remote");
    });

    // Bind sortable column header clicks
    var sortHeaders = shadow.querySelectorAll(".ft-sortable");
    for (var h = 0; h < sortHeaders.length; h++) {
      addEventListener(sortHeaders[h], "click", handleSortClick);
    }

    // Pane focus tracking
    addEventListener(els.localPane, "click", function () {
      setActivePane("local");
    });
    addEventListener(els.remotePane, "click", function () {
      setActivePane("remote");
    });

    // Modal events — no longer needed (using api.ui.modal)

    // Context menu — right-click on file body areas
    addEventListener(els.localBody, "contextmenu", function (e) {
      handleContextMenu(e, "local");
    });
    addEventListener(els.remoteBody, "contextmenu", function (e) {
      handleContextMenu(e, "remote");
    });

    // Context menu — item clicks
    addEventListener(els.ctxOpen, "click", function () {
      hideCtx();
      openSelectedFile();
    });
    addEventListener(els.ctxRename, "click", function () {
      hideCtx();
      renameSelectedItem();
    });
    addEventListener(els.ctxDuplicate, "click", function () {
      hideCtx();
      duplicateSelected();
    });
    addEventListener(els.ctxUpload, "click", function () {
      hideCtx();
      uploadSelected();
    });
    addEventListener(els.ctxDownload, "click", function () {
      hideCtx();
      downloadSelected();
    });
    addEventListener(els.ctxNewFile, "click", function () {
      hideCtx();
      addNewFile();
    });
    addEventListener(els.ctxNewFolder, "click", function () {
      hideCtx();
      addNewFolder();
    });
    addEventListener(els.ctxDelete, "click", function () {
      hideCtx();
      deleteSelected();
    });

    // Dismiss context menu on any click outside
    addEventListener(
      shadow.querySelector(".ft-container"),
      "click",
      function (e) {
        if (ctxVisible && !els.ctx.contains(e.target)) hideCtx();
      },
    );

    // Dismiss context menu on Escape, F2 to rename
    addEventListener(
      shadow.querySelector(".ft-container"),
      "keydown",
      function (e) {
        if (e.key === "Escape" && ctxVisible) {
          hideCtx();
          e.preventDefault();
        }
        if (e.key === "F2") {
          e.preventDefault();
          renameSelectedItem();
        }
      },
    );

    // Listen for SFTP progress
    api.events.on("sftp-progress", handleProgress);

    // Listen for FTP progress
    api.events.on("ftp-progress", handleProgress);

    // Listen for global connection status changes
    addEventListener(
      document,
      "termul:connection-status",
      handleConnectionStatus,
    );

    // Set initial active pane
    setActivePane("local");

    // Initialize
    initLocal();
    initRemote();
  });

  PLUGIN_LIFECYCLE.onUnmount(function () {
    // Cleanup is handled automatically by the plugin system
  });

  // ─── Connection Status Handler ─────────────────────────────────────

  /**
   * Handle global connection status changes (termul:connection-status).
   * Updates the remote pane to reflect connection state.
   */
  function handleConnectionStatus(e) {
    var detail = e.detail || {};
    var status = detail.status;

    if (status === "disconnected") {
      // Connection lost — clear remote entries and show error
      remoteEntries = [];
      remotePath = "";
      els.remotePath.value = "";
      renderRemoteList();
      showRemoteError(
        isFtp()
          ? "Disconnected from FTP server"
          : "Disconnected from SSH server",
      );
    } else if (status === "connected") {
      // Connection (re)established — re-init remote pane
      initRemote();
    } else if (status === "reconnecting") {
      setRemoteStatus("Reconnecting…");
    }
  }

  // ─── Sorting ────────────────────────────────────────────────────────

  /**
   * Handle click on a sortable column header.
   */
  function handleSortClick(e) {
    var el = e.currentTarget;
    var pane = el.getAttribute("data-pane");
    var key = el.getAttribute("data-sort");

    if (pane === "local") {
      if (localSort.key === key) {
        localSort.dir = localSort.dir === "asc" ? "desc" : "asc";
      } else {
        localSort.key = key;
        localSort.dir = "asc";
      }
      renderLocalList();
    } else if (pane === "remote") {
      if (remoteSort.key === key) {
        remoteSort.dir = remoteSort.dir === "asc" ? "desc" : "asc";
      } else {
        remoteSort.key = key;
        remoteSort.dir = "asc";
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
    var dirMul = sort.dir === "asc" ? 1 : -1;

    sorted.sort(function (a, b) {
      // Directories always come first regardless of sort key
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      var aVal, bVal;

      if (key === "name") {
        aVal = (a.name || "").toLowerCase();
        bVal = (b.name || "").toLowerCase();
        var cmp = aVal.localeCompare(bVal);
        return cmp * dirMul;
      } else if (key === "size") {
        aVal = a.size || 0;
        bVal = b.size || 0;
        return (aVal - bVal) * dirMul;
      } else if (key === "date") {
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
    var sort = pane === "local" ? localSort : remoteSort;
    var headers = shadow.querySelectorAll(
      '.ft-sortable[data-pane="' + pane + '"]',
    );

    for (var i = 0; i < headers.length; i++) {
      var el = headers[i];
      el.classList.remove("ft-sort-asc", "ft-sort-desc", "ft-sort-active");
      if (el.getAttribute("data-sort") === sort.key) {
        el.classList.add("ft-sort-" + sort.dir);
        el.classList.add("ft-sort-active");
      }
    }
  }

  // ─── Active Pane ─────────────────────────────────────────────────────

  function setActivePane(pane) {
    activePane = pane;
    if (pane === "local") {
      els.localPane.classList.add("ft-active");
      els.remotePane.classList.remove("ft-active");
    } else {
      els.localPane.classList.remove("ft-active");
      els.remotePane.classList.add("ft-active");
    }
    updateActionButtons();
  }

  function updateActionButtons() {
    // Update delete button based on selection in active pane
    var selection = activePane === "local" ? selectedLocal : selectedRemote;
    var hasSelection = Object.keys(selection).length > 0;
    els.deleteBtn.disabled = !hasSelection;
  }

  // ─── Context Menu ────────────────────────────────────────────────────

  function handleContextMenu(e, pane) {
    e.preventDefault();
    e.stopPropagation();

    ctxPane = pane;
    setActivePane(pane);

    // If right-clicked on a row that is not selected, select it first
    var row = e.target.closest(".ft-row");
    if (row && row.getAttribute("data-name")) {
      var name = row.getAttribute("data-name");
      var selection = pane === "local" ? selectedLocal : selectedRemote;
      if (!selection[name]) {
        if (pane === "local") {
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
    var selection = ctxPane === "local" ? selectedLocal : selectedRemote;
    var entries = ctxPane === "local" ? localEntries : remoteEntries;
    var hasSelection = Object.keys(selection).length > 0;
    var hasLocalItems = hasSelection && ctxPane === "local";
    var hasRemoteItems = hasSelection && ctxPane === "remote";

    // "Open" — show when exactly one text file or viewable file is selected
    var canOpen = false;
    var selectedNames = Object.keys(selection);
    if (selectedNames.length === 1) {
      var entry = findEntryByName(entries, selectedNames[0]);
      if (entry && (isTextFile(entry) || isViewableFile(entry))) {
        canOpen = true;
      }
    }
    els.ctxOpen.disabled = !canOpen;
    els.ctxOpen.style.display = "";

    // "Rename" — show when exactly one item is selected
    var canRename = selectedNames.length === 1;
    els.ctxRename.disabled = !canRename;
    els.ctxRename.style.display = "";

    // "Duplicate" — enabled when at least one item is selected
    els.ctxDuplicate.disabled = !hasSelection;
    els.ctxDuplicate.style.display = "";

    els.ctxUpload.disabled = !hasLocalItems;
    els.ctxDownload.disabled = !hasRemoteItems;
    els.ctxDelete.disabled = !hasSelection;

    // Show/hide transfer items based on pane
    var isLocal = ctxPane === "local";
    els.ctxUpload.style.display = isLocal ? "" : "none";
    els.ctxDownload.style.display = isLocal ? "none" : "";
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
    var container = shadow.querySelector(".ft-container");
    var rect = container.getBoundingClientRect();
    var menuW = 200;
    var menuH = 200; // estimated

    var left = x - rect.left;
    var top = y - rect.top;

    if (left + menuW > rect.width) left = rect.width - menuW - 4;
    if (top + menuH > rect.height) top = rect.height - menuH - 4;
    if (left < 0) left = 4;
    if (top < 0) top = 4;

    els.ctx.style.left = left + "px";
    els.ctx.style.top = top + "px";
    els.ctx.classList.add("ft-ctx-open");
    ctxVisible = true;
  }

  function hideCtx() {
    if (els.ctx) els.ctx.classList.remove("ft-ctx-open");
    ctxVisible = false;
  }

  // ─── Local FS Operations ────────────────────────────────────────────

  async function initLocal() {
    try {
      userDirs = await window.termulAPI.fs.userDirs();
    } catch (e) {
      userDirs = { home: "/" };
    }

    // Try to load saved path first
    var savedPath = await loadSavedLocalPath();
    if (savedPath) {
      // Validate saved path exists by attempting to load it
      try {
        var result = await window.termulAPI.fs.listDir(savedPath);
        if (result.success) {
          localPath = savedPath;
          await loadLocalDir(localPath);
          return;
        }
      } catch (e) {
        // Saved path is invalid, fall back to home
        console.warn("[FileTransfer] Saved local path invalid, using home:", e);
      }
    }

    // Fall back to home directory
    localPath = userDirs.home || "/";
    await loadLocalDir(localPath);
  }

  async function loadLocalDir(dirPath) {
    clearTimeout(localBcClickTimer);
    setLocalStatus("Loading...");
    els.localBody.innerHTML =
      '<div class="ft-loading"><div class="tui-spinner"></div><span>Loading...</span></div>';

    try {
      var result = await window.termulAPI.fs.listDir(dirPath);
      if (!result.success) {
        showLocalError(result.error);
        return;
      }
      localPath = result.path;
      localEntries = result.entries;
      els.localPath.value = localPath;
      renderPathBreadcrumb(els.localBreadcrumb, localPath, "local");
      switchToBreadcrumb("local");
      renderLocalList();
      var fileCount = localEntries.filter(function (e) {
        return e.isFile;
      }).length;
      var dirCount = localEntries.filter(function (e) {
        return e.isDirectory;
      }).length;
      setLocalStatus(dirCount + " folders, " + fileCount + " files");

      // Save path for next time
      await saveLocalPath(localPath);
    } catch (e) {
      showLocalError(e.message);
    }
  }

  function renderLocalList() {
    selectedLocal = {};
    lastClickedLocal = null;
    localSorted = sortEntries(localEntries, localSort);
    var html = "";

    // Parent directory entry
    html +=
      '<div class="ft-row ft-parent-dir" tabindex="0" data-action="parent-local">' +
      '<div class="ft-row-name"><div class="ft-icon ft-icon-parent">' +
      ICONS.parent +
      '</div><span class="ft-row-name-text">..</span></div>' +
      '<div class="ft-row-size"></div><div class="ft-row-date"></div></div>';

    for (var i = 0; i < localSorted.length; i++) {
      var entry = localSorted[i];
      var iconClass = entry.isDirectory ? "ft-icon-folder" : "ft-icon-file";
      var iconSvg = entry.isDirectory ? ICONS.folder : ICONS.file;
      var sizeStr = entry.isFile ? formatSize(entry.size) : "";
      var dateStr = entry.modifyTime ? formatDate(entry.modifyTime) : "";

      html +=
        '<div class="ft-row" tabindex="0" data-name="' +
        escapeAttr(entry.name) +
        '" data-index="' +
        i +
        '">' +
        '<div class="ft-row-name"><div class="ft-icon ' +
        iconClass +
        '">' +
        iconSvg +
        "</div>" +
        '<span class="ft-row-name-text">' +
        escapeHtml(entry.name) +
        "</span></div>" +
        '<div class="ft-row-size">' +
        sizeStr +
        "</div>" +
        '<div class="ft-row-date">' +
        dateStr +
        "</div></div>";
    }

    els.localBody.innerHTML = html;
    updateSortIndicators("local");
    updateActionButtons();

    // Bind click events on rows
    var rows = els.localBody.querySelectorAll(".ft-row");
    for (var r = 0; r < rows.length; r++) {
      addEventListener(rows[r], "click", handleLocalRowClick);
      addEventListener(rows[r], "dblclick", handleLocalRowDblClick);
    }
  }

  function handleLocalRowClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute("data-action") === "parent-local") return;

    var name = row.getAttribute("data-name");
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
          toggleLocalSelection(
            localSorted[i].name,
            getLocalRowByName(localSorted[i].name),
          );
        }
      }
    } else {
      clearLocalSelection();
      toggleLocalSelection(name, row);
    }
    lastClickedLocal = name;
    setActivePane("local");
  }

  function handleLocalRowDblClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute("data-action") === "parent-local") {
      goUpLocal();
      return;
    }
    var name = row.getAttribute("data-name");
    if (!name) return;
    var entry = findLocalEntry(name);
    if (!entry) return;
    if (entry.isDirectory) {
      loadLocalDir(entry.path);
    } else if (isViewableFile(entry)) {
      // Open images/PDFs in the viewer
      ctxPane = "local";
      clearLocalSelection();
      toggleLocalSelection(name, row);
      openSelectedFile();
    } else if (isTextFile(entry)) {
      // Open text files in the editor
      ctxPane = "local";
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
    return els.localBody.querySelector(
      '.ft-row[data-name="' + CSS.escape(name) + '"]',
    );
  }

  function toggleLocalSelection(name, row) {
    if (selectedLocal[name]) {
      delete selectedLocal[name];
      if (row) row.classList.remove("ft-selected");
    } else {
      selectedLocal[name] = true;
      if (row) row.classList.add("ft-selected");
    }
  }

  function clearLocalSelection() {
    selectedLocal = {};
    var sel = els.localBody.querySelectorAll(".ft-row.ft-selected");
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove("ft-selected");
  }

  function navigateLocal(path) {
    if (path) loadLocalDir(path);
  }

  function goUpLocal() {
    if (!localPath) return;
    // Use ".." segment — backend path.resolve handles both Unix and Windows
    loadLocalDir(localPath + "/..");
  }

  function goHomeLocal() {
    if (userDirs && userDirs.home) {
      loadLocalDir(userDirs.home);
    }
  }

  function showLocalError(msg) {
    els.localBody.innerHTML =
      '<div class="ft-error">' + escapeHtml(msg || "Error") + "</div>";
    setLocalStatus("Error");
  }

  function setLocalStatus(msg) {
    if (els.localStatus) els.localStatus.textContent = msg;
  }

  // ─── Remote FS Operations ───────────────────────────────────────────

  async function initRemote() {
    if (!api.connectionId) {
      showRemoteError(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
      );
      els.remotePath.value = "";
      return;
    }

    // Try to load saved path first
    var savedPath = await loadSavedRemotePath();
    if (savedPath) {
      // Validate saved path exists by attempting to load it
      try {
        var result;
        if (isFtp()) {
          result = await window.termulAPI.ftp.listDir(
            api.connectionId,
            savedPath,
          );
        } else {
          result = await window.termulAPI.ssh.sftpListDir(
            api.connectionId,
            savedPath,
          );
        }
        if (result.success) {
          remotePath = savedPath;
          await loadRemoteDir(remotePath);
          return;
        }
      } catch (e) {
        // Saved path is invalid, fall back to home
        console.warn(
          "[FileTransfer] Saved remote path invalid, using home:",
          e,
        );
      }
    }

    // Fall back to home directory
    try {
      var homeResult;
      if (isFtp()) {
        homeResult = await window.termulAPI.ftp.home(api.connectionId);
      } else {
        homeResult = await window.termulAPI.ssh.sftpHome(api.connectionId);
      }
      if (homeResult.success) {
        remotePath = homeResult.path;
      } else {
        remotePath = "/";
      }
    } catch (e) {
      remotePath = "/";
    }
    await loadRemoteDir(remotePath);
  }

  async function loadRemoteDir(dirPath) {
    clearTimeout(remoteBcClickTimer);
    if (!api.connectionId) {
      showRemoteError("Not connected");
      return;
    }
    setRemoteStatus("Loading...");
    els.remoteBody.innerHTML =
      '<div class="ft-loading"><div class="tui-spinner"></div><span>Loading...</span></div>';

    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.listDir(api.connectionId, dirPath);
      } else {
        result = await window.termulAPI.ssh.sftpListDir(
          api.connectionId,
          dirPath,
        );
      }
      if (!result.success) {
        showRemoteError(result.error);
        return;
      }
      remotePath = dirPath;
      remoteEntries = result.entries;
      els.remotePath.value = remotePath;
      renderPathBreadcrumb(els.remoteBreadcrumb, remotePath, "remote");
      switchToBreadcrumb("remote");
      renderRemoteList();
      var fileCount = remoteEntries.filter(function (e) {
        return e.isFile;
      }).length;
      var dirCount = remoteEntries.filter(function (e) {
        return e.isDirectory;
      }).length;
      setRemoteStatus(dirCount + " folders, " + fileCount + " files");

      // Save path for next time
      await saveRemotePath(remotePath);
    } catch (e) {
      showRemoteError(e.message);
    }
  }

  function renderRemoteList() {
    selectedRemote = {};
    lastClickedRemote = null;
    remoteSorted = sortEntries(remoteEntries, remoteSort);
    var html = "";

    // Parent directory entry
    html +=
      '<div class="ft-row ft-parent-dir" tabindex="0" data-action="parent-remote">' +
      '<div class="ft-row-name"><div class="ft-icon ft-icon-parent">' +
      ICONS.parent +
      '</div><span class="ft-row-name-text">..</span></div>' +
      '<div class="ft-row-size"></div><div class="ft-row-date"></div></div>';

    for (var i = 0; i < remoteSorted.length; i++) {
      var entry = remoteSorted[i];
      var iconClass = entry.isDirectory ? "ft-icon-folder" : "ft-icon-file";
      var iconSvg = entry.isDirectory ? ICONS.folder : ICONS.file;
      var sizeStr = entry.isFile ? formatSize(entry.size) : "";
      var dateStr = entry.modifyTime ? formatDate(entry.modifyTime) : "";

      html +=
        '<div class="ft-row" tabindex="0" data-name="' +
        escapeAttr(entry.name) +
        '" data-index="' +
        i +
        '">' +
        '<div class="ft-row-name"><div class="ft-icon ' +
        iconClass +
        '">' +
        iconSvg +
        "</div>" +
        '<span class="ft-row-name-text">' +
        escapeHtml(entry.name) +
        "</span></div>" +
        '<div class="ft-row-size">' +
        sizeStr +
        "</div>" +
        '<div class="ft-row-date">' +
        dateStr +
        "</div></div>";
    }

    els.remoteBody.innerHTML = html;
    updateSortIndicators("remote");
    updateActionButtons();

    // Bind click events on rows
    var rows = els.remoteBody.querySelectorAll(".ft-row");
    for (var r = 0; r < rows.length; r++) {
      addEventListener(rows[r], "click", handleRemoteRowClick);
      addEventListener(rows[r], "dblclick", handleRemoteRowDblClick);
    }
  }

  function handleRemoteRowClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute("data-action") === "parent-remote") return;

    var name = row.getAttribute("data-name");
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
          toggleRemoteSelection(
            remoteSorted[i].name,
            getRemoteRowByName(remoteSorted[i].name),
          );
        }
      }
    } else {
      clearRemoteSelection();
      toggleRemoteSelection(name, row);
    }
    lastClickedRemote = name;
    setActivePane("remote");
  }

  function handleRemoteRowDblClick(e) {
    var row = e.currentTarget;
    if (row.getAttribute("data-action") === "parent-remote") {
      goUpRemote();
      return;
    }
    var name = row.getAttribute("data-name");
    if (!name) return;
    var entry = findRemoteEntry(name);
    if (!entry) return;
    if (entry.isDirectory) {
      loadRemoteDir(entry.path);
    } else if (isViewableFile(entry)) {
      // Open images/PDFs in the viewer
      ctxPane = "remote";
      clearRemoteSelection();
      toggleRemoteSelection(name, row);
      openSelectedFile();
    } else if (isTextFile(entry)) {
      // Open text files in the editor
      ctxPane = "remote";
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
    return els.remoteBody.querySelector(
      '.ft-row[data-name="' + CSS.escape(name) + '"]',
    );
  }

  function toggleRemoteSelection(name, row) {
    if (selectedRemote[name]) {
      delete selectedRemote[name];
      if (row) row.classList.remove("ft-selected");
    } else {
      selectedRemote[name] = true;
      if (row) row.classList.add("ft-selected");
    }
  }

  function clearRemoteSelection() {
    selectedRemote = {};
    var sel = els.remoteBody.querySelectorAll(".ft-row.ft-selected");
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove("ft-selected");
  }

  function navigateRemote(path) {
    if (path) loadRemoteDir(path);
  }

  function goUpRemote() {
    if (!remotePath || remotePath === "/") return;
    var parts = remotePath.split("/");
    parts.pop();
    var parent = parts.join("/") || "/";
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
    els.remoteBody.innerHTML =
      '<div class="ft-error">' + escapeHtml(msg || "Error") + "</div>";
    setRemoteStatus("Error");
  }

  function setRemoteStatus(msg) {
    if (els.remoteStatus) els.remoteStatus.textContent = msg;
  }

  // ─── Transfer Operations ────────────────────────────────────────────

  function updateTransferButtons() {
    var hasLocalSelection = Object.keys(selectedLocal).length > 0;
    var hasRemoteSelection = Object.keys(selectedRemote).length > 0;
    // Enable for any selection (files and/or folders)
    els.uploadBtn.disabled = !hasLocalSelection;
    els.downloadBtn.disabled = !hasRemoteSelection;
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
    var selection = activePane === "local" ? selectedLocal : selectedRemote;
    var entries = activePane === "local" ? localEntries : remoteEntries;
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

  // ─── Recursive Folder Collection ──────────────────────────────────────

  /**
   * Recursively collect all files from a local directory tree.
   * Returns array of { name, path, relativePath, size }.
   */
  async function collectLocalFilesRecursively(dirPath, baseRelative) {
    var files = [];
    try {
      var result = await window.termulAPI.fs.listDir(dirPath);
      if (!result.success) return files;
      for (var i = 0; i < result.entries.length; i++) {
        var entry = result.entries[i];
        var rel = baseRelative ? baseRelative + "/" + entry.name : entry.name;
        if (entry.isDirectory) {
          var sub = await collectLocalFilesRecursively(entry.path, rel);
          files = files.concat(sub);
        } else if (entry.isFile) {
          files.push({
            name: entry.name,
            path: entry.path,
            relativePath: rel,
            size: entry.size,
          });
        }
      }
    } catch (e) {
      /* skip unreadable dirs */
    }
    return files;
  }

  /**
   * Recursively collect all sub-directory relative paths from a local directory tree.
   * Returns array of relative paths in parent-first order.
   */
  async function collectLocalDirsRecursively(dirPath, baseRelative) {
    var dirs = [];
    try {
      var result = await window.termulAPI.fs.listDir(dirPath);
      if (!result.success) return dirs;
      for (var i = 0; i < result.entries.length; i++) {
        var entry = result.entries[i];
        if (entry.isDirectory) {
          var rel = baseRelative ? baseRelative + "/" + entry.name : entry.name;
          dirs.push(rel);
          var sub = await collectLocalDirsRecursively(entry.path, rel);
          dirs = dirs.concat(sub);
        }
      }
    } catch (e) {
      /* skip unreadable dirs */
    }
    return dirs;
  }

  /**
   * Recursively collect all files from a remote directory tree.
   * Returns array of { name, path, relativePath, size }.
   */
  async function collectRemoteFilesRecursively(dirPath, baseRelative) {
    var files = [];
    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.listDir(api.connectionId, dirPath);
      } else {
        result = await window.termulAPI.ssh.sftpListDir(
          api.connectionId,
          dirPath,
        );
      }
      if (!result.success) return files;
      for (var i = 0; i < result.entries.length; i++) {
        var entry = result.entries[i];
        var rel = baseRelative ? baseRelative + "/" + entry.name : entry.name;
        if (entry.isDirectory) {
          var sub = await collectRemoteFilesRecursively(entry.path, rel);
          files = files.concat(sub);
        } else if (entry.isFile) {
          files.push({
            name: entry.name,
            path: entry.path,
            relativePath: rel,
            size: entry.size,
          });
        }
      }
    } catch (e) {
      /* skip unreadable dirs */
    }
    return files;
  }

  /**
   * Recursively collect all sub-directory relative paths from a remote directory tree.
   * Returns array of relative paths in parent-first order.
   */
  async function collectRemoteDirsRecursively(dirPath, baseRelative) {
    var dirs = [];
    try {
      var result;
      if (isFtp()) {
        result = await window.termulAPI.ftp.listDir(api.connectionId, dirPath);
      } else {
        result = await window.termulAPI.ssh.sftpListDir(
          api.connectionId,
          dirPath,
        );
      }
      if (!result.success) return dirs;
      for (var i = 0; i < result.entries.length; i++) {
        var entry = result.entries[i];
        if (entry.isDirectory) {
          var rel = baseRelative ? baseRelative + "/" + entry.name : entry.name;
          dirs.push(rel);
          var sub = await collectRemoteDirsRecursively(entry.path, rel);
          dirs = dirs.concat(sub);
        }
      }
    } catch (e) {
      /* skip unreadable dirs */
    }
    return dirs;
  }

  /**
   * Ensure a remote directory exists. Uses mkdir -p via SSH exec or ftp.mkdir.
   * Includes a small delay to avoid overwhelming the server with channel requests.
   */
  async function ensureRemoteDir(dirPath) {
    try {
      if (isFtp()) {
        var result = await window.termulAPI.ftp.mkdir(
          api.connectionId,
          dirPath,
        );
        return result;
      } else {
        // Use mkdir -p via SSH exec for robustness (handles existing dirs and nested paths)
        var esc = shellQuote(dirPath);
        var result = await window.termulAPI.ssh.exec(
          api.connectionId,
          "mkdir -p " + esc,
        );
        // Add a small delay to avoid channel exhaustion
        await new Promise(function (resolve) {
          setTimeout(resolve, 50);
        });
        return result;
      }
    } catch (e) {
      // Non-fatal — dir may already exist
      return { success: true };
    }
  }

  /**
   * Ensure a local directory exists. Creates parent dirs by calling in order.
   */
  async function ensureLocalDir(dirPath) {
    try {
      var result = await window.termulAPI.fs.mkdir(dirPath);
      return result;
    } catch (e) {
      // Non-fatal — dir may already exist
      return { success: true };
    }
  }

  async function uploadSelected() {
    // Snapshot and clear selection immediately to prevent duplicate processing
    var names = Object.keys(selectedLocal);
    if (names.length === 0) return;
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    var snapshot = names.slice();
    clearLocalSelection();
    updateTransferButtons();
    setLocalStatus("Preparing upload...");

    for (var i = 0; i < snapshot.length; i++) {
      var entry = findLocalEntry(snapshot[i]);
      if (!entry) continue;

      if (entry.isFile) {
        // Single file upload
        var remoteFilePath = joinRemotePath(remotePath, entry.name);
        addTransfer(
          "upload",
          entry.name,
          entry.path,
          remoteFilePath,
          entry.size,
        );
      } else if (entry.isDirectory) {
        // Folder upload — collect all files and dirs recursively
        var folderDirs = await collectLocalDirsRecursively(
          entry.path,
          entry.name,
        );
        var folderFiles = await collectLocalFilesRecursively(
          entry.path,
          entry.name,
        );

        // Create the root remote folder first (before sub-dirs or files)
        var remoteFolderPath = joinRemotePath(remotePath, entry.name);
        await ensureRemoteDir(remoteFolderPath);

        // Create remote sub-directories (parent-first order)
        for (var d = 0; d < folderDirs.length; d++) {
          var remoteDirPath = joinRemotePath(remotePath, folderDirs[d]);
          await ensureRemoteDir(remoteDirPath);
        }

        // Add all files to transfer queue
        for (var f = 0; f < folderFiles.length; f++) {
          var remoteFile = joinRemotePath(
            remotePath,
            folderFiles[f].relativePath,
          );
          addTransfer(
            "upload",
            folderFiles[f].relativePath,
            folderFiles[f].path,
            remoteFile,
            folderFiles[f].size,
          );
        }
      }
    }

    setLocalStatus("");
    processQueue();
  }

  async function downloadSelected() {
    // Snapshot and clear selection immediately to prevent duplicate processing
    var names = Object.keys(selectedRemote);
    if (names.length === 0) return;
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    var snapshot = names.slice();
    clearRemoteSelection();
    updateTransferButtons();
    setRemoteStatus("Preparing download...");

    for (var i = 0; i < snapshot.length; i++) {
      var entry = findRemoteEntry(snapshot[i]);
      if (!entry) continue;

      if (entry.isFile) {
        // Single file download
        var localFilePath = joinLocalPath(localPath, entry.name);
        addTransfer(
          "download",
          entry.name,
          entry.path,
          localFilePath,
          entry.size,
        );
      } else if (entry.isDirectory) {
        // Folder download — collect all files and dirs recursively
        var folderDirs = await collectRemoteDirsRecursively(
          entry.path,
          entry.name,
        );
        var folderFiles = await collectRemoteFilesRecursively(
          entry.path,
          entry.name,
        );

        // Create the root local folder first (before sub-dirs or files)
        var localFolderPath = joinLocalPath(localPath, entry.name);
        await ensureLocalDir(localFolderPath);

        // Create local sub-directories (parent-first order)
        for (var d = 0; d < folderDirs.length; d++) {
          var localDirPath = joinLocalPath(localPath, folderDirs[d]);
          await ensureLocalDir(localDirPath);
        }

        // Add all files to transfer queue
        for (var f = 0; f < folderFiles.length; f++) {
          var localFile = joinLocalPath(localPath, folderFiles[f].relativePath);
          addTransfer(
            "download",
            folderFiles[f].relativePath,
            folderFiles[f].path,
            localFile,
            folderFiles[f].size,
          );
        }
      }
    }

    setRemoteStatus("");
    processQueue();
  }

  function addTransfer(type, name, sourcePath, destPath, size) {
    transferCounter++;
    var transfer = {
      id: "xfer_" + transferCounter,
      type: type,
      name: name,
      source: sourcePath,
      dest: destPath,
      size: size || 0,
      percent: 0,
      status: "pending",
      error: null,
    };
    transferQueue.push(transfer);
    renderQueueItem(transfer);
    updateQueueCount();
    // Ensure queue section is expanded when items are added
    var queueSection = shadow.querySelector(".ft-queue-section");
    if (queueSection) {
      queueSection.classList.remove("ft-collapsed");
    }
  }

  /**
   * Remove a transfer's UI element after a delay.
   * This keeps completed/failed transfers visible briefly.
   * Note: The transfer is already removed from the queue array, this just removes the UI.
   */
  function removeTransferAfterDelay(transferId, delayMs) {
    setTimeout(function () {
      // Just remove the UI element - transfer is already removed from queue array
      var queueItem = shadow.getElementById("queue-" + transferId);
      if (queueItem) {
        queueItem.remove();
      }
      // Show empty message if no more visible items and queue is empty
      if (transferQueue.length === 0 && els.queueList) {
        var hasVisibleItems = els.queueList.querySelector(".ft-queue-item");
        if (!hasVisibleItems) {
          var emptyMsg = els.queueList.querySelector(".ft-queue-empty");
          if (!emptyMsg) {
            els.queueList.innerHTML =
              '<div class="ft-queue-empty">No active transfers</div>';
          }
        }
      }
    }, delayMs);
  }

  function renderQueueItem(transfer) {
    var iconClass =
      transfer.type === "upload" ? "ft-icon-upload" : "ft-icon-download";
    var iconSvg = transfer.type === "upload" ? ICONS.upload : ICONS.download;
    var statusText = "Queued";

    var html =
      '<div class="ft-queue-item" id="queue-' +
      transfer.id +
      '">' +
      '<div class="ft-queue-item-icon ' +
      iconClass +
      '">' +
      iconSvg +
      "</div>" +
      '<div class="ft-queue-item-info">' +
      '<div class="ft-queue-item-name">' +
      escapeHtml(transfer.name) +
      "</div>" +
      '<div class="ft-queue-item-progress">' +
      '<div class="ft-queue-item-bar"><div class="ft-queue-item-bar-fill" id="bar-' +
      transfer.id +
      '" style="width:0%"></div></div>' +
      '<span class="ft-queue-item-percent" id="pct-' +
      transfer.id +
      '">0%</span>' +
      "</div></div>" +
      '<div class="ft-queue-item-status" id="status-' +
      transfer.id +
      '">' +
      statusText +
      "</div>" +
      "</div>";

    // Remove empty message if present
    var emptyMsg = els.queueList.querySelector(".ft-queue-empty");
    if (emptyMsg) {
      emptyMsg.remove();
    }

    els.queueList.insertAdjacentHTML("beforeend", html);
  }

  /**
   * Mark a transfer item as complete or failed with visual styling
   */
  function markTransferDone(transferId, status) {
    var queueItem = shadow.getElementById("queue-" + transferId);
    if (queueItem) {
      if (status === "complete") {
        queueItem.classList.add("ft-completed");
      } else if (status === "failed") {
        queueItem.classList.add("ft-failed");
      }
    }
  }

  async function processQueue() {
    if (isTransferring) return;
    isTransferring = true;

    // NOTE: We no longer pre-test the connection before starting transfers.
    // The connection test was causing issues because:
    // 1. It used ssh.exec which requires a full shell (not always available)
    // 2. sftpStat might fail on some servers
    // 3. The actual transfer functions (sftpUpload/sftpDownload) have better error handling
    // Let the transfers fail naturally with specific error messages instead.

    while (transferQueue.length > 0) {
      var transfer = transferQueue[0];

      // Skip transfers that are already complete or failed (shouldn't happen, but safety check)
      if (transfer.status === "complete" || transfer.status === "failed") {
        transferQueue.shift();
        continue;
      }

      // Update status to active
      transfer.status = "transferring";
      updateQueueItemStatus(transfer.id, "Transferring...", "");
      updateQueueCount();

      try {
        console.log(
          "[FileTransfer] Starting transfer:",
          transfer.type,
          transfer.source,
          "->",
          transfer.dest,
          "id:",
          transfer.id,
        );
        var result;
        if (transfer.type === "upload") {
          if (isFtp()) {
            result = await window.termulAPI.ftp.upload(
              api.connectionId,
              transfer.source,
              transfer.dest,
              transfer.id,
            );
          } else {
            result = await window.termulAPI.ssh.sftpUpload(
              api.connectionId,
              transfer.source,
              transfer.dest,
              transfer.id,
            );
          }
        } else {
          if (isFtp()) {
            result = await window.termulAPI.ftp.download(
              api.connectionId,
              transfer.source,
              transfer.dest,
              transfer.id,
            );
          } else {
            result = await window.termulAPI.ssh.sftpDownload(
              api.connectionId,
              transfer.source,
              transfer.dest,
              transfer.id,
            );
          }
        }
        if (result.success) {
          transfer.status = "complete";
          updateQueueItemStatus(transfer.id, "Complete", "ft-complete");
          updateQueueItemBar(transfer.id, 100, "ft-complete");
          updateQueueItemPercent(transfer.id, "100%");
          markTransferDone(transfer.id, "complete");
          // Keep in queue for 5 seconds before removing
          removeTransferAfterDelay(transfer.id, 5000);
        } else {
          transfer.status = "failed";
          // Check if error is connection-related
          var errorMsg = result.error || "Failed";
          if (
            errorMsg.includes("Connection") ||
            errorMsg.includes("channel") ||
            errorMsg.includes("closed")
          ) {
            // Connection error - abort remaining transfers
            updateQueueItemStatus(transfer.id, errorMsg, "ft-error");
            updateQueueItemBar(transfer.id, transfer.percent || 0, "ft-error");
            markTransferDone(transfer.id, "failed");
            // Keep in queue for 5 seconds before removing
            removeTransferAfterDelay(transfer.id, 5000);

            // Mark remaining transfers as failed
            var remainingCount = transferQueue.length;
            for (var i = 0; i < remainingCount; i++) {
              var remaining = transferQueue[0]; // Always take from front since we're shifting
              remaining.status = "failed";
              updateQueueItemStatus(
                remaining.id,
                "Connection lost",
                "ft-error",
              );
              updateQueueItemBar(
                remaining.id,
                remaining.percent || 0,
                "ft-error",
              );
              markTransferDone(remaining.id, "failed");
              // Schedule removal for each
              removeTransferAfterDelay(remaining.id, 5000);
              transferQueue.shift(); // Remove from queue to prevent endless loop
            }
            updateQueueCount();
            break;
          } else {
            // Display error - show clearer message for channel errors
            if (
              errorMsg.includes("Channel open") ||
              errorMsg.includes("open failed")
            ) {
              updateQueueItemStatus(
                transfer.id,
                "Server busy - try again",
                "ft-error",
              );
            } else {
              updateQueueItemStatus(transfer.id, errorMsg, "ft-error");
            }
            updateQueueItemBar(transfer.id, transfer.percent, "ft-error");
            markTransferDone(transfer.id, "failed");
            // Keep in queue for 5 seconds before removing
            removeTransferAfterDelay(transfer.id, 5000);
          }
        }
      } catch (e) {
        transfer.status = "failed";
        var catchError = e.message || "Error";
        // Check if error is connection-related
        if (
          catchError.includes("Connection") ||
          catchError.includes("channel") ||
          catchError.includes("closed")
        ) {
          // Connection error - abort remaining transfers
          updateQueueItemStatus(transfer.id, catchError, "ft-error");
          updateQueueItemBar(transfer.id, transfer.percent || 0, "ft-error");
          markTransferDone(transfer.id, "failed");
          // Keep in queue for 5 seconds before removing
          removeTransferAfterDelay(transfer.id, 5000);

          // Mark remaining transfers as failed
          var remainingCount = transferQueue.length;
          for (var i = 0; i < remainingCount; i++) {
            var remaining2 = transferQueue[0]; // Always take from front since we're shifting
            remaining2.status = "failed";
            updateQueueItemStatus(remaining2.id, "Connection lost", "ft-error");
            updateQueueItemBar(
              remaining2.id,
              remaining2.percent || 0,
              "ft-error",
            );
            markTransferDone(remaining2.id, "failed");
            // Schedule removal for each
            removeTransferAfterDelay(remaining2.id, 5000);
            transferQueue.shift(); // Remove from queue to prevent endless loop
          }
          updateQueueCount();
          break;
        } else {
          // Display error - show clearer message for channel errors
          if (
            catchError.includes("Channel open") ||
            catchError.includes("open failed")
          ) {
            updateQueueItemStatus(
              transfer.id,
              "Server busy - try again",
              "ft-error",
            );
          } else {
            updateQueueItemStatus(transfer.id, catchError, "ft-error");
          }
          updateQueueItemBar(transfer.id, transfer.percent, "ft-error");
          markTransferDone(transfer.id, "failed");
          // Keep in queue for 5 seconds before removing
          removeTransferAfterDelay(transfer.id, 5000);
        }
      }

      // Remove from queue immediately to prevent endless loop
      // The UI element will stay visible for 5 seconds via removeTransferAfterDelay
      transferQueue.shift();
      updateQueueCount();
    }

    isTransferring = false;

    // Refresh both panes after all active transfers complete
    // Wait a bit for the UI to update first
    setTimeout(function () {
      refreshBoth();
    }, 100);
  }

  function handleProgress(data) {
    // Find the transfer in the queue by transferId
    for (var i = 0; i < transferQueue.length; i++) {
      if (transferQueue[i].id === data.transferId) {
        transferQueue[i].percent = data.percent;
        updateQueueItemPercent(data.transferId, data.percent + "%");
        updateQueueItemBar(data.transferId, data.percent, "");
        break;
      }
    }
  }

  function updateQueueItemStatus(id, text, cls) {
    var el = shadow.getElementById("status-" + id);
    if (!el) return;
    el.textContent = text;
    el.className = "ft-queue-item-status";
    if (cls) el.classList.add(cls);
  }

  function updateQueueItemBar(id, percent, cls) {
    var el = shadow.getElementById("bar-" + id);
    if (!el) return;
    el.style.width = Math.min(100, Math.max(0, percent)) + "%";
    el.className = "ft-queue-item-bar-fill";
    if (cls) el.classList.add(cls);
  }

  function updateQueueItemPercent(id, text) {
    var el = shadow.getElementById("pct-" + id);
    if (el) el.textContent = text;
  }

  function updateQueueCount() {
    // Count only active transfers (not complete/failed)
    var activeCount = 0;
    for (var i = 0; i < transferQueue.length; i++) {
      if (
        transferQueue[i].status === "pending" ||
        transferQueue[i].status === "transferring"
      ) {
        activeCount++;
      }
    }
    if (els.queueCount) {
      els.queueCount.textContent =
        activeCount + " transfer" + (activeCount !== 1 ? "s" : "");
    }
    // Only show empty message if queue array is empty AND no visible items in DOM
    var hasVisibleItems = els.queueList
      ? els.queueList.querySelector(".ft-queue-item")
      : null;
    if (transferQueue.length === 0 && els.queueList && !hasVisibleItems) {
      var emptyMsg = els.queueList.querySelector(".ft-queue-empty");
      if (!emptyMsg) {
        els.queueList.innerHTML =
          '<div class="ft-queue-empty">No active transfers</div>';
      }
    }
  }

  function toggleQueue() {
    var section = shadow.querySelector(".ft-queue-section");
    if (section) section.classList.toggle("ft-collapsed");
  }

  // ─── File Operations (Add File, Add Folder, Delete) ────────────────

  async function addNewFile() {
    if (activePane === "remote" && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    var name = await promptUser(
      activePane === "local"
        ? "Create New File (Local)"
        : "Create New File (Remote)",
      "File name:",
      "new_file.txt",
    );
    if (!name) return;

    if (activePane === "local") {
      var targetPath = joinLocalPath(localPath, name);
      try {
        var result = await window.termulAPI.fs.createFile(targetPath);
        if (!result.success) {
          toast = api.ui.toast();
          toast.show(result.error || "Failed to create file", "error");
        } else {
          loadLocalDir(localPath);
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || "Failed to create file", "error");
      }
    } else {
      // Remote
      var remoteFilePath = joinRemotePath(remotePath, name);
      if (isFtp()) {
        // FTP: write empty content to create file
        try {
          var result = await window.termulAPI.ftp.writeFile(
            api.connectionId,
            remoteFilePath,
            "",
          );
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || "Failed to create file", "error");
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || "Failed to create file", "error");
        }
      } else {
        // SSH: use touch via ssh:exec
        var remotePathEsc = shellQuote(remoteFilePath);
        try {
          var result = await window.termulAPI.ssh.exec(
            api.connectionId,
            "touch " + remotePathEsc,
          );
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || "Failed to create file", "error");
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || "Failed to create file", "error");
        }
      }
    }
  }

  async function addNewFolder() {
    if (activePane === "remote" && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    var name = await promptUser(
      activePane === "local"
        ? "Create New Folder (Local)"
        : "Create New Folder (Remote)",
      "Folder name:",
      "new_folder",
    );
    if (!name) return;

    if (activePane === "local") {
      var targetPath = joinLocalPath(localPath, name);
      try {
        var result = await window.termulAPI.fs.mkdir(targetPath);
        if (!result.success) {
          toast = api.ui.toast();
          toast.show(result.error || "Failed to create folder", "error");
        } else {
          loadLocalDir(localPath);
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || "Failed to create folder", "error");
      }
    } else {
      // Remote
      var remoteFolderPath = joinRemotePath(remotePath, name);
      if (isFtp()) {
        // FTP: use FTP mkdir
        try {
          var result = await window.termulAPI.ftp.mkdir(
            api.connectionId,
            remoteFolderPath,
          );
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || "Failed to create folder", "error");
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || "Failed to create folder", "error");
        }
      } else {
        // SSH: use mkdir -p via ssh:exec
        var remotePathEsc = shellQuote(remoteFolderPath);
        try {
          var result = await window.termulAPI.ssh.exec(
            api.connectionId,
            "mkdir -p " + remotePathEsc,
          );
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || "Failed to create folder", "error");
          } else {
            loadRemoteDir(remotePath);
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || "Failed to create folder", "error");
        }
      }
    }
  }

  async function deleteSelected() {
    var items = getSelectedItems();
    if (items.length === 0) return;

    var names = items.map(function (it) {
      return it.name;
    });
    var preview =
      names.length <= 5
        ? names.join(", ")
        : names.slice(0, 5).join(", ") + " and " + (names.length - 5) + " more";

    var confirmed = await confirmUser(
      "Delete " +
        items.length +
        " item" +
        (items.length !== 1 ? "s" : "") +
        "?",
      preview,
    );

    if (!confirmed) return;

    if (activePane === "local") {
      // Delete local files/dirs one by one
      for (var i = 0; i < items.length; i++) {
        try {
          var result = await window.termulAPI.fs.deletePath(items[i].path);
          if (!result.success) {
            var toast = api.ui.toast();
            toast.show(
              "Failed to delete " +
                items[i].name +
                ": " +
                (result.error || "Unknown error"),
              "error",
            );
          }
        } catch (e) {}
      }
      loadLocalDir(localPath);
    } else {
      if (!api.connectionId) {
        var toast = api.ui.toast();
        toast.show(
          isFtp()
            ? "Not connected to FTP server"
            : "Not connected to SSH server",
          "error",
        );
        return;
      }

      if (isFtp()) {
        // FTP: delete items one by one (FTP doesn't support batch commands)
        for (var j = 0; j < items.length; j++) {
          try {
            if (items[j].isDirectory) {
              var result = await window.termulAPI.ftp.rmdir(
                api.connectionId,
                items[j].path,
              );
            } else {
              var result = await window.termulAPI.ftp.delete(
                api.connectionId,
                items[j].path,
              );
            }
            if (!result.success) {
              toast = api.ui.toast();
              toast.show(
                "Failed to delete " +
                  items[j].name +
                  ": " +
                  (result.error || "Unknown error"),
                "error",
              );
            }
          } catch (e) {
            toast = api.ui.toast();
            toast.show(
              "Failed to delete " +
                items[j].name +
                ": " +
                (e.message || "Unknown error"),
              "error",
            );
          }
        }
      } else {
        // SSH: batch delete using single rm -rf with all paths
        var paths = [];
        for (var j = 0; j < items.length; j++) {
          paths.push(shellQuote(items[j].path));
        }

        var cmd = "rm -rf " + paths.join(" ");
        try {
          var result = await window.termulAPI.ssh.exec(api.connectionId, cmd);
          if (!result.success) {
            toast = api.ui.toast();
            toast.show(result.error || "Failed to delete items", "error");
          }
        } catch (e) {
          toast = api.ui.toast();
          toast.show(e.message || "Failed to delete items", "error");
        }
      }
      loadRemoteDir(remotePath);
    }
  }

  // ─── Open in Editor / Viewer ────────────────────────────────────────

  // ─── Rename ─────────────────────────────────────────────────────────

  async function renameSelectedItem() {
    var selection = activePane === "local" ? selectedLocal : selectedRemote;
    var names = Object.keys(selection);

    if (names.length !== 1) {
      var toast = api.ui.toast();
      toast.show("Select exactly one item to rename", "info");
      return;
    }

    var oldName = names[0];
    var entries = activePane === "local" ? localEntries : remoteEntries;
    var entry = findEntryByName(entries, oldName);
    if (!entry) return;

    if (activePane === "remote" && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    var newName = await promptUser(
      activePane === "local" ? "Rename (Local)" : "Rename (Remote)",
      'New name for "' + oldName + '":',
      oldName,
    );
    if (!newName || newName === oldName) return;

    // Validate: no slashes or backslashes in name
    if (newName.indexOf("/") !== -1 || newName.indexOf("\\") !== -1) {
      toast = api.ui.toast();
      toast.show("Name cannot contain slashes", "error");
      return;
    }

    if (activePane === "local") {
      var oldPath = entry.path;
      var newPath = joinLocalPath(localPath, newName);
      try {
        var result = await window.termulAPI.fs.rename(oldPath, newPath);
        if (!result || !result.success) {
          toast = api.ui.toast();
          toast.show((result && result.error) || "Failed to rename", "error");
        } else {
          clearLocalSelection();
          loadLocalDir(localPath);
          var successToast = api.ui.toast();
          successToast.show('Renamed to "' + newName + '"', "success");
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || "Failed to rename", "error");
      }
    } else {
      // Remote
      var oldPath = entry.path;
      var newPath = joinRemotePath(remotePath, newName);
      try {
        var result;
        if (isFtp()) {
          result = await window.termulAPI.ftp.rename(
            api.connectionId,
            oldPath,
            newPath,
          );
        } else {
          result = await window.termulAPI.ssh.sftpRename(
            api.connectionId,
            oldPath,
            newPath,
          );
        }
        if (!result || !result.success) {
          toast = api.ui.toast();
          toast.show((result && result.error) || "Failed to rename", "error");
        } else {
          clearRemoteSelection();
          loadRemoteDir(remotePath);
          var successToast = api.ui.toast();
          successToast.show('Renamed to "' + newName + '"', "success");
        }
      } catch (e) {
        toast = api.ui.toast();
        toast.show(e.message || "Failed to rename", "error");
      }
    }
  }

  // ─── Duplicate ──────────────────────────────────────────────────────

  /**
   * Check if an error message indicates an SSH channel exhaustion / closure error.
   */
  function isChannelError(msg) {
    if (!msg) return false;
    var lower = msg.toLowerCase();
    return (
      lower.indexOf("channel") !== -1 ||
      lower.indexOf("open failed") !== -1 ||
      lower.indexOf("too many") !== -1 ||
      lower.indexOf("resource") !== -1
    );
  }

  /**
   * Generate a non-conflicting duplicate name.
   * e.g. "file.txt" → "file copy.txt", "file copy.txt" → "file copy 2.txt"
   *      "folder" → "folder copy", "folder copy" → "folder copy 2"
   */
  function generateDuplicateName(originalName, existingNames) {
    var existingSet = {};
    for (var i = 0; i < existingNames.length; i++) {
      existingSet[existingNames[i]] = true;
    }

    var baseName = originalName;
    var ext = "";
    var dotIdx = originalName.lastIndexOf(".");
    // Only treat as an extension if there's a dot and it's not a hidden file like ".gitignore"
    if (dotIdx > 0) {
      baseName = originalName.substring(0, dotIdx);
      ext = originalName.substring(dotIdx); // includes the dot
    }

    // First try: "basename copy.ext"
    var candidate = baseName + " copy" + ext;
    if (!existingSet[candidate]) return candidate;

    // Then try: "basename copy 2.ext", "basename copy 3.ext", etc.
    var counter = 2;
    while (true) {
      candidate = baseName + " copy " + counter + ext;
      if (!existingSet[candidate]) return candidate;
      counter++;
      // Safety limit
      if (counter > 1000) return baseName + " copy " + Date.now() + ext;
    }
  }

  async function duplicateSelected() {
    var selection = activePane === "local" ? selectedLocal : selectedRemote;
    var entries = activePane === "local" ? localEntries : remoteEntries;
    var names = Object.keys(selection);

    if (names.length === 0) {
      var toast = api.ui.toast();
      toast.show("Select at least one item to duplicate", "info");
      return;
    }

    if (activePane === "remote" && !api.connectionId) {
      var toast = api.ui.toast();
      toast.show(
        isFtp() ? "Not connected to FTP server" : "Not connected to SSH server",
        "error",
      );
      return;
    }

    // Get existing names in current directory to avoid conflicts
    var existingNames = [];
    for (var e = 0; e < entries.length; e++) {
      existingNames.push(entries[e].name);
    }

    if (activePane === "local") {
      // Duplicate local items
      for (var i = 0; i < names.length; i++) {
        var entry = findEntryByName(entries, names[i]);
        if (!entry) continue;

        var newName = generateDuplicateName(entry.name, existingNames);
        var sourcePath = entry.path;
        var destPath = joinLocalPath(localPath, newName);

        try {
          var result;
          if (entry.isDirectory) {
            // For directories, use copyDir if available, otherwise use recursive approach
            result = await window.termulAPI.fs.copyPath(sourcePath, destPath);
          } else {
            result = await window.termulAPI.fs.copyPath(sourcePath, destPath);
          }

          if (!result || !result.success) {
            toast = api.ui.toast();
            toast.show(
              'Failed to duplicate "' +
                entry.name +
                '": ' +
                ((result && result.error) || "Unknown error"),
              "error",
            );
          } else {
            existingNames.push(newName);
          }
        } catch (err) {
          toast = api.ui.toast();
          toast.show(
            'Failed to duplicate "' +
              entry.name +
              '": ' +
              (err.message || "Unknown error"),
            "error",
          );
        }
      }
      loadLocalDir(localPath);
    } else {
      // Remote
      if (isFtp()) {
        // FTP: duplicate items one by one
        for (var j = 0; j < names.length; j++) {
          var entry = findEntryByName(entries, names[j]);
          if (!entry) continue;

          var newName = generateDuplicateName(entry.name, existingNames);

          try {
            var result;
            if (entry.isDirectory) {
              // FTP doesn't have a native copy — notify the user
              toast = api.ui.toast();
              toast.show("Cannot duplicate directories via FTP", "error");
              continue;
            } else {
              // Read the file content, then write to the new name
              var readResult = await window.termulAPI.ftp.readFile(
                api.connectionId,
                entry.path,
              );
              if (!readResult || !readResult.success) {
                toast = api.ui.toast();
                toast.show('Failed to read "' + entry.name + '"', "error");
                continue;
              }
              var remoteDest = joinRemotePath(remotePath, newName);
              result = await window.termulAPI.ftp.writeFile(
                api.connectionId,
                remoteDest,
                readResult.content,
              );
            }

            if (!result || !result.success) {
              toast = api.ui.toast();
              toast.show('Failed to duplicate "' + entry.name + '"', "error");
            } else {
              existingNames.push(newName);
            }
          } catch (err) {
            toast = api.ui.toast();
            toast.show(
              'Failed to duplicate "' +
                entry.name +
                '": ' +
                (err.message || "Unknown error"),
              "error",
            );
          }
        }
      } else {
        // SSH: use cp -r for copy, with delay between commands to avoid channel exhaustion
        var sshPaths = [];
        var sshEntries = [];
        for (var k = 0; k < names.length; k++) {
          var entry = findEntryByName(entries, names[k]);
          if (!entry) continue;

          var newName = generateDuplicateName(entry.name, existingNames);
          var destPath = joinRemotePath(remotePath, newName);
          sshPaths.push({
            src: shellQuote(entry.path),
            dst: shellQuote(destPath),
          });
          sshEntries.push({ entry: entry, newName: newName });
          existingNames.push(newName);
        }

        // Execute cp commands sequentially with delay between each
        for (var p = 0; p < sshPaths.length; p++) {
          var cpEntry = sshEntries[p].entry;
          var cpFlag = cpEntry.isDirectory ? "-r" : "";
          var cpCmd =
            "cp " + cpFlag + " " + sshPaths[p].src + " " + sshPaths[p].dst;
          try {
            var result = await window.termulAPI.ssh.exec(
              api.connectionId,
              cpCmd,
            );
            if (!result || !result.success) {
              toast = api.ui.toast();
              toast.show(
                'Failed to duplicate "' +
                  cpEntry.name +
                  '": ' +
                  ((result && result.error) || "Unknown error"),
                "error",
              );
            }
          } catch (err) {
            toast = api.ui.toast();
            toast.show(
              'Failed to duplicate "' +
                cpEntry.name +
                '": ' +
                (err.message || "Unknown error"),
              "error",
            );
          }
          // Add a delay between commands to avoid channel exhaustion
          if (p < sshPaths.length - 1) {
            await new Promise(function (resolve) {
              setTimeout(resolve, 150);
            });
          }
        }
      }
      loadRemoteDir(remotePath);
    }
  }

  // ─── Open in Editor / Viewer ────────────────────────────────────────

  function openSelectedFile() {
    var selection = ctxPane === "local" ? selectedLocal : selectedRemote;
    var names = Object.keys(selection);
    if (names.length !== 1) return;

    var entries = ctxPane === "local" ? localEntries : remoteEntries;
    var entry = findEntryByName(entries, names[0]);
    if (!entry) return;

    var filePath = entry.path;
    var source = ctxPane; // 'local' or 'remote'

    if (isViewableFile(entry)) {
      // Open images and PDFs in the file-viewer plugin
      api.events.emit("open-in-viewer", {
        source: source,
        path: filePath,
        name: entry.name,
      });
    } else if (isTextFile(entry)) {
      // Open text files in the file-editor plugin
      api.events.emit("open-in-editor", {
        source: source,
        path: filePath,
        name: entry.name,
      });
    }
  }

  // ─── Refresh ────────────────────────────────────────────────────────

  async function refreshBoth() {
    loadLocalDir(localPath);
    if (api.connectionId && remotePath) {
      loadRemoteDir(remotePath);
    }
  }

  // ─── Breadcrumb Functions ──────────────────────────────────────────────

  /**
   * Render path breadcrumb segments into a container element.
   * Handles both Unix paths (/home/user) and Windows paths (C:\Users\name).
   */
  function renderPathBreadcrumb(containerEl, path, pane) {
    if (!containerEl || !path) return;

    var isWindows = /^[A-Za-z]:/.test(path);
    var segments = []; // { name, fullPath }

    if (isWindows) {
      // Windows path: C:\Users\name
      var parts = path.split(/[\\\/]/).filter(function (s) {
        return s !== "";
      });
      var accumulated = "";
      for (var i = 0; i < parts.length; i++) {
        accumulated = i === 0 ? parts[i] + "\\" : accumulated + "\\" + parts[i];
        segments.push({ name: parts[i], fullPath: accumulated });
      }
    } else {
      // Unix path: /home/user
      if (path.charAt(0) === "/") {
        segments.push({ name: "/", fullPath: "/" });
        var rest = path.substring(1);
        if (rest) {
          var parts = rest.split("/").filter(function (s) {
            return s !== "";
          });
          var accumulated = "/";
          for (var i = 0; i < parts.length; i++) {
            accumulated =
              accumulated === "/"
                ? "/" + parts[i]
                : accumulated + "/" + parts[i];
            segments.push({ name: parts[i], fullPath: accumulated });
          }
        }
      } else {
        // Relative path fallback
        var parts = path.split("/").filter(function (s) {
          return s !== "";
        });
        var accumulated = "";
        for (var i = 0; i < parts.length; i++) {
          accumulated = accumulated ? accumulated + "/" + parts[i] : parts[i];
          segments.push({ name: parts[i], fullPath: accumulated });
        }
      }
    }

    var html = "";
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var isLast = i === segments.length - 1;

      // Add chevron separator between segments
      if (i > 0) {
        html += '<span class="ft-bc-sep">›</span>';
      }

      var cls = isLast ? "ft-bc-segment ft-bc-current" : "ft-bc-segment";
      html +=
        '<span class="' +
        cls +
        '" data-path="' +
        escapeAttr(seg.fullPath) +
        '" data-pane="' +
        pane +
        '">' +
        escapeHtml(seg.name) +
        "</span>";
    }

    containerEl.innerHTML = html;
  }

  /**
   * Switch path bar to breadcrumb display mode.
   */
  function switchToBreadcrumb(pane) {
    if (pane === "local") {
      if (els.localBreadcrumb) els.localBreadcrumb.style.display = "";
      if (els.localPath) els.localPath.style.display = "none";
      localPathMode = "breadcrumb";
    } else {
      if (els.remoteBreadcrumb) els.remoteBreadcrumb.style.display = "";
      if (els.remotePath) els.remotePath.style.display = "none";
      remotePathMode = "breadcrumb";
    }
  }

  /**
   * Switch path bar to editable text input mode.
   */
  function switchToInput(pane) {
    if (pane === "local") {
      if (els.localBreadcrumb) els.localBreadcrumb.style.display = "none";
      if (els.localPath) {
        els.localPath.style.display = "";
        els.localPath.value = localPath;
        els.localPath.focus();
        els.localPath.select();
      }
      localPathMode = "input";
    } else {
      if (els.remoteBreadcrumb) els.remoteBreadcrumb.style.display = "none";
      if (els.remotePath) {
        els.remotePath.style.display = "";
        els.remotePath.value = remotePath;
        els.remotePath.focus();
        els.remotePath.select();
      }
      remotePathMode = "input";
    }
  }

  // ─── Utility Functions ──────────────────────────────────────────────

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    var size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function formatDate(timestamp) {
    if (!timestamp) return "";
    var d = new Date(timestamp);
    var year = d.getFullYear();
    var month = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    var hours = String(d.getHours()).padStart(2, "0");
    var mins = String(d.getMinutes()).padStart(2, "0");
    return year + "-" + month + "-" + day + " " + hours + ":" + mins;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function joinRemotePath(dir, name) {
    if (dir === "/") return "/" + name;
    return dir + "/" + name;
  }

  function joinLocalPath(dir, name) {
    // Handle both Unix and Windows paths
    if (dir.indexOf("/") !== -1 && dir.indexOf("\\") === -1) {
      return dir + "/" + name;
    }
    return dir + "\\" + name;
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

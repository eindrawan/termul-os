// File Viewer Plugin — View images and PDF documents
//
// Available globals from the sandbox:
//   PLUGIN_API, PLUGIN_LIFECYCLE, PLUGIN_EXPORTS,
//   shadow, shadowDoc, addEventListener,
//   setTimeout, setInterval, clearTimeout, clearInterval
//

(function () {
  var api = PLUGIN_API;

  // ─── Constants ─────────────────────────────────────────────────────────

  var SOURCE_LOCAL = 'local';
  var SOURCE_REMOTE = 'remote';

  var TYPE_IMAGE = 'image';
  var TYPE_PDF = 'pdf';
  var TYPE_UNKNOWN = 'unknown';

  var IMAGE_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico',
    'tiff', 'tif', 'avif'
  ];

  var PDF_EXTENSIONS = ['pdf'];

  var IMAGE_MIME_MAP = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
    'avif': 'image/avif'
  };

  // Zoom levels
  var ZOOM_MIN = 10;
  var ZOOM_MAX = 500;
  var ZOOM_STEP = 25;
  var ZOOM_FIT = 'fit';
  var ZOOM_ACTUAL = 100;

  // ─── State ──────────────────────────────────────────────────────────────

  var openFiles = [];         // { id, source, path, name, type, base64, mimeType, zoomMode, blobUrl }
  var activeFileId = null;

  // DOM element cache
  var els = {};

  // ─── Icons ───────────────────────────────────────────────────────────────

  var ICON_LOCAL = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var ICON_REMOTE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  var ICON_CLOSE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  PLUGIN_LIFECYCLE.onMount(function () {
    // Cache DOM elements
    els.openLocalBtn = shadow.getElementById('fv-open-local');
    els.openRemoteBtn = shadow.getElementById('fv-open-remote');
    els.zoomOut = shadow.getElementById('fv-zoom-out');
    els.zoomIn = shadow.getElementById('fv-zoom-in');
    els.zoomFit = shadow.getElementById('fv-zoom-fit');
    els.zoomActual = shadow.getElementById('fv-zoom-actual');
    els.zoomLabel = shadow.getElementById('fv-zoom-label');
    els.tabsScroll = shadow.getElementById('fv-tabs-scroll');
    els.viewerWrapper = shadow.getElementById('fv-viewer-wrapper');
    els.empty = shadow.getElementById('fv-empty');
    els.content = shadow.getElementById('fv-content');
    els.emptyOpenLocal = shadow.getElementById('fv-empty-open-local');
    els.emptyOpenRemote = shadow.getElementById('fv-empty-open-remote');

    // Status bar elements
    els.statusFile = shadow.getElementById('fv-status-file');
    els.statusType = shadow.getElementById('fv-status-type');
    els.statusSource = shadow.getElementById('fv-status-source');
    els.statusSize = shadow.getElementById('fv-status-size');

    // Remote modal — now uses api.ui.modal (no HTML modal needed)

    // Bind toolbar events
    addEventListener(els.openLocalBtn, 'click', openLocalFileDialog);
    addEventListener(els.openRemoteBtn, 'click', showRemoteFileDialog);
    addEventListener(els.zoomOut, 'click', zoomOut);
    addEventListener(els.zoomIn, 'click', zoomIn);
    addEventListener(els.zoomFit, 'click', zoomToFit);
    addEventListener(els.zoomActual, 'click', zoomToActual);

    // Empty state buttons
    addEventListener(els.emptyOpenLocal, 'click', openLocalFileDialog);
    addEventListener(els.emptyOpenRemote, 'click', showRemoteFileDialog);

    // Remote modal events — now uses api.ui.modal

    // Mouse wheel zoom on viewer
    addEventListener(els.content, 'wheel', function (e) {
      if (!activeFileId) return;
      var file = getActiveFile();
      if (!file || file.type !== TYPE_IMAGE) return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    });

    // Listen for external "open file" requests
    api.events.on('viewer-open-file', function (detail) {
      if (!detail || !detail.path) return;
      openFile(detail.path, detail.source || SOURCE_LOCAL);
    });
  });

  PLUGIN_LIFECYCLE.onUnmount(function () {
    // Revoke all Blob URLs to prevent memory leaks
    for (var i = 0; i < openFiles.length; i++) {
      if (openFiles[i].blobUrl) {
        URL.revokeObjectURL(openFiles[i].blobUrl);
      }
    }
    openFiles = [];
    activeFileId = null;
  });

  // ─── File Type Detection ────────────────────────────────────────────────

  function getFileExtension(filePath) {
    var parts = filePath.split('.');
    if (parts.length < 2) return '';
    return parts[parts.length - 1].toLowerCase();
  }

  function detectFileType(filePath) {
    var ext = getFileExtension(filePath);
    for (var i = 0; i < IMAGE_EXTENSIONS.length; i++) {
      if (IMAGE_EXTENSIONS[i] === ext) return TYPE_IMAGE;
    }
    for (var j = 0; j < PDF_EXTENSIONS.length; j++) {
      if (PDF_EXTENSIONS[j] === ext) return TYPE_PDF;
    }
    return TYPE_UNKNOWN;
  }

  function getMimeType(filePath) {
    var ext = getFileExtension(filePath);
    return IMAGE_MIME_MAP[ext] || 'application/octet-stream';
  }

  function getFileName(filePath) {
    var parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  function generateFileId() {
    return 'fv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // ─── File Operations ────────────────────────────────────────────────────

  function openLocalFileDialog() {
    window.termulAPI.dialog.openFile({
      title: 'Open Image or PDF',
      filters: [
        { name: 'All Supported', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif', 'avif', 'pdf'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif', 'avif'] },
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }).then(function (result) {
      if (result.canceled || result.filePaths.length === 0) return;
      openFile(result.filePaths[0], SOURCE_LOCAL);
    });
  }

  function showRemoteFileDialog() {
    if (!api.connectionId) {
      var toast = api.ui.toast();
      toast.show('Not connected to SSH server', 'error');
      return;
    }
    var modal = api.ui.modal({
      title: 'Open Remote File',
      content:
        '<label style="display:block;margin-bottom:6px;font-size:13px;color:var(--tui-text-secondary);">File path on remote server:</label>' +
        '<input type="text" class="tui-input" id="fv-remote-path-input" placeholder="/home/user/image.png" style="width:100%;">',
      buttons: [
        { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
        { label: 'Open', variant: 'primary', onClick: function(m) {
          var remotePath = m.el.querySelector('#fv-remote-path-input').value.trim();
          if (!remotePath) return;
          m.close();
          openFile(remotePath, SOURCE_REMOTE);
        }}
      ]
    });
    modal.open();
    setTimeout(function() {
      var input = modal.el.querySelector('#fv-remote-path-input');
      if (input) {
        input.focus();
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            var openBtn = modal.el.querySelector('.tui-btn-primary');
            if (openBtn) openBtn.click();
          }
        });
      }
    }, 50);
  }

  function hideRemoteFileDialog() {
    // No-op: kept for API compatibility (restoreEmptyState references removed)
  }

  async function openRemoteFile() {
    // No-op: logic moved into showRemoteFileDialog modal callback
  }

  async function openFile(path, source) {
    var fileType = detectFileType(path);

    if (fileType === TYPE_UNKNOWN) {
      var toast = api.ui.toast();
      toast.show('Unsupported file type. Supported: images and PDFs.', 'error');
      return;
    }

    // Show loading state
    showLoading();

    try {
      var base64Data;

      if (source === SOURCE_LOCAL) {
        var result = await window.termulAPI.fs.readFile(path, 'base64');
        if (!result.success) {
          showError('Failed to read file: ' + result.error);
          restoreViewState();
          return;
        }
        base64Data = result.content;
      } else {
        if (!api.connectionId) {
          showError('Not connected to SSH server');
          restoreViewState();
          return;
        }
        // Read remote binary file directly as base64 via SFTP
        var result = await window.termulAPI.ssh.sftpReadFileBase64(api.connectionId, path);
        if (!result.success) {
          showError('Failed to read remote file: ' + result.error);
          restoreViewState();
          return;
        }
        base64Data = result.content;
      }

      var fileName = getFileName(path);
      var fileId = generateFileId();
      var mimeType = fileType === TYPE_IMAGE ? getMimeType(path) : 'application/pdf';

      // Create a Blob URL for CSP compatibility (data: URLs may be blocked by CSP).
      // Blob URLs are same-origin and work with 'self' CSP directive.
      var blob = base64ToBlob(base64Data, mimeType);
      var blobUrl = URL.createObjectURL(blob);

      var fileData = {
        id: fileId,
        source: source,
        path: path,
        name: fileName,
        type: fileType,
        base64: base64Data,
        mimeType: mimeType,
        zoomMode: ZOOM_FIT,
        zoomPercent: 100,
        blobUrl: blobUrl
      };

      openFiles.push(fileData);
      setActiveFile(fileId);
      renderTabs();

    } catch (err) {
      showError('Failed to open file: ' + err.message);
      restoreViewState();
    }
  }

  function closeFile(fileId) {
    var file = openFiles.find(function (f) { return f.id === fileId; });
    if (!file) return;

    // Revoke Blob URL to free memory
    if (file.blobUrl) {
      URL.revokeObjectURL(file.blobUrl);
    }

    var idx = openFiles.indexOf(file);
    openFiles.splice(idx, 1);

    if (activeFileId === fileId) {
      if (openFiles.length > 0) {
        var newIdx = Math.min(idx, openFiles.length - 1);
        setActiveFile(openFiles[newIdx].id);
      } else {
        activeFileId = null;
        restoreEmptyState();
      }
    }

    renderTabs();
    updateStatusBar();
  }

  // ─── Active File Management ─────────────────────────────────────────────

  function getActiveFile() {
    return openFiles.find(function (f) { return f.id === activeFileId; }) || null;
  }

  function setActiveFile(fileId) {
    activeFileId = fileId;
    var file = getActiveFile();

    if (!file) {
      restoreEmptyState();
      return;
    }

    els.empty.style.display = 'none';
    els.content.style.display = 'flex';

    renderContent(file);
    updateZoomControls(file);
    renderTabs();
    updateStatusBar();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  function renderContent(file) {
    els.content.innerHTML = '';

    if (file.type === TYPE_IMAGE) {
      renderImage(file);
    } else if (file.type === TYPE_PDF) {
      renderPDF(file);
    }
  }

  function renderImage(file) {
    var wrapper = document.createElement('div');
    wrapper.className = 'fv-image-wrapper';

    var img = document.createElement('img');
    img.className = 'fv-image';
    img.src = file.blobUrl;
    img.alt = file.name;
    img.draggable = false;

    // Apply current zoom
    applyImageZoom(img, file);

    wrapper.appendChild(img);
    els.content.appendChild(wrapper);
  }

  function renderPDF(file) {
    var iframe = document.createElement('iframe');
    iframe.className = 'fv-pdf-iframe';
    iframe.src = file.blobUrl;
    iframe.setAttribute('frameborder', '0');
    iframe.title = file.name;

    els.content.appendChild(iframe);
  }

  function applyImageZoom(img, file) {
    if (file.zoomMode === ZOOM_FIT) {
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      img.style.width = '';
      img.style.height = '';
    } else {
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = file.zoomPercent + '%';
      img.style.height = 'auto';
    }
  }

  function showLoading() {
    els.empty.style.display = 'flex';
    els.empty.innerHTML =
      '<div class="fv-loading">' +
        '<div class="tui-spinner"></div>' +
        '<span class="fv-loading-text">Loading file...</span>' +
      '</div>';
    els.content.style.display = 'none';
    els.content.innerHTML = '';
  }

  function restoreEmptyState() {
    els.content.style.display = 'none';
    els.content.innerHTML = '';
    els.empty.style.display = 'flex';
    els.empty.innerHTML =
      '<div class="fv-empty-icon">' +
        '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">' +
          '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
          '<circle cx="8.5" cy="8.5" r="1.5"/>' +
          '<path d="M21 15l-5-5L5 21"/>' +
        '</svg>' +
      '</div>' +
      '<p class="fv-empty-text">Open an image or PDF to view</p>' +
      '<div class="fv-empty-shortcuts">' +
        '<button class="tui-btn tui-btn-default" id="fv-empty-open-local">Open Local File</button>' +
        '<button class="tui-btn tui-btn-default" id="fv-empty-open-remote">Open Remote File</button>' +
      '</div>' +
      '<p class="fv-empty-formats">Supported: PNG, JPG, GIF, BMP, SVG, WebP, ICO, PDF</p>';

    // Re-bind empty state buttons
    var localBtn = shadow.getElementById('fv-empty-open-local');
    var remoteBtn = shadow.getElementById('fv-empty-open-remote');
    if (localBtn) addEventListener(localBtn, 'click', openLocalFileDialog);
    if (remoteBtn) addEventListener(remoteBtn, 'click', showRemoteFileDialog);

    updateZoomControls(null);
  }

  // ─── Zoom Controls ──────────────────────────────────────────────────────

  function updateZoomControls(file) {
    var isImage = file && file.type === TYPE_IMAGE;
    els.zoomOut.style.display = isImage ? '' : 'none';
    els.zoomIn.style.display = isImage ? '' : 'none';
    els.zoomFit.style.display = isImage ? '' : 'none';
    els.zoomActual.style.display = isImage ? '' : 'none';
    els.zoomLabel.style.display = isImage ? '' : 'none';

    if (isImage) {
      if (file.zoomMode === ZOOM_FIT) {
        els.zoomLabel.textContent = 'Fit';
      } else {
        els.zoomLabel.textContent = file.zoomPercent + '%';
      }
    }
  }

  function zoomIn() {
    var file = getActiveFile();
    if (!file || file.type !== TYPE_IMAGE) return;

    if (file.zoomMode === ZOOM_FIT) {
      file.zoomPercent = 100;
    }
    file.zoomPercent = Math.min(ZOOM_MAX, file.zoomPercent + ZOOM_STEP);
    file.zoomMode = 'manual';
    applyCurrentZoom();
  }

  function zoomOut() {
    var file = getActiveFile();
    if (!file || file.type !== TYPE_IMAGE) return;

    if (file.zoomMode === ZOOM_FIT) {
      file.zoomPercent = 100;
    }
    file.zoomPercent = Math.max(ZOOM_MIN, file.zoomPercent - ZOOM_STEP);
    file.zoomMode = 'manual';
    applyCurrentZoom();
  }

  function zoomToFit() {
    var file = getActiveFile();
    if (!file || file.type !== TYPE_IMAGE) return;

    file.zoomMode = ZOOM_FIT;
    applyCurrentZoom();
  }

  function zoomToActual() {
    var file = getActiveFile();
    if (!file || file.type !== TYPE_IMAGE) return;

    file.zoomMode = 'manual';
    file.zoomPercent = ZOOM_ACTUAL;
    applyCurrentZoom();
  }

  function applyCurrentZoom() {
    var file = getActiveFile();
    if (!file) return;

    var img = els.content.querySelector('.fv-image');
    if (img) {
      applyImageZoom(img, file);
    }

    updateZoomControls(file);
  }

  // ─── Tab Management ─────────────────────────────────────────────────────

  function renderTabs() {
    var html = '';
    for (var i = 0; i < openFiles.length; i++) {
      var file = openFiles[i];
      var isActive = file.id === activeFileId ? ' active' : '';
      var sourceIcon = file.source === SOURCE_LOCAL ? ICON_LOCAL : ICON_REMOTE;
      var typeIcon = file.type === TYPE_PDF ? ' fv-tab-pdf' : '';

      html += '<div class="fv-tab' + isActive + typeIcon + '" data-file-id="' + file.id + '">';
      html += '<div class="fv-tab-icon ' + file.source + '">' + sourceIcon + '</div>';
      html += '<span class="fv-tab-name">' + escapeHtml(file.name) + '</span>';
      html += '<button class="fv-tab-close" title="Close">' + ICON_CLOSE + '</button>';
      html += '</div>';
    }

    els.tabsScroll.innerHTML = html;

    // Bind tab click events
    var tabs = els.tabsScroll.querySelectorAll('.fv-tab');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var fileId = tab.getAttribute('data-file-id');

      addEventListener(tab, 'click', function (fid) {
        return function (e) {
          if (!e.target.closest('.fv-tab-close')) {
            setActiveFile(fid);
          }
        };
      }(fileId));

      var closeBtn = tab.querySelector('.fv-tab-close');
      addEventListener(closeBtn, 'click', function (fid) {
        return function (e) {
          e.stopPropagation();
          closeFile(fid);
        };
      }(fileId));
    }
  }

  // ─── Status Bar ─────────────────────────────────────────────────────────

  function updateStatusBar() {
    if (!activeFileId) {
      els.statusFile.textContent = 'No file open';
      els.statusType.textContent = '—';
      els.statusSource.textContent = '—';
      els.statusSize.textContent = '—';
      return;
    }

    var file = getActiveFile();
    if (!file) return;

    els.statusFile.textContent = file.name;
    els.statusType.textContent = file.type === TYPE_IMAGE ? 'Image (' + getFileExtension(file.path).toUpperCase() + ')' : 'PDF Document';
    els.statusSource.textContent = file.source === SOURCE_LOCAL ? 'Local' : 'Remote';

    // Estimate size from base64 length
    var rawBytes = Math.round((file.base64.length * 3) / 4);
    els.statusSize.textContent = formatFileSize(rawBytes);
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  /**
   * Convert a base64 string to a Blob object.
   * Uses atob + Uint8Array for browser compatibility.
   */
  function base64ToBlob(base64, mimeType) {
    var binaryString = atob(base64);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showError(message) {
    var toast = api.ui.toast();
    toast.show(message, 'error');
  }

  /**
   * Restore the correct view after a failed operation.
   * If other files are still open, switch to the last active file.
   * Otherwise, show the empty state.
   */
  function restoreViewState() {
    if (openFiles.length > 0 && activeFileId) {
      var file = getActiveFile();
      if (file) {
        els.empty.style.display = 'none';
        els.content.style.display = 'flex';
        renderContent(file);
        updateZoomControls(file);
        return;
      }
    }
    restoreEmptyState();
  }

})();

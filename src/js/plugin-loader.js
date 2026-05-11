/**
 * Plugin Loader v2 — Robust plugin management system
 *
 * Improvements over v1:
 * - Shadow DOM isolation for each plugin (no CSS/DOM leaks)
 * - Plugin lifecycle hooks: onInit, onMount, onUnmount, onFocus, onBlur
 * - Scoped PluginAPI per instance with live references
 * - Batched file loading (single IPC call per plugin)
 * - Proper cleanup on window close (timers, listeners, DOM)
 * - Manifest validation
 */

/* ─── Manifest Schema ───────────────────────────────────────────────── */
const MANIFEST_SCHEMA = {
  required: ['name', 'version', 'dirName'],
  fields: {
    name:        { type: 'string',  required: true },
    description: { type: 'string',  required: false },
    version:     { type: 'string',  required: true },
    author:      { type: 'string',  required: false },
    dirName:     { type: 'string',  required: true },
    system:      { type: 'boolean', required: false, default: false },
    permissions: { type: 'array',   required: false, default: [] },
    window:      { type: 'object',  required: false, default: { width: 800, height: 550 } },
    icon:        { type: 'string',  required: false },
  }
};

class PluginLoader {
  constructor() {
    /** @type {Map<string, Object>} dirName → manifest */
    this.plugins = new Map();

    /** @type {Map<string, PluginInstance>} windowId → instance */
    this.instances = new Map();

    /** @type {Set<Function>} */
    this._changeListeners = new Set();

    /** @type {string|null} Cached shared UI CSS */
    this._sharedCSS = null;

    /** @type {Promise<string>|null} In-flight request for shared CSS */
    this._sharedCSSPromise = null;
  }

  /* ─── Change Notification ────────────────────────────────────────── */

  /** @param {Function} cb - (action: 'install'|'uninstall'|'update', dirName) => void */
  onPluginChange(cb) {
    this._changeListeners.add(cb);
  }

  offPluginChange(cb) {
    this._changeListeners.delete(cb);
  }

  _notify(action, dirName) {
    this._changeListeners.forEach(cb => {
      try { cb(action, dirName); }
      catch (e) { console.error('[PluginLoader] change listener error:', e); }
    });
  }

  /* ─── Shared UI Components ────────────────────────────────────────── */

  /**
   * Get the shared UI component CSS (cached after first load).
   * @returns {Promise<string>}
   */
  async getSharedCSS() {
    if (this._sharedCSS) return this._sharedCSS;

    if (!this._sharedCSSPromise) {
      this._sharedCSSPromise = window.termulAPI.ui.getSharedCSS()
        .then(css => {
          this._sharedCSS = css || '';
          this._sharedCSSPromise = null;
          return this._sharedCSS;
        })
        .catch(err => {
          console.error('[PluginLoader] Failed to load shared UI CSS:', err);
          this._sharedCSSPromise = null;
          return '';
        });
    }
    return this._sharedCSSPromise;
  }

  /* ─── Loading ────────────────────────────────────────────────────── */

  /**
   * Load all plugin manifests from disk via IPC.
   * Also pre-fetches the shared UI CSS for injection into shadow DOMs.
   * Returns validated plugin list.
   */
  async loadAll() {
    try {
      // Pre-fetch shared UI CSS and wait for it so it's available
      // when plugin instances are mounted into shadow DOMs.
      await this.getSharedCSS();

      const raw = await window.termulAPI.plugins.getAll();
      this.plugins.clear();

      for (const manifest of raw) {
        const validation = this.validateManifest(manifest);
        if (validation.valid) {
          this.plugins.set(manifest.dirName, manifest);
        } else {
          console.warn(`[PluginLoader] Invalid manifest "${manifest.dirName}":`, validation.errors);
        }
      }

      return this.getAll();
    } catch (err) {
      console.error('[PluginLoader] loadAll failed:', err);
      return [];
    }
  }

  getAll() {
    return Array.from(this.plugins.values());
  }

  get(dirName) {
    return this.plugins.get(dirName) || null;
  }

  /* ─── Manifest Validation ────────────────────────────────────────── */

  validateManifest(mf) {
    const errors = [];
    if (!mf || typeof mf !== 'object') {
      return { valid: false, errors: ['Manifest must be an object'] };
    }

    for (const [key, schema] of Object.entries(MANIFEST_SCHEMA.fields)) {
      if (mf[key] === undefined || mf[key] === null) {
        if (schema.required) {
          errors.push(`Missing required field: "${key}"`);
        }
        continue;
      }
      if (schema.type === 'string' && typeof mf[key] !== 'string') {
        errors.push(`Field "${key}" must be a string`);
      } else if (schema.type === 'boolean' && typeof mf[key] !== 'boolean') {
        errors.push(`Field "${key}" must be a boolean`);
      } else if (schema.type === 'array' && !Array.isArray(mf[key])) {
        errors.push(`Field "${key}" must be an array`);
      } else if (schema.type === 'object' && (typeof mf[key] !== 'object' || Array.isArray(mf[key]) || mf[key] === null)) {
        errors.push(`Field "${key}" must be an object`);
      }
    }

    // Validate dirName is a safe directory name (no path traversal)
    if (mf.dirName && /[/\\:]|\.\./.test(mf.dirName)) {
      errors.push('dirName must not contain path separators or ".."');
    }

    // Validate semver-ish version
    if (mf.version && !/^\d+\.\d+\.\d+/.test(mf.version)) {
      errors.push('version must follow semver (e.g. "1.0.0")');
    }

    return { valid: errors.length === 0, errors };
  }

  /* ─── Instance Management ────────────────────────────────────────── */

  registerInstance(windowId, instance) {
    this.instances.set(windowId, instance);
  }

  unregisterInstance(windowId) {
    this.instances.delete(windowId);
  }

  /**
   * Get all running instances for a given plugin dirName
   */
  getRunningInstances(dirName) {
    const running = [];
    for (const [windowId, inst] of this.instances) {
      if (inst.dirName === dirName) {
        running.push({ windowId, instance: inst });
      }
    }
    return running;
  }

  /* ─── Install / Uninstall / Update ───────────────────────────────── */

  async install(pluginData) {
    // Validate manifest inside pluginData
    if (pluginData.manifest) {
      const v = this.validateManifest(pluginData.manifest);
      if (!v.valid) {
        return { success: false, error: 'Invalid manifest: ' + v.errors.join('; ') };
      }
    }

    try {
      const result = await window.termulAPI.plugins.install(pluginData);
      if (result.success) {
        await this.loadAll();
        this._notify('install', pluginData.dirName);
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async uninstall(dirName) {
    const plugin = this.plugins.get(dirName);
    if (!plugin) {
      return { success: false, error: 'Plugin not found' };
    }

    // Prevent uninstalling running plugins
    const running = this.getRunningInstances(dirName);
    if (running.length > 0) {
      return {
        success: false,
        error: `Cannot uninstall: ${running.length} instance(s) are running. Close the app first.`
      };
    }

    try {
      const result = await window.termulAPI.plugins.uninstall(dirName);
      if (result.success) {
        this.plugins.delete(dirName);
        this._notify('uninstall', dirName);
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /* ─── Plugin Rendering ───────────────────────────────────────────── */

  /**
   * Load all plugin files in a single batched IPC call.
   * Returns { html, css, js, icon }
   */
  async loadPluginFiles(dirName) {
    return window.termulAPI.plugins.loadFiles(dirName);
  }

  /**
   * Get the icon SVG for a plugin.
   */
  async getPluginIcon(plugin) {
    if (plugin.icon && plugin.icon.trim().startsWith('<')) {
      return plugin.icon;
    }
    try {
      const files = await this.loadPluginFiles(plugin.dirName);
      if (files.icon) return files.icon;
    } catch { /* ignore */ }
    return this.getDefaultIcon();
  }

  getDefaultIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="3"/>
      <path d="M9 9l6 6M15 9l-6 6"/>
    </svg>`;
  }

  /**
   * Create a scoped PluginAPI for a specific plugin instance.
   * This gives each plugin live references (not frozen snapshots).
   */
  createPluginAPI(dirName, windowId) {
    const self = this;
    /** Per-window component cache to avoid creating duplicate containers (e.g. toast). */
    const _componentCache = {};
    return {
      /** Plugin's own manifest */
      manifest: self.plugins.get(dirName),

      /** Plugin's directory name */
      dirName: dirName,

      /** The window ID this instance lives in */
      windowId: windowId,

      /** SSH access (live reference via getter) */
      get ssh() { return window.termulAPI.ssh; },

      /** FTP access (live reference via getter) */
      get ftp() { return window.termulAPI.ftp; },

      /** Port forwarding tunnel access (live reference via getter) */
      get tunnel() { return window.termulAPI.tunnel; },

      /** Current connection ID (live) */
      get connectionId() {
        return window.TermulOS?.os?.connectionId || null;
      },

      /** Current connection profile (live) */
      get profile() {
        return window.TermulOS?.os?.currentProfile || null;
      },

      /** Scoped event bus — auto-cleans up when plugin unmounts */
      events: {
        on(event, callback) {
          const handler = (e) => callback(e.detail);
          document.addEventListener('termul:' + event, handler);
          // Store reference for auto-cleanup
          if (!self._instanceEvents.has(windowId)) {
            self._instanceEvents.set(windowId, []);
          }
          self._instanceEvents.get(windowId).push({ event: 'termul:' + event, handler, original: callback });
          return callback;
        },
        off(event, callback) {
          const list = self._instanceEvents.get(windowId);
          if (!list) return;
          const idx = list.findIndex(e => e.original === callback);
          if (idx >= 0) {
            document.removeEventListener(list[idx].event, list[idx].handler);
            list.splice(idx, 1);
          }
        },
        emit(event, data) {
          document.dispatchEvent(new CustomEvent('termul:' + event, { detail: data }));
        }
      },

      /** Dialog helpers */
      dialog: window.termulAPI.dialog,

      /** Platform info */
      platform: window.termulAPI.platform,

      /**
       * Resolve a path relative to the plugin's directory.
       * Returns the file content.
       */
      async readFile(fileName) {
        return window.termulAPI.plugins.readFile(dirName, fileName);
      },

      /* ─── TermulUI Shared Component Library ──────────────────────── */

      /**
       * Shared UI library with CSS injection and component factories.
       * All factory functions return plain DOM elements (no framework).
       */
      ui: {
        /**
         * Inject the shared TermulUI stylesheet into a shadow root.
         * Call this once during onMount before rendering components.
         * @param {ShadowRoot} targetShadow - The plugin's shadow root
         * @returns {Promise<void>}
         */
        async injectStyles(targetShadow) {
          const css = await self.getSharedCSS();
          if (!css) return;
          // Avoid duplicate injection
          if (targetShadow.querySelector('style[data-tui-shared]')) return;
          const style = document.createElement('style');
          style.setAttribute('data-tui-shared', 'true');
          style.textContent = css;
          targetShadow.appendChild(style);
        },

        /**
         * Create a themed button element.
         * @param {Object} opts
         * @param {string} [opts.label] - Button text
         * @param {string} [opts.variant] - 'default'|'primary'|'accent'|'danger'|'ghost'
         * @param {string} [opts.icon] - SVG markup for an icon
         * @param {boolean} [opts.disabled]
         * @param {Function} [opts.onClick]
         * @returns {HTMLButtonElement}
         */
        button(opts = {}) {
          const el = document.createElement('button');
          el.className = 'tui-btn';
          if (opts.variant && opts.variant !== 'default') {
            el.classList.add('tui-btn-' + opts.variant);
          } else if (!opts.variant) {
            el.classList.add('tui-btn-default');
          }
          if (opts.icon) el.innerHTML = opts.icon;
          if (opts.label) {
            const span = document.createElement('span');
            span.textContent = opts.label;
            el.appendChild(span);
          }
          if (opts.disabled) el.disabled = true;
          if (opts.onClick) el.addEventListener('click', opts.onClick);
          return el;
        },

        /**
         * Create an icon-only button.
         * @param {Object} opts
         * @param {string} opts.icon - SVG markup
         * @param {string} [opts.title] - Tooltip text
         * @param {Function} [opts.onClick]
         * @returns {HTMLButtonElement}
         */
        iconButton(opts = {}) {
          const el = document.createElement('button');
          el.className = 'tui-btn-icon';
          el.innerHTML = opts.icon || '';
          if (opts.title) el.title = opts.title;
          if (opts.onClick) el.addEventListener('click', opts.onClick);
          return el;
        },

        /**
         * Create a toggle switch.
         * @param {Object} opts
         * @param {boolean} [opts.active] - Initial state
         * @param {Function} [opts.onChange] - Called with new boolean value
         * @returns {HTMLElement}
         */
        toggle(opts = {}) {
          const el = document.createElement('button');
          el.className = 'tui-toggle';
          el.type = 'button';
          el.setAttribute('role', 'switch');
          if (opts.active) {
            el.classList.add('active');
            el.setAttribute('aria-checked', 'true');
          } else {
            el.setAttribute('aria-checked', 'false');
          }
          if (opts.onChange) {
            el.addEventListener('click', () => {
              const isActive = el.classList.toggle('active');
              el.setAttribute('aria-checked', String(isActive));
              opts.onChange(isActive);
            });
          }
          return el;
        },

        /**
         * Create a card container.
         * @param {Object} opts
         * @param {string} [opts.title] - Card title text
         * @param {string} [opts.icon] - SVG markup for header icon
         * @returns {HTMLElement} The .tui-card element with optional header and body div
         */
        card(opts = {}) {
          const el = document.createElement('div');
          el.className = 'tui-card';

          if (opts.title || opts.icon) {
            const header = document.createElement('div');
            header.className = 'tui-card-header';
            if (opts.icon) {
              const iconWrap = document.createElement('div');
              iconWrap.className = 'tui-card-icon';
              iconWrap.innerHTML = opts.icon;
              header.appendChild(iconWrap);
            }
            if (opts.title) {
              const titleEl = document.createElement('div');
              titleEl.className = 'tui-card-title';
              titleEl.textContent = opts.title;
              header.appendChild(titleEl);
            }
            el.appendChild(header);
          }

          const body = document.createElement('div');
          body.className = 'tui-card-body';
          el.appendChild(body);

          return el;
        },

        /**
         * Create a progress bar.
         * @param {Object} opts
         * @param {number} [opts.value] - Percentage 0-100
         * @param {string} [opts.variant] - 'default'|'medium'|'high'
         * @returns {{ container: HTMLElement, fill: HTMLElement }}
         */
        progressBar(opts = {}) {
          const container = document.createElement('div');
          container.className = 'tui-progress';
          const fill = document.createElement('div');
          fill.className = 'tui-progress-fill';
          if (opts.variant) fill.classList.add(opts.variant);
          fill.style.width = Math.max(0, Math.min(100, opts.value || 0)) + '%';
          container.appendChild(fill);
          return { container, fill };
        },

        /**
         * Create a status indicator (dot + text).
         * @param {Object} opts
         * @param {string} [opts.text] - Status text
         * @param {string} [opts.state] - 'success'|'error'|'warning'|'info'|'connected'|'disconnected'
         * @param {boolean} [opts.pulse] - Whether to animate the dot
         * @returns {{ container: HTMLElement, dot: HTMLElement, textEl: HTMLElement }}
         */
        status(opts = {}) {
          const container = document.createElement('div');
          container.className = 'tui-status';

          const dot = document.createElement('span');
          dot.className = 'tui-status-dot';
          if (opts.state) dot.classList.add(opts.state);
          if (opts.pulse) dot.classList.add('pulse');
          container.appendChild(dot);

          let textEl = null;
          if (opts.text !== undefined) {
            textEl = document.createElement('span');
            textEl.textContent = opts.text;
            container.appendChild(textEl);
          }

          return { container, dot, textEl };
        },

        /**
         * Create a select/dropdown.
         * @param {Object} opts
         * @param {Array<{value: string, label: string}>} [opts.options]
         * @param {string} [opts.value] - Pre-selected value
         * @param {Function} [opts.onChange] - Called with new value
         * @returns {HTMLSelectElement}
         */
        select(opts = {}) {
          const el = document.createElement('select');
          el.className = 'tui-select';
          if (opts.options) {
            for (const opt of opts.options) {
              const option = document.createElement('option');
              option.value = opt.value;
              option.textContent = opt.label;
              if (opts.value === opt.value) option.selected = true;
              el.appendChild(option);
            }
          }
          if (opts.onChange) {
            el.addEventListener('change', () => opts.onChange(el.value));
          }
          return el;
        },

        /**
         * Create a text input.
         * @param {Object} opts
         * @param {string} [opts.placeholder]
         * @param {string} [opts.value]
         * @param {string} [opts.type] - 'text'|'password'|'number'
         * @param {Function} [opts.onInput]
         * @returns {HTMLInputElement}
         */
        input(opts = {}) {
          const el = document.createElement('input');
          el.className = 'tui-input';
          el.type = opts.type || 'text';
          if (opts.placeholder) el.placeholder = opts.placeholder;
          if (opts.value !== undefined) el.value = opts.value;
          if (opts.onInput) el.addEventListener('input', () => opts.onInput(el.value));
          return el;
        },

        /**
         * Create a toolbar with left and right sections.
         * @param {Object} opts
         * @param {string} [opts.title] - Toolbar title
         * @returns {{ container: HTMLElement, left: HTMLElement, right: HTMLElement }}
         */
        toolbar(opts = {}) {
          const container = document.createElement('div');
          container.className = 'tui-toolbar';

          const left = document.createElement('div');
          left.className = 'tui-toolbar-left';
          if (opts.title) {
            const titleEl = document.createElement('span');
            titleEl.className = 'tui-toolbar-title';
            titleEl.textContent = opts.title;
            left.appendChild(titleEl);
          }

          const right = document.createElement('div');
          right.className = 'tui-toolbar-right';

          container.appendChild(left);
          container.appendChild(right);

          return { container, left, right };
        },

        /**
         * Create a badge element.
         * @param {Object} opts
         * @param {string} opts.text - Badge text
         * @param {string} [opts.variant] - 'default'|'success'|'error'|'warning'
         * @returns {HTMLElement}
         */
        badge(opts = {}) {
          const el = document.createElement('span');
          el.className = 'tui-badge';
          if (opts.variant && opts.variant !== 'default') {
            el.classList.add('tui-badge-' + opts.variant);
          }
          el.textContent = opts.text || '';
          return el;
        },

        /**
         * Create a settings item row (label/description + control).
         * @param {Object} opts
         * @param {string} [opts.label] - Item label
         * @param {string} [opts.description] - Item description
         * @returns {{ container: HTMLElement, infoEl: HTMLElement, controlEl: HTMLElement }}
         */
        settingsItem(opts = {}) {
          const container = document.createElement('div');
          container.className = 'tui-settings-item';

          const infoEl = document.createElement('div');
          infoEl.className = 'tui-settings-item-info';
          if (opts.label) {
            const label = document.createElement('div');
            label.className = 'tui-settings-item-label';
            label.textContent = opts.label;
            infoEl.appendChild(label);
          }
          if (opts.description) {
            const desc = document.createElement('div');
            desc.className = 'tui-settings-item-desc';
            desc.textContent = opts.description;
            infoEl.appendChild(desc);
          }

          const controlEl = document.createElement('div');
          controlEl.className = 'tui-settings-item-control';

          container.appendChild(infoEl);
          container.appendChild(controlEl);

          return { container, infoEl, controlEl };
        },

        /**
         * Create an empty state placeholder.
         * @param {Object} opts
         * @param {string} [opts.icon] - SVG markup
         * @param {string} [opts.text] - Message text
         * @returns {HTMLElement}
         */
        emptyState(opts = {}) {
          const el = document.createElement('div');
          el.className = 'tui-empty';
          if (opts.icon) {
            const iconWrap = document.createElement('div');
            iconWrap.className = 'tui-empty-icon';
            iconWrap.innerHTML = opts.icon;
            el.appendChild(iconWrap);
          }
          if (opts.text) {
            const textEl = document.createElement('p');
            textEl.className = 'tui-empty-text';
            textEl.textContent = opts.text;
            el.appendChild(textEl);
          }
          return el;
        },

        /* ─── Complex (Stateful) Component Factories ─────────────────── */

        /**
         * Create a modal dialog.
         * @param {Object} opts
         * @param {string} [opts.title] - Modal title
         * @param {string} [opts.content] - HTML body content
         * @param {Array<{label:string,variant?:string,onClick?:Function}>} [opts.buttons]
         * @param {boolean} [opts.closeOnBackdrop=true]
         * @param {boolean} [opts.closeOnEscape=true]
         * @param {Function} [opts.onClose]
         * @returns {TuiModal}
         */
        modal(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiModal(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a tabbed panel container.
         * @param {Object} opts
         * @param {Array<{id:string, label:string, content:string}>} opts.items
         * @param {string} [opts.activeTab]
         * @param {Function} [opts.onSwitch]
         * @returns {TuiTabs}
         */
        tabs(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiTabs(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a data table.
         * @param {Object} opts
         * @param {Array<{key:string,label:string,sortable?:boolean,render?:Function}>} opts.columns
         * @param {Array<Object>} [opts.data]
         * @param {boolean} [opts.selectable=false]
         * @param {Function} [opts.onRowClick]
         * @param {Function} [opts.onSelectionChange]
         * @param {string} [opts.emptyText]
         * @returns {TuiDataTable}
         */
        dataTable(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiDataTable(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a dropdown/context menu.
         * @param {Object} opts
         * @param {HTMLElement} opts.trigger - Anchor element
         * @param {Array<{label:string,icon?:string,variant?:string,onClick?:Function,separator?:boolean}>} opts.items
         * @param {boolean} [opts.closeOnClick=true]
         * @returns {TuiDropdown}
         */
        dropdown(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiDropdown(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a toast notification system.
         * @param {Object} opts
         * @param {string} [opts.position='bottom-right']
         * @param {number} [opts.defaultDuration=4000]
         * @param {number} [opts.maxVisible=5]
         * @returns {TuiToast}
         */
        toast(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;

          // Reuse cached toast instance for this plugin window.
          // Prevents creating a new .tui-toast-container on every api.ui.toast() call.
          const cacheKey = 'toast:' + (opts.position || 'bottom-right');
          if (_componentCache[cacheKey]) {
            return _componentCache[cacheKey];
          }

          const comp = new window.TuiToast(shadow, opts);
          if (instance) instance._components.push(comp);
          _componentCache[cacheKey] = comp;
          return comp;
        },

        /**
         * Create an accordion / collapsible sections.
         * @param {Object} opts
         * @param {Array<{title:string,content:string,open?:boolean}>} opts.items
         * @param {boolean} [opts.multiple=false]
         * @param {Function} [opts.onToggle]
         * @returns {TuiAccordion}
         */
        accordion(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiAccordion(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a Windows 11-style sidebar navigation.
         * @param {Object} opts
         * @param {Array<{id:string, label:string, icon?:string, section?:string, sectionLabel?:string}>} opts.items
         *   Navigation items. Items with different `section` values get separated by dividers.
         * @param {string} [opts.activeItem] - Initially active item id (defaults to first)
         * @param {boolean} [opts.searchable=false] - Show search input at top
         * @param {string} [opts.searchPlaceholder='Search...'] - Placeholder for search input
         * @param {Function} [opts.onNavigate] - Called with (itemId) when item is clicked
         * @param {Function} [opts.onSearch] - Called with (query) when search text changes
         * @param {number} [opts.width=240] - Sidebar width in pixels
         * @returns {TuiSidebarNav}
         */
        sidebarNav(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiSidebarNav(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },

        /**
         * Create a radio button group.
         * @param {Object} opts
         * @param {string} [opts.name] - Radio group name (for native grouping)
         * @param {Array<{value: string, label: string, disabled?: boolean}>} opts.options
         * @param {string} [opts.value] - Initially selected value
         * @param {'horizontal'|'vertical'} [opts.direction='horizontal'] - Layout direction
         * @param {Function} [opts.onChange] - Called with (value) when selection changes
         * @returns {TuiRadioGroup}
         */
        radioGroup(opts = {}) {
          const instance = window.PluginLoader.instances.get(windowId);
          const shadow = instance ? instance.shadow : null;
          const comp = new window.TuiRadioGroup(shadow, opts);
          if (instance) instance._components.push(comp);
          return comp;
        },
      },
    };
  }

  /** Track per-instance event listeners for auto-cleanup */
  _instanceEvents = new Map();

  /**
   * Clean up all event listeners registered by a plugin instance.
   */
  cleanupInstanceEvents(windowId) {
    const list = this._instanceEvents.get(windowId);
    if (!list) return;
    for (const { event, handler } of list) {
      document.removeEventListener(event, handler);
    }
    this._instanceEvents.delete(windowId);
  }
}

/**
 * PluginInstance — represents a running plugin inside a window.
 * Manages lifecycle and Shadow DOM isolation.
 */
class PluginInstance {
  /**
   * @param {string} windowId
   * @param {Object} manifest
   * @param {HTMLElement} hostElement — the element that will host the shadow DOM
   */
  constructor(windowId, manifest, hostElement) {
    this.windowId = windowId;
    this.manifest = manifest;
    this.dirName = manifest.dirName;
    this.hostElement = hostElement;

    /** @type {ShadowRoot} */
    this.shadow = null;

    /** @type {Object} the plugin's exported API (set by plugin script) */
    this.exports = {};

    /** @type {Object} lifecycle handlers set by plugin script */
    this._lifecycle = {};

    /** Track timers registered by plugin for auto-cleanup */
    this._timers = new Set();
    this._intervals = new Set();

    /** Track DOM event listeners added by plugin for auto-cleanup */
    this._listeners = [];

    /** Track TuiComponent instances for auto-destroy on unmount */
    this._components = [];
  }

  /**
   * Mount the plugin into its shadow DOM.
   * @param {Object} files - { html, css, js, icon }
   * @param {Object} pluginAPI - scoped API for this instance
   */
  mount(files, pluginAPI) {
    // Create shadow DOM for isolation
    this.shadow = this.hostElement.attachShadow({ mode: 'open' });

    // Inject shared TermulUI component styles FIRST (before plugin CSS)
    const sharedCSS = window.PluginLoader._sharedCSS;
    if (sharedCSS) {
      const sharedStyle = document.createElement('style');
      sharedStyle.setAttribute('data-tui-shared', 'true');
      sharedStyle.textContent = sharedCSS;
      this.shadow.appendChild(sharedStyle);
    }

    // Inject xterm.js CSS into shadow DOM so the terminal renders correctly.
    // Without this, internal xterm elements like .xterm-char-measure-element
    // become visible (showing measurement characters like "$$$$$" at the top)
    // and other critical layout rules (scrollbar, viewport, rows) are missing.
    const xtermCSS = window.PluginLoader._xtermCSS;
    if (xtermCSS) {
      const xtermStyle = document.createElement('style');
      xtermStyle.setAttribute('data-xterm', 'true');
      xtermStyle.textContent = xtermCSS;
      this.shadow.appendChild(xtermStyle);
    }

    // Inject plugin-specific styles into shadow
    if (files.css) {
      const style = document.createElement('style');
      style.textContent = files.css;
      this.shadow.appendChild(style);
    }

    // Inject HTML into shadow
    if (files.html) {
      const wrapper = document.createElement('div');
      wrapper.className = 'plugin-root';
      wrapper.innerHTML = files.html;
      this.shadow.appendChild(wrapper);
    }

    // Execute plugin script with scoped API
    if (files.js) {
      try {
        // Provide timer overrides that track for cleanup
        const sandboxedSetTimeout = (fn, ms) => {
          const id = setTimeout(fn, ms);
          this._timers.add(id);
          return id;
        };
        const sandboxedSetInterval = (fn, ms) => {
          const id = setInterval(fn, ms);
          this._intervals.add(id);
          return id;
        };
        const sandboxedClearTimeout = (id) => {
          clearTimeout(id);
          this._timers.delete(id);
        };
        const sandboxedClearInterval = (id) => {
          clearInterval(id);
          this._intervals.delete(id);
        };

        // Scoped addEventListener that tracks for cleanup
        const sandboxedAddEventListener = (target, event, handler, options) => {
          target.addEventListener(event, handler, options);
          this._listeners.push({ target, event, handler, options });
        };

        // Build the lifecycle registration object the plugin can use
        const lifecycle = {
          onInit: (fn) => { this._lifecycle.onInit = fn; },
          onMount: (fn) => { this._lifecycle.onMount = fn; },
          onUnmount: (fn) => { this._lifecycle.onUnmount = fn; },
          onFocus: (fn) => { this._lifecycle.onFocus = fn; },
          onBlur: (fn) => { this._lifecycle.onBlur = fn; },
        };

        // Execute in a function scope
        const fn = new Function(
          'PLUGIN_API', 'PLUGIN_LIFECYCLE', 'PLUGIN_EXPORTS',
          'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
          'addEventListener',
          'shadow', 'shadowDoc',
          files.js
        );

        fn(
          pluginAPI,
          lifecycle,
          this.exports,
          sandboxedSetTimeout,
          sandboxedSetInterval,
          sandboxedClearTimeout,
          sandboxedClearInterval,
          sandboxedAddEventListener,
          this.shadow,
          this.shadow
        );

        // Fire lifecycle hooks
        if (this._lifecycle.onInit) {
          this._lifecycle.onInit(pluginAPI);
        }
        if (this._lifecycle.onMount) {
          this._lifecycle.onMount(pluginAPI);
        }

      } catch (err) {
        console.error(`[PluginLoader] Error executing plugin "${this.dirName}":`, err);
        // Show error in the plugin area
        const errorDiv = document.createElement('div');
        errorDiv.className = 'plugin-error';
        errorDiv.innerHTML = `<p>Plugin Error</p><pre>${err.message}\n${err.stack || ''}</pre>`;
        errorDiv.style.cssText = 'padding:20px;color:#ff6b6b;font-family:monospace;font-size:13px;background:#1a0000;';
        this.shadow.appendChild(errorDiv);
      }
    }
  }

  /**
   * Focus notification — the window containing this plugin gained focus.
   */
  focus() {
    if (this._lifecycle.onFocus) {
      try { this._lifecycle.onFocus(); }
      catch (e) { console.error(`[Plugin] onFocus error in "${this.dirName}":`, e); }
    }
  }

  /**
   * Blur notification — the window containing this plugin lost focus.
   */
  blur() {
    if (this._lifecycle.onBlur) {
      try { this._lifecycle.onBlur(); }
      catch (e) { console.error(`[Plugin] onBlur error in "${this.dirName}":`, e); }
    }
  }

  /**
   * Unmount — full cleanup. Called when the window closes.
   */
  unmount() {
    // Fire lifecycle hook
    if (this._lifecycle.onUnmount) {
      try { this._lifecycle.onUnmount(); }
      catch (e) { console.error(`[Plugin] onUnmount error in "${this.dirName}":`, e); }
    }

    // Destroy all tracked TuiComponent instances
    for (const comp of this._components) {
      try { comp.destroy(); }
      catch (e) { console.error(`[Plugin] component destroy error:`, e); }
    }
    this._components = [];

    // Clear tracked timers
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    for (const id of this._intervals) clearInterval(id);
    this._intervals.clear();

    // Remove tracked event listeners
    for (const { target, event, handler, options } of this._listeners) {
      target.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    // Destroy shadow DOM (removes all DOM + CSS)
    if (this.shadow) {
      this.shadow.innerHTML = '';
    }

    // Clean up plugin-loader scoped events
    window.PluginLoader.cleanupInstanceEvents(this.windowId);

    this._lifecycle = {};
    this.exports = {};
  }
}

// Export as singleton
window.PluginLoader = new PluginLoader();
window.PluginInstance = PluginInstance;

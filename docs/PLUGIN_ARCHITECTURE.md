# TermulOS Plugin Architecture Documentation

## Table of Contents
1. [Overview](#overview)
2. [Core Components](#core-components)
3. [Plugin Structure](#plugin-structure)
4. [Lifecycle Management](#lifecycle-management)
5. [Shadow DOM Isolation](#shadow-dom-isolation)
6. [Plugin API](#plugin-api)
7. [Component System](#component-system)
8. [Execution Model](#execution-model)
9. [Resource Management](#resource-management)
10. [Communication Patterns](#communication-patterns)

---

## Overview

TermulOS uses a plugin-based architecture where each application window runs a separate plugin instance. Plugins are completely isolated from each other and the host application using **Shadow DOM** and **sandboxed execution contexts**.

### Key Design Principles

1. **Isolation**: Each plugin runs in its own Shadow DOM, preventing CSS and DOM leakage
2. **Sandboxing**: Plugin code executes in a controlled environment with tracked resources
3. **Lifecycle Management**: Plugins have well-defined lifecycle hooks for initialization and cleanup
4. **No Framework Dependencies**: Plugins use vanilla JavaScript with optional UI component library
5. **Auto-Cleanup**: All timers, listeners, and components are automatically cleaned up on unmount

---

## Core Components

### 1. PluginLoader (Singleton)

**Location**: `src/js/plugin-loader.js`

The `PluginLoader` is the central orchestrator for all plugin operations:

```javascript
class PluginLoader {
  plugins: Map<string, Object>        // dirName → manifest
  instances: Map<string, PluginInstance>  // windowId → instance
  _sharedCSS: string                   // Cached shared UI styles
  _instanceEvents: Map                 // Per-instance event tracking
}
```

**Responsibilities**:
- Load and validate plugin manifests
- Install/uninstall plugins
- Batch-load plugin files (HTML, CSS, JS, icon)
- Create scoped PluginAPI instances
- Track running plugin instances
- Clean up instance resources

### 2. PluginInstance

**Location**: `src/js/plugin-loader.js` (lines 793-998)

Represents a single running plugin instance:

```javascript
class PluginInstance {
  windowId: string
  manifest: Object
  dirName: string
  shadow: ShadowRoot              // Plugin's isolated DOM
  exports: Object                 // Plugin's public API
  _lifecycle: Object              // Lifecycle handlers
  _timers: Set                    // Tracked setTimeout IDs
  _intervals: Set                 // Tracked setInterval IDs
  _listeners: Array               // Tracked event listeners
  _components: Array              // Tracked TuiComponent instances
}
```

**Responsibilities**:
- Create and manage Shadow DOM
- Execute plugin code in sandbox
- Track all plugin resources for cleanup
- Fire lifecycle hooks
- Clean up on unmount

### 3. WindowManager

**Location**: `src/js/window-manager.js`

Manages application windows and integrates with PluginInstance:

```javascript
class WindowManager {
  windows: Map<string, Object>    // windowId → window data
  activeWindowId: string
  zIndex: number
  currentTabId: string
}
```

**Responsibilities**:
- Create and position windows
- Mount plugins into windows
- Handle window focus/minimize/maximize/close
- Integrate with plugin lifecycle (focus/blur)
- Clean up plugins when windows close

---

## Plugin Structure

### Directory Layout

```
src/plugins/[plugin-name]/
├── manifest.json       # Plugin metadata
├── index.html          # Plugin HTML structure
├── styles.css          # Plugin-specific styles (optional)
└── main.js            # Plugin logic
```

### Manifest Schema

```json
{
  "name": "Plugin Name",           // Required: Display name
  "description": "Description",    // Optional: Short description
  "version": "1.0.0",             // Required: Semver version
  "author": "Author",              // Optional: Author name
  "dirName": "plugin-name",        // Required: Directory name (safe path)
  "system": false,                 // Optional: Mark as system plugin
  "window": {                      // Optional: Default window size
    "width": 800,
    "height": 550
  },
  "permissions": [],               // Optional: Required permissions
  "icon": "<svg>...</svg>"         // Optional: SVG icon markup
}
```

### Plugin Files

**index.html** - Plugin's HTML structure:
```html
<div class="plugin-container">
  <div class="plugin-toolbar">
    <span class="plugin-title">My Plugin</span>
  </div>
  <div class="plugin-content">
    <!-- Content goes here -->
  </div>
</div>
```

**styles.css** - Plugin-specific styles (scoped to Shadow DOM):
```css
.plugin-container {
  padding: 20px;
}

.plugin-toolbar {
  /* These styles don't leak outside the plugin */
}
```

**main.js** - Plugin logic (see Execution Model below):

---

## Lifecycle Management

Plugins have a well-defined lifecycle with hooks at key points:

### Lifecycle Hooks

```javascript
PLUGIN_LIFECYCLE.onInit(function(pluginAPI) {
  // Called once when plugin is first loaded
  // Use for one-time setup
});

PLUGIN_LIFECYCLE.onMount(function(pluginAPI) {
  // Called every time the plugin window opens
  // Use for DOM initialization, event listeners, etc.
});

PLUGIN_LIFECYCLE.onUnmount(function() {
  // Called when the window closes
  // Cleanup happens automatically, but you can do manual cleanup here
});

PLUGIN_LIFECYCLE.onFocus(function() {
  // Called when the window gains focus
});

PLUGIN_LIFECYCLE.onBlur(function() {
  // Called when the window loses focus
});
```

### Lifecycle Flow

```
Window Opens
    ↓
PluginInstance created
    ↓
Shadow DOM attached
    ↓
Shared CSS injected
    ↓
Plugin CSS injected
    ↓
Plugin HTML injected
    ↓
Plugin JS executed
    ↓
onInit() called (first time only)
    ↓
onMount() called
    ↓
[Plugin runs...]
    ↓
Window focus changes → onFocus() / onBlur()
    ↓
Window closes
    ↓
onUnmount() called
    ↓
Auto-cleanup (timers, listeners, components)
    ↓
Shadow DOM destroyed
```

---

## Shadow DOM Isolation

### What is Shadow DOM?

Shadow DOM creates an isolated subtree within the DOM that:
- Has its own scoped CSS
- Cannot be accessed from outside (except via shadow root)
- Protects the host from plugin CSS leakage
- Protects the plugin from host CSS

### How TermulOS Uses It

Each plugin instance gets its own Shadow DOM:

```javascript
// In PluginInstance.mount()
this.shadow = this.hostElement.attachShadow({ mode: 'open' });
```

### Style Isolation

Styles are injected in a specific order for proper cascade:

```javascript
// 1. Shared TermulUI styles (first - lowest priority)
const sharedStyle = document.createElement('style');
sharedStyle.setAttribute('data-tui-shared', 'true');
sharedStyle.textContent = sharedCSS;
this.shadow.appendChild(sharedStyle);

// 2. Plugin-specific styles (higher priority)
if (files.css) {
  const style = document.createElement('style');
  style.textContent = files.css;
  this.shadow.appendChild(style);
}
```

This allows plugins to override shared styles if needed.

### DOM Access

Plugins access their DOM via the `shadow` global:

```javascript
// Shadow DOM is isolated from main document
const container = shadow.querySelector('.plugin-container');

// Use shadow.getElementById() for ID selection
const title = shadow.getElementById('plugin-title');
```

---

## Plugin API

Each plugin instance receives a **scoped API object** via `PLUGIN_API`:

```javascript
const api = PLUGIN_API;
```

### API Structure

```javascript
{
  // Plugin metadata
  manifest: Object,           // Plugin's manifest
  dirName: string,            // Plugin directory name
  windowId: string,           // Window ID

  // Live references (getters)
  ssh: Object,                // SSH API (via termulAPI.ssh)
  connectionId: string,       // Current connection ID
  profile: Object,            // Current connection profile

  // Event bus (scoped, auto-cleanup)
  events: {
    on(event, callback),      // Listen to global event
    off(event, callback),     // Remove listener
    emit(event, data)         // Emit event
  },

  // System APIs
  dialog: Object,             // Dialog helpers
  platform: string,           // Platform info

  // File access
  async readFile(fileName),   // Read file from plugin directory

  // UI component library
  ui: {
    async injectStyles(shadow),
    button(opts),
    iconButton(opts),
    toggle(opts),
    card(opts),
    progressBar(opts),
    status(opts),
    select(opts),
    input(opts),
    toolbar(opts),
    badge(opts),
    settingsItem(opts),
    emptyState(opts),
    modal(opts),
    tabs(opts),
    dataTable(opts),
    dropdown(opts),
    toast(opts),
    accordion(opts)
  }
}
```

### Live References

The API provides **live references**, not static snapshots:

```javascript
// Using the API
if (api.connectionId) {
  console.log('Connected to:', api.profile.name);
}

// These automatically update when connection changes
```

### Scoped Events

The event bus is scoped per-instance and auto-cleans up:

```javascript
// Listen to events
api.events.on('connection:established', (data) => {
  console.log('Connected!', data);
});

// Emit events
api.events.emit('plugin:customEvent', { message: 'Hello' });

// No need to manually remove listeners - cleaned up on unmount
```

---

## Component System

TermulOS provides a shared UI component library called **TermulUI**.

### Component Architecture

Components are **stateful** and **destroyable**:

```javascript
// Base class for all components
class TuiComponent {
  shadow: ShadowRoot           // Plugin's shadow root
  state: Object                // Component state
  el: HTMLElement              // Root DOM element

  // State management
  setState(partial)            // Merge state and re-render

  // Tracked resources (auto-cleanup)
  setTimeout(fn, ms)           // Tracked timeout
  setInterval(fn, ms)          // Tracked interval
  listen(target, event, fn)    // Tracked event listener

  // Lifecycle
  destroy()                    // Full cleanup
}
```

### Using Components

```javascript
// Create a toast notification system
const toast = PLUGIN_API.ui.toast({
  position: 'bottom-right',
  defaultDuration: 4000
});

// Show a notification
toast.show('Connection established', 'success');

// Components are automatically tracked and cleaned up
// when the plugin unmounts
```

### Component Files

After refactoring, components are split into separate files:

```
src/js/tui/
├── TuiComponent.js       // Base class
├── TuiModal.js
├── TuiTabs.js
├── TuiDataTable.js
├── TuiDropdown.js
├── TuiToast.js
├── TuiAccordion.js
└── index.js              // Exports all components
```

### Component Tracking

All components created via `PLUGIN_API.ui.*` are automatically tracked:

```javascript
// In plugin-loader.js
modal(opts = {}) {
  const instance = window.PluginLoader.instances.get(windowId);
  const comp = new window.TuiModal(shadow, opts);
  if (instance) instance._components.push(comp);  // Auto-track
  return comp;
}
```

When a plugin unmounts, all tracked components are destroyed:

```javascript
// In PluginInstance.unmount()
for (const comp of this._components) {
  try { comp.destroy(); }
  catch (e) { console.error('[Plugin] component destroy error:', e); }
}
this._components = [];
```

---

## Execution Model

### Sandbox Environment

Plugin code doesn't execute directly in the global scope. Instead, it's executed in a **sandboxed function** with controlled globals:

```javascript
// In PluginInstance.mount()
const fn = new Function(
  'PLUGIN_API', 'PLUGIN_LIFECYCLE', 'PLUGIN_EXPORTS',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'addEventListener',
  'shadow', 'shadowDoc',
  files.js
);

fn(
  pluginAPI,           // Scoped API
  lifecycle,           // Lifecycle registration
  this.exports,        // Exports object
  sandboxedSetTimeout,     // Tracked setTimeout
  sandboxedSetInterval,    // Tracked setInterval
  sandboxedClearTimeout,   // Tracked clearTimeout
  sandboxedClearInterval,  // Tracked clearInterval
  sandboxedAddEventListener,  // Tracked addEventListener
  this.shadow,          // Shadow DOM
  this.shadow           // Shadow DOM (alias)
);
```

### Tracked Globals

All potentially-leaking globals are replaced with tracked versions:

```javascript
// setTimeout is replaced with:
const sandboxedSetTimeout = (fn, ms) => {
  const id = setTimeout(fn, ms);
  this._timers.add(id);  // Track for cleanup
  return id;
};

// addEventListener is replaced with:
const sandboxedAddEventListener = (target, event, handler, options) => {
  target.addEventListener(event, handler, options);
  this._listeners.push({ target, event, handler, options });  // Track
};
```

This ensures **100% cleanup** - no timer or listener is left behind.

### Exports

Plugins can expose an API to the host:

```javascript
// In plugin main.js
PLUGIN_EXPORTS.myFunction = function() {
  return 'Hello from plugin';
};

// Accessible via:
window.PluginLoader.instances.get(windowId).exports.myFunction()
```

### Available Globals

Plugins have access to these global objects:

```javascript
// From TermulOS (injected by app.js)
window.Terminal        // xterm.js Terminal class
window.FitAddon        // xterm.js FitAddon class
window.TuiComponent    // Base UI component class
window.TuiModal        // UI components
window.TuiTabs
window.TuiDataTable
window.TuiDropdown
window.TuiToast
window.TuiAccordion

// Standard browser APIs
window.XMLHttpRequest
window.fetch
window.WebSocket
// etc.

// TermulOS APIs (via PLUGIN_API)
PLUGIN_API
PLUGIN_LIFECYCLE
PLUGIN_EXPORTS
shadow (ShadowRoot)
shadowDoc (ShadowRoot - alias)
addEventListener (tracked version)
setTimeout (tracked version)
setInterval (tracked version)
clearTimeout (tracked version)
clearInterval (tracked version)
```

---

## Resource Management

### Automatic Cleanup

When a plugin unmounts, **all** resources are automatically cleaned up:

```javascript
// In PluginInstance.unmount()

// 1. Fire lifecycle hook
if (this._lifecycle.onUnmount) {
  this._lifecycle.onUnmount();
}

// 2. Destroy all tracked components
for (const comp of this._components) {
  comp.destroy();
}

// 3. Clear all tracked timers
for (const id of this._timers) clearTimeout(id);
for (const id of this._intervals) clearInterval(id);

// 4. Remove all tracked listeners
for (const { target, event, handler, options } of this._listeners) {
  target.removeEventListener(event, handler, options);
}

// 5. Destroy shadow DOM
this.shadow.innerHTML = '';

// 6. Clean up scoped events
window.PluginLoader.cleanupInstanceEvents(this.windowId);
```

### What Gets Tracked

1. **Timers**: All `setTimeout` and `setInterval` calls
2. **Listeners**: All `addEventListener` calls (via scoped version)
3. **Components**: All `PLUGIN_API.ui.*` component creations
4. **Events**: All `PLUGIN_API.events.on` subscriptions

### Manual Cleanup

Plugins can also do manual cleanup in `onUnmount`:

```javascript
PLUGIN_LIFECYCLE.onUnmount(function() {
  // Close WebSocket connections
  if (ws) ws.close();

  // Abort pending fetch requests
  if (abortController) abortController.abort();

  // Release other resources
});
```

---

## Communication Patterns

### Plugin → Host

Via **exports**:

```javascript
// Plugin main.js
PLUGIN_EXPORTS.getStatus = function() {
  return { connected: true, data: '...' };
};

// Host code
const instance = window.PluginLoader.instances.get(windowId);
const status = instance.exports.getStatus();
```

### Host → Plugin

Via **lifecycle hooks**:

```javascript
// Plugin receives focus notification
PLUGIN_LIFECYCLE.onFocus(function() {
  // Focus the terminal, resume updates, etc.
});
```

### Plugin ↔ Plugin

Via **event bus**:

```javascript
// Plugin A emits
api.events.emit('data:updated', { id: 123, value: 'foo' });

// Plugin B listens
api.events.on('data:updated', (data) => {
  console.log('Received:', data);
});
```

### Plugin → Backend

Via **termulAPI**:

```javascript
// SSH access
const result = await api.ssh.execute(command);

// File access
const content = await api.readFile('config.json');

// Dialogs
api.dialog.showMessageBox({ message: 'Hello' });
```

---

## File Loading

### Batch Loading

Plugin files are loaded in a **single IPC call** for efficiency:

```javascript
// In WindowManager.mountPlugin()
const files = await window.PluginLoader.loadPluginFiles(plugin.dirName);

// Returns:
{
  html: '<div>...</div>',
  css: '.plugin { ... }',
  js: 'PLUGIN_LIFECYCLE.onMount...',
  icon: '<svg>...</svg>',
  error: null
}
```

### Shared Resources

**Shared UI CSS** is pre-fetched and cached:

```javascript
// In PluginLoader.loadAll()
await this.getSharedCSS();  // Pre-fetch for all plugins

// Later, when mounting plugin:
const sharedCSS = window.PluginLoader._sharedCSS;  // Already cached
```

This avoids redundant file reads and IPC calls.

---

## Installation Flow

### Installing a Plugin

```javascript
// 1. User provides plugin data
const pluginData = {
  dirName: 'my-plugin',
  manifest: { /* ... */ },
  files: {
    html: '...',
    css: '...',
    js: '...',
    icon: '...'
  }
};

// 2. PluginLoader validates manifest
const validation = window.PluginLoader.validateManifest(pluginData.manifest);
if (!validation.valid) {
  return { success: false, error: validation.errors };
}

// 3. IPC call to install
const result = await window.termulAPI.plugins.install(pluginData);

// 4. Reload all manifests
await window.PluginLoader.loadAll();

// 5. Notify listeners
window.PluginLoader._notify('install', 'my-plugin');
```

### Uninstalling a Plugin

```javascript
// 1. Check if running
const running = window.PluginLoader.getRunningInstances(dirName);
if (running.length > 0) {
  return { success: false, error: 'Cannot uninstall running plugin' };
}

// 2. IPC call to uninstall
const result = await window.termulAPI.plugins.uninstall(dirName);

// 3. Remove from cache
window.PluginLoader.plugins.delete(dirName);

// 4. Notify listeners
window.PluginLoader._notify('uninstall', dirName);
```

---

## Error Handling

### Manifest Validation

Manifests are validated before loading:

```javascript
validateManifest(mf) {
  // Check required fields
  // Check field types
  // Check dirName safety (no path traversal)
  // Check version format (semver)

  return { valid: boolean, errors: string[] };
}
```

### Plugin Execution Errors

Errors during plugin execution are caught and displayed:

```javascript
try {
  fn(pluginAPI, lifecycle, this.exports, ...);
} catch (err) {
  console.error(`[PluginLoader] Error executing plugin "${this.dirName}":`, err);

  // Show error in plugin area
  const errorDiv = document.createElement('div');
  errorDiv.className = 'plugin-error';
  errorDiv.innerHTML = `<p>Plugin Error</p><pre>${err.message}</pre>`;
  this.shadow.appendChild(errorDiv);
}
```

### Lifecycle Hook Errors

Errors in lifecycle hooks are logged but don't crash the plugin:

```javascript
if (this._lifecycle.onUnmount) {
  try { this._lifecycle.onUnmount(); }
  catch (e) {
    console.error(`[Plugin] onUnmount error in "${this.dirName}":`, e);
  }
}
```

---

## Security Considerations

### Path Traversal Protection

```javascript
// Validate dirName doesn't contain path separators or ".."
if (mf.dirName && /[/\\:]|\.\./.test(mf.dirName)) {
  errors.push('dirName must not contain path separators or ".."');
}
```

### Shadow DOM Isolation

- CSS cannot leak out of plugin's shadow DOM
- Plugin cannot access host DOM (only via explicit API)
- Plugin cannot access other plugin DOMs

### Scoped APIs

- SSH access is via `api.ssh`, not direct
- File access restricted to plugin directory via `api.readFile()`
- Event listeners auto-cleanup prevents memory leaks

### Resource Limits

- All timers tracked and cleaned up
- All listeners tracked and cleaned up
- All components tracked and destroyed
- Shadow DOM destroyed on unmount

---

## Performance Optimizations

### Batch File Loading

All plugin files loaded in one IPC call:

```javascript
// Instead of 4 separate IPC calls:
// const html = await readFile('index.html');
// const css = await readFile('styles.css');
// const js = await readFile('main.js');
// const icon = await readFile('icon.svg');

// Single IPC call:
const files = await loadPluginFiles(dirName);
```

### Shared CSS Caching

Shared UI CSS loaded once and cached:

```javascript
if (this._sharedCSS) return this._sharedCSS;  // Cache hit
```

### Pre-fetching

Shared CSS pre-fetched during `loadAll()`:

```javascript
async loadAll() {
  await this.getSharedCSS();  // Pre-fetch
  // Load manifests...
}
```

---

## Extension Points

### Adding a New Plugin

1. Create plugin directory: `src/plugins/my-plugin/`
2. Create `manifest.json`
3. Create `index.html`
4. Create `styles.css` (optional)
5. Create `main.js`
6. Plugin is automatically discovered by `loadAll()`

### Adding a New UI Component

1. Create component class in `src/js/tui/TuiMyComponent.js`
2. Inherit from `TuiComponent`
3. Implement constructor and `destroy()` lifecycle
4. Add factory in `plugin-loader.js`:
   ```javascript
   myComponent(opts = {}) {
     const instance = window.PluginLoader.instances.get(windowId);
     const comp = new window.TuiMyComponent(shadow, opts);
     if (instance) instance._components.push(comp);
     return comp;
   }
   ```
5. Export in `src/js/tui/index.js`

### Adding a New API

Add to `createPluginAPI()` in `plugin-loader.js`:

```javascript
createPluginAPI(dirName, windowId) {
  return {
    // ...existing APIs...

    myNewAPI: {
      method1() { /* ... */ },
      method2() { /* ... */ }
    }
  };
}
```

---

## Best Practices

### Plugin Authors

1. **Use lifecycle hooks**:
   - Initialize in `onMount()`, not at top level
   - Cleanup in `onUnmount()` for custom resources

2. **Track resources manually**:
   - For resources not auto-tracked (WebSocket, Fetch)
   - Clean them up in `onUnmount()`

3. **Use the component library**:
   - `PLUGIN_API.ui.*` components are auto-tracked
   - Don't manually create complex UI if component exists

4. **Event bus**:
   - Use `api.events` for plugin-to-plugin communication
   - Events are auto-cleanup on unmount

5. **Error handling**:
   - Wrap risky operations in try-catch
   - Show user-friendly error messages

### Core Developers

1. **Maintain isolation**:
   - Keep Shadow DOM boundaries
   - Don't share global state between plugins

2. **Auto-cleanup**:
   - Track all resources that need cleanup
   - Use tracked versions of globals

3. **API design**:
   - Use getters for live references
   - Keep API scoped per-instance

4. **Performance**:
   - Batch IPC calls
   - Cache shared resources
   - Lazy-load when possible

---

## Debugging

### Plugin Developer Tools

```javascript
// In browser console (main process)

// List all loaded plugins
window.PluginLoader.getAll();

// Get running instances
window.PluginLoader.instances;

// Access specific instance
const instance = window.PluginLoader.instances.get('win_xxx');
console.log(instance.exports);

// Inspect shadow DOM
instance.shadow;
```

### Common Issues

**Plugin not loading**:
- Check manifest validation errors
- Check browser console for errors
- Verify file paths

**Styles not applying**:
- Check CSS injection order (shared → plugin)
- Check Shadow DOM scoping

**Memory leaks**:
- Ensure all listeners use tracked `addEventListener`
- Ensure all timers use tracked `setTimeout`/`setInterval`
- Use `PLUGIN_API.ui.*` components (auto-tracked)

**Lifecycle not firing**:
- Check that `PLUGIN_LIFECYCLE.onMount()` is called
- Check for syntax errors in plugin code

---

## Future Enhancements

Potential improvements to the architecture:

1. **Hot Reload**: Reload plugins without restarting windows
2. **Plugin Sandboxing**: Use `iframe` or worker for stricter isolation
3. **Plugin Permissions**: More granular permission system
4. **Plugin Dependencies**: Allow plugins to depend on other plugins
5. **Plugin Marketplace**: Central repository for plugins
6. **Version Compatibility**: Semantic versioning checks
7. **Plugin Debugging**: Dedicated dev tools for plugins
8. **Component State Management**: More sophisticated state (Redux-like)
9. **Plugin Communication**: Direct plugin-to-plugin messaging
10. **Async Components**: Support for async component rendering

---

## Summary

The TermulOS plugin architecture is designed for:

- ✅ **Isolation**: Complete separation via Shadow DOM
- ✅ **Security**: Scoped APIs and sandboxed execution
- ✅ **Performance**: Efficient resource management
- ✅ **Developer Experience**: Simple API with lifecycle hooks
- ✅ **Maintainability**: Auto-cleanup prevents resource leaks
- ✅ **Extensibility**: Easy to add plugins and components

The architecture prioritizes **robustness** and **cleanliness** over complexity, ensuring plugins cannot accidentally or maliciously interfere with each other or the host application.

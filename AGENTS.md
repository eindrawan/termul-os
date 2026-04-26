# TermulOS - Agent Reference Guide

This document provides a comprehensive summary of all TermulOS documentation for AI agents and developers working on the project.

## ⚠️ CRITICAL: Always Use TermulUI Components

**DO NOT create custom UI components.** TermulOS provides a complete library of reusable UI components (TermulUI) that MUST be used instead of creating custom HTML/CSS.

### Why Use TermulUI Components?
- ✅ **Auto-cleanup**: All TermulUI components are automatically tracked and cleaned up on unmount
- ✅ **Consistency**: Maintains visual consistency across the entire system
- ✅ **No memory leaks**: Custom components often leak memory and resources
- ✅ **Faster development**: Components are pre-built and ready to use
- ❌ **Custom UI = Bugs**: Custom modals, toasts, buttons often cause memory leaks and break cleanup

### Available Components (Always Use These)
```javascript
// Modals - NEVER use alert(), confirm(), or custom modals
api.ui.modal({ title: 'Confirm', content: '...', buttons: [...] })

// Toasts - NEVER use custom notifications
api.ui.toast().show('Message', 'success')

// Buttons - NEVER create custom button classes
api.ui.button({ label: 'Click', variant: 'primary' })

// Tables - NEVER build custom tables
api.ui.dataTable({ columns: [...], data: [...] })

// And many more - see section 3 below
```

**If you need a UI element, check if a TermulUI component exists first. It almost always does.**

---

## Table of Contents

1. [Plugin Architecture](#1-plugin-architecture)
2. [Quick Start Guide](#2-quick-start-guide)
3. [Reusable Components](#3-reusable-components-termului)
4. [Store Mechanism](#4-store-mechanism)

---

## 1. Plugin Architecture

### Overview
TermulOS uses a plugin-based architecture where each application window runs a separate plugin instance with complete isolation using **Shadow DOM** and **sandboxed execution contexts**.

### Key Design Principles
- **Isolation**: Each plugin runs in its own Shadow DOM
- **Sandboxing**: Controlled environment with tracked resources
- **Lifecycle Management**: Well-defined hooks for initialization and cleanup
- **No Framework Dependencies**: Vanilla JavaScript with optional UI component library
- **Auto-Cleanup**: All timers, listeners, and components are automatically cleaned up

### Core Components

#### 1. PluginLoader (Singleton)
**Location**: `src/js/plugin-loader.js`

Central orchestrator for all plugin operations:
- Load and validate plugin manifests
- Install/uninstall plugins
- Batch-load plugin files
- Create scoped PluginAPI instances
- Track running plugin instances
- Clean up instance resources

#### 2. PluginInstance
**Location**: `src/js/plugin-loader.js` (lines 793-998)

Represents a single running plugin instance with:
- Shadow DOM management
- Sandbox execution
- Resource tracking (timers, listeners, components)
- Lifecycle hook firing
- Cleanup on unmount

#### 3. WindowManager
**Location**: `src/js/window-manager.js`

Manages application windows and integrates with PluginInstance:
- Create and position windows
- Mount plugins into windows
- Handle window focus/minimize/maximize/close
- Clean up plugins when windows close

### Plugin Structure
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
  "dirName": "plugin-name",        // Required: Directory name
  "system": false,                 // Optional: Mark as system plugin
  "window": {                      // Optional: Default window size
    "width": 800,
    "height": 550
  },
  "permissions": [],               // Optional: Required permissions
  "icon": "<svg>...</svg>"         // Optional: SVG icon markup
}
```

### Lifecycle Hooks
```javascript
PLUGIN_LIFECYCLE.onInit(function(pluginAPI) {
  // Called once when plugin is first loaded
});

PLUGIN_LIFECYCLE.onMount(function(pluginAPI) {
  // Called every time the plugin window opens
});

PLUGIN_LIFECYCLE.onUnmount(function() {
  // Called when the window closes
});

PLUGIN_LIFECYCLE.onFocus(function() {
  // Called when the window gains focus
});

PLUGIN_LIFECYCLE.onBlur(function() {
  // Called when the window loses focus
});
```

### Plugin API Structure
```javascript
{
  // Plugin metadata
  manifest: Object,
  dirName: string,
  windowId: string,

  // Live references (getters)
  ssh: Object,
  connectionId: string,
  profile: Object,

  // Event bus (scoped, auto-cleanup)
  events: {
    on(event, callback),
    off(event, callback),
    emit(event, data)
  },

  // System APIs
  dialog: Object,
  platform: string,

  // File access
  async readFile(fileName),

  // UI component library
  ui: { /* all TermulUI components */ }
}
```

---

## 2. Quick Start Guide

### Create Your First Plugin in 5 Minutes

#### Step 1: Create Plugin Directory
```
src/plugins/my-plugin/
├── manifest.json
├── index.html
└── main.js
```

#### Step 2: Write manifest.json
```json
{
  "name": "My Plugin",
  "description": "My awesome plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "dirName": "my-plugin",
  "window": {
    "width": 600,
    "height": 400
  }
}
```

#### Step 3: Write index.html
```html
<div class="my-plugin">
  <h1>Hello, World!</h1>
  <button id="my-button">Click Me</button>
  <div id="output"></div>
</div>
```

#### Step 4: Write main.js
```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const button = shadow.getElementById('my-button');
  const output = shadow.getElementById('output');

  addEventListener(button, 'click', function() {
    output.textContent = 'Button clicked!';
  });
});
```

### Common Patterns

#### Access Current Connection
```javascript
const api = PLUGIN_API;
if (api.connectionId) {
  console.log('Connected to:', api.profile.host);
}
```

#### Show Toast Notification
```javascript
const toast = PLUGIN_API.ui.toast();
toast.show('Operation completed!', 'success');
```

#### Create Modal
```javascript
const modal = PLUGIN_API.ui.modal({
  title: 'Confirm Action',
  content: '<p>Are you sure?</p>',
  buttons: [
    { label: 'Cancel', onClick: () => modal.close() },
    { label: 'Confirm', variant: 'danger', onClick: () => {
      console.log('Confirmed!');
      modal.close();
    }}
  ]
});
modal.open();
```

#### Fetch Data from API
```javascript
PLUGIN_LIFECYCLE.onMount(async function() {
  try {
    const response = await fetch('https://api.example.com/data');
    const data = await response.json();
    const output = shadow.getElementById('output');
    output.textContent = JSON.stringify(data);
  } catch (error) {
    const toast = PLUGIN_API.ui.toast();
    toast.show('Failed to load data', 'error');
  }
});
```

#### Update UI Periodically
```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const output = shadow.getElementById('output');
  setInterval(() => {
    output.textContent = new Date().toLocaleTimeString();
  }, 1000);
});
```

#### Access SSH
```javascript
const api = PLUGIN_API;
if (api.connectionId) {
  const result = await api.ssh.execute('ls -la');
  console.log(result.stdout);
}
```

### Best Practices

#### ✅ Do
- **ALWAYS use `PLUGIN_API.ui.*` components** (auto-cleanup, consistent)
- **ALWAYS check TermulUI library before creating custom UI**
- Use tracked `addEventListener` (provided by sandbox)
- Use lifecycle hooks for initialization
- Handle errors with try-catch
- Use `shadow.getElementById()` for ID selection
- Cleanup custom resources in `onUnmount`

#### ❌ Don't
- **NEVER create custom modals, toasts, buttons, or UI elements**
- **NEVER use `alert()`, `confirm()`, or native browser dialogs**
- **NEVER write custom CSS for components that already exist in TermulUI**
- Don't use global `window.addEventListener`
- Don't use global `setTimeout` without tracking
- Don't access other plugin DOMs directly
- Don't modify global state
- Don't forget to cleanup WebSockets, Fetch, etc.

### 🔴 Common Mistakes to Avoid

```javascript
// ❌ WRONG - Creating custom modal
const modal = document.createElement('div');
modal.className = 'my-custom-modal';
shadow.appendChild(modal);

// ✅ CORRECT - Using TermulUI modal
const modal = api.ui.modal({
  title: 'Confirm',
  content: '<p class="tui-modal-message">Are you sure?</p>',
  buttons: [ /* ... */ ]
});
modal.open();

// ❌ WRONG - Using native alert
alert('Operation failed');

// ✅ CORRECT - Using TermulUI toast
const toast = api.ui.toast();
toast.show('Operation failed', 'error');

// ❌ WRONG - Creating custom button with custom CSS
const btn = document.createElement('button');
btn.className = 'my-custom-btn';
btn.style.cssText = 'background: blue; color: white;';

// ✅ CORRECT - Using TermulUI button
const btn = api.ui.button({
  label: 'Click Me',
  variant: 'primary'
});
```

---

## 3. Reusable Components (TermulUI)

### 🎨 Why TermulUI Components Are Mandatory

**Every UI element you need already exists in TermulUI.** Do not create custom components.

Before writing any custom HTML/CSS for a UI element, check if TermulUI provides it:
- Need a dialog? → `api.ui.modal()`
- Need a notification? → `api.ui.toast()`
- Need a button? → `api.ui.button()`
- Need a table? → `api.ui.dataTable()`
- Need tabs? → `api.ui.tabs()`
- Need a dropdown? → `api.ui.dropdown()`
- Need settings UI? → `api.ui.settingsItem()`, `api.ui.toggle()`

**Creating custom UI components is the #1 cause of bugs and memory leaks in plugins.**

### CSS Classes

#### Button Variants
```html
<!-- Primary (confirm/OK actions) -->
<button class="tui-btn tui-btn-primary">Install</button>

<!-- Default (cancel/secondary actions) -->
<button class="tui-btn tui-btn-default">Cancel</button>

<!-- Danger (destructive actions) -->
<button class="tui-btn tui-btn-danger">Delete</button>

<!-- Ghost (toolbar actions) -->
<button class="tui-btn tui-btn-ghost">Refresh</button>

<!-- Accent (highlighted/call-to-action) -->
<button class="tui-btn tui-btn-accent">Highlight</button>

<!-- Icon button (small toolbar icons) -->
<button class="tui-btn-icon">
  <svg width="14" height="14">...</svg>
</button>
```

#### Modal Buttons
```html
<button class="tui-modal-btn tui-modal-btn-secondary">Cancel</button>
<button class="tui-modal-btn tui-modal-btn-primary">OK</button>
```

### JavaScript Components

#### TuiModal - Dialog/Confirmation
```javascript
var modal = api.ui.modal({
  title: 'Confirm Action',
  content: '<p class="tui-modal-message">Are you sure?</p>',
  buttons: [
    { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
    { label: 'Confirm', variant: 'danger', onClick: function(m) { m.close(); doAction(); } }
  ]
});
modal.open();
```

#### TuiToast - Notifications
```javascript
var toast = api.ui.toast({
  position: 'bottom-right',
  defaultDuration: 4000
});

toast.show('Saved successfully', 'success');    // Green
toast.show('File not found', 'error');           // Red
toast.show('Processing...', 'info');             // Blue
toast.show('Warning: Low disk space', 'warning'); // Yellow
```

#### TuiTabs - Tabbed Panel
```javascript
var tabs = api.ui.tabs({
  items: [
    { id: 'tab1', label: 'General', content: '<div>Tab 1 content</div>' },
    { id: 'tab2', label: 'Advanced', content: '<div>Tab 2 content</div>' }
  ],
  activeTab: 'tab1',
  onSwitch: function(tabId) {
    console.log('Switched to:', tabId);
  }
});
someContainer.appendChild(tabs.el);
```

#### TuiDataTable - Data Table
```javascript
var table = api.ui.dataTable({
  columns: [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'size', label: 'Size', sortable: true },
    { key: 'type', label: 'Type', render: function(val) { return '<span class="tag">' + val + '</span>'; } }
  ],
  data: [
    { name: 'file.txt', size: 1024, type: 'text' },
    { name: 'image.png', size: 2048, type: 'image' }
  ],
  selectable: true,
  onRowClick: function(row) { console.log('Clicked:', row); }
});
someContainer.appendChild(table.el);
```

#### Stateless Component Factories

```javascript
// Button
var btn = api.ui.button({
  label: 'Click Me',
  variant: 'primary',
  icon: '<svg>...</svg>',
  onClick: function() { console.log('clicked'); }
});

// Toggle
var toggle = api.ui.toggle({
  checked: false,
  label: 'Enable feature',
  onChange: function(checked) { }
});

// Card
var card = api.ui.card({
  title: 'Card Title',
  subtitle: 'Optional subtitle',
  content: '<p>Card body</p>'
});

// Progress Bar
var progress = api.ui.progressBar({
  value: 75,
  max: 100,
  label: 'Uploading...'
});

// Status
var status = api.ui.status({
  variant: 'success',
  text: 'Connected'
});

// Select
var select = api.ui.select({
  options: [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' }
  ],
  value: 'a',
  onChange: function(value) { }
});

// Input
var input = api.ui.input({
  placeholder: 'Enter text...',
  value: '',
  type: 'text',
  onChange: function(value) { }
});

// Badge
var badge = api.ui.badge({
  variant: 'info',
  text: '3'
});

// Settings Item
var item = api.ui.settingsItem({
  title: 'Auto-save',
  description: 'Save files automatically',
  control: toggleElement
});

// Empty State
var empty = api.ui.emptyState({
  icon: '<svg>...</svg>',
  title: 'No Items',
  description: 'Add some items to get started'
});
```

### CSS Custom Properties
```css
/* Colors */
var(--tui-accent-primary)       /* Primary accent (#0078D4) */
var(--tui-accent-secondary)     /* Secondary accent (#60CDFF) */

/* Backgrounds */
var(--tui-bg-surface)           /* Surface background (#0f0f0f) */
var(--tui-bg-glass)             /* Glass/transparent bg */

/* Text */
var(--tui-text-primary)         /* Primary text (#e0e0e0) */
var(--tui-text-secondary)       /* Secondary text */

/* Borders */
var(--tui-border-subtle)        /* Subtle border */
var(--tui-border-medium)        /* Medium border */

/* Spacing */
var(--tui-space-xs)             /* 4px */
var(--tui-space-sm)             /* 8px */
var(--tui-space-md)             /* 16px */

/* Radius */
var(--tui-radius-sm)            /* 6px */
var(--tui-radius-md)            /* 10px */

/* Shadows */
var(--tui-shadow-sm)
var(--tui-shadow-md)
```

---

## 4. Store Mechanism

### Overview
The Plugin Store is a built-in system plugin that lets users browse and install plugins from a GitHub repository. It fetches a store index from a configurable raw GitHub URL and installs plugins through the existing `PluginLoader.install()` pipeline.

### Architecture
```
GitHub Repo (store/)
├── index.json              ← Plugin registry
├── hello-world/            ← Example store plugin
│   ├── manifest.json
│   ├── index.html
│   ├── style.css
│   ├── main.js
│   └── icon.svg
└── another-plugin/
    └── ...

        │ fetch() via CSP-allowed URL
        ▼

Plugin Store Plugin
├── Fetch store/index.json
├── Render plugin cards
├── On "Install" → fetch all files
└── Call PluginLoader.install(data)
```

### Store Index Format
```json
[
  {
    "id": "hello-world",
    "name": "Hello World",
    "description": "A simple demo plugin.",
    "version": "1.0.0",
    "author": "TermulOS",
    "dirName": "hello-world",
    "category": "demo",
    "tags": ["demo", "example"],
    "icon": "<svg>...</svg>",
    "window": {
      "width": 500,
      "height": 400
    },
    "files": ["manifest.json", "index.html", "style.css", "main.js", "icon.svg"]
  }
]
```

### Store URL Configuration

#### Default URL
```javascript
var DEFAULT_STORE_URL = 'https://raw.githubusercontent.com/eindrawan/termul-os/refs/heads/main/store/';
```

#### URL Format
```
https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}/store/
```

### Install Flow

1. User clicks "Install"
2. Fetch all plugin files in parallel from store
3. Parse manifest.json → validate
4. Build pluginData object
5. Call `PluginLoader.install(pluginData)` → IPC → write to plugins dir
6. Re-render store UI to show installed status

### Uninstall Flow

1. User clicks "Uninstall"
2. Show confirmation dialog (TuiModal)
3. Call `PluginLoader.uninstall(dirName)` → IPC → remove directory
4. Re-render store UI

### Update Detection
```javascript
var hasUpdate = isInstalled &&
                installedVersion &&
                plugin.version &&
                installedVersion !== plugin.version;
```

### Search & Filtering
Real-time search across:
- plugin.name
- plugin.description
- plugin.author
- plugin.tags (joined)
- plugin.category

Case-insensitive substring matching on every keystroke.

### Content Security Policy
In `src/index.html`:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self' 'unsafe-inline' 'unsafe-eval';
           connect-src 'self' https://raw.githubusercontent.com;
           script-src 'self' 'unsafe-inline' 'unsafe-eval';
           style-src 'self' 'unsafe-inline';">
```

### Adding a Plugin to the Store

1. Create plugin directory in `store/`
2. Add entry to `store/index.json`
3. Commit and push to GitHub

---

## Key File Locations

### Plugin System
- `src/js/plugin-loader.js` - Plugin loader and instance management
- `src/js/window-manager.js` - Window management
- `src/js/tui/` - TermulUI component library
- `src/plugins/` - Plugin directories

### Store
- `store/index.json` - Plugin registry
- `store/{plugin-name}/` - Store plugins
- `src/plugins/plugin-store/` - Store system plugin

### Styles
- `src/styles/plugin-components.css` - Shared TermulUI CSS
- `src/plugins/{plugin}/style.css` - Plugin-specific styles

---

## Development Workflow

1. **Create Plugin**: Set up plugin directory with manifest, HTML, CSS, and JS
2. **Use Lifecycle Hooks**: Initialize in `onMount`, cleanup in `onUnmount`
3. **Use Component Library**: Leverage `PLUGIN_API.ui.*` for UI components
4. **Track Resources**: All timers, listeners, and components are auto-tracked
5. **Test**: Use browser DevTools to inspect plugin instance and shadow DOM
6. **Publish**: Add to store index and push to GitHub

---

## Common Issues & Solutions

### Plugin Not Loading
- Check manifest validation errors
- Check browser console for errors
- Verify file paths

### Styles Not Applying
- Check CSS injection order (shared → plugin)
- Check Shadow DOM scoping

### Memory Leaks
- Ensure all listeners use tracked `addEventListener`
- Ensure all timers use tracked `setTimeout`/`setInterval`
- Use `PLUGIN_API.ui.*` components (auto-tracked)

### Lifecycle Not Firing
- Check that `PLUGIN_LIFECYCLE.onMount()` is called
- Check for syntax errors in plugin code

---

## Additional Resources

- **Full Architecture**: `docs/PLUGIN_ARCHITECTURE.md`
- **Component Library**: `docs/REUSABLE_COMPONENTS.md`
- **Store Mechanism**: `docs/STORE_MECHANISM.md`
- **Example Plugins**: `src/plugins/terminal/`, `src/plugins/settings/`

---

## Final Reminder

### 🚨 BEFORE YOU WRITE ANY CUSTOM UI CODE:

1. **Check if TermulUI has this component** - 99% of the time, it does
2. **Use `PLUGIN_API.ui.*` factory methods** - They handle tracking and cleanup
3. **Never use native browser dialogs** - `alert()`, `confirm()`, `prompt()` break immersion
4. **Never create custom modals/toasts** - Use `api.ui.modal()` and `api.ui.toast()`
5. **Never write custom CSS for buttons** - Use `tui-btn` classes or `api.ui.button()`

**The TermulUI library exists for a reason. Use it.**

---

*Last updated: April 25, 2026*

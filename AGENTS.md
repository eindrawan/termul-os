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

## 2. Settings & Profile-Specific Persistence

### Overview

TermulOS supports multiple connection profiles (SSH connections), and many settings should be **profile-specific** rather than global. This ensures each connection can have its own customized configuration.

### Settings Pattern

All profile-specific settings use the pattern:

```javascript
const key = 'settingName:' + profile.id;
await window.termulAPI.settings.get(key, defaultValue);
await window.termulAPI.settings.set(key, value);
```

### Existing Profile-Specific Settings

| Setting | Key Pattern | Purpose |
|---------|-------------|---------|
| Desktop Background | `desktopBackground:${profile.id}` | Custom wallpaper image path per profile |
| Hidden Desktop Icons | `desktop:hiddenIcons:${profile.id}` | Array of plugin dirNames hidden from desktop |
| Pinned Taskbar Apps | `taskbar:pinnedApps:${profile.id}` | Array of plugin dirNames pinned to taskbar |

### Implementation Example

Here's how desktop background settings work (from `app.js`):

```javascript
async applyProfileBackground(profile) {
  const app = document.getElementById('app');
  if (!app || !profile || !profile.id) return;

  try {
    // Build profile-specific key
    const key = 'desktopBackground:' + profile.id;
    const savedBg = await window.termulAPI.settings.get(key, null);

    if (savedBg) {
      // Apply saved background
      const normalizedPath = savedBg.replace(/\\/g, '/');
      app.style.backgroundImage = "url('localfile://bg#" + encodeURIComponent(normalizedPath) + "')";
      app.style.backgroundSize = 'cover';
      app.style.backgroundPosition = 'center';
    } else {
      // No custom background for this profile — restore default
      app.style.backgroundImage = '';
    }
  } catch (e) {
    console.warn('[TermulOS] Failed to load desktop background:', e);
  }
}
```

### Desktop Icons & Taskbar Pinning Per Profile

Both desktop icon visibility and taskbar pinning are profile-specific:

#### Hidden Desktop Icons
```javascript
// From desktop.js
async loadHiddenIcons() {
  try {
    const key = this.currentProfileId
      ? `desktop:hiddenIcons:${this.currentProfileId}`
      : 'desktop:hiddenIcons';
    const saved = await window.termulAPI.settings.get(key, null);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) {
        this.hiddenIcons = new Set(arr);
      }
    }
  } catch (e) {
    console.warn('[Desktop] Failed to load hidden icons:', e);
  }
}
```

#### Pinned Taskbar Apps
```javascript
// From taskbar.js
async loadPinnedApps() {
  try {
    const key = this.currentProfileId
      ? `taskbar:pinnedApps:${this.currentProfileId}`
      : 'taskbar:pinnedApps';
    const saved = await window.termulAPI.settings.get(key, null);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) {
        this.pinnedApps = arr;
      }
    }
  } catch (e) {
    console.warn('[Taskbar] Failed to load pinned apps:', e);
  }
}
```

### Reloading Settings on Profile Switch

When switching between connection tabs, profile-specific settings are reloaded:

```javascript
// From app.js - switchTab method
async switchTab(tabId) {
  const tab = this.tabs.find(t => t.id === tabId);
  if (!tab) return;

  // ... update active tab, show windows, etc ...

  // Apply this profile's desktop background
  this.applyProfileBackground(tab.profile);

  // Reload desktop and taskbar settings for this profile
  if (window.Desktop && tab.profile && tab.profile.id) {
    await window.Desktop.reloadSettings(tab.profile.id);
  }
  if (window.Taskbar && tab.profile && tab.profile.id) {
    await window.Taskbar.reloadSettings(tab.profile.id);
  }
}
```

### Implementing Profile-Specific Settings in Your Code

When creating plugins or features that need per-profile settings:

1. **Accept profile ID during initialization:**
   ```javascript
   async init(profileId = null) {
     this.currentProfileId = profileId;
     await this.loadSettings();
   }
   ```

2. **Use profile-specific keys:**
   ```javascript
   async loadSettings() {
     const key = this.currentProfileId
       ? `myFeature:settings:${this.currentProfileId}`
       : 'myFeature:settings';
     const saved = await window.termulAPI.settings.get(key, null);
     // ... parse and apply settings
   }
   ```

3. **Save with profile-specific keys:**
   ```javascript
   async saveSettings() {
     const key = this.currentProfileId
       ? `myFeature:settings:${this.currentProfileId}`
       : 'myFeature:settings';
     await window.termulAPI.settings.set(key, JSON.stringify(this.settings));
   }
   ```

4. **Provide reload method for profile switching:**
   ```javascript
   async reloadSettings(profileId) {
     this.currentProfileId = profileId;
     await this.loadSettings();
     this.render(); // Re-render UI with new settings
   }
   ```

### Accessing Current Profile from Plugins

Plugins can access the current profile through the `PLUGIN_API`:

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const api = PLUGIN_API;

  // Check if connected to a profile
  if (api.connectionId && api.profile) {
    console.log('Connected to:', api.profile.host);
    console.log('Profile ID:', api.profile.id);

    // Use profile.id for profile-specific settings
    const key = 'myPlugin:data:' + api.profile.id;
    const data = await window.termulAPI.settings.get(key, null);
  }
});
```

### Backward Compatibility

When no profile ID is provided (e.g., in connection dialog mode), the code falls back to global keys without the profile suffix:

```javascript
const key = this.currentProfileId
  ? `setting:${this.currentProfileId}`  // Profile-specific
  : 'setting';                           // Global fallback
```

This ensures the feature works in both scenarios.

### Best Practices

✅ **Do:**
- Always use `profile.id` for settings that vary per connection
- Provide fallback to global keys when `profileId` is null
- Implement `reloadSettings()` for live profile switching
- Clear/reset settings when switching to a profile with no saved data

❌ **Don't:**
- Use global settings for connection-specific data
- Forget to handle the case where `profileId` is null
- Store sensitive data (passwords, keys) in settings - use secure storage instead

---

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

## 3. Quick Start Guide

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

## 4. Reusable Components (TermulUI)

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

## 5. Store Mechanism

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

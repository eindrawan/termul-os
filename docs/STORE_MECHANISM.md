# TermulOS Plugin Store

## Overview

The Plugin Store is a built-in system plugin that lets users browse and install plugins from a GitHub repository. It fetches a store index from a configurable raw GitHub URL, displays available plugins, and installs them by downloading files via `fetch()` through the existing `PluginLoader.install()` pipeline.

---

## Architecture

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

┌──────────────────────────────────────┐
│  Plugin Store (src/plugins/plugin-store/)  │
│                                      │
│  1. Fetch store/index.json           │
│  2. Render plugin cards              │
│  3. On "Install" → fetch all files   │
│     from store/{dirName}/*           │
│  4. Call PluginLoader.install(data)  │
│     → IPC → write to plugins dir    │
└──────────────────────────────────────┘
```

### No Backend Changes Required

The store plugin is entirely a frontend plugin. It uses:
- **Browser `fetch()`** to download files from GitHub raw content URLs
- **Existing `PluginLoader.install()`** IPC method to write files to disk
- **Existing `PluginLoader.uninstall()`** IPC method to remove plugins

No new IPC handlers were added. The store plugin is just another plugin using the existing plugin API.

---

## Store Index Format

The `store/index.json` file is the plugin registry. It must be a JSON array at the root of the `store/` directory.

### Schema

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

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique plugin identifier |
| `name` | string | Yes | Display name shown in the store |
| `description` | string | Yes | Short description shown in the store card |
| `version` | string | Yes | Semantic version (e.g. `1.0.0`) |
| `author` | string | No | Author name |
| `dirName` | string | Yes | Directory name in `store/` — must match the folder name exactly |
| `category` | string | No | Category tag displayed on the card |
| `tags` | string[] | No | Searchable tags |
| `icon` | string | No | Inline SVG markup for the plugin icon |
| `window` | object | No | Default window dimensions `{ width, height }` |
| `files` | string[] | Yes | List of files to download during install |

---

## Store Plugin Structure

Each plugin in the store is a directory under `store/` with the same file structure as local plugins:

```
store/{plugin-name}/
├── manifest.json    # Required — plugin metadata
├── index.html       # Plugin HTML
├── style.css        # Plugin styles (optional)
├── main.js          # Plugin logic
└── icon.svg         # Plugin icon (optional)
```

The `manifest.json` inside the store plugin must follow the standard plugin manifest schema:

```json
{
  "name": "Plugin Name",
  "description": "What it does",
  "version": "1.0.0",
  "author": "Author Name",
  "dirName": "plugin-name",
  "system": false,
  "window": {
    "width": 500,
    "height": 400
  },
  "permissions": []
}
```

---

## Install Flow

### Step-by-Step

```
User clicks "Install"
       │
       ▼
1. Find plugin entry in store/index.json
       │
       ▼
2. Read `files` array to know what to download
       │
       ▼
3. Fetch all files in parallel:
   GET store/{dirName}/manifest.json
   GET store/{dirName}/index.html
   GET store/{dirName}/style.css
   GET store/{dirName}/main.js
   GET store/{dirName}/icon.svg
       │
       ▼
4. Parse manifest.json → validate
       │
       ▼
5. Build pluginData object:
   {
     dirName: "hello-world",
     manifest: { /* parsed JSON */ },
     mainScript: "/* JS content */",
     mainHtml: "<div>...</div>",
     styles: "/* CSS content */",
     icon: "<svg>...</svg>"
   }
       │
       ▼
6. Call PluginLoader.install(pluginData)
   → IPC: plugins:install
   → Electron writes files to src/plugins/{dirName}/
       │
       ▼
7. Re-render store UI to show installed status
```

### Install Data Format

The data passed to `PluginLoader.install()` must match the IPC handler's expected fields:

```javascript
{
  dirName: string,        // Safe directory name (no path separators)
  manifest: object,       // Parsed manifest.json
  mainScript: string|null, // Content of main.js
  mainHtml: string|null,   // Content of index.html
  styles: string|null,     // Content of style.css
  icon: string|null        // Content of icon.svg
}
```

The Electron IPC handler (`plugins:install`) writes these to `src/plugins/{dirName}/`:
- `manifest.json` → stringified with 2-space indent
- `main.js` → raw content
- `index.html` → raw content
- `style.css` → raw content
- `icon.svg` → raw content

### Uninstall Flow

```
User clicks "Uninstall"
       │
       ▼
1. Show confirmation dialog (TuiModal)
       │
       ▼ (confirmed)
2. Call PluginLoader.uninstall(dirName)
   → IPC: plugins:uninstall
   → Electron removes src/plugins/{dirName}/ directory
       │
       ▼
3. Re-render store UI to show install button
```

---

## Store URL Configuration

### Default URL

The store URL is configured in `src/plugins/plugin-store/main.js`:

```javascript
var DEFAULT_STORE_URL = 'https://raw.githubusercontent.com/eindrawan/termul-os/refs/heads/main/store/';
```

### URL Format

```
https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}/store/
```

The URL must end with a trailing `/`. The store appends file paths to this base:
- `{url}index.json` — plugin registry
- `{url}{dirName}/manifest.json` — specific plugin file
- `{url}{dirName}/main.js` — etc.

### Runtime Configuration

Users can change the store URL at runtime via the settings panel (gear icon in the store header):

1. Click the gear icon
2. Enter a new raw GitHub URL
3. Click "Save & Reload"

The URL is persisted to Electron settings via `window.termulAPI.settings.set('store:url', url)`.

### Important Notes

- **GitHub raw URLs only serve files, not directories.** Fetching a directory URL returns 404 — this is expected. The store only fetches specific file paths.
- **The `refs/heads/` prefix** in the URL is required for raw GitHub content URLs when using the full ref path.

---

## Content Security Policy

The store fetches from GitHub, so the CSP must allow connections to `raw.githubusercontent.com`.

In `src/index.html`:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self' 'unsafe-inline' 'unsafe-eval';
           connect-src 'self' https://raw.githubusercontent.com;
           script-src 'self' 'unsafe-inline' 'unsafe-eval';
           style-src 'self' 'unsafe-inline';">
```

The key directive is `connect-src 'self' https://raw.githubusercontent.com` which allows `fetch()` to GitHub.

---

## Update Detection

The store compares installed plugin versions against store versions:

```javascript
var hasUpdate = isInstalled &&
                installedVersion &&
                plugin.version &&
                installedVersion !== plugin.version;
```

When an update is available, the card shows:
- Version change badge: `v1.0.0 → v1.1.0`
- "Update" button (same install flow, overwrites existing files)

---

## Search & Filtering

The store supports real-time search across multiple fields:

```javascript
// Searchable fields
plugin.name
plugin.description
plugin.author
plugin.tags (joined)
plugin.category
```

Search is case-insensitive substring matching triggered on every keystroke.

---

## Adding a New Plugin to the Store

### 1. Create the plugin directory

```
store/my-plugin/
├── manifest.json
├── index.html
├── style.css
├── main.js
└── icon.svg
```

### 2. Add entry to store/index.json

```json
[
  {
    "id": "my-plugin",
    "name": "My Plugin",
    "description": "What my plugin does",
    "version": "1.0.0",
    "author": "Your Name",
    "dirName": "my-plugin",
    "category": "utility",
    "tags": ["utility", "tool"],
    "icon": "<svg viewBox='0 0 24 24'>...</svg>",
    "window": { "width": 600, "height": 450 },
    "files": ["manifest.json", "index.html", "style.css", "main.js", "icon.svg"]
  }
]
```

### 3. Commit and push to GitHub

The store will automatically pick up new plugins on the next refresh.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Store URL unreachable | Error state with "Retry" button |
| Invalid index.json format | Error state with message |
| Plugin file 404 | File is skipped (optional files) |
| Missing manifest.json | Install fails with error dialog |
| Invalid manifest.json | Install fails with parse error |
| Install IPC failure | Error dialog via TuiModal |
| Uninstall IPC failure | Error dialog via TuiModal |

All user-facing errors use the standard `TuiModal` component (no native `alert()` or `confirm()`).

---

## File Reference

| File | Purpose |
|------|---------|
| `store/index.json` | Plugin registry (fetched at runtime) |
| `store/hello-world/*` | Example store plugin |
| `src/plugins/plugin-store/manifest.json` | Store system plugin metadata |
| `src/plugins/plugin-store/index.html` | Store UI layout |
| `src/plugins/plugin-store/style.css` | Store-specific styles |
| `src/plugins/plugin-store/main.js` | Store logic (fetch, install, uninstall) |
| `src/plugins/plugin-store/icon.svg` | Store icon |
| `src/index.html` | CSP config (`connect-src`) |

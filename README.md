# TermulOS

An SSH client with an OS-like interface featuring a Windows 12-inspired glassmorphism design.

## Features

- **Connection Profiles**: Save and manage SSH connection profiles
- **Plugin Architecture**: Modular apps that can be installed/uninstalled
- **Windows 12 Design**: Beautiful glassy UI with blur effects
- **Taskbar & Start Menu**: OS-like navigation
- **Window Management**: Draggable, resizable windows
- **Built-in Apps**:
  - **Terminal**: SSH terminal emulator
  - **Settings**: System configuration
  - **System Monitor**: Resource monitoring

## Installation

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build for distribution
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

## Plugin System

Plugins are stored in `src/plugins/` and consist of:
- `manifest.json` - Plugin metadata
- `index.html` - UI template
- `main.js` - Plugin logic
- `style.css` - Custom styles
- `icon.svg` - App icon

### Creating a Plugin

1. Create a directory in `src/plugins/your-plugin/`
2. Add a `manifest.json`:
```json
{
  "name": "Your Plugin",
  "description": "Plugin description",
  "version": "1.0.0",
  "dirName": "your-plugin",
  "system": false,
  "window": { "width": 600, "height": 400 }
}
```
3. Implement the plugin in `main.js` with access to `PLUGIN_API`

## Architecture

```
TermulOS/
├── electron/          # Electron main process
│   ├── main.js        # IPC handlers, SSH connections
│   └── preload.js     # Context bridge
├── src/
│   ├── js/            # Frontend modules
│   ├── styles/        # CSS
│   └── plugins/       # Plugin system
└── package.json
```

## Tech Stack

- **Electron** - Desktop framework
- **SSH2** - SSH client library
- **Vanilla JS** - No frameworks

## License

MIT

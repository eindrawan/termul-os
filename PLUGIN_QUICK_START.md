# Plugin Quick Start Guide

## Create Your First Plugin in 5 Minutes

### Step 1: Create Plugin Directory

```
src/plugins/my-plugin/
├── manifest.json
├── index.html
└── main.js
```

### Step 2: Write manifest.json

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

### Step 3: Write index.html

```html
<div class="my-plugin">
  <h1>Hello, World!</h1>
  <button id="my-button">Click Me</button>
  <div id="output"></div>
</div>
```

### Step 4: Write main.js

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const button = shadow.getElementById('my-button');
  const output = shadow.getElementById('output');

  addEventListener(button, 'click', function() {
    output.textContent = 'Button clicked!';
  });
});
```

### That's It!

Your plugin is ready. It will automatically appear in the app.

---

## Using the Plugin API

### Access Current Connection

```javascript
const api = PLUGIN_API;

if (api.connectionId) {
  console.log('Connected to:', api.profile.host);
}
```

### Show a Toast Notification

```javascript
const toast = PLUGIN_API.ui.toast();
toast.show('Operation completed!', 'success');
```

### Create a Modal

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

### Create a Data Table

```javascript
const table = PLUGIN_API.ui.dataTable({
  columns: [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: '', render: (val, row) => {
      return `<button class="tui-btn">Edit</button>`;
    }}
  ],
  data: [
    { name: 'Item 1', status: 'Active' },
    { name: 'Item 2', status: 'Inactive' }
  ],
  selectable: true,
  onRowClick: (row, index) => {
    console.log('Clicked row:', row);
  }
});

shadow.querySelector('.container').appendChild(table.el);
```

### Use TermulUI Components

```javascript
// Create a button
const btn = PLUGIN_API.ui.button({
  label: 'Click Me',
  variant: 'primary',
  icon: '<svg>...</svg>',
  onClick: () => console.log('Clicked!')
});

// Create a toggle
const toggle = PLUGIN_API.ui.toggle({
  active: false,
  onChange: (isActive) => console.log('Toggle:', isActive)
});

// Create a card
const card = PLUGIN_API.ui.card({
  title: 'Card Title',
  icon: '<svg>...</svg>'
});
card.body.textContent = 'Card content';

// Append to shadow DOM
shadow.querySelector('.container').appendChild(btn);
shadow.querySelector('.container').appendChild(toggle);
shadow.querySelector('.container').appendChild(card);
```

### Listen to Events

```javascript
const api = PLUGIN_API;

// Listen to connection events
api.events.on('connection:established', (data) => {
  console.log('Connected!');
});

// Emit custom events
api.events.emit('my-plugin:action', { value: 123 });
```

---

## Lifecycle Hooks

### onMount - Called when window opens

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  // Initialize DOM
  // Add event listeners
  // Start timers
  // Create UI components
});
```

### onUnmount - Called when window closes

```javascript
PLUGIN_LIFECYCLE.onUnmount(function() {
  // Cleanup happens automatically, but you can:
  // Close WebSocket connections
  // Abort pending requests
  // Save state
});
```

### onFocus - Called when window gains focus

```javascript
PLUGIN_LIFECYCLE.onFocus(function() {
  // Resume updates
  // Focus input fields
});
```

### onBlur - Called when window loses focus

```javascript
PLUGIN_LIFECYCLE.onBlur(function() {
  // Pause updates
  // Save state
});
```

---

## Common Patterns

### Fetch Data from API

```javascript
PLUGIN_LIFECYCLE.onMount(async function() {
  try {
    const response = await fetch('https://api.example.com/data');
    const data = await response.json();

    const output = shadow.getElementById('output');
    output.textContent = JSON.stringify(data);
  } catch (error) {
    console.error('Fetch error:', error);
    const toast = PLUGIN_API.ui.toast();
    toast.show('Failed to load data', 'error');
  }
});
```

### Update UI Periodically

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const output = shadow.getElementById('output');

  // Tracked timer - auto-cleanup on unmount
  const timer = setInterval(() => {
    output.textContent = new Date().toLocaleTimeString();
  }, 1000);
});
```

### Create Settings Panel

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const container = shadow.querySelector('.settings-container');

  // Create settings item
  const item = PLUGIN_API.ui.settingsItem({
    label: 'Enable Feature',
    description: 'Turn on this cool feature'
  });

  // Create toggle control
  const toggle = PLUGIN_API.ui.toggle({
    active: true,
    onChange: (isActive) => {
      console.log('Feature:', isActive);
    }
  });

  // Assemble
  item.controlEl.appendChild(toggle);
  container.appendChild(item.container);
});
```

### Create Tabbed Interface

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const container = shadow.querySelector('.container');

  const tabs = PLUGIN_API.ui.tabs({
    items: [
      {
        id: 'tab1',
        label: 'Tab 1',
        content: '<div>Content 1</div>'
      },
      {
        id: 'tab2',
        label: 'Tab 2',
        content: '<div>Content 2</div>'
      }
    ],
    activeTab: 'tab1',
    onSwitch: (tabId) => {
      console.log('Switched to:', tabId);
    }
  });

  container.appendChild(tabs.el);
});
```

---

## Styling Your Plugin

### Add styles.css

```css
.my-plugin {
  padding: 20px;
  font-family: system-ui, sans-serif;
}

h1 {
  color: var(--tui-accent);
  margin-bottom: 20px;
}

button {
  margin: 10px 0;
}

#output {
  margin-top: 20px;
  padding: 10px;
  background: var(--tui-bg-secondary);
  border-radius: 4px;
}
```

### Use TermulUI CSS Variables

```css
/* Available variables */
--tui-accent           /* Accent color */
--tui-bg-primary       /* Primary background */
--tui-bg-secondary     /* Secondary background */
--tui-text-primary     /* Primary text */
--tui-text-secondary   /* Secondary text */
--tui-border           /* Border color */
--tui-radius           /* Border radius */
```

---

## Accessing SSH

```javascript
const api = PLUGIN_API;

if (api.connectionId) {
  // Execute command
  const result = await api.ssh.execute('ls -la');

  // Show output
  console.log(result.stdout);
  console.log(result.stderr);
  console.log(result.exitCode);
} else {
  const toast = PLUGIN_API.ui.toast();
  toast.show('Not connected', 'warning');
}
```

---

## Best Practices

### ✅ Do

- Use `PLUGIN_API.ui.*` components (auto-cleanup)
- Use tracked `addEventListener` (provided by sandbox)
- Use lifecycle hooks for initialization
- Handle errors with try-catch
- Use `shadow.getElementById()` for ID selection
- Cleanup custom resources in `onUnmount`

### ❌ Don't

- Don't use global `window.addEventListener` (won't be cleaned up)
- Don't use global `setTimeout` without tracking (won't be cleaned up)
- Don't access other plugin DOMs directly
- Don't modify global state
- Don't forget to cleanup WebSockets, Fetch, etc.

---

## Example: Complete Plugin

### manifest.json

```json
{
  "name": "SSH Commander",
  "description": "Execute SSH commands easily",
  "version": "1.0.0",
  "author": "You",
  "dirName": "ssh-commander",
  "window": {
    "width": 700,
    "height": 500
  }
}
```

### index.html

```html
<div class="ssh-commander">
  <div class="commander-toolbar">
    <input type="text" id="command-input" placeholder="Enter command..." />
    <button id="execute-btn">Execute</button>
  </div>
  <div class="commander-output">
    <pre id="output"></pre>
  </div>
</div>
```

### styles.css

```css
.ssh-commander {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
}

.commander-toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

#command-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--tui-border);
  border-radius: var(--tui-radius);
  background: var(--tui-bg-secondary);
  color: var(--tui-text-primary);
}

#execute-btn {
  padding: 8px 16px;
  background: var(--tui-accent);
  color: white;
  border: none;
  border-radius: var(--tui-radius);
  cursor: pointer;
}

.commander-output {
  flex: 1;
  overflow: auto;
  background: var(--tui-bg-secondary);
  border-radius: var(--tui-radius);
  padding: 15px;
}

#output {
  margin: 0;
  font-family: 'Consolas', monospace;
  font-size: 13px;
  color: var(--tui-text-primary);
}
```

### main.js

```javascript
PLUGIN_LIFECYCLE.onMount(function() {
  const api = PLUGIN_API;
  const input = shadow.getElementById('command-input');
  const button = shadow.getElementById('execute-btn');
  const output = shadow.getElementById('output');

  // Check connection
  if (!api.connectionId) {
    output.textContent = 'Not connected to SSH server';
    return;
  }

  // Execute command
  async function executeCommand() {
    const command = input.value.trim();
    if (!command) return;

    output.textContent = `> ${command}\nExecuting...`;

    try {
      const result = await api.ssh.execute(command);
      output.textContent = `> ${command}\n${result.stdout}`;

      if (result.stderr) {
        output.textContent += `\n[stderr]\n${result.stderr}`;
      }

      if (result.exitCode !== 0) {
        output.textContent += `\n[exit code: ${result.exitCode}]`;
      }
    } catch (error) {
      output.textContent = `> ${command}\nError: ${error.message}`;
    }
  }

  // Event listeners
  addEventListener(button, 'click', executeCommand);
  addEventListener(input, 'keydown', (e) => {
    if (e.key === 'Enter') executeCommand();
  });

  // Focus input
  input.focus();

  // Show connection info
  const toast = api.ui.toast();
  toast.show(`Connected to ${api.profile.host}`, 'success');
});
```

---

## Testing Your Plugin

### 1. Start TermulOS

```bash
npm start
```

### 2. Open DevTools

Press `F12` or `Ctrl+Shift+I`

### 3. Check Console for Errors

```javascript
// List all plugins
window.PluginLoader.getAll();

// Check if your plugin loaded
window.PluginLoader.get('my-plugin');
```

### 4. Test Lifecycle

- Open plugin window → `onMount` fires
- Focus/blur window → `onFocus`/`onBlur` fire
- Close window → `onUnmount` fires, cleanup runs

---

## Need Help?

- See full documentation: `PLUGIN_ARCHITECTURE.md`
- Check example plugins: `src/plugins/terminal/`, `src/plugins/settings/`
- API reference: See `PLUGIN_API` object in browser console

---

## Checklist

Before publishing your plugin:

- [ ] Manifest has all required fields
- [ ] Plugin loads without errors
- [ ] All resources cleaned up on unmount
- [ ] Works in multiple windows (multi-instance)
- [ ] Handles connection state correctly
- [ ] No console errors or warnings
- [ ] Tested on different screen sizes
- [ ] User-friendly error messages

---

## Next Steps

1. Explore the component library: `PLUGIN_API.ui.*`
2. Read the full architecture documentation
3. Check out example plugins
4. Build something awesome! 🚀

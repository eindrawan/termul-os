# TermulOS Reusable Components (TermulUI)

## Overview

TermulOS provides a shared UI component library called **TermulUI** — a set of CSS classes and JavaScript components that all plugins can use. They are injected into each plugin's Shadow DOM automatically and ensure visual consistency across the system.

---

## How Styles Are Injected

When a plugin mounts, styles are injected in this order (lowest to highest priority):

```
1. Shared TermulUI CSS    ← plugin-components.css (cached, shared across all plugins)
2. Plugin CSS             ← plugin's own style.css (can override shared styles)
```

This means plugin CSS can override any shared style if needed.

---

## CSS Classes Quick Reference

### Buttons

All buttons use the base class `tui-btn` plus a variant modifier.

```html
<!-- Base (transparent) -->
<button class="tui-btn">Button</button>

<!-- Primary (accent blue, for confirm/OK actions) -->
<button class="tui-btn tui-btn-primary">Install</button>

<!-- Default (subtle border, for cancel/secondary actions) -->
<button class="tui-btn tui-btn-default">Cancel</button>

<!-- Danger (red tint, for destructive actions) -->
<button class="tui-btn tui-btn-danger">Delete</button>

<!-- Ghost (no background, for toolbar actions) -->
<button class="tui-btn tui-btn-ghost">Refresh</button>

<!-- Accent (gradient, for highlighted actions) -->
<button class="tui-btn tui-btn-accent">Highlight</button>

<!-- Icon button (square, for small toolbar icons) -->
<button class="tui-btn-icon">
  <svg width="14" height="14">...</svg>
</button>
```

### Button Variants Reference

| Variant | Classes | Use For | Appearance |
|---------|---------|---------|------------|
| Primary | `tui-btn tui-btn-primary` | Confirm, OK, Install | Solid accent blue, white text |
| Default | `tui-btn tui-btn-default` | Cancel, secondary actions | Glass background, subtle border |
| Danger | `tui-btn tui-btn-danger` | Delete, Uninstall | Red tint background, red text |
| Ghost | `tui-btn tui-btn-ghost` | Toolbar actions, subtle buttons | Transparent, hover shows bg |
| Accent | `tui-btn tui-btn-accent` | Highlighted/call-to-action | Gradient (primary → secondary) |
| Icon | `tui-btn-icon` | Small square icon buttons | 32×32, transparent, hover shows bg |

### Disabled State

All button variants support the `disabled` attribute:

```html
<button class="tui-btn tui-btn-primary" disabled>Disabled</button>
```

This reduces opacity to 0.5 and sets `cursor: not-allowed`.

### Buttons with Icons

All `tui-btn` variants support inline SVG icons. Use `gap` spacing (built-in):

```html
<button class="tui-btn tui-btn-primary">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
  Install
</button>
```

### Modal-Specific Buttons

For dialog/modal footers, use the `tui-modal-btn` classes:

```html
<button class="tui-modal-btn tui-modal-btn-secondary">Cancel</button>
<button class="tui-modal-btn tui-modal-btn-primary">OK</button>
```

These have specific sizing (min-width: 80px, min-height: 30px) and Win11-style appearance.

---

## JavaScript Components

All JS components are accessed via `PLUGIN_API.ui.*` factory methods. They are automatically tracked and cleaned up when the plugin unmounts.

### Base Class: TuiComponent

Every component extends `TuiComponent`:

```javascript
class TuiComponent {
  shadow: ShadowRoot       // Plugin's shadow root
  opts: Object             // Component options
  el: HTMLElement          // Root DOM element
  state: Object            // Component state

  setState(partial)        // Merge state and re-render
  setTimeout(fn, ms)       // Tracked timeout (auto-cleaned)
  setInterval(fn, ms)      // Tracked interval (auto-cleaned)
  listen(target, event, fn) // Tracked listener (auto-cleaned)
  destroy()                // Full cleanup
}
```

---

### TuiModal — Dialog/Confirmation

Overlay dialogs with backdrop, keyboard dismiss, and focus trap.

```javascript
var api = PLUGIN_API;

// Alert dialog
var alert = api.ui.modal({
  title: 'Error',
  content: '<p class="tui-modal-message">Something went wrong.</p>',
  buttons: [
    { label: 'OK', variant: 'primary', onClick: function(m) { m.close(); } }
  ]
});
alert.open();

// Confirmation dialog
var confirm = api.ui.modal({
  title: 'Delete Item',
  content: '<p class="tui-modal-message">Are you sure?</p>',
  buttons: [
    { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
    { label: 'Confirm', variant: 'danger', onClick: function(m) { m.close(); doAction(); } }
  ]
});
confirm.open();

// Prompt dialog (with input)
var prompt = api.ui.modal({
  title: 'Enter Name',
  content: '<div class="tui-modal-message">Enter a name:</div><input class="tui-modal-input" id="my-input" />',
  buttons: [
    { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
    { label: 'OK', variant: 'primary', onClick: function(m) {
      var val = m.shadow.querySelector('#my-input').value;
      m.close();
      console.log('Value:', val);
    }}
  ]
});
prompt.open();
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | string | — | Modal header title |
| `content` | string | — | HTML content for the body |
| `buttons` | array | — | Array of `{ label, variant, onClick }` |
| `closeOnBackdrop` | boolean | `true` | Close when clicking backdrop |
| `closeOnEscape` | boolean | `true` | Close on Escape key |
| `onClose` | function | — | Called when modal closes |

#### Button Variants for Modals

| Variant | CSS Class | Use For |
|---------|-----------|---------|
| `'primary'` | `tui-btn-primary` | Confirm, OK |
| `'default'` | `tui-btn-default` | Cancel, secondary |
| `'danger'` | `tui-btn-danger` | Destructive confirm |

#### Methods

- `open()` — Show the modal (appends to shadow root)
- `close()` — Hide the modal (removes from shadow root)
- `setContent(html)` — Update body content

#### CSS Classes for Modal Content

```html
<!-- Message text -->
<p class="tui-modal-message">Your message here</p>

<!-- Input field inside modal -->
<input class="tui-modal-input" placeholder="Enter value..." />
```

---

### TuiToast — Notifications

Non-blocking toast notifications.

```javascript
var toast = api.ui.toast({
  position: 'bottom-right',    // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  defaultDuration: 4000         // Auto-dismiss time in ms
});

toast.show('Saved successfully', 'success');    // Green
toast.show('File not found', 'error');           // Red
toast.show('Processing...', 'info');             // Blue
toast.show('Warning: Low disk space', 'warning'); // Yellow
```

---

### TuiTabs — Tabbed Panel

Tabbed content container.

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

---

### TuiDataTable — Data Table

Sortable, selectable data table.

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
  onRowClick: function(row) { console.log('Clicked:', row); },
  onSelectionChange: function(rows) { console.log('Selected:', rows); },
  emptyText: 'No files found'
});
someContainer.appendChild(table.el);
```

---

### TuiDropdown — Context Menu

Dropdown/context menu component.

```javascript
var dropdown = api.ui.dropdown({
  items: [
    { label: 'Open', action: 'open' },
    { label: 'Edit', action: 'edit' },
    { type: 'separator' },
    { label: 'Delete', action: 'delete', danger: true }
  ],
  onSelect: function(action) {
    console.log('Selected:', action);
  }
});

// Show at position
dropdown.show(x, y);
```

---

### TuiAccordion — Expandable Sections

Collapsible content sections.

```javascript
var accordion = api.ui.accordion({
  items: [
    { id: 'section1', title: 'Section 1', content: '<p>Content here</p>' },
    { id: 'section2', title: 'Section 2', content: '<p>More content</p>' }
  ],
  multiple: false  // Allow multiple open sections
});
someContainer.appendChild(accordion.el);
```

---

### TuiSidebarNav — Sidebar Navigation

Vertical sidebar with navigation items (used in the Settings plugin).

```javascript
var sidebar = api.ui.sidebarNav({
  items: [
    { id: 'general', label: 'General', icon: '<svg>...</svg>' },
    { id: 'appearance', label: 'Appearance', icon: '<svg>...</svg>' },
    { id: 'about', label: 'About', icon: '<svg>...</svg>' }
  ],
  active: 'general',
  onSelect: function(id) {
    console.log('Selected:', id);
  }
});
someContainer.appendChild(sidebar.el);
```

---

### TuiRadioGroup — Radio Button Group

Group of mutually exclusive options.

```javascript
var radio = api.ui.radioGroup({
  name: 'theme',
  items: [
    { value: 'dark', label: 'Dark Theme' },
    { value: 'light', label: 'Light Theme' }
  ],
  value: 'dark',
  onChange: function(value) {
    console.log('Theme:', value);
  }
});
someContainer.appendChild(radio.el);
```

---

## Stateless Component Factories

These return plain DOM elements (no lifecycle, no tracking needed):

### button(opts)

```javascript
var btn = api.ui.button({
  label: 'Click Me',
  variant: 'primary',  // 'primary' | 'default' | 'danger' | 'ghost' | 'accent'
  icon: '<svg>...</svg>',
  onClick: function() { console.log('clicked'); }
});
```

### iconButton(opts)

```javascript
var btn = api.ui.iconButton({
  icon: '<svg>...</svg>',
  title: 'Close',
  onClick: function() { }
});
```

### toggle(opts)

```javascript
var toggle = api.ui.toggle({
  checked: false,
  label: 'Enable feature',
  onChange: function(checked) { }
});
```

### card(opts)

```javascript
var card = api.ui.card({
  title: 'Card Title',
  subtitle: 'Optional subtitle',
  content: '<p>Card body</p>',
  actions: '<button class="tui-btn tui-btn-primary">Action</button>'
});
```

### progressBar(opts)

```javascript
var progress = api.ui.progressBar({
  value: 75,
  max: 100,
  label: 'Uploading...',
  variant: 'default'  // 'default' | 'success' | 'error'
});
```

### status(opts)

```javascript
var status = api.ui.status({
  variant: 'success',  // 'success' | 'error' | 'warning' | 'info' | 'muted'
  text: 'Connected'
});
```

### select(opts)

```javascript
var select = api.ui.select({
  options: [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' }
  ],
  value: 'a',
  onChange: function(value) { }
});
```

### input(opts)

```javascript
var input = api.ui.input({
  placeholder: 'Enter text...',
  value: '',
  type: 'text',
  onChange: function(value) { }
});
```

### toolbar(opts)

```javascript
var toolbar = api.ui.toolbar({
  left: '<span class="title">My App</span>',
  right: '<button class="tui-btn tui-btn-ghost">Settings</button>'
});
```

### badge(opts)

```javascript
var badge = api.ui.badge({
  variant: 'info',  // 'info' | 'success' | 'warning' | 'error'
  text: '3'
});
```

### settingsItem(opts)

```javascript
var item = api.ui.settingsItem({
  title: 'Auto-save',
  description: 'Save files automatically',
  control: toggleElement
});
```

### emptyState(opts)

```javascript
var empty = api.ui.emptyState({
  icon: '<svg>...</svg>',
  title: 'No Items',
  description: 'Add some items to get started'
});
```

---

## CSS Utility Classes

### Scrollbar

```html
<div class="tui-scrollbar">...</div>
```

Custom styled scrollbar matching the dark theme.

### Spinner

```html
<div class="tui-spinner"></div>
```

Loading spinner (animated border ring).

### CSS Custom Properties (available in all plugins)

```css
/* Colors */
var(--tui-accent-primary)       /* Primary accent (#0078D4) */
var(--tui-accent-secondary)     /* Secondary accent (#60CDFF) */
var(--tui-accent-hover)         /* Accent hover state */

/* Backgrounds */
var(--tui-bg-surface)           /* Surface background (#0f0f0f) */
var(--tui-bg-glass)             /* Glass/transparent bg */
var(--tui-bg-hover)             /* Hover background */

/* Text */
var(--tui-text-primary)         /* Primary text (#e0e0e0) */
var(--tui-text-secondary)       /* Secondary text */
var(--tui-text-tertiary)        /* Tertiary/muted text */

/* Borders */
var(--tui-border-subtle)        /* Subtle border */
var(--tui-border-medium)        /* Medium border */

/* Spacing */
var(--tui-space-xs)             /* 4px */
var(--tui-space-sm)             /* 8px */
var(--tui-space-md)             /* 16px */
var(--tui-space-lg)             /* 24px */

/* Radius */
var(--tui-radius-sm)            /* 6px */
var(--tui-radius-md)            /* 10px */

/* Shadows */
var(--tui-shadow-sm)
var(--tui-shadow-md)
var(--tui-shadow-lg)

/* Transitions */
var(--tui-transition-fast)      /* 150ms ease */

/* Error */
var(--tui-error-text)           /* Error text color */
```

---

## Component File Structure

```
src/js/tui/
├── TuiComponent.js       # Base class
├── TuiModal.js           # Dialog component
├── TuiTabs.js            # Tabbed panel
├── TuiDataTable.js       # Data table
├── TuiDropdown.js        # Context menu
├── TuiToast.js           # Toast notifications
├── TuiAccordion.js       # Expandable sections
├── TuiSidebarNav.js      # Sidebar navigation
├── TuiRadioGroup.js      # Radio button group
└── index.js              # Exports all components

src/styles/
└── plugin-components.css # All shared CSS styles
```

---

## Best Practices

### Use Standard Button Variants

Always use `tui-btn` with a variant class — never create custom button styles:

```html
<!-- ✅ Correct -->
<button class="tui-btn tui-btn-primary">Install</button>
<button class="tui-btn tui-btn-default">Cancel</button>
<button class="tui-btn tui-btn-danger">Delete</button>
<button class="tui-btn tui-btn-ghost">Refresh</button>

<!-- ❌ Wrong — custom button classes break consistency -->
<button class="my-custom-btn">Install</button>
```

### Use TuiModal Instead of Native Dialogs

```javascript
// ✅ Correct — uses the component system
api.ui.modal({
  title: 'Confirm',
  content: '<p class="tui-modal-message">Are you sure?</p>',
  buttons: [
    { label: 'Cancel', variant: 'default', onClick: function(m) { m.close(); } },
    { label: 'Confirm', variant: 'danger', onClick: function(m) { m.close(); doIt(); } }
  ]
}).open();

// ❌ Wrong — native dialogs break the OS look
confirm('Are you sure?');
alert('Something happened');
```

### Use CSS Variables for Theming

```css
/* ✅ Correct — adapts to theme changes */
.my-element {
  background: var(--tui-bg-surface);
  color: var(--tui-text-primary);
  border: 1px solid var(--tui-border-subtle);
}

/* ❌ Wrong — hardcoded colors */
.my-element {
  background: #0f0f0f;
  color: #e0e0e0;
}
```

### Let the System Track Components

```javascript
// ✅ Correct — auto-tracked, auto-cleaned on unmount
var toast = api.ui.toast({ position: 'bottom-right' });
var modal = api.ui.modal({ title: 'Hello' });

// ❌ Wrong — manual DOM, no tracking
var div = document.createElement('div');
shadow.appendChild(div);
// Won't be cleaned up on unmount
```

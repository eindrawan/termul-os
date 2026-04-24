/**
 * TuiSidebarNav - Windows 11-style sidebar navigation.
 *
 * Features:
 *   - Optional search bar at the top
 *   - Navigation items with icon + label
 *   - Active item with pill-shaped highlight (Win11 Fluent Design)
 *   - Subtle hover states with smooth transitions
 *   - Section grouping with dividers
 *   - Dynamic item addition/removal
 *   - Active item change via setActive()
 *   - Auto-cleanup of all event listeners
 *
 * Usage (via PLUGIN_API.ui.sidebarNav):
 *   const nav = PLUGIN_API.ui.sidebarNav({
 *     items: [
 *       { id: 'general', label: 'General', icon: '<svg>...</svg>' },
 *       { id: 'appearance', label: 'Appearance', icon: '<svg>...</svg>' },
 *     ],
 *     activeItem: 'general',
 *     searchable: true,
 *     searchPlaceholder: 'Search settings...',
 *     onNavigate: (itemId) => { ... },
 *     onSearch: (query) => { ... }
 *   });
 *   shadow.querySelector('.my-sidebar').appendChild(nav.el);
 */

class TuiSidebarNav extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {Array<{id:string, label:string, icon?:string, section?:string}>} opts.items
   *   Navigation items. Items with different `section` values are separated by dividers.
   * @param {string} [opts.activeItem] - Initially active item id (defaults to first)
   * @param {boolean} [opts.searchable=false] - Show search input at top
   * @param {string} [opts.searchPlaceholder='Search...'] - Placeholder for search
   * @param {Function} [opts.onNavigate] - Called with (itemId) when an item is clicked
   * @param {Function} [opts.onSearch] - Called with (query) when search text changes
   * @param {number} [opts.width=240] - Sidebar width in pixels
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = {
      activeItem: opts.activeItem || (opts.items && opts.items[0] && opts.items[0].id) || null,
      searchQuery: ''
    };
    this._itemButtons = {};
    this._build();
  }

  _build() {
    const container = document.createElement('nav');
    container.className = 'tui-sidebar-nav';
    if (this.opts.width) {
      container.style.width = this.opts.width + 'px';
    }

    // Optional search bar
    if (this.opts.searchable) {
      const searchWrap = document.createElement('div');
      searchWrap.className = 'tui-sidebar-search';

      const searchIcon = document.createElement('div');
      searchIcon.className = 'tui-sidebar-search-icon';
      searchIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';

      const searchInput = document.createElement('input');
      searchInput.className = 'tui-sidebar-search-input';
      searchInput.type = 'text';
      searchInput.placeholder = this.opts.searchPlaceholder || 'Search...';
      this._searchInput = searchInput;

      this.listen(searchInput, 'input', () => {
        const query = searchInput.value.trim().toLowerCase();
        this.state.searchQuery = query;
        this._filterItems(query);
        if (this.opts.onSearch) {
          this.opts.onSearch(query);
        }
      });

      searchWrap.appendChild(searchIcon);
      searchWrap.appendChild(searchInput);
      container.appendChild(searchWrap);
    }

    // Items container (scrollable)
    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'tui-sidebar-items';
    this._itemsWrap = itemsWrap;

    this._buildItems(this.opts.items || []);

    container.appendChild(itemsWrap);
    this.el = container;
    this._updateActive();
  }

  /**
   * Build the navigation items, creating section dividers as needed.
   * @param {Array} items
   */
  _buildItems(items) {
    this._itemsWrap.innerHTML = '';
    this._itemButtons = {};

    let lastSection = null;

    for (const item of items) {
      // Section divider
      if (item.section && item.section !== lastSection) {
        if (lastSection !== null) {
          const divider = document.createElement('div');
          divider.className = 'tui-sidebar-divider';
          this._itemsWrap.appendChild(divider);
        }
        lastSection = item.section;

        if (item.sectionLabel) {
          const sectionLabel = document.createElement('div');
          sectionLabel.className = 'tui-sidebar-section-label';
          sectionLabel.textContent = item.sectionLabel;
          this._itemsWrap.appendChild(sectionLabel);
        }
      } else if (!item.section && lastSection !== null) {
        lastSection = null;
      }

      const btn = document.createElement('button');
      btn.className = 'tui-sidebar-item';
      btn.dataset.itemId = item.id;

      if (item.icon) {
        const iconWrap = document.createElement('span');
        iconWrap.className = 'tui-sidebar-item-icon';
        iconWrap.innerHTML = item.icon;
        btn.appendChild(iconWrap);
      }

      const label = document.createElement('span');
      label.className = 'tui-sidebar-item-label';
      label.textContent = item.label;
      btn.appendChild(label);

      this.listen(btn, 'click', () => {
        this.setActive(item.id);
        if (this.opts.onNavigate) {
          this.opts.onNavigate(item.id);
        }
      });

      this._itemsWrap.appendChild(btn);
      this._itemButtons[item.id] = btn;
    }
  }

  /**
   * Filter visible items based on search query.
   * @param {string} query
   */
  _filterItems(query) {
    const items = this.opts.items || [];
    for (const item of items) {
      const btn = this._itemButtons[item.id];
      if (!btn) continue;
      if (!query) {
        btn.style.display = '';
        continue;
      }
      const match = item.label.toLowerCase().includes(query);
      btn.style.display = match ? '' : 'none';
    }

    // Hide empty dividers and section labels
    const children = Array.from(this._itemsWrap.children);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.classList.contains('tui-sidebar-divider') || child.classList.contains('tui-sidebar-section-label')) {
        // Show if next visible sibling is an item
        let nextVisible = false;
        for (let j = i + 1; j < children.length; j++) {
          const next = children[j];
          if (next.classList.contains('tui-sidebar-item')) {
            if (next.style.display !== 'none') {
              nextVisible = true;
            }
          } else if (next.classList.contains('tui-sidebar-divider')) {
            break;
          }
        }
        child.style.display = nextVisible ? '' : 'none';
      }
    }
  }

  /**
   * Update active state classes.
   */
  _updateActive() {
    const activeId = this.state.activeItem;
    for (const [id, btn] of Object.entries(this._itemButtons)) {
      btn.classList.toggle('active', id === activeId);
    }
  }

  /**
   * Set the active navigation item.
   * @param {string} itemId
   */
  setActive(itemId) {
    if (this.state.activeItem === itemId) return;
    this.state.activeItem = itemId;
    this._updateActive();
  }

  /**
   * Get the currently active item id.
   * @returns {string|null}
   */
  getActive() {
    return this.state.activeItem;
  }

  /**
   * Dynamically add a navigation item.
   * @param {Object} item - { id, label, icon?, section?, sectionLabel? }
   * @param {number} [index] - Position to insert at (defaults to end)
   */
  addItem(item, index) {
    if (this._itemButtons[item.id]) return; // already exists
    this.opts.items = this.opts.items || [];
    if (typeof index === 'number') {
      this.opts.items.splice(index, 0, item);
    } else {
      this.opts.items.push(item);
    }
    // Rebuild items to handle sections correctly
    this._buildItems(this.opts.items);
    this._updateActive();
    // Re-apply search filter
    if (this.state.searchQuery) {
      this._filterItems(this.state.searchQuery);
    }
  }

  /**
   * Remove a navigation item by id.
   * @param {string} itemId
   */
  removeItem(itemId) {
    if (!this._itemButtons[itemId]) return;
    this.opts.items = (this.opts.items || []).filter(i => i.id !== itemId);
    if (this.state.activeItem === itemId) {
      this.state.activeItem = this.opts.items.length > 0 ? this.opts.items[0].id : null;
    }
    this._buildItems(this.opts.items);
    this._updateActive();
    if (this.state.searchQuery) {
      this._filterItems(this.state.searchQuery);
    }
  }

  /**
   * Focus the search input (if searchable).
   */
  focusSearch() {
    if (this._searchInput) {
      this._searchInput.focus();
    }
  }

  render() {
    this._updateActive();
  }

  _onDestroy() {
    this._itemButtons = {};
    this._searchInput = null;
  }
}

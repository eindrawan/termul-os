/**
 * TuiTabs - Tabbed panels with active state and keyboard navigation.
 *
 * Features:
 *   - Multiple tab panels with switching
 *   - Active state management
 *   - onSwitch callback when tab changes
 *   - Dynamic tab addition via addTab()
 *   - Access individual panels via getPanel()
 */

class TuiTabs extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {Array<{id:string, label:string, content:string}>} opts.items - Tab definitions
   * @param {string} [opts.activeTab] - Initial active tab id (defaults to first)
   * @param {Function} [opts.onSwitch] - Called with (tabId) when tab changes
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = {
      activeTab: opts.activeTab || (opts.items && opts.items[0] && opts.items[0].id) || null
    };
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.className = 'tui-tabs';

    const tabBar = document.createElement('div');
    tabBar.className = 'tui-tabs-bar';
    this._tabButtons = {};

    for (const item of (this.opts.items || [])) {
      const btn = document.createElement('button');
      btn.className = 'tui-tabs-btn';
      btn.textContent = item.label;
      btn.dataset.tabId = item.id;
      this.listen(btn, 'click', () => this.switchTo(item.id));
      tabBar.appendChild(btn);
      this._tabButtons[item.id] = btn;
    }
    container.appendChild(tabBar);

    const panelContainer = document.createElement('div');
    panelContainer.className = 'tui-tabs-panels';
    this._panels = {};

    for (const item of (this.opts.items || [])) {
      const panel = document.createElement('div');
      panel.className = 'tui-tabs-panel';
      panel.dataset.tabId = item.id;
      if (item.content) panel.innerHTML = item.content;
      panelContainer.appendChild(panel);
      this._panels[item.id] = panel;
    }
    container.appendChild(panelContainer);

    this.el = container;
    this._updateActive();
  }

  _updateActive() {
    const activeId = this.state.activeTab;
    for (const [id, btn] of Object.entries(this._tabButtons)) {
      btn.classList.toggle('active', id === activeId);
    }
    for (const [id, panel] of Object.entries(this._panels)) {
      panel.classList.toggle('active', id === activeId);
    }
  }

  switchTo(tabId) {
    if (this.state.activeTab === tabId) return;
    this.state.activeTab = tabId;
    this._updateActive();
    if (this.opts.onSwitch) this.opts.onSwitch(tabId);
  }

  /** Get the panel DOM element for a given tab id */
  getPanel(tabId) {
    return this._panels[tabId] || null;
  }

  /** Dynamically add a tab */
  addTab(item) {
    if (this._tabButtons[item.id]) return; // already exists

    const btn = document.createElement('button');
    btn.className = 'tui-tabs-btn';
    btn.textContent = item.label;
    btn.dataset.tabId = item.id;
    this.listen(btn, 'click', () => this.switchTo(item.id));
    this.el.querySelector('.tui-tabs-bar').appendChild(btn);
    this._tabButtons[item.id] = btn;

    const panel = document.createElement('div');
    panel.className = 'tui-tabs-panel';
    panel.dataset.tabId = item.id;
    if (item.content) panel.innerHTML = item.content;
    this.el.querySelector('.tui-tabs-panels').appendChild(panel);
    this._panels[item.id] = panel;

    this._updateActive();
  }

  render() {
    this._updateActive();
  }
}

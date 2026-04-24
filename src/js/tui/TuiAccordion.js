/**
 * TuiAccordion - Collapsible sections with optional single-open mode.
 *
 * Features:
 *   - Multiple collapsible sections
 *   - Single-open mode (only one section open at a time)
 *   - Multiple-open mode (allow multiple sections open)
 *   - onToggle callback for state changes
 *   - Programmatic open/close via index
 *   - Access section body for dynamic content
 */

class TuiAccordion extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {Array<{title:string, content:string, open?:boolean}>} opts.items
   * @param {boolean} [opts.multiple=false] - Allow multiple sections open at once
   * @param {Function} [opts.onToggle] - Called with (itemIndex, isOpen)
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = {
      openItems: new Set(
        (opts.items || [])
          .map((item, i) => item.open ? i : -1)
          .filter(i => i >= 0)
      )
    };
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.className = 'tui-accordion';
    this._sections = [];

    for (let i = 0; i < (this.opts.items || []).length; i++) {
      const item = this.opts.items[i];
      const section = document.createElement('div');
      section.className = 'tui-accordion-section';
      if (this.state.openItems.has(i)) section.classList.add('tui-accordion-open');

      const header = document.createElement('button');
      header.className = 'tui-accordion-header';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = item.title;
      header.appendChild(titleSpan);
      const arrow = document.createElement('span');
      arrow.className = 'tui-accordion-arrow';
      arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
      header.appendChild(arrow);

      const idx = i;
      this.listen(header, 'click', () => this.toggle(idx));

      const body = document.createElement('div');
      body.className = 'tui-accordion-body';
      if (item.content) body.innerHTML = item.content;

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
      this._sections.push({ section, body });
    }

    this.el = container;
  }

  toggle(index) {
    if (this.state.openItems.has(index)) {
      this.state.openItems.delete(index);
    } else {
      // Close others if single mode
      if (!this.opts.multiple) {
        this.state.openItems.clear();
      }
      this.state.openItems.add(index);
    }
    this._updateVisual();
    if (this.opts.onToggle) {
      this.opts.onToggle(index, this.state.openItems.has(index));
    }
  }

  _updateVisual() {
    for (let i = 0; i < this._sections.length; i++) {
      this._sections[i].section.classList.toggle('tui-accordion-open', this.state.openItems.has(i));
    }
  }

  /** Open a specific section by index */
  open(index) {
    if (!this.opts.multiple) this.state.openItems.clear();
    this.state.openItems.add(index);
    this._updateVisual();
  }

  /** Close a specific section by index */
  close(index) {
    this.state.openItems.delete(index);
    this._updateVisual();
  }

  /** Get the body element of a section for dynamic content */
  getBody(index) {
    return this._sections[index] ? this._sections[index].body : null;
  }

  render() {
    this._updateVisual();
  }
}

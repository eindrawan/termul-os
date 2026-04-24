/**
 * TuiDropdown - Positioned context menus triggered by an anchor element.
 *
 * Features:
 *   - Positioning relative to trigger element (auto-flip if near viewport edge)
 *   - Menu items with icons and variants
 *   - Separators between items
 *   - Auto-close on click outside or Escape key
 *   - Close on item click (configurable)
 *   - Windows 11 Fluent Design styling with glassmorphism
 */

class TuiDropdown extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {HTMLElement} opts.trigger - Element to position relative to
   * @param {Array<{label:string, icon?:string, variant?:string, onClick?:Function, separator?:boolean}>} opts.items
   * @param {boolean} [opts.closeOnClick=true] - Close menu after item click
   * @param {'bottom-start'|'bottom-end'|'top-start'|'top-end'} [opts.placement='bottom-start'] - Preferred placement
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = { open: false };
    this._build();
  }

  _build() {
    const menu = document.createElement('div');
    menu.className = 'tui-dropdown';
    menu.setAttribute('role', 'menu');

    for (const item of (this.opts.items || [])) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'tui-dropdown-separator';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'tui-dropdown-item';
      if (item.variant) btn.classList.add('tui-dropdown-item-' + item.variant);
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('tabindex', '-1');
      if (item.icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'tui-dropdown-icon';
        iconSpan.innerHTML = item.icon;
        btn.appendChild(iconSpan);
      }
      const labelSpan = document.createElement('span');
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);

      if (item.onClick) {
        this.listen(btn, 'click', () => {
          item.onClick();
          if (this.opts.closeOnClick !== false) this.close();
        });
      }
      menu.appendChild(btn);
    }

    this.el = menu;

    // Close on click outside
    this.listen(this.shadow.ownerDocument || document, 'mousedown', (e) => {
      if (this.state.open && !this.el.contains(e.target) && e.target !== this.opts.trigger) {
        this.close();
      }
    });

    // Close on Escape
    this.listen(this.shadow.ownerDocument || document, 'keydown', (e) => {
      if (e.key === 'Escape' && this.state.open) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  open() {
    if (this.state.open) return;
    this.state.open = true;
    this.el.classList.add('tui-dropdown-open');
    this.shadow.appendChild(this.el);

    // Position relative to trigger
    if (this.opts.trigger) {
      this._position();
    }
  }

  /**
   * Position the dropdown relative to the trigger element,
   * auto-flipping if the dropdown would overflow the viewport.
   */
  _position() {
    const trigger = this.opts.trigger;
    const triggerRect = trigger.getBoundingClientRect();
    const hostRect = this.shadow.host.getBoundingClientRect();
    const menuRect = this.el.getBoundingClientRect();
    const placement = this.opts.placement || 'bottom-start';

    const gap = 4;
    const relTop = triggerRect.top - hostRect.top;
    const relBottom = triggerRect.bottom - hostRect.top;
    const relLeft = triggerRect.left - hostRect.left;
    const relRight = triggerRect.right - hostRect.left;

    // Determine vertical placement
    let placeAbove = placement.startsWith('top');
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    if (!placeAbove && menuRect.height > spaceBelow && spaceAbove > spaceBelow) {
      placeAbove = true;
    } else if (placeAbove && menuRect.height > spaceAbove && spaceBelow > spaceAbove) {
      placeAbove = false;
    }

    // Determine horizontal alignment
    let alignEnd = placement.endsWith('end');
    const spaceRight = window.innerWidth - triggerRect.left;
    const spaceLeft = triggerRect.right;
    if (!alignEnd && menuRect.width > spaceRight && spaceLeft > spaceRight) {
      alignEnd = true;
    } else if (alignEnd && menuRect.width > spaceLeft && spaceRight > spaceLeft) {
      alignEnd = false;
    }

    if (placeAbove) {
      this.el.style.top = (relTop - menuRect.height - gap) + 'px';
      this.el.style.transformOrigin = 'bottom left';
    } else {
      this.el.style.top = (relBottom + gap) + 'px';
      this.el.style.transformOrigin = 'top left';
    }

    if (alignEnd) {
      this.el.style.left = (relRight - menuRect.width) + 'px';
    } else {
      this.el.style.left = relLeft + 'px';
    }
  }

  close() {
    if (!this.state.open) return;
    this.state.open = false;
    this.el.classList.remove('tui-dropdown-open');
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  toggle() {
    if (this.state.open) this.close();
    else this.open();
  }

  _onDestroy() {
    this.close();
  }
}

/**
 * TuiModal - Overlay dialogs with backdrop, keyboard dismiss, and focus trap.
 *
 * Features:
 *   - Backdrop overlay with click-to-close
 *   - Escape key to close
 *   - Customizable title, content, and buttons
 *   - Close button in header
 *   - onClose callback when modal closes
 */

class TuiModal extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {string} [opts.title] - Modal title
   * @param {string} [opts.content] - HTML content for the body
   * @param {Array<{label:string,variant?:string,onClick?:Function}>} [opts.buttons]
   * @param {boolean} [opts.closeOnBackdrop=true] - Close when clicking backdrop
   * @param {boolean} [opts.closeOnEscape=true] - Close on Escape key
   * @param {Function} [opts.onClose] - Called when modal closes
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = { open: false };
    this._build();
  }

  _build() {
    const backdrop = document.createElement('div');
    backdrop.className = 'tui-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const dialog = document.createElement('div');
    dialog.className = 'tui-modal';

    // Header
    if (this.opts.title) {
      const header = document.createElement('div');
      header.className = 'tui-modal-header';
      const title = document.createElement('h3');
      title.className = 'tui-modal-title';
      title.textContent = this.opts.title;
      header.appendChild(title);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tui-btn-icon tui-modal-close';
      closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5"/></svg>';
      closeBtn.title = 'Close';
      this.listen(closeBtn, 'click', () => this.close());
      header.appendChild(closeBtn);
      dialog.appendChild(header);
    }

    // Body
    const body = document.createElement('div');
    body.className = 'tui-modal-body';
    if (this.opts.content) body.innerHTML = this.opts.content;
    dialog.appendChild(body);
    this._bodyEl = body;

    // Footer / Buttons
    if (this.opts.buttons && this.opts.buttons.length > 0) {
      const footer = document.createElement('div');
      footer.className = 'tui-modal-footer';
      for (const btnOpts of this.opts.buttons) {
        const btn = document.createElement('button');
        btn.className = 'tui-btn';
        btn.classList.add('tui-btn-' + (btnOpts.variant || 'default'));
        btn.textContent = btnOpts.label || 'OK';
        if (btnOpts.onClick) {
          this.listen(btn, 'click', () => btnOpts.onClick(this));
        }
        footer.appendChild(btn);
      }
      dialog.appendChild(footer);
    }

    backdrop.appendChild(dialog);
    this.el = backdrop;
    this._dialog = dialog;

    // Backdrop click
    if (this.opts.closeOnBackdrop !== false) {
      this.listen(backdrop, 'click', (e) => {
        if (e.target === backdrop) this.close();
      });
    }

    // Escape key
    if (this.opts.closeOnEscape !== false) {
      this.listen(this.shadow.ownerDocument || document, 'keydown', (e) => {
        if (e.key === 'Escape' && this.state.open) this.close();
      });
    }
  }

  open() {
    this.state.open = true;
    this.el.classList.add('tui-modal-open');
    // Append to shadow root so it overlays everything
    this.shadow.appendChild(this.el);
  }

  close() {
    this.state.open = false;
    this.el.classList.remove('tui-modal-open');
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    if (this.opts.onClose) this.opts.onClose();
  }

  /** Update the body content */
  setContent(html) {
    if (this._bodyEl) this._bodyEl.innerHTML = html;
  }
}

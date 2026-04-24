/**
 * TuiToast - Stacked, auto-dismissing notifications.
 *
 * Features:
 *   - Multiple position options (top/bottom left/right)
 *   - Auto-dismiss with configurable duration
 *   - Multiple variants (success, error, warning, info)
 *   - Stacking with max visible limit
 *   - Manual close button
 *   - Individual toast dismissal via ID
 */

class TuiToast extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {string} [opts.position='bottom-right'] - 'top-right'|'top-left'|'bottom-right'|'bottom-left'
   * @param {number} [opts.defaultDuration=4000] - Default auto-dismiss ms
   * @param {number} [opts.maxVisible=5] - Max toasts visible at once
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = { toasts: [] };
    this._counter = 0;
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.className = 'tui-toast-container';
    container.classList.add('tui-toast-' + (this.opts.position || 'bottom-right'));
    this.el = container;

    // Append to shadow immediately so toasts have a place to go
    this.shadow.appendChild(this.el);
  }

  /**
   * Show a toast notification.
   * @param {string} message - Text to display
   * @param {string} [variant='info'] - 'success'|'error'|'warning'|'info'
   * @param {number} [duration] - Override auto-dismiss duration (0 = manual close)
   * @returns {number} toast id
   */
  show(message, variant = 'info', duration) {
    const id = ++this._counter;
    const dur = duration !== undefined ? duration : (this.opts.defaultDuration || 4000);

    const toast = document.createElement('div');
    toast.className = 'tui-toast tui-toast-' + variant;
    toast.dataset.toastId = id;

    const iconMap = {
      success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
      error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    const iconEl = document.createElement('span');
    iconEl.className = 'tui-toast-icon';
    iconEl.innerHTML = iconMap[variant] || iconMap.info;
    toast.appendChild(iconEl);

    const msgEl = document.createElement('span');
    msgEl.className = 'tui-toast-message';
    msgEl.textContent = message;
    toast.appendChild(msgEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tui-toast-close';
    closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5"/></svg>';
    this.listen(closeBtn, 'click', () => this.dismiss(id));
    toast.appendChild(closeBtn);

    this.el.appendChild(toast);

    // Auto-dismiss
    if (dur > 0) {
      this.setTimeout(() => this.dismiss(id), dur);
    }

    // Enforce max visible
    const maxVisible = this.opts.maxVisible || 5;
    while (this.el.children.length > maxVisible) {
      this.el.removeChild(this.el.firstChild);
    }

    // Animate in
    requestAnimationFrame(() => toast.classList.add('tui-toast-visible'));

    return id;
  }

  /** Dismiss a specific toast by id */
  dismiss(id) {
    const toast = this.el.querySelector('[data-toast-id="' + id + '"]');
    if (toast) {
      toast.classList.add('tui-toast-exit');
      this.setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }
  }

  /** Dismiss all toasts */
  dismissAll() {
    this.el.innerHTML = '';
  }

  _onDestroy() {
    this.dismissAll();
  }
}

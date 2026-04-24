/**
 * TuiComponent - Base class for all TermulUI components.
 *
 * Provides:
 *   - State management (setState)
 *   - Tracked timers (setTimeout, setInterval) - auto-cleanup on destroy
 *   - Tracked event listeners - auto-cleanup on destroy
 *   - Destroy lifecycle with cleanup hooks
 *
 * All component classes extend this base class.
 */

class TuiComponent {
  /**
   * @param {ShadowRoot} shadow - The plugin's shadow root
   * @param {Object} opts - Component-specific options
   */
  constructor(shadow, opts = {}) {
    this.shadow = shadow;
    this.opts = opts;
    this.el = null;
    this.state = {};
    this._destroyed = false;
    this._timers = new Set();
    this._intervals = new Set();
    this._listeners = [];
    this._id = 'tui_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  }

  /**
   * Merge partial state and re-render.
   * @param {Object} partial
   */
  setState(partial) {
    Object.assign(this.state, partial);
    if (typeof this.render === 'function') this.render();
  }

  /** Tracked setTimeout — auto-cleaned on destroy */
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.add(id);
    return id;
  }

  /** Tracked setInterval — auto-cleaned on destroy */
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervals.add(id);
    return id;
  }

  /** Tracked addEventListener — auto-cleaned on destroy */
  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this._listeners.push({ target, event, handler, options });
    return handler;
  }

  /** Full cleanup — removes DOM, clears timers, detaches listeners */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Allow subclass cleanup
    if (typeof this._onDestroy === 'function') this._onDestroy();

    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    for (const id of this._intervals) clearInterval(id);
    this._intervals.clear();
    for (const { target, event, handler, options } of this._listeners) {
      target.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}

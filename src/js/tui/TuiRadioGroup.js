/**
 * TuiRadioGroup - Shareable radio button group component.
 *
 * Features:
 *   - Custom-styled radio buttons matching the TermulOS glassmorphism theme
 *   - Horizontal or vertical layout
 *   - Proper centering with flex-shrink and transform-based dot positioning
 *   - Change event callback
 *   - Programmatic value getter/setter
 *   - Supports disabled state per option
 *
 * Usage via PLUGIN_API.ui:
 *   const radio = PLUGIN_API.ui.radioGroup({
 *     name: 'authType',
 *     options: [
 *       { value: 'password', label: 'Password' },
 *       { value: 'key', label: 'Private Key' },
 *     ],
 *     value: 'password',
 *     onChange: (value) => { ... },
 *   });
 *   shadow.appendChild(radio.el);
 */

class TuiRadioGroup extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {string} opts.name - Radio group name (required for native grouping)
   * @param {Array<{value: string, label: string, disabled?: boolean}>} opts.options
   * @param {string} [opts.value] - Initially selected value
   * @param {'horizontal'|'vertical'} [opts.direction='horizontal'] - Layout direction
   * @param {Function} [opts.onChange] - Called with (value) when selection changes
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = {
      value: opts.value || (opts.options && opts.options.length > 0 ? opts.options[0].value : ''),
    };
    this._build();
  }

  _build() {
    const container = document.createElement('div');
    container.className = 'tui-radio-group';
    if (this.opts.direction === 'vertical') {
      container.classList.add('tui-radio-group-vertical');
    }
    this.el = container;

    const name = this.opts.name || ('tui-radio-' + this._id);

    if (this.opts.options) {
      for (const opt of this.opts.options) {
        const label = document.createElement('label');
        label.className = 'tui-radio';
        if (opt.disabled) {
          label.classList.add('tui-radio-disabled');
        }

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = name;
        input.value = opt.value;
        input.className = 'tui-radio-input';
        if (this.state.value === opt.value) {
          input.checked = true;
        }
        if (opt.disabled) {
          input.disabled = true;
        }

        const labelText = document.createElement('span');
        labelText.className = 'tui-radio-label';
        labelText.textContent = opt.label;

        label.appendChild(input);
        label.appendChild(labelText);

        this.listen(input, 'change', () => {
          this.setState({ value: input.value });
          if (typeof this.opts.onChange === 'function') {
            this.opts.onChange(input.value);
          }
        });

        container.appendChild(label);
      }
    }
  }

  /**
   * Get the currently selected value.
   * @returns {string}
   */
  getValue() {
    return this.state.value;
  }

  /**
   * Programmatically set the selected value.
   * @param {string} value
   */
  setValue(value) {
    if (this.state.value === value) return;
    this.setState({ value: value });

    // Update DOM
    if (this.el) {
      const inputs = this.el.querySelectorAll('.tui-radio-input');
      for (const input of inputs) {
        input.checked = (input.value === value);
      }
    }

    if (typeof this.opts.onChange === 'function') {
      this.opts.onChange(value);
    }
  }

  /**
   * Enable or disable a specific option by value.
   * @param {string} value
   * @param {boolean} disabled
   */
  setDisabled(value, disabled) {
    if (!this.el) return;
    const inputs = this.el.querySelectorAll('.tui-radio-input');
    for (const input of inputs) {
      if (input.value === value) {
        input.disabled = disabled;
        const label = input.closest('.tui-radio');
        if (label) {
          label.classList.toggle('tui-radio-disabled', disabled);
        }
      }
    }
  }

  _onDestroy() {
    // DOM cleanup is handled by base class
  }
}

/**
 * TuiDataTable - Column-based data grid with sorting and row selection.
 *
 * Features:
 *   - Column-based layout with sortable headers
 *   - Row selection (single or multiple via checkboxes)
 *   - Custom cell renderers
 *   - Sortable columns with indicators
 *   - Empty state handling
 *   - onRowClick and onSelectionChange callbacks
 */

class TuiDataTable extends TuiComponent {
  /**
   * @param {ShadowRoot} shadow
   * @param {Object} opts
   * @param {Array<{key:string, label:string, sortable?:boolean, render?:Function}>} opts.columns
   * @param {Array<Object>} [opts.data] - Row data (array of objects)
   * @param {boolean} [opts.selectable=false] - Show row checkboxes
   * @param {Function} [opts.onRowClick] - Called with (rowData, rowIndex)
   * @param {Function} [opts.onSelectionChange] - Called with (selectedRows[])
   * @param {string} [opts.emptyText] - Text when no data
   */
  constructor(shadow, opts = {}) {
    super(shadow, opts);
    this.state = {
      data: opts.data || [],
      sortKey: null,
      sortDir: 'asc',
      selectedRows: new Set()
    };
    this._build();
    this._renderRows();
  }

  _build() {
    const container = document.createElement('div');
    container.className = 'tui-table-container';

    const table = document.createElement('table');
    table.className = 'tui-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    if (this.opts.selectable) {
      const th = document.createElement('th');
      th.className = 'tui-table-th tui-table-check';
      const checkAll = document.createElement('input');
      checkAll.type = 'checkbox';
      checkAll.className = 'tui-table-checkbox';
      this.listen(checkAll, 'change', () => this._toggleAll(checkAll.checked));
      th.appendChild(checkAll);
      this._checkAll = checkAll;
      headerRow.appendChild(th);
    }

    this._headerCells = {};
    for (const col of (this.opts.columns || [])) {
      const th = document.createElement('th');
      th.className = 'tui-table-th';
      if (col.sortable) {
        th.classList.add('tui-table-sortable');
        this.listen(th, 'click', () => this._sort(col.key));
      }
      th.textContent = col.label;
      headerRow.appendChild(th);
      this._headerCells[col.key] = th;
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    tbody.className = 'tui-table-body';
    table.appendChild(tbody);
    this._tbody = tbody;

    container.appendChild(table);
    this.el = container;
  }

  _sort(key) {
    if (this.state.sortKey === key) {
      this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.state.sortKey = key;
      this.state.sortDir = 'asc';
    }
    this._renderRows();
  }

  _getSortedData() {
    let data = [...this.state.data];
    if (this.state.sortKey) {
      data.sort((a, b) => {
        const aVal = a[this.state.sortKey];
        const bVal = b[this.state.sortKey];
        let cmp = 0;
        if (aVal < bVal) cmp = -1;
        else if (aVal > bVal) cmp = 1;
        return this.state.sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return data;
  }

  _renderRows() {
    this._tbody.innerHTML = '';
    const data = this._getSortedData();

    // Update sort indicators on headers
    for (const [key, th] of Object.entries(this._headerCells)) {
      th.classList.remove('tui-table-sort-asc', 'tui-table-sort-desc');
      if (key === this.state.sortKey) {
        th.classList.add(this.state.sortDir === 'asc' ? 'tui-table-sort-asc' : 'tui-table-sort-desc');
      }
    }

    if (data.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'tui-table-empty';
      td.colSpan = (this.opts.columns ? this.opts.columns.length : 1) + (this.opts.selectable ? 1 : 0);
      td.textContent = this.opts.emptyText || 'No data';
      tr.appendChild(td);
      this._tbody.appendChild(tr);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const tr = document.createElement('tr');
      tr.className = 'tui-table-row';

      if (this.opts.selectable) {
        const td = document.createElement('td');
        td.className = 'tui-table-td tui-table-check';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'tui-table-checkbox';
        checkbox.checked = this.state.selectedRows.has(i);
        const idx = i;
        this.listen(checkbox, 'change', () => this._toggleRow(idx, checkbox.checked));
        td.appendChild(checkbox);
        tr.appendChild(td);
      }

      for (const col of (this.opts.columns || [])) {
        const td = document.createElement('td');
        td.className = 'tui-table-td';
        const val = row[col.key];
        if (col.render) {
          td.innerHTML = col.render(val, row, i);
        } else {
          td.textContent = val !== undefined && val !== null ? String(val) : '';
        }
        tr.appendChild(td);
      }

      if (this.opts.onRowClick) {
        tr.classList.add('tui-table-clickable');
        const rowData = row;
        const rowIdx = i;
        this.listen(tr, 'click', (e) => {
          if (e.target.classList.contains('tui-table-checkbox')) return;
          this.opts.onRowClick(rowData, rowIdx);
        });
      }

      this._tbody.appendChild(tr);
    }
  }

  _toggleRow(idx, checked) {
    if (checked) this.state.selectedRows.add(idx);
    else this.state.selectedRows.delete(idx);
    if (this.opts.onSelectionChange) {
      const selected = this._getSortedData().filter((_, i) => this.state.selectedRows.has(i));
      this.opts.onSelectionChange(selected);
    }
  }

  _toggleAll(checked) {
    if (checked) {
      for (let i = 0; i < this.state.data.length; i++) this.state.selectedRows.add(i);
    } else {
      this.state.selectedRows.clear();
    }
    this._renderRows();
    if (this.opts.onSelectionChange) {
      const selected = checked ? [...this.state.data] : [];
      this.opts.onSelectionChange(selected);
    }
  }

  /** Replace all data and re-render */
  setData(data) {
    this.state.data = data || [];
    this.state.selectedRows.clear();
    this._renderRows();
  }

  /** Get currently selected row data */
  getSelected() {
    return this._getSortedData().filter((_, i) => this.state.selectedRows.has(i));
  }

  render() {
    this._renderRows();
  }
}

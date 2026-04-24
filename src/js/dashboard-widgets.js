/**
 * DashboardWidgets - Remote server system information panel
 * Displays CPU, RAM, Storage, Network, and System uptime from the SSH-connected server
 */
class DashboardWidgets {
  constructor() {
    this.element = null;
    this.refreshInterval = null;
    this.refreshRate = 4000; // 4 seconds
    this.collapsed = false;
    this.cpuHistory = [];
    this.maxHistoryLength = 30;
    this.connectionId = null;
    this.connected = false;
    this._prevCpuStat = null; // previous /proc/stat first line for CPU % delta
  }

  /**
   * Initialize the dashboard widgets and insert into the desktop
   */
  init() {
    this.element = document.getElementById('dashboard-widgets');
    if (!this.element) return;

    this.render();
    this.setupConnectionListener();

    // Collapse toggle
    this.element.addEventListener('click', (e) => {
      if (e.target.closest('.dashboard-collapse-btn')) {
        this.toggleCollapse();
      }
    });
  }

  /**
   * Listen for connection status changes and tab switches to start/stop refreshing
   */
  setupConnectionListener() {
    document.addEventListener('termul:connection-status', (e) => {
      const detail = e.detail;
      if (detail.status === 'connected') {
        this.connectionId = detail.connectionId;
        this.connected = true;
        this._prevCpuStat = null;
        this.cpuHistory = [];
        this.startRefresh();
        this.setStatusLive();
      } else if (detail.status === 'disconnected') {
        this.connected = false;
        this.stopRefresh();
        this.setStatusDisconnected();
      } else if (detail.status === 'reconnecting') {
        this.connected = false;
        this.stopRefresh();
        this.setStatusReconnecting();
      }
    });

    // Follow the active tab when the user switches connections
    document.addEventListener('termul:tab-switched', (e) => {
      const detail = e.detail;
      if (detail.status === 'connected' && detail.connectionId !== this.connectionId) {
        this.connectionId = detail.connectionId;
        this.connected = true;
        this._prevCpuStat = null;
        this.cpuHistory = [];
        this.startRefresh();
        this.setStatusLive();
      } else if (detail.status === 'disconnected') {
        this.connected = false;
        this.stopRefresh();
        this.setStatusDisconnected();
      } else if (detail.status === 'reconnecting') {
        this.connected = false;
        this.stopRefresh();
        this.setStatusReconnecting();
      }
    });
  }

  /**
   * Render the widget HTML
   */
  render() {
    if (!this.element) return;

    this.element.innerHTML = `
      <div class="dashboard-header">
        <span class="dashboard-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          Server
        </span>
        <div class="dashboard-status" id="dashboard-status">
          <span class="dashboard-status-dot"></span>
          <span class="dashboard-status-text">Waiting</span>
        </div>
        <button class="dashboard-collapse-btn" title="Toggle panel">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="4,2 8,6 4,10"/>
          </svg>
        </button>
      </div>
      <div class="dashboard-body">
        <!-- Host Widget -->
        <div class="dashboard-widget dashboard-widget-host" id="widget-host">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                <line x1="6" y1="6" x2="6.01" y2="6"/>
                <line x1="6" y1="18" x2="6.01" y2="18"/>
              </svg>
            </div>
            <span class="widget-label">Host</span>
            <span class="widget-value" id="host-value">--</span>
          </div>
          <div class="widget-detail" id="host-detail">--</div>
        </div>

        <!-- CPU Widget -->
        <div class="dashboard-widget" id="widget-cpu">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
                <rect x="9" y="9" width="6" height="6"/>
                <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
                <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
                <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
                <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
              </svg>
            </div>
            <span class="widget-label">CPU</span>
            <span class="widget-value" id="cpu-value">--</span>
          </div>
          <div class="widget-mini-chart" id="cpu-chart"></div>
          <div class="widget-detail" id="cpu-detail">--</div>
        </div>

        <!-- Memory Widget -->
        <div class="dashboard-widget" id="widget-memory">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </div>
            <span class="widget-label">RAM</span>
            <span class="widget-value" id="memory-value">--</span>
          </div>
          <div class="widget-bar">
            <div class="widget-bar-fill" id="memory-bar" style="width: 0%"></div>
          </div>
          <div class="widget-detail" id="memory-detail">-- / --</div>
        </div>

        <!-- Disk Widget -->
        <div class="dashboard-widget" id="widget-disk">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              </svg>
            </div>
            <span class="widget-label">Storage</span>
            <span class="widget-value" id="disk-value">--</span>
          </div>
          <div class="widget-bar">
            <div class="widget-bar-fill" id="disk-bar" style="width: 0%"></div>
          </div>
          <div class="widget-detail" id="disk-detail">--</div>
        </div>

        <!-- Network Widget -->
        <div class="dashboard-widget" id="widget-network">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                <line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
            </div>
            <span class="widget-label">Network</span>
            <span class="widget-value" id="network-value">--</span>
          </div>
          <div class="widget-detail" id="network-detail">--</div>
        </div>

        <!-- Uptime Widget -->
        <div class="dashboard-widget" id="widget-uptime">
          <div class="widget-header">
            <div class="widget-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <span class="widget-label">Uptime</span>
            <span class="widget-value" id="uptime-value">--</span>
          </div>
          <div class="widget-detail" id="uptime-detail">--</div>
        </div>
      </div>
    `;
  }

  /* ── Status indicators ──────────────────────────────────────────── */

  setStatusLive() {
    const el = document.getElementById('dashboard-status');
    if (!el) return;
    el.className = 'dashboard-status live';
    el.innerHTML = '<span class="dashboard-status-dot"></span><span class="dashboard-status-text">Live</span>';
  }

  setStatusDisconnected() {
    const el = document.getElementById('dashboard-status');
    if (!el) return;
    el.className = 'dashboard-status disconnected';
    el.innerHTML = '<span class="dashboard-status-dot"></span><span class="dashboard-status-text">Offline</span>';
  }

  setStatusReconnecting() {
    const el = document.getElementById('dashboard-status');
    if (!el) return;
    el.className = 'dashboard-status reconnecting';
    el.innerHTML = '<span class="dashboard-status-dot"></span><span class="dashboard-status-text">Reconnecting</span>';
  }

  /* ── Refresh lifecycle ──────────────────────────────────────────── */

  startRefresh() {
    this.stopRefresh();
    this.refresh();
    this.refreshInterval = setInterval(() => this.refresh(), this.refreshRate);
  }

  stopRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Fetch remote system stats via SSH exec and update all widgets.
   * Uses a single batched command to minimize SSH round-trips.
   */
  async refresh() {
    if (!this.connected || !this.connectionId) return;

    // Batched command: key=value output for reliable parsing
    const cmd = [
      'echo "HOSTNAME=$(hostname)"',
      'echo "UNAME=$(uname -srm)"',
      'echo "CPU_CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"',
      // /proc/stat first line for CPU usage delta
      'echo "CPU_STAT=$(head -1 /proc/stat)"',
      // Memory in kB from /proc/meminfo
      'echo "MEM_TOTAL=$(grep MemTotal /proc/meminfo | awk \'{print $2}\')"',
      'echo "MEM_AVAIL=$(grep MemAvailable /proc/meminfo | awk \'{print $2}\')"',
      // Disk usage in 1K-blocks
      'echo "DISK=$(df -B1 / 2>/dev/null | tail -1 | awk \'{print $2":"$3":"$4}\')"',
      // Uptime in seconds
      'echo "UPTIME=$(cat /proc/uptime | awk \'{print int($1)}\')"',
      // Load average
      'echo "LOAD=$(cat /proc/loadavg | awk \'{print $1","$2","$3}\')"',
      // IP addresses (space-separated IPv4)
      'echo "IPS=$(hostname -I 2>/dev/null || echo \'\')"',
    ].join('; ');

    try {
      const result = await window.termulAPI.ssh.exec(this.connectionId, cmd);
      if (result && result.success && result.stdout) {
        const data = this.parseOutput(result.stdout);
        this.updateWidgets(data);
      }
    } catch (err) {
      // Silently ignore — will retry next cycle
    }
  }

  /**
   * Parse key=value output from the batched SSH command.
   */
  parseOutput(stdout) {
    const map = {};
    const lines = stdout.split('\n');
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        map[key] = val;
      }
    }
    return map;
  }

  /* ── Widget updaters ────────────────────────────────────────────── */

  updateWidgets(data) {
    this.updateHost(data);
    this.updateCpu(data);
    this.updateMemory(data);
    this.updateDisk(data);
    this.updateNetwork(data);
    this.updateUptime(data);
  }

  updateHost(data) {
    const valueEl = document.getElementById('host-value');
    const detailEl = document.getElementById('host-detail');
    if (!valueEl) return;

    const hostname = data.HOSTNAME || '--';
    valueEl.textContent = hostname;

    if (detailEl && data.UNAME) {
      detailEl.textContent = data.UNAME;
    }
  }

  updateCpu(data) {
    const valueEl = document.getElementById('cpu-value');
    const detailEl = document.getElementById('cpu-detail');
    const chartEl = document.getElementById('cpu-chart');
    if (!valueEl) return;

    // Calculate CPU % from /proc/stat delta
    let usage = 0;
    const statLine = data.CPU_STAT;
    if (statLine) {
      usage = this.calculateCpuDelta(statLine);
    }

    valueEl.textContent = usage + '%';
    if (usage > 80) {
      valueEl.className = 'widget-value danger';
    } else if (usage > 60) {
      valueEl.className = 'widget-value warning';
    } else {
      valueEl.className = 'widget-value';
    }

    const cores = data.CPU_CORES || '--';
    const loadParts = (data.LOAD || '').split(',');
    if (detailEl) {
      detailEl.textContent = cores + ' cores';
      if (loadParts.length >= 3) {
        detailEl.textContent += ' \u00B7 load ' + loadParts.map(function(l) { return parseFloat(l).toFixed(1); }).join('/');
      }
    }

    // Push to sparkline history
    if (usage > 0) {
      this.cpuHistory.push(usage);
      if (this.cpuHistory.length > this.maxHistoryLength) {
        this.cpuHistory.shift();
      }
    }
    this.renderMiniChart(chartEl);
  }

  /**
   * Calculate CPU usage % from two consecutive /proc/stat readings.
   * Format: cpu  user nice system idle iowait irq softirq steal guest guest_nice
   */
  calculateCpuDelta(statLine) {
    const parts = statLine.split(/\s+/);
    if (parts.length < 5) return 0;

    // Skip "cpu" prefix
    const vals = parts.slice(1).map(function(v) { return parseInt(v, 10) || 0; });
    const idle = vals[3] + (vals[4] || 0); // idle + iowait
    const total = vals.reduce(function(a, b) { return a + b; }, 0);

    if (this._prevCpuStat) {
      const idleDiff = idle - this._prevCpuStat.idle;
      const totalDiff = total - this._prevCpuStat.total;
      this._prevCpuStat = { idle: idle, total: total };
      if (totalDiff > 0) {
        return Math.round((1 - idleDiff / totalDiff) * 100);
      }
    }

    this._prevCpuStat = { idle: idle, total: total };
    return 0;
  }

  /**
   * Render a simple SVG sparkline chart for CPU usage
   */
  renderMiniChart(container) {
    if (!container || this.cpuHistory.length < 2) return;

    const width = 100;
    const height = 28;
    const points = this.cpuHistory;
    const step = width / (this.maxHistoryLength - 1);

    let pathD = '';
    let areaD = '';

    for (let i = 0; i < points.length; i++) {
      const x = i * step;
      const y = height - (points[i] / 100) * height;
      if (i === 0) {
        pathD += 'M' + x + ' ' + y;
        areaD += 'M' + x + ' ' + height + ' L' + x + ' ' + y;
      } else {
        pathD += ' L' + x + ' ' + y;
        areaD += ' L' + x + ' ' + y;
      }
    }

    const lastX = (points.length - 1) * step;
    areaD += ' L' + lastX + ' ' + height + ' Z';

    container.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" class="cpu-sparkline">' +
      '<defs>' +
      '<linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#60CDFF" stop-opacity="0.3"/>' +
      '<stop offset="100%" stop-color="#60CDFF" stop-opacity="0.02"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<path d="' + areaD + '" fill="url(#cpuGrad)"/>' +
      '<path d="' + pathD + '" fill="none" stroke="#60CDFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  updateMemory(data) {
    const valueEl = document.getElementById('memory-value');
    const barEl = document.getElementById('memory-bar');
    const detailEl = document.getElementById('memory-detail');
    if (!valueEl) return;

    const totalKB = parseInt(data.MEM_TOTAL, 10) || 0;
    const availKB = parseInt(data.MEM_AVAIL, 10) || 0;
    const usedKB = totalKB - availKB;
    const percent = totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0;

    valueEl.textContent = percent + '%';
    if (percent > 80) {
      valueEl.className = 'widget-value danger';
    } else if (percent > 60) {
      valueEl.className = 'widget-value warning';
    } else {
      valueEl.className = 'widget-value';
    }

    if (barEl) {
      barEl.style.width = percent + '%';
      barEl.className = 'widget-bar-fill';
      if (percent > 80) barEl.classList.add('danger');
      else if (percent > 60) barEl.classList.add('warning');
    }

    if (detailEl) {
      const usedGB = this.formatKB(usedKB);
      const totalGB = this.formatKB(totalKB);
      detailEl.textContent = usedGB + ' / ' + totalGB;
    }
  }

  updateDisk(data) {
    const valueEl = document.getElementById('disk-value');
    const barEl = document.getElementById('disk-bar');
    const detailEl = document.getElementById('disk-detail');
    if (!valueEl) return;

    const diskParts = (data.DISK || '').split(':');
    const totalBytes = parseInt(diskParts[0], 10) || 0;
    const usedBytes = parseInt(diskParts[1], 10) || 0;
    const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    valueEl.textContent = percent + '%';
    if (percent > 90) {
      valueEl.className = 'widget-value danger';
    } else if (percent > 75) {
      valueEl.className = 'widget-value warning';
    } else {
      valueEl.className = 'widget-value';
    }

    if (barEl) {
      barEl.style.width = percent + '%';
      barEl.className = 'widget-bar-fill';
      if (percent > 90) barEl.classList.add('danger');
      else if (percent > 75) barEl.classList.add('warning');
    }

    if (detailEl) {
      const usedGB = this.formatBytes(usedBytes);
      const totalGB = this.formatBytes(totalBytes);
      detailEl.textContent = usedGB + ' / ' + totalGB;
    }
  }

  updateNetwork(data) {
    const valueEl = document.getElementById('network-value');
    const detailEl = document.getElementById('network-detail');
    if (!valueEl) return;

    const ips = (data.IPS || '').trim().split(/\s+/).filter(Boolean);
    if (ips.length > 0) {
      valueEl.textContent = ips.length + ' IP' + (ips.length > 1 ? 's' : '');
      valueEl.className = 'widget-value';
      if (detailEl) {
        detailEl.innerHTML = ips.map(function(ip) {
          return '<span class="network-iface">' + ip + '</span>';
        }).join('');
      }
    } else {
      valueEl.textContent = 'N/A';
      valueEl.className = 'widget-value';
      if (detailEl) {
        detailEl.textContent = 'No interfaces detected';
      }
    }
  }

  updateUptime(data) {
    const uptimeEl = document.getElementById('uptime-value');
    const detailEl = document.getElementById('uptime-detail');
    if (!uptimeEl) return;

    const seconds = parseInt(data.UPTIME, 10) || 0;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
      uptimeEl.textContent = days + 'd ' + hours + 'h';
    } else {
      uptimeEl.textContent = hours + 'h ' + minutes + 'm';
    }

    if (detailEl) {
      const loadParts = (data.LOAD || '').split(',');
      if (loadParts.length >= 3) {
        detailEl.textContent = 'Load: ' + loadParts.map(function(l) { return parseFloat(l).toFixed(2); }).join(' / ');
      }
    }
  }

  /* ── Utilities ──────────────────────────────────────────────────── */

  toggleCollapse() {
    this.collapsed = !this.collapsed;
    if (this.collapsed) {
      this.element.classList.add('collapsed');
    } else {
      this.element.classList.remove('collapsed');
    }
  }

  formatBytes(bytes) {
    if (bytes <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    var value = bytes / Math.pow(1024, i);
    if (i >= 3) {
      return value.toFixed(1) + ' ' + units[i];
    }
    return Math.round(value) + ' ' + units[i];
  }

  formatKB(kb) {
    return this.formatBytes(kb * 1024);
  }

  destroy() {
    this.stopRefresh();
    this._prevCpuStat = null;
    this.cpuHistory = [];
    this.connected = false;
    this.connectionId = null;
  }
}

// Export as singleton
window.DashboardWidgets = new DashboardWidgets();

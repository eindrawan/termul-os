// System Monitor Plugin (v2 lifecycle API)
// Fetches real system metrics from the remote server via SSH exec
(function() {
  const api = PLUGIN_API;

  // State
  let refreshInterval = null;
  let prevCpuStat = null;

  // Elements
  let statusEl, cpuValueEl, cpuBarEl, cpuCoresEl;
  let memoryValueEl, memoryBarEl, memoryTotalEl, memoryAvailableValueEl;
  let loadAvgEl, diskValueEl, diskBarEl, diskMountEl, diskAvailableValueEl;
  let connectedHostEl;

  PLUGIN_LIFECYCLE.onMount(function() {
    statusEl = shadow.getElementById('monitor-status');
    cpuValueEl = shadow.getElementById('cpu-value');
    cpuBarEl = shadow.getElementById('cpu-bar');
    cpuCoresEl = shadow.getElementById('cpu-cores');
    memoryValueEl = shadow.getElementById('memory-value');
    memoryBarEl = shadow.getElementById('memory-bar');
    memoryTotalEl = shadow.getElementById('memory-total');
    memoryAvailableValueEl = shadow.getElementById('memory-available-value');
    loadAvgEl = shadow.getElementById('load-avg');
    diskValueEl = shadow.getElementById('disk-value');
    diskBarEl = shadow.getElementById('disk-bar');
    diskMountEl = shadow.getElementById('disk-mount');
    diskAvailableValueEl = shadow.getElementById('disk-available-value');
    connectedHostEl = shadow.getElementById('connected-host');

    // Set connected host
    const profile = api.profile;
    if (connectedHostEl && profile) {
      connectedHostEl.textContent = profile.username + '@' + profile.host;
    }

    startMonitoring();
  });

  PLUGIN_LIFECYCLE.onUnmount(function() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  });

  async function startMonitoring() {
    if (!api.connectionId) {
      showError('No active connection');
      return;
    }

    // Initial fetch
    await fetchRemoteData();

    // Start periodic refresh every 4 seconds
    refreshInterval = setInterval(async () => {
      await fetchRemoteData();
    }, 4000);
  }

  /**
   * Fetch remote system stats via a single batched SSH command.
   * Output format: KEY=value for reliable parsing.
   */
  async function fetchRemoteData() {
    var connectionId = api.connectionId;
    if (!connectionId) {
      showError('No active connection');
      return;
    }

    setRefreshing(true);

    var cmd = [
      'echo "CPU_CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"',
      'echo "CPU_STAT=$(head -1 /proc/stat)"',
      'echo "MEM_TOTAL=$(grep MemTotal /proc/meminfo | awk \'{print $2}\')"',
      'echo "MEM_AVAIL=$(grep MemAvailable /proc/meminfo | awk \'{print $2}\')"',
      'echo "DISK=$(df -B1 / 2>/dev/null | tail -1 | awk \'{print $2":"$3":"$4}\')"',
      'echo "LOAD=$(cat /proc/loadavg | awk \'{print $1","$2","$3}\')"',
      'echo "UPTIME=$(cat /proc/uptime | awk \'{print int($1)}\')"',
    ].join('; ');

    try {
      var result = await api.ssh.exec(connectionId, cmd);
      if (result && result.success && result.stdout) {
        var data = parseOutput(result.stdout);
        updateDisplay(data);
        setRefreshing(false);
      } else {
        showError('Command failed');
      }
    } catch (err) {
      showError('Fetch error: ' + (err.message || err));
    }
  }

  /**
   * Parse key=value lines from SSH output.
   */
  function parseOutput(stdout) {
    var map = {};
    var lines = stdout.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var idx = line.indexOf('=');
      if (idx > 0) {
        var key = line.substring(0, idx).trim();
        var val = line.substring(idx + 1).trim();
        map[key] = val;
      }
    }
    return map;
  }

  /**
   * Update all UI elements with parsed remote data.
   */
  function updateDisplay(data) {
    // CPU
    var cores = data.CPU_CORES || '--';
    var cpuUsage = 0;
    var statLine = data.CPU_STAT;
    if (statLine) {
      cpuUsage = calculateCpuDelta(statLine);
    }

    if (cpuCoresEl) cpuCoresEl.textContent = cores + ' cores';
    if (cpuValueEl) cpuValueEl.textContent = cpuUsage + '%';
    if (cpuBarEl) {
      cpuBarEl.style.width = cpuUsage + '%';
      setBarColor(cpuBarEl, cpuUsage);
    }

    // Memory
    var totalKB = parseInt(data.MEM_TOTAL, 10) || 0;
    var availKB = parseInt(data.MEM_AVAIL, 10) || 0;
    var usedKB = totalKB - availKB;
    var memPercent = totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0;

    if (memoryValueEl) memoryValueEl.textContent = memPercent + '%';
    if (memoryBarEl) {
      memoryBarEl.style.width = memPercent + '%';
      setBarColor(memoryBarEl, memPercent);
    }
    if (memoryTotalEl) {
      var usedGB = formatKB(usedKB);
      var totalGB = formatKB(totalKB);
      memoryTotalEl.textContent = usedGB + ' / ' + totalGB;
    }
    if (memoryAvailableValueEl) {
      memoryAvailableValueEl.textContent = availKB > 0 ? formatKB(availKB) : '--';
    }

    // Load Average
    if (loadAvgEl) {
      var loadParts = (data.LOAD || '').split(',');
      if (loadParts.length >= 3) {
        loadAvgEl.textContent = loadParts.map(function(l) { return parseFloat(l).toFixed(2); }).join(' / ');
      } else {
        loadAvgEl.textContent = '--';
      }
    }

    // Disk
    var diskParts = (data.DISK || '').split(':');
    var diskTotalBytes = parseInt(diskParts[0], 10) || 0;
    var diskUsedBytes = parseInt(diskParts[1], 10) || 0;
    var diskAvailBytes = parseInt(diskParts[2], 10) || 0;
    if (diskTotalBytes > 0) {
      var diskPercent = Math.round((diskUsedBytes / diskTotalBytes) * 100);
      if (diskValueEl) diskValueEl.textContent = diskPercent + '%';
      if (diskBarEl) {
        diskBarEl.style.width = diskPercent + '%';
        setBarColor(diskBarEl, diskPercent);
      }
      if (diskMountEl) {
        diskMountEl.textContent = formatBytes(diskUsedBytes) + ' / ' + formatBytes(diskTotalBytes);
      }
      if (diskAvailableValueEl) {
        diskAvailableValueEl.textContent = diskAvailBytes > 0 ? formatBytes(diskAvailBytes) : '--';
      }
    }
  }

  /**
   * Calculate CPU usage % from consecutive /proc/stat readings.
   * Format: cpu  user nice system idle iowait irq softirq steal guest guest_nice
   */
  function calculateCpuDelta(statLine) {
    var parts = statLine.split(/\s+/);
    if (parts.length < 5) return 0;

    // Skip "cpu" prefix
    var vals = parts.slice(1);
    var idle = (parseInt(vals[3], 10) || 0) + (parseInt(vals[4], 10) || 0);
    var total = 0;
    for (var i = 0; i < vals.length; i++) {
      total += parseInt(vals[i], 10) || 0;
    }

    if (prevCpuStat) {
      var idleDiff = idle - prevCpuStat.idle;
      var totalDiff = total - prevCpuStat.total;
      prevCpuStat = { idle: idle, total: total };
      if (totalDiff > 0) {
        return Math.round((1 - idleDiff / totalDiff) * 100);
      }
    }

    prevCpuStat = { idle: idle, total: total };
    return 0;
  }

  function setBarColor(barEl, value) {
    barEl.classList.remove('high', 'medium');
    if (value > 80) barEl.classList.add('high');
    else if (value > 60) barEl.classList.add('medium');
  }

  function setRefreshing(refreshing) {
    if (!statusEl) return;
    var dot = statusEl.querySelector('.tui-status-dot');
    var textEl = statusEl.querySelector('.status-text');
    if (dot) {
      if (refreshing) {
        dot.classList.add('success', 'pulse');
      } else {
        dot.classList.remove('pulse');
      }
    }
    if (textEl) textEl.textContent = refreshing ? 'Refreshing...' : 'Live';
  }

  function showError(message) {
    if (!statusEl) return;
    var dot = statusEl.querySelector('.tui-status-dot');
    var textEl = statusEl.querySelector('.status-text');
    if (dot) {
      dot.classList.remove('success', 'pulse');
      dot.classList.add('error');
    }
    if (textEl) textEl.textContent = message;
  }

  function formatBytes(bytes) {
    if (bytes <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    var value = bytes / Math.pow(1024, i);
    if (i >= 3) {
      return value.toFixed(1) + ' ' + units[i];
    }
    return Math.round(value) + ' ' + units[i];
  }

  function formatKB(kb) {
    return formatBytes(kb * 1024);
  }
})();

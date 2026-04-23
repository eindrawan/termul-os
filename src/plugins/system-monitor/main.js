// System Monitor Plugin (v2 lifecycle API)
(function() {
  const api = PLUGIN_API;

  // State
  let refreshInterval = null;

  // Elements
  let statusEl, cpuValueEl, cpuBarEl, cpuCoresEl;
  let memoryValueEl, memoryBarEl, memoryTotalEl;
  let loadAvgEl, diskValueEl, diskBarEl, diskMountEl;
  let connectedHostEl;

  PLUGIN_LIFECYCLE.onMount(function() {
    statusEl = shadow.getElementById('monitor-status');
    cpuValueEl = shadow.getElementById('cpu-value');
    cpuBarEl = shadow.getElementById('cpu-bar');
    cpuCoresEl = shadow.getElementById('cpu-cores');
    memoryValueEl = shadow.getElementById('memory-value');
    memoryBarEl = shadow.getElementById('memory-bar');
    memoryTotalEl = shadow.getElementById('memory-total');
    loadAvgEl = shadow.getElementById('load-avg');
    diskValueEl = shadow.getElementById('disk-value');
    diskBarEl = shadow.getElementById('disk-bar');
    diskMountEl = shadow.getElementById('disk-mount');
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

    setRefreshing(true);
    loadMockData();

    // Start periodic refresh
    refreshInterval = setInterval(() => {
      setRefreshing(true);
      loadMockData();
      setTimeout(() => setRefreshing(false), 500);
    }, 5000);
  }

  function loadMockData() {
    const data = {
      cores: 8,
      cpuUsage: Math.floor(Math.random() * 40) + 20,
      memoryTotal: 16384,
      memoryUsed: Math.floor(Math.random() * 8000) + 4000,
      memoryPercent: Math.floor(Math.random() * 30) + 30,
      loadAvg: [0.5, 0.8, 0.6],
      diskTotal: 500,
      diskUsed: Math.floor(Math.random() * 200) + 100,
    };

    // CPU
    if (cpuCoresEl) cpuCoresEl.textContent = data.cores + ' cores';
    if (cpuValueEl) cpuValueEl.textContent = data.cpuUsage + '%';
    if (cpuBarEl) {
      cpuBarEl.style.width = data.cpuUsage + '%';
      setBarColor(cpuBarEl, data.cpuUsage);
    }

    // Memory
    if (memoryTotalEl) {
      const totalGB = (data.memoryTotal / 1024).toFixed(1);
      const usedGB = (data.memoryUsed / 1024).toFixed(1);
      memoryTotalEl.textContent = usedGB + 'GB / ' + totalGB + 'GB';
    }
    if (memoryValueEl) memoryValueEl.textContent = data.memoryPercent + '%';
    if (memoryBarEl) {
      memoryBarEl.style.width = data.memoryPercent + '%';
      setBarColor(memoryBarEl, data.memoryPercent);
    }

    // Load Average
    if (loadAvgEl) {
      loadAvgEl.textContent = data.loadAvg.map(l => l.toFixed(2)).join(' / ');
    }

    // Disk
    if (data.diskTotal) {
      const usedPercent = Math.round((data.diskUsed / data.diskTotal) * 100);
      if (diskValueEl) diskValueEl.textContent = usedPercent + '%';
      if (diskBarEl) {
        diskBarEl.style.width = usedPercent + '%';
        setBarColor(diskBarEl, usedPercent);
      }
      if (diskMountEl) diskMountEl.textContent = data.diskUsed + 'GB / ' + data.diskTotal + 'GB';
    }
  }

  function setBarColor(barEl, value) {
    barEl.classList.remove('high', 'medium');
    if (value > 80) barEl.classList.add('high');
    else if (value > 60) barEl.classList.add('medium');
  }

  function setRefreshing(refreshing) {
    if (!statusEl) return;
    const dot = statusEl.querySelector('.tui-status-dot');
    const textEl = statusEl.querySelector('.status-text');
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
    const dot = statusEl.querySelector('.tui-status-dot');
    const textEl = statusEl.querySelector('.status-text');
    if (dot) {
      dot.classList.remove('success', 'pulse');
      dot.classList.add('error');
    }
    if (textEl) textEl.textContent = message;
  }
})();

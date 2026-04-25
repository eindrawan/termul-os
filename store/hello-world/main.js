// Hello World Plugin — A simple demo plugin from the TermulOS Store
(function() {
  var api = PLUGIN_API;
  var counter = 0;
  var clockInterval = null;

  PLUGIN_LIFECYCLE.onMount(function() {
    var counterEl = shadow.getElementById('hw-counter');
    var decBtn = shadow.getElementById('hw-dec');
    var incBtn = shadow.getElementById('hw-inc');
    var timeEl = shadow.getElementById('hw-time');

    // Counter controls
    if (decBtn) {
      addEventListener(decBtn, 'click', function() {
        counter--;
        if (counterEl) counterEl.textContent = counter;
      });
    }

    if (incBtn) {
      addEventListener(incBtn, 'click', function() {
        counter++;
        if (counterEl) counterEl.textContent = counter;
      });
    }

    // Live clock
    function updateTime() {
      if (timeEl) {
        var now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
      }
    }
    updateTime();
    clockInterval = setInterval(updateTime, 1000);
  });

  PLUGIN_LIFECYCLE.onUnmount(function() {
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
  });
})();

// ANDROID sidebar tab — status/start/stop chrome around the canvas that
// android-view-client.js paints (frames come from src/android/frame-stream.js
// polling adb server-side; this file never talks to adb directly, only the
// HTTP control routes in src/routes/settings/android.ts).
(function () {
  'use strict';

  var POLL_MS = 3000;
  var pollTimer = null;
  var viewDetach = null;
  var currentSerial = null;

  function setStatus(text) {
    var el = document.getElementById('android-status');
    if (el) el.textContent = text;
  }

  function setButtons(running) {
    var startBtn = document.getElementById('android-start-btn');
    var stopBtn = document.getElementById('android-stop-btn');
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  async function refreshStatus() {
    try {
      var res = await fetch('/api/android/devices');
      var data = await res.json();
      var device = (data.devices || []).find(function (d) { return d.state === 'device'; });
      if (device) {
        currentSerial = device.serial;
        setStatus(device.model ? device.serial + ' (' + device.model + ')' : device.serial);
        setButtons(true);
      } else {
        currentSerial = null;
        setStatus('No device connected.');
        setButtons(false);
      }
    } catch (e) {
      setStatus('Status check failed: ' + e.message);
    }
  }

  async function start() {
    setStatus('Starting emulator (first boot can take a minute)...');
    document.getElementById('android-start-btn').disabled = true;
    try {
      var res = await fetch('/api/android/emulator/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      var data = await res.json();
      if (!data.ok) { setStatus('Failed to start: ' + data.error); document.getElementById('android-start-btn').disabled = false; return; }
      currentSerial = data.serial;
      await refreshStatus();
    } catch (e) {
      setStatus('Failed to start: ' + e.message);
      document.getElementById('android-start-btn').disabled = false;
    }
  }

  async function stop() {
    if (!currentSerial) return;
    setStatus('Stopping...');
    try {
      await fetch('/api/android/emulator/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial: currentSerial }),
      });
    } finally {
      await refreshStatus();
    }
  }

  function key(name) {
    if (!currentSerial) return;
    fetch('/api/android/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial: currentSerial, key: name }),
    }).catch(function () {});
  }

  function onTabShown() {
    if (!viewDetach && typeof attachAndroidView === 'function') {
      viewDetach = attachAndroidView(document.getElementById('android-view-canvas'));
    }
    refreshStatus();
    if (!pollTimer) pollTimer = setInterval(refreshStatus, POLL_MS);
  }

  function onTabHidden() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  window.laxAndroidTab = { onTabShown: onTabShown, onTabHidden: onTabHidden, start: start, stop: stop, key: key };
})();

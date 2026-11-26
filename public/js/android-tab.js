// ANDROID sidebar tab — status/start/stop chrome around the canvas that
// android-view-client.js paints (frames come from src/android/frame-stream.ts
// polling adb server-side; this file never talks to adb directly, only the
// HTTP control routes in src/routes/settings/android.ts).
//
// The tab shows one device: the one an agent is driving when there is one,
// else the first connected. While it is open its status poll names that device
// (?view=), which is what keeps the device's feed running server-side, so a
// phone over USB shows the same as an emulator this app booted. And the tab
// opens itself the first time the agent of the chat on screen uses the
// `android` tool, the way the Browser tab does for a page.
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

  // Stop kills an emulator; a phone is not ours to switch off.
  function setButtons(serial) {
    var startBtn = document.getElementById('android-start-btn');
    var stopBtn = document.getElementById('android-stop-btn');
    if (startBtn) startBtn.disabled = !!serial;
    if (stopBtn) stopBtn.disabled = !serial || serial.indexOf('emulator-') !== 0;
  }

  // The device an agent holds is the one worth watching.
  function deviceToShow(devices) {
    var ready = (devices || []).filter(function (d) { return d.state === 'device'; });
    return ready.filter(function (d) { return d.heldBy; })[0] || ready[0] || null;
  }

  function devicesUrl(serial) {
    return '/api/android/devices' + (serial ? '?view=' + encodeURIComponent(serial) : '');
  }

  // One chat's agent drives a device at a time (src/android/device-hold.ts):
  // say whose it is, so a second chat's "device is busy" has an answer.
  function holderLabel(heldBy) {
    if (!heldBy || !heldBy.sessionId) return '';
    var here = '';
    try { here = (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { here = ''; }
    return heldBy.sessionId === here ? ' · this chat’s agent is using it' : ' · in use by ' + heldBy.title;
  }

  async function refreshStatus() {
    try {
      var asked = currentSerial;
      var res = await fetch(devicesUrl(asked));
      var data = await res.json();
      var device = deviceToShow(data.devices);
      if (device) {
        currentSerial = device.serial;
        setStatus((device.model ? device.serial + ' (' + device.model + ')' : device.serial) + holderLabel(device.heldBy));
        setButtons(device.serial);
        // The device changed (or this is the first look): start its feed now,
        // not at the next poll.
        if (device.serial !== asked) fetch(devicesUrl(device.serial)).catch(function () {});
      } else {
        currentSerial = null;
        setStatus('No device connected.');
        setButtons(null);
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
      viewDetach = attachAndroidView(document.getElementById('android-view-canvas'), function () { return currentSerial; });
    }
    refreshStatus();
    if (!pollTimer) pollTimer = setInterval(refreshStatus, POLL_MS);
  }

  function onTabHidden() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // The agent of the chat on screen used the android tool: bring the tab up so
  // its work on the device is visible. Once per chat: a user who closes the tab
  // has said they do not want it, and the next tap must not bring it back.
  var surfacedFor = {};
  function onChatEvent(sessionId, _entry, ev) {
    if (!ev || ev.type !== 'tool_start' || ev.toolName !== 'android') return;
    var here = '';
    try { here = (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { here = ''; }
    if (!here || sessionId !== here || surfacedFor[sessionId]) return;
    surfacedFor[sessionId] = true;
    if (typeof agentFeedsOpen !== 'undefined' && !agentFeedsOpen && typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
    if (typeof switchSidePanelTab === 'function' && (typeof sidePanelTab === 'undefined' || sidePanelTab !== 'android')) switchSidePanelTab('android');
  }
  if (window.ChatStreamStore && typeof ChatStreamStore.subscribeAll === 'function') ChatStreamStore.subscribeAll(onChatEvent);

  window.laxAndroidTab = { onTabShown: onTabShown, onTabHidden: onTabHidden, start: start, stop: stop, key: key, refresh: refreshStatus };
})();

// window.lax.chat: how an app built in Local Agent X talks to the user's agents.
//
// The server injects this into every app page it serves, with the app's id and
// its chat capability (src/server/app-chat-inject.ts). The calls go to the
// app's own origin (src/routes/app-chat.ts), which answers them only once the
// user has allowed this app, on a card in their Local Agent X inbox.
//
//   const reply = lax.chat('scheduler', 'Who is on tomorrow?', { persona: 'You plan staff shifts.' });
//   for await (const event of reply) { ... }   // { type: 'delta' | 'replace' | 'needs_approval' | 'error' | 'done' }
//   const text = await reply.text();           // or: the whole reply, once it has ended
//   reply.cancel();                            // stop listening (the turn keeps running)
//   await lax.chatHistory('scheduler');        // [{ role: 'user' | 'assistant', text }]
//   await lax.chatStop('scheduler');           // stop the thread's running turn
//
// A refused call rejects with an Error carrying `code`: 'needs_approval' (the
// user has not answered yet: tell them to look in Local Agent X, then retry),
// 'denied', 'busy', 'rate_limited', 'too_many_threads', 'slash_command',
// 'bad_request', 'bad_thread'.
//
// Injected inline, so nothing here may spell a closing script tag.
function __laxInstallAppChat(appId, token) {
  var base = '/api/app-chat/' + appId + '/threads/';
  var auth = { Authorization: 'Bearer ' + token };

  function refusal(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      var error = new Error(data.error || ('The request failed (' + res.status + ').'));
      error.code = data.code || ('http_' + res.status);
      error.status = res.status;
      throw error;
    });
  }

  function call(thread, tail, init) {
    return fetch(base + encodeURIComponent(thread) + tail, init).then(function (res) { return res.ok ? res : refusal(res); });
  }

  async function* readEvents(started) {
    var res = await started;
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (var cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        var frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        var line = frame.split('\n').find(function (l) { return l.indexOf('data: ') === 0; });
        if (!line) continue; // a heartbeat
        var event = JSON.parse(line.slice(6));
        yield event;
        if (event.type === 'done') return;
      }
    }
  }

  function chat(thread, message, options) {
    var controller = new AbortController();
    var started = call(thread, '/messages', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({ message: message, persona: (options && options.persona) || '' }),
      signal: controller.signal,
    });
    // One reader for the one response, whichever way the caller consumes it.
    var events = readEvents(started);
    var reply = {
      cancel: function () { controller.abort(); },
      text: async function () {
        var text = '';
        var failure = null;
        for await (var event of events) {
          if (event.type === 'delta') text += event.text;
          else if (event.type === 'replace') text = event.text;
          else if (event.type === 'error') failure = event.message;
        }
        if (failure && !text) throw Object.assign(new Error(failure), { code: 'turn_failed' });
        return text;
      },
    };
    reply[Symbol.asyncIterator] = function () { return events; };
    return reply;
  }

  window.lax = window.lax || {};
  window.lax.chat = chat;
  window.lax.chatHistory = function (thread) {
    return call(thread, '/messages', { headers: auth }).then(function (res) { return res.json(); }).then(function (data) { return data.messages; });
  };
  window.lax.chatStop = function (thread) {
    return call(thread, '/stop', { method: 'POST', headers: auth }).then(function (res) { return res.json(); }).then(function (data) { return data.stopped; });
  };
}

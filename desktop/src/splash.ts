// Branded loading screen shown INSTANTLY on window creation so a slow
// server boot doesn't look like a frozen / broken app. Theme-aware so
// the transition into the real app doesn't flash. Progressive hints
// after 15s / 45s explain what's actually happening (first-run model
// pulls, etc.) so the user doesn't keep clicking the dock icon.
//
// Recovery UI: when main hits a fatal boot error it injects buttons via
// showSplashRecovery() that navigate to lax://repair, lax://logs, or
// lax://quit. main.ts intercepts those via webContents.will-navigate so
// the splash can stay a pure data: URL (no IPC / preload plumbing).

export function buildSplashDataUrl(theme: string): string {
  const isLight = theme === "light";
  const bg = isLight ? "#f6f7fa" : "#0a0a0f";
  const fg = isLight ? "#1a1a2e" : "#dddde8";
  const dim = isLight ? "rgba(26,26,46,0.55)" : "rgba(221,221,232,0.55)";
  const dimmer = isLight ? "rgba(26,26,46,0.35)" : "rgba(221,221,232,0.35)";
  const ringTrack = isLight ? "rgba(26,26,46,0.10)" : "rgba(221,221,232,0.10)";
  const btnBg = isLight ? "rgba(26,26,46,0.06)" : "rgba(221,221,232,0.08)";
  const btnHover = isLight ? "rgba(26,26,46,0.12)" : "rgba(221,221,232,0.14)";
  const accent = "#3a7";
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Local Agent X</title><style>
html,body{margin:0;height:100%;background:${bg};color:${fg};font-family:"Segoe UI",-apple-system,system-ui,sans-serif;-webkit-app-region:drag;overflow:hidden;}
.wrap{height:100%;display:flex;align-items:center;justify-content:center;}
.card{text-align:center;-webkit-app-region:no-drag;max-width:480px;padding:0 24px;}
.brand{font-size:1.05rem;letter-spacing:0.22em;font-weight:600;opacity:0.92;margin-bottom:1.8rem;}
.ring{width:34px;height:34px;border:3px solid ${ringTrack};border-top-color:${accent};border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto 1.1rem;}
.ring.hidden{display:none;}
.status{font-size:0.82rem;color:${dim};}
.hint{font-size:0.72rem;color:${dimmer};margin-top:0.6rem;min-height:1rem;transition:opacity 0.3s;opacity:0;}
.hint.show{opacity:1;}
.actions{margin-top:1.4rem;display:none;gap:0.6rem;justify-content:center;flex-wrap:wrap;}
.actions.show{display:flex;}
.actions button{font:inherit;font-size:0.78rem;color:${fg};background:${btnBg};border:0;border-radius:6px;padding:0.55rem 1.1rem;cursor:pointer;transition:background 0.15s;}
.actions button:hover{background:${btnHover};}
.actions button.primary{background:${accent};color:#fff;}
.actions button.primary:hover{background:#4c9;}
@keyframes spin{to{transform:rotate(360deg);}}
</style></head><body><div class="wrap"><div class="card">
<div class="brand">LOCAL AGENT X</div>
<div class="ring" id="r"></div>
<div class="status">Starting…</div>
<div class="hint" id="h"></div>
<div class="actions" id="a">
  <button class="primary" onclick="location.href='lax://repair'">Repair &amp; Relaunch</button>
  <button onclick="location.href='lax://logs'">Open Logs</button>
  <button onclick="location.href='lax://quit'">Quit</button>
</div>
</div></div><script>
let s=0;const h=document.getElementById('h');
// Capture the interval on window so main.ts can clearInterval() when
// painting an explicit hint (config error, startup failure). Without
// this the timer would tick on at s=15/s=45 and clobber the explicit
// hint with the default "Warming up…" / "Still loading…" text.
window.__laxSplashTimer=setInterval(()=>{s++;
if(s===15){h.textContent='Warming up the agent runtime — usually 15-30 seconds.';h.classList.add('show');}
else if(s===45){h.textContent='Still loading. Check ~/.lax/sax-server.log if this hangs.';}
},1000);
// Called by main.ts when reconcile / server boot fails. Stops the
// spinner, reveals the action buttons. The buttons themselves are
// always in the DOM (no innerHTML injection needed) — just toggle
// visibility via the .show class.
window.__laxShowRecovery=function(){
  if(window.__laxSplashTimer){clearInterval(window.__laxSplashTimer);}
  document.getElementById('r').classList.add('hidden');
  document.getElementById('a').classList.add('show');
};
</script></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

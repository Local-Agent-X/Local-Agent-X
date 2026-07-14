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

import { nativeTheme } from "electron";
import { bgForTheme } from "./theme";
import type { DesktopSettings } from "./settings";

export function buildSplashDataUrl(theme: DesktopSettings["theme"]): string {
  // Resolve "system" via the OS (same rule as overlayForTheme) and paint the
  // page from bgForTheme — the SAME source as the window backgroundColor and
  // the boot-phase titleBarOverlay fallback, so all three boot surfaces match
  // by construction instead of via three hand-kept hexes.
  const isLight = theme === "light" || (theme === "system" && !nativeTheme.shouldUseDarkColors);
  const bg = bgForTheme(theme);
  const fg = isLight ? "#1a1a2e" : "#dddde8";
  const dim = isLight ? "rgba(26,26,46,0.55)" : "rgba(221,221,232,0.55)";
  const dimmer = isLight ? "rgba(26,26,46,0.35)" : "rgba(221,221,232,0.35)";
  const ringTrack = isLight ? "rgba(26,26,46,0.10)" : "rgba(221,221,232,0.10)";
  const btnBg = isLight ? "rgba(26,26,46,0.06)" : "rgba(221,221,232,0.08)";
  const btnHover = isLight ? "rgba(26,26,46,0.12)" : "rgba(221,221,232,0.14)";
  const accent = "#3a7";
  // Peak alpha for the phrase-rain backdrop — kept well under the card text
  // so the rain reads as atmosphere, not content. Light themes need less.
  const rainAlpha = isLight ? "0.22" : "0.38";
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Local Agent X</title><style>
html,body{margin:0;height:100%;background:${bg};color:${fg};font-family:"Segoe UI",-apple-system,system-ui,sans-serif;-webkit-app-region:drag;overflow:hidden;}
#rain{position:fixed;inset:0;pointer-events:none;}
.wrap{position:relative;z-index:1;height:100%;display:flex;align-items:center;justify-content:center;}
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
else if(s===45){h.textContent='Still loading. Check ~/.lax/logs/server.log if this hangs.';}
},1000);
// Called by main.ts when reconcile / server boot fails. Stops the
// spinner, reveals the action buttons. The buttons themselves are
// always in the DOM (no innerHTML injection needed) — just toggle
// visibility via the .show class.
window.__laxShowRecovery=function(){
  if(window.__laxSplashTimer){clearInterval(window.__laxSplashTimer);}
  if(window.__laxRainStop){window.__laxRainStop();}
  document.getElementById('r').classList.add('hidden');
  document.getElementById('a').classList.add('show');
};
// Phrase-rain backdrop — inlined port of public/js/phrase-rain.js (the splash
// is a pure data: URL, so it can't load thinking-phrases.js). Same falling
// vertical-phrase columns, dimmed to backdrop level and stopped permanently
// when the recovery UI appears so the error state stays calm.
(function(){
  var dead=false,run=false,last=0,dpr=1,cols=[];
  try{if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;}catch(e){}
  var P=['DECRYPTING','GATHERING INTEL','GOING DARK','TRIANGULATING','RUNNING RECON',
    'TRACING THE SIGNAL','CRACKING THE CIPHER','SECURING THE CHANNEL','EYES ONLY',
    'CONNECTING THE DOTS','ESTABLISHING COMMS','AUTHENTICATING','COMPILING THE BRIEF',
    'ACTIVATING THE NETWORK','SWEEPING FOR BUGS','WARMING UP'];
  var CELL=16,TRAIL=14,GAP=4,A=${rainAlpha};
  var cv=document.createElement('canvas');cv.id='rain';cv.setAttribute('aria-hidden','true');
  document.body.insertBefore(cv,document.body.firstChild);
  var cx=cv.getContext('2d');
  function rnd(a,b){return a+Math.random()*(b-a);}
  function stream(){
    var s=[],n=4+(Math.random()*3|0);
    for(var p=0;p<n;p++){
      var ph=P[Math.random()*P.length|0];
      for(var j=0;j<ph.length;j++)s.push(ph.charAt(j));
      for(var g=0;g<GAP;g++)s.push('');
    }
    return s;
  }
  function seed(){
    var n=Math.ceil(innerWidth/CELL),rows=Math.ceil(innerHeight/CELL);
    cols=[];
    for(var i=0;i<n;i++)cols.push({x:i*CELL,head:rnd(-TRAIL,rows)*CELL,sp:rnd(55,130),acc:0,s:stream(),pos:(Math.random()*40|0)});
  }
  function size(){
    dpr=Math.min(devicePixelRatio||1,2);
    cv.width=Math.floor(innerWidth*dpr);cv.height=Math.floor(innerHeight*dpr);
    cv.style.width=innerWidth+'px';cv.style.height=innerHeight+'px';
    seed();
  }
  function frame(t){
    if(!run)return;
    if(!last)last=t;
    var dt=Math.min(t-last,60);last=t;
    var H=innerHeight,off=H+TRAIL*CELL;
    cx.save();cx.scale(dpr,dpr);
    cx.clearRect(0,0,innerWidth,H);
    cx.font='600 '+CELL+'px Consolas,Menlo,monospace';
    cx.textBaseline='top';cx.fillStyle='${accent}';
    for(var i=0;i<cols.length;i++){
      var c=cols[i];
      c.acc+=dt;
      while(c.acc>=c.sp){
        c.acc-=c.sp;c.pos++;c.head+=CELL;
        if(c.head>off){c.s=stream();c.pos=0;c.head=rnd(-TRAIL,-1)*CELL;c.acc=0;break;}
      }
      for(var k=0;k<TRAIL;k++){
        var si=c.pos-k;
        if(si<0)continue;
        var ch=c.s[si%c.s.length];
        if(!ch)continue;
        var gy=c.head-k*CELL;
        if(gy<-CELL||gy>H)continue;
        cx.globalAlpha=(1-k/TRAIL)*A;
        cx.fillText(ch,c.x,gy);
      }
    }
    cx.globalAlpha=1;cx.restore();
    requestAnimationFrame(frame);
  }
  function start(){if(dead||run)return;run=true;last=0;requestAnimationFrame(frame);}
  window.__laxRainStop=function(){dead=true;run=false;cx.clearRect(0,0,cv.width,cv.height);cv.style.display='none';};
  addEventListener('resize',function(){if(!dead)size();});
  document.addEventListener('visibilitychange',function(){if(document.hidden)run=false;else start();});
  size();start();
})();
</script></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

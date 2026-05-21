// JavaScript injected into BrowserWindow renderers. Kept as plain string
// constants instead of executable functions because the body runs inside
// the renderer's context — different `window`, different DOM, no access
// to anything in main. The main-process file just calls
// webContents.executeJavaScript(STRING) on the right lifecycle event.

import { nativeTheme } from "electron";
import type { DesktopSettings } from "./settings";

// Titlebar injected into the main window on Windows/Linux. macOS uses the
// native top-of-screen menu bar — skipped there.
//
// Why a template string instead of a .js file shipped alongside: this
// runs in the renderer's CSP-sandboxed context, has no module loader,
// and depends on var() CSS variables exposed by the LAX app. A file
// boundary would only buy a marginal IDE win at the cost of a build-
// step concern. Plain string is fine.
export const MAIN_WINDOW_TITLEBAR_JS = `
(function() {
  if (document.getElementById('desktop-titlebar')) return;
  const bar = document.createElement('div');
  bar.id = 'desktop-titlebar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:32px;z-index:99999;display:flex;align-items:center;background:var(--bg, #0a0a0f);-webkit-app-region:drag;font-family:"Segoe UI",sans-serif;font-size:12px;user-select:none;';

  const menus = [
    { label:'File', items:['New Session','Restart Server','—','Quit'] },
    { label:'Edit', items:['Undo','Redo','—','Cut','Copy','Paste'] },
    { label:'View', items:['Reload','Toggle Agents','Toggle DevTools','—','Zoom In','Zoom Out','Reset Zoom'] },
    { label:'Window', items:['Minimize','Close to Tray'] },
    { label:'Help', items:['About'] }
  ];

  let openMenu = null;
  function closeAllMenus() {
    document.querySelectorAll('.dtb-dd').forEach(d => d.style.display='none');
    document.querySelectorAll('.dtb-btn').forEach(b => { b.style.color='var(--muted, #888)'; b.style.background=''; });
    openMenu = null;
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#desktop-titlebar')) closeAllMenus();
  });

  const favicon = document.createElement('img');
  favicon.src = '/favicon.png';
  favicon.style.cssText = 'width:16px;height:16px;margin:0 8px 0 8px;-webkit-app-region:no-drag;';
  bar.appendChild(favicon);

  menus.forEach(menu => {
    const btn = document.createElement('div');
    btn.className = 'dtb-btn';
    btn.textContent = menu.label;
    btn.style.cssText = 'padding:4px 8px;color:var(--muted, #888);cursor:pointer;-webkit-app-region:no-drag;position:relative;';

    const dd = document.createElement('div');
    dd.className = 'dtb-dd';
    dd.style.cssText = 'display:none;position:absolute;top:100%;left:0;background:var(--bg, #0a0a0f);border:1px solid var(--border, #1a1a2f);min-width:180px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:100000;padding:4px 0;';

    menu.items.forEach(item => {
      if (item === '—') {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:var(--border, #1a1a2f);margin:4px 0;';
        dd.appendChild(sep);
      } else {
        const it = document.createElement('div');
        it.textContent = item;
        it.style.cssText = 'padding:6px 12px;color:var(--text, #ccc);cursor:pointer;';
        it.onmouseenter = () => it.style.background='var(--hover, #1a1a2f)';
        it.onmouseleave = () => it.style.background='';
        it.onclick = (e) => {
          e.stopPropagation();
          closeAllMenus();
          if(window.desktop) {
            if(item==='Quit') window.desktop.quit();
            if(item==='Restart Server') window.desktop.restartServer();
            if(item==='New Session') window.startNewSession?.();
            if(item==='Toggle DevTools') window.desktop.toggleDevTools();
          }
          if(item==='Reload') location.reload();
          if(item==='Toggle Agents') { const b=document.getElementById('agents-toggle'); if(b) b.click(); }
          if(item==='Zoom In') document.body.style.zoom=(parseFloat(document.body.style.zoom||'1')+0.1)+'';
          if(item==='Zoom Out') document.body.style.zoom=(parseFloat(document.body.style.zoom||'1')-0.1)+'';
          if(item==='Reset Zoom') document.body.style.zoom='1';
          if(item==='Minimize') window.desktop?.toggleWindow();
          if(item==='Close to Tray') window.desktop?.toggleWindow();
        };
        dd.appendChild(it);
      }
    });

    btn.appendChild(dd);

    btn.onclick = (e) => {
      e.stopPropagation();
      if (openMenu === dd) { closeAllMenus(); return; }
      closeAllMenus();
      dd.style.display='block';
      btn.style.color='var(--accent, #40f0f0)';
      btn.style.background='var(--hover, #1a1a2f)';
      openMenu = dd;
    };
    btn.onmouseenter = () => {
      if (openMenu && openMenu !== dd) {
        closeAllMenus();
        dd.style.display='block';
        btn.style.color='var(--accent, #40f0f0)';
        btn.style.background='var(--hover, #1a1a2f)';
        openMenu = dd;
      }
    };

    bar.appendChild(btn);
  });

  document.body.prepend(bar);
  document.body.classList.add('desktop-frame');
})();
`;

// Drag strip injected into child app windows. Reads the app's effective
// body background, paints the strip with it, and reports the hex back to
// main so the OS chrome overlay matches — eliminates the LAX-theme-strip-
// over-app-content seam. Reserves 80px on the left for traffic lights
// (Mac); on Windows/Linux the strip extends to right:0 so titleBarOverlay
// paints over the right edge and no dark sliver remains.
export function buildAppDragStripJs(theme: DesktopSettings["theme"]): string {
  const reserveLeft = process.platform === "darwin" ? 80 : 0;
  const reserveRight = 0;
  const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  const fallbackBg = isDark ? "#0a0a0f" : "#ffffff";
  return `
    (() => {
      if (document.getElementById('__lax_drag_strip')) return;

      function readBg(el) {
        const c = getComputedStyle(el).backgroundColor;
        return (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') ? c : null;
      }
      const tint = readBg(document.body) || readBg(document.documentElement) || '${fallbackBg}';
      const m = String(tint).match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
      let isDarkTint = false;
      let hexTint = tint;
      if (m) {
        const r = +m[1], g = +m[2], b = +m[3];
        isDarkTint = (0.299*r + 0.587*g + 0.114*b) / 255 < 0.5;
        const toHex = (v) => ('0' + (+v).toString(16)).slice(-2);
        hexTint = '#' + toHex(r) + toHex(g) + toHex(b);
      } else {
        isDarkTint = ${isDark ? "true" : "false"};
      }
      const symbolColor = isDarkTint ? '#e0e0e8' : '#1a1a2e';

      const bar = document.createElement('div');
      bar.id = '__lax_drag_strip';
      bar.style.cssText = 'position:fixed;top:0;left:${reserveLeft}px;right:${reserveRight}px;height:32px;z-index:2147483647;background:' + tint + ';-webkit-app-region:drag;pointer-events:auto;';
      document.body.appendChild(bar);

      if (window.desktop && window.desktop.reportChromeTint) {
        try { window.desktop.reportChromeTint(hexTint, symbolColor); } catch (e) {}
      }
      const cs = getComputedStyle(document.body);
      const cur = parseInt(cs.paddingTop) || 0;
      if (cur < 32) document.body.style.paddingTop = (cur + 32) + 'px';
    })();
  `;
}

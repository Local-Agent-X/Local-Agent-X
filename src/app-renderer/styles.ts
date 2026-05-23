/**
 * Static CSS for rendered apps. Pure string — no interpolation, no user input.
 * Injected under a per-request nonce by page.ts.
 */

export const APP_STYLES = `
    :root {
      --bg: #0a0a0a; --bg2: #141414; --bg3: #1e1e1e;
      --fg: #e0e0e0; --muted: #888;
      --accent: #00d4ff; --accent2: #0af;
      --border: #2a2a2a; --radius: 8px;
      --sans: system-ui, -apple-system, sans-serif;
      --mono: 'SF Mono', 'Fira Code', monospace;
      --green: #4caf50; --red: #f44336; --yellow: #ffc107; --blue: #2196f3;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--sans); padding: 24px; min-height: 100vh; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 4px; display: inline-flex; align-items: center; gap: 12px; }
    .app-desc { color: var(--muted); font-size: .85rem; margin-bottom: 20px; }
    .app-header { margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .app-version { font-size: .65rem; color: var(--muted); font-family: var(--mono); padding: 2px 6px; background: var(--bg2); border-radius: 4px; }

    /* Status badges */
    .app-status-badge { font-size: .65rem; font-family: var(--mono); padding: 2px 8px; border-radius: 8px; text-transform: uppercase; letter-spacing: .5px; }
    .app-status-suspended { background: var(--red); color: #fff; }
    .app-status-archived { background: var(--yellow); color: #000; }

    /* Components */
    .app-stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; text-align: center; }
    .app-stat-label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .app-stat-value { font-size: 2rem; font-weight: 700; color: var(--accent); font-family: var(--mono); }
    .app-stat-unit { font-size: .7rem; color: var(--muted); }

    .app-text { padding: 8px 0; line-height: 1.5; }

    .app-btn { background: var(--accent); color: #000; border: none; border-radius: var(--radius); padding: 8px 20px; font-weight: 600; cursor: pointer; font-size: .85rem; transition: opacity .15s; }
    .app-btn:hover { opacity: .85; }
    .app-btn:disabled { opacity: .4; cursor: not-allowed; }

    .app-field { margin-bottom: 12px; }
    .app-label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .app-input, .app-select { width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; color: var(--fg); font-size: .85rem; outline: none; }
    .app-input:focus, .app-select:focus { border-color: var(--accent); }

    .app-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: .85rem; }
    .app-toggle input { width: 16px; height: 16px; accent-color: var(--accent); }

    .app-table-wrap { overflow-x: auto; }
    .app-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .app-table th { background: var(--bg3); color: var(--muted); text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .app-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .app-table tr:hover { background: var(--bg2); }

    .app-chart { background: var(--bg2); border-radius: var(--radius); padding: 16px; }
    .app-chart-label { font-size: .75rem; color: var(--muted); text-align: center; margin-top: 8px; }

    .app-list { background: var(--bg2); border-radius: var(--radius); padding: 12px 16px; }
    .app-list-label { font-size: .75rem; color: var(--muted); margin-bottom: 8px; }
    .app-list ul { list-style: none; }
    .app-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: .85rem; }
    .app-list li:last-child { border-bottom: none; }

    .app-form { background: var(--bg2); border-radius: var(--radius); padding: 16px; }
    .app-image img { border-radius: var(--radius); }

    /* Progress bar */
    .app-progress { margin: 8px 0; }
    .app-progress-label { font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .app-progress-bar { background: var(--bg3); border-radius: 4px; height: 8px; overflow: hidden; }
    .app-progress-fill { background: var(--accent); height: 100%; border-radius: 4px; transition: width .3s ease; }
    .app-progress-value { font-size: .7rem; color: var(--muted); margin-top: 2px; text-align: right; font-family: var(--mono); }

    /* Alert */
    .app-alert { padding: 12px 16px; border-radius: var(--radius); font-size: .85rem; position: relative; margin: 8px 0; border: 1px solid; }
    .app-alert-info { background: rgba(33,150,243,.1); border-color: var(--blue); color: var(--blue); }
    .app-alert-success { background: rgba(76,175,80,.1); border-color: var(--green); color: var(--green); }
    .app-alert-warning { background: rgba(255,193,7,.1); border-color: var(--yellow); color: var(--yellow); }
    .app-alert-error { background: rgba(244,67,54,.1); border-color: var(--red); color: var(--red); }
    .app-alert-close { position: absolute; top: 8px; right: 12px; background: none; border: none; color: inherit; cursor: pointer; font-size: 1.2rem; }

    /* Code block */
    .app-code { background: var(--bg2); border-radius: var(--radius); overflow-x: auto; }
    .app-code-label { font-size: .7rem; color: var(--muted); padding: 8px 12px 0; font-family: var(--mono); }
    .app-code pre { padding: 12px; margin: 0; }
    .app-code code { font-family: var(--mono); font-size: .8rem; color: var(--fg); white-space: pre-wrap; }

    /* Badge */
    .app-badge { display: inline-block; font-size: .7rem; font-family: var(--mono); padding: 2px 8px; border-radius: 8px; }
    .app-badge-default { background: var(--bg3); color: var(--muted); }
    .app-badge-success { background: rgba(76,175,80,.2); color: var(--green); }
    .app-badge-warning { background: rgba(255,193,7,.2); color: var(--yellow); }
    .app-badge-error { background: rgba(244,67,54,.2); color: var(--red); }
    .app-badge-info { background: rgba(33,150,243,.2); color: var(--blue); }

    /* Divider */
    .app-divider { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

    /* Tabs */
    .app-tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .app-tab-btn { background: none; border: none; color: var(--muted); padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: .85rem; }
    .app-tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .app-tab-panel { display: none; }
    .app-tab-panel.active { display: block; }

    /* Status indicator */
    .app-status { position: fixed; bottom: 12px; right: 12px; font-size: .7rem; color: var(--muted); background: var(--bg2); padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border); display: flex; align-items: center; gap: 6px; }
    .app-status.connected { color: var(--green); }
    .app-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .app-status.connected .app-status-dot { background: var(--green); }
  `;

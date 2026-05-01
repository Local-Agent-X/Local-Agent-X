"""One-shot patcher: wires the Tier 4 advanced controls into settings.js.

Adds:
  * onTier4SettingChange(key, value) — immediate POST + localStorage mirror.
  * loadVoiceTier4Settings(s) — populate inputs from settings + voice catalog.
  * refreshVoiceTier4Visibility(engine) — show/hide the panel.
  * Hooks into loadSettings + onVoiceEngineChange.

Re-running is safe (bails if the marker is already present).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / "public" / "js" / "settings.js"
text = target.read_text(encoding="utf-8")

if "onTier4SettingChange" in text:
    print("ALREADY APPLIED")
    sys.exit(0)


# ---- 1. Hook loadSettings: after set('cfg-voice-engine', ...) call loadVoiceTier4Settings(s).
load_anchor = (
    "    set('cfg-voice-engine', s.voiceEngine || 'tier4');\n"
    "    if (typeof refreshVoiceEngineStatus === 'function') refreshVoiceEngineStatus(s.voiceEngine || 'tier4');\n"
)
load_replacement = (
    "    set('cfg-voice-engine', s.voiceEngine || 'tier4');\n"
    "    if (typeof refreshVoiceEngineStatus === 'function') refreshVoiceEngineStatus(s.voiceEngine || 'tier4');\n"
    "    if (typeof loadVoiceTier4Settings === 'function') loadVoiceTier4Settings(s);\n"
    "    if (typeof refreshVoiceTier4Visibility === 'function') refreshVoiceTier4Visibility(s.voiceEngine || 'tier4');\n"
)
if load_anchor not in text:
    print("MISS: loadSettings anchor not found", file=sys.stderr)
    sys.exit(2)
text = text.replace(load_anchor, load_replacement, 1)


# ---- 2. Hook onVoiceEngineChange: also toggle tier4 panel visibility.
engine_anchor = "    refreshVoiceEngineStatus(engine);\n  } catch (e) {\n    console.warn('[voice-engine] save failed:', e);\n  }\n}"
engine_replacement = (
    "    refreshVoiceEngineStatus(engine);\n"
    "    if (typeof refreshVoiceTier4Visibility === 'function') refreshVoiceTier4Visibility(engine);\n"
    "  } catch (e) {\n"
    "    console.warn('[voice-engine] save failed:', e);\n"
    "  }\n"
    "}"
)
if engine_anchor not in text:
    print("MISS: onVoiceEngineChange anchor not found", file=sys.stderr)
    sys.exit(3)
text = text.replace(engine_anchor, engine_replacement, 1)


# ---- 3. Append the three new functions after refreshVoiceEngineStatus closes.
ref_anchor = (
    "  if (info) info.textContent = lbl.detail;\n"
    "}\n"
    "\n"
    "async function onEmbProviderChange(provider) {"
)
ref_replacement = (
    "  if (info) info.textContent = lbl.detail;\n"
    "}\n"
    "\n"
    "// ── Tier 4 advanced (voice / speed / device / dtype + whisper) ──\n"
    "// Persists per-key to settings.json via /api/settings on every change.\n"
    "// The voice-session reader picks up changes on the next session — no restart.\n"
    "// Empty-string values delete the key (server merges naively, so we send null).\n"
    "async function onTier4SettingChange(key, raw) {\n"
    "  if (!key) return;\n"
    "  let value = (raw === '' || raw == null) ? null : raw;\n"
    "  if (key === 'voiceTier4Speed' && value != null) {\n"
    "    const n = parseFloat(value);\n"
    "    if (!Number.isFinite(n) || n < 0.5 || n > 2) {\n"
    "      console.warn('[tier4-settings] speed out of range; ignoring');\n"
    "      return;\n"
    "    }\n"
    "    value = n;\n"
    "  }\n"
    "  try {\n"
    "    const payload = {}; payload[key] = value;\n"
    "    if (typeof apiPost === 'function') await apiPost('/api/settings', payload);\n"
    "    else await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });\n"
    "    try {\n"
    "      const saved = JSON.parse(localStorage.getItem('sax_settings') || '{}');\n"
    "      if (value === null) delete saved[key]; else saved[key] = value;\n"
    "      localStorage.setItem('sax_settings', JSON.stringify(saved));\n"
    "    } catch {}\n"
    "  } catch (e) {\n"
    "    console.warn('[tier4-settings] save failed:', key, e);\n"
    "  }\n"
    "}\n"
    "window.onTier4SettingChange = onTier4SettingChange;\n"
    "\n"
    "function refreshVoiceTier4Visibility(engine) {\n"
    "  const panel = document.getElementById('voice-tier4-options');\n"
    "  if (!panel) return;\n"
    "  panel.style.display = engine === 'tier4' ? '' : 'none';\n"
    "}\n"
    "window.refreshVoiceTier4Visibility = refreshVoiceTier4Visibility;\n"
    "\n"
    "let _tier4VoiceCatalog = null;\n"
    "async function loadVoiceTier4Settings(s) {\n"
    "  const select = document.getElementById('cfg-voice-tier4-voice');\n"
    "  if (!_tier4VoiceCatalog) {\n"
    "    try {\n"
    "      const r = await (typeof apiFetch === 'function' ? apiFetch('/api/voice/tier4/voices') : fetch('/api/voice/tier4/voices'));\n"
    "      _tier4VoiceCatalog = await r.json();\n"
    "    } catch (e) {\n"
    "      console.warn('[tier4-settings] /api/voice/tier4/voices failed', e);\n"
    "      _tier4VoiceCatalog = { voices: [], default: 'am_michael' };\n"
    "    }\n"
    "  }\n"
    "  if (select && _tier4VoiceCatalog && Array.isArray(_tier4VoiceCatalog.voices)) {\n"
    "    const def = _tier4VoiceCatalog.default || 'am_michael';\n"
    "    const list = _tier4VoiceCatalog.voices.slice().sort((a, b) => {\n"
    "      const aEn = a.language && a.language.startsWith('en') ? 0 : 1;\n"
    "      const bEn = b.language && b.language.startsWith('en') ? 0 : 1;\n"
    "      return aEn - bEn || (a.id || '').localeCompare(b.id || '');\n"
    "    });\n"
    "    const optEsc = (str) => String(str || '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\n"
    "    select.innerHTML = '<option value=\"\">Default (' + optEsc(def) + ')</option>' +\n"
    "      list.map(v => '<option value=\"' + optEsc(v.id) + '\">' + optEsc(v.name || v.id) + ' — ' + optEsc(v.language || '?') + '/' + optEsc(v.gender || '?') + '</option>').join('');\n"
    "  }\n"
    "  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); };\n"
    "  set('cfg-voice-tier4-voice', s.voiceTier4Voice);\n"
    "  set('cfg-voice-tier4-speed', s.voiceTier4Speed);\n"
    "  set('cfg-voice-tier4-device', s.voiceTier4Device);\n"
    "  set('cfg-voice-tier4-dtype', s.voiceTier4Dtype);\n"
    "  set('cfg-voice-whisper-model', s.voiceWhisperModel);\n"
    "  set('cfg-voice-whisper-device', s.voiceWhisperDevice);\n"
    "}\n"
    "window.loadVoiceTier4Settings = loadVoiceTier4Settings;\n"
    "\n"
    "async function onEmbProviderChange(provider) {"
)
if ref_anchor not in text:
    print("MISS: refreshVoiceEngineStatus anchor not found", file=sys.stderr)
    sys.exit(4)
text = text.replace(ref_anchor, ref_replacement, 1)


target.write_text(text, encoding="utf-8")
print("OK: settings.js patched")

"""One-shot patcher: adds Tier 4 advanced controls to public/app.html.

Re-running is safe — bails out if the marker block is already present.
This file is left in scripts/ as a record of the patch but isn't wired
into anything; delete after the change lands if desired.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / "public" / "app.html"
text = target.read_text(encoding="utf-8")

if 'id="voice-tier4-options"' in text:
    print("ALREADY APPLIED")
    sys.exit(0)

needle = (
    '          <div class="field-hint" id="voice-engine-active-info" '
    'style="font-size:.74rem;color:var(--muted);margin-top:4px">&nbsp;</div>\n'
    '        </div>\n'
    '        <div class="section-card">\n'
    '          <div class="section-title">Text-to-Speech</div>'
)
if needle not in text:
    print("MISS: anchor text not found", file=sys.stderr)
    sys.exit(2)

block = (
    '          <div class="field-hint" id="voice-engine-active-info" '
    'style="font-size:.74rem;color:var(--muted);margin-top:4px">&nbsp;</div>\n'
    '          <div id="voice-tier4-options" '
    'style="display:none;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">\n'
    '            <div style="font-family:var(--mono);font-size:.65rem;color:var(--accent);'
    'letter-spacing:1px;margin-bottom:8px">TIER 4 ADVANCED</div>\n'
    '            <div class="field-row">\n'
    '              <div class="field"><label class="field-label">Kokoro voice</label>'
    '<select class="field-select" id="cfg-voice-tier4-voice" '
    'onchange="onTier4SettingChange(\'voiceTier4Voice\', this.value)">'
    '<option value="">Loading…</option></select>'
    '<div class="field-hint">English voices first; full Kokoro catalog from the runtime.</div></div>\n'
    '              <div class="field"><label class="field-label">Speed</label>'
    '<input class="field-input" id="cfg-voice-tier4-speed" type="number" step="0.05" min="0.5" max="2" '
    'placeholder="1.0" onchange="onTier4SettingChange(\'voiceTier4Speed\', this.value)"/>'
    '<div class="field-hint">0.5–2.0. Blank = default (1.0).</div></div>\n'
    '            </div>\n'
    '            <div class="field-row">\n'
    '              <div class="field"><label class="field-label">TTS device</label>'
    '<select class="field-select" id="cfg-voice-tier4-device" '
    'onchange="onTier4SettingChange(\'voiceTier4Device\', this.value)">'
    '<option value="">Auto</option><option value="cpu">CPU</option>'
    '<option value="dml">DirectML (GPU)</option><option value="cuda">CUDA (GPU)</option></select>'
    '<div class="field-hint">Auto-falls back to CPU if the GPU EP can\'t bind.</div></div>\n'
    '              <div class="field"><label class="field-label">TTS dtype</label>'
    '<select class="field-select" id="cfg-voice-tier4-dtype" '
    'onchange="onTier4SettingChange(\'voiceTier4Dtype\', this.value)">'
    '<option value="">Auto</option><option value="fp32">fp32</option>'
    '<option value="fp16">fp16</option><option value="q8">q8</option>'
    '<option value="q4">q4</option></select>'
    '<div class="field-hint">CPU works best with q8; GPU prefers fp16.</div></div>\n'
    '            </div>\n'
    '            <div class="field-row">\n'
    '              <div class="field"><label class="field-label">Whisper model</label>'
    '<select class="field-select" id="cfg-voice-whisper-model" '
    'onchange="onTier4SettingChange(\'voiceWhisperModel\', this.value)">'
    '<option value="">Auto (tiny.en)</option><option value="tiny.en">tiny.en (fastest)</option>'
    '<option value="base.en">base.en</option>'
    '<option value="small.en">small.en (best accuracy)</option></select></div>\n'
    '              <div class="field"><label class="field-label">Whisper device</label>'
    '<select class="field-select" id="cfg-voice-whisper-device" '
    'onchange="onTier4SettingChange(\'voiceWhisperDevice\', this.value)">'
    '<option value="">Auto</option><option value="cpu">CPU</option>'
    '<option value="dml">DirectML (GPU)</option><option value="cuda">CUDA (GPU)</option></select></div>\n'
    '            </div>\n'
    '            <div class="field-hint" style="margin-top:6px">'
    'Saved to <code>~/.lax/settings.json</code>. New voice sessions pick up changes automatically '
    '— no restart.</div>\n'
    '          </div>\n'
    '        </div>\n'
    '        <div class="section-card">\n'
    '          <div class="section-title">Text-to-Speech</div>'
)
target.write_text(text.replace(needle, block, 1), encoding="utf-8")
print("OK: app.html patched")

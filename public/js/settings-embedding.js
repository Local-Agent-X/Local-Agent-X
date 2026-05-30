// ── Settings: Embedding provider ──
//
// Picks the embedding provider (Ollama / OpenAI / etc.) for semantic search.

async function onEmbProviderChange(provider) {
  const hint = document.getElementById('cfg-emb-hint');
  const modelInput = document.getElementById('cfg-emb-model');
  const modelSelect = document.getElementById('cfg-emb-model-select');

  const hints = {
    ollama: 'Select an Ollama model. Run "ollama pull nomic-embed-text" to add embedding models.',
    openai: 'Recommended: text-embedding-3-small ($0.02/M tokens). Needs OPENAI_API_KEY in secrets.',
    gemini: 'Recommended: text-embedding-004. Needs GEMINI_API_KEY in secrets.',
    local: 'Built-in TF-IDF embeddings. No external server needed but lower quality.',
    none: 'Keyword search only. No semantic matching.',
  };
  if (hint) hint.textContent = hints[provider] || '';

  if (provider === 'ollama' && modelSelect) {
    // Show dropdown, hide text input, load Ollama models
    modelSelect.style.display = '';
    if (modelInput) modelInput.style.display = 'none';
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      // ?include=embeddings — the default endpoint filters embedding-only
      // models out (they can't serve chat). This dropdown specifically
      // wants embedding models, so opt in.
      const data = await apiJson('/api/models/local?include=embeddings');
      const models = (data.models || []).map(function(m) { return m.name; });
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models found — run ollama pull nomic-embed-text</option>';
        return;
      }
      // Embedding-friendly models get sorted to top
      var embModels = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed', 'bge-large', 'bge-base'];
      var sorted = models.slice().sort(function(a, b) {
        var aEmb = embModels.some(function(e) { return a.includes(e); }) ? 0 : 1;
        var bEmb = embModels.some(function(e) { return b.includes(e); }) ? 0 : 1;
        return aEmb - bEmb || a.localeCompare(b);
      });
      modelSelect.innerHTML = sorted.map(function(m) {
        var isEmb = embModels.some(function(e) { return m.includes(e); });
        var label = isEmb ? m + ' (embedding)' : m;
        return '<option value="' + esc(m) + '">' + esc(label) + '</option>';
      }).join('');
      // Try to select saved or default
      var saved = modelInput ? modelInput.value : '';
      if (saved && sorted.includes(saved)) modelSelect.value = saved;
      else if (sorted.find(function(m) { return m.includes('nomic-embed'); })) modelSelect.value = sorted.find(function(m) { return m.includes('nomic-embed'); });
      // Sync hidden input
      if (modelInput) modelInput.value = modelSelect.value;
      modelSelect.onchange = function() { if (modelInput) modelInput.value = modelSelect.value; };
    } catch {
      modelSelect.innerHTML = '<option value="">Ollama not running</option>';
    }
  } else if (modelSelect) {
    // Non-Ollama: show text input, hide dropdown
    modelSelect.style.display = 'none';
    if (modelInput) modelInput.style.display = '';
    var defaults = { openai: 'text-embedding-3-small', gemini: 'text-embedding-004', local: '', none: '' };
    if (modelInput) modelInput.value = defaults[provider] || '';
  }
}
window.onEmbProviderChange = onEmbProviderChange;


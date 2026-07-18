(function () {
  const descriptions = {
    assisted: 'New skills wait for your review.',
    autonomous: 'Qualified skills become available automatically within your existing permissions.',
  };

  function renderLearningMode(mode) {
    const selected = mode === 'autonomous' ? 'autonomous' : 'assisted';
    document.querySelectorAll('[data-learning-mode]').forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.learningMode === selected));
    });
    const status = document.getElementById('learning-mode-status');
    if (status) status.textContent = descriptions[selected];
  }

  async function selectLearningMode(mode) {
    renderLearningMode(mode);
    try {
      const result = await apiPost('/api/settings', { learningMode: mode });
      if (!result.ok) throw new Error(result.error || 'Unable to save learning mode');
    } catch {
      const settings = await apiJson('/api/settings');
      renderLearningMode(settings.learningMode);
    }
  }

  async function loadLearningMode() {
    const control = document.getElementById('learning-mode-control');
    if (!control) return;
    control.addEventListener('click', (event) => {
      const button = event.target.closest('[data-learning-mode]');
      if (button) selectLearningMode(button.dataset.learningMode);
    });
    try {
      const settings = await apiJson('/api/settings');
      renderLearningMode(settings.learningMode);
    } catch {}
  }

  window.renderLearningMode = renderLearningMode;
  document.addEventListener('DOMContentLoaded', loadLearningMode);
}());

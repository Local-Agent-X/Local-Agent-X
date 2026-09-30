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

  function renderSkillReviewEnabled(enabled) {
    const box = document.getElementById('skill-review-enabled');
    if (box) box.checked = enabled !== false;
  }

  async function selectSkillReviewEnabled(enabled) {
    renderSkillReviewEnabled(enabled);
    try {
      const result = await apiPost('/api/settings', { skillReviewEnabled: enabled });
      if (!result.ok) throw new Error(result.error || 'Unable to save skill review setting');
    } catch {
      const settings = await apiJson('/api/settings');
      renderSkillReviewEnabled(settings.skillReviewEnabled);
    }
  }

  async function loadLearningMode() {
    const control = document.getElementById('learning-mode-control');
    if (!control) return;
    control.addEventListener('click', (event) => {
      const button = event.target.closest('[data-learning-mode]');
      if (button) selectLearningMode(button.dataset.learningMode);
    });
    const box = document.getElementById('skill-review-enabled');
    if (box) box.addEventListener('change', () => selectSkillReviewEnabled(box.checked));
    try {
      const settings = await apiJson('/api/settings');
      renderLearningMode(settings.learningMode);
      renderSkillReviewEnabled(settings.skillReviewEnabled);
    } catch {}
  }

  window.renderLearningMode = renderLearningMode;
  window.renderSkillReviewEnabled = renderSkillReviewEnabled;
  document.addEventListener('DOMContentLoaded', loadLearningMode);
}());

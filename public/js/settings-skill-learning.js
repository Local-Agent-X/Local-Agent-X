(function () {
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

  function renderFailureReviewEnabled(enabled) {
    const box = document.getElementById('failure-review-enabled');
    if (box) box.checked = enabled !== false;
  }

  async function selectFailureReviewEnabled(enabled) {
    renderFailureReviewEnabled(enabled);
    try {
      const result = await apiPost('/api/settings', { failureReviewEnabled: enabled });
      if (!result.ok) throw new Error(result.error || 'Unable to save failure review setting');
    } catch {
      const settings = await apiJson('/api/settings');
      renderFailureReviewEnabled(settings.failureReviewEnabled);
    }
  }

  async function loadSkillLearning() {
    const box = document.getElementById('skill-review-enabled');
    if (!box) return;
    box.addEventListener('change', () => selectSkillReviewEnabled(box.checked));
    const failureBox = document.getElementById('failure-review-enabled');
    if (failureBox) failureBox.addEventListener('change', () => selectFailureReviewEnabled(failureBox.checked));
    try {
      const settings = await apiJson('/api/settings');
      renderSkillReviewEnabled(settings.skillReviewEnabled);
      renderFailureReviewEnabled(settings.failureReviewEnabled);
    } catch {}
  }

  window.renderSkillReviewEnabled = renderSkillReviewEnabled;
  window.renderFailureReviewEnabled = renderFailureReviewEnabled;
  document.addEventListener('DOMContentLoaded', loadSkillLearning);
}());

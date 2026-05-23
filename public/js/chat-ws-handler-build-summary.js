// ── Chat WS: build-run summary formatter ──
// Renders structured Build-Run Summary text from bg_op_completed metadata
// emitted by the primal_run_build_plan orchestrator. Replaces the
// "halt reason as one paragraph" failure mode where the user couldn't
// tell which chunk shipped or how to resume.
function renderBuildRunSummary(meta) {
  const lines = [];
  const projectName = (meta.project_name || 'project').toString();
  const phase = (meta.phase || 'unknown').toString().toUpperCase();
  const committed = Number(meta.chunks_committed || 0);
  const total = Number(meta.total_chunks || 0);
  const pct = total > 0 ? Math.round((committed / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));

  lines.push('BUILD RUN — ' + projectName);
  lines.push('Status: ' + phase + (meta.resumable ? '  (resumable)' : ''));
  lines.push('Chunks: ' + committed + '/' + total + ' committed  ' + bar + '  ' + pct + '%');
  if (meta.current_chunk) lines.push('Last touched: chunk ' + meta.current_chunk);
  if (meta.halt_gate) lines.push('Halt gate: ' + meta.halt_gate);
  if (meta.halt_reason) {
    const reasonText = String(meta.halt_reason).slice(0, 280);
    lines.push('Halt reason: ' + reasonText + (String(meta.halt_reason).length > 280 ? '…' : ''));
  }

  const verdicts = Array.isArray(meta.per_chunk_verdicts) ? meta.per_chunk_verdicts : [];
  if (verdicts.length > 0) {
    lines.push('');
    lines.push('Per-chunk verdicts:');
    for (const v of verdicts) {
      lines.push('  chunk ' + v.chunk + ': ' + v.action);
    }
  }

  if (meta.resumable && meta.project_dir) {
    lines.push('');
    const pd = String(meta.project_dir).replace(/\\/g, '\\\\');
    lines.push('Resume:  primal_build_resume({project_dir: "' + pd + '"})');
  }
  if (phase === 'COMPLETE') {
    lines.push('');
    lines.push('Build complete. Review LAUNCH_READINESS.md before deploying.');
  }
  return lines.join('\n');
}

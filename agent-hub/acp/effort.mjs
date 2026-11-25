// effort.mjs — one reasoning-effort knob for every agent.
//
// Agents name the option differently (OpenCode: `effort` with low|high|max|default; Codex:
// `reasoning_effort` with low..max). Each registry entry declares its own mapping:
//
//   "effort": { "option": "effort", "values": { "low": "low", "medium": "default", ... } }
//
// and the hub turns `--effort low` into the matching `--config option=value`. Measured reason
// (2026-11-08): OpenCode spent 296 of 314 s reasoning (21k reasoning tokens for 4.3k of output)
// to rewrite a document. Text and mechanical work rarely need more than `low`.

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

/**
 * The `option=value` config change for [level] on an agent whose registry entry has [effort],
 * or null when the agent declares no effort option (the caller warns and carries on).
 */
export function effortConfig(effort, level) {
  if (!EFFORT_LEVELS.includes(level)) {
    throw new Error(`unknown effort "${level}" (use ${EFFORT_LEVELS.join(', ')})`);
  }
  if (!effort?.option || !effort.values) return null;
  const value = effort.values[level];
  return value ? `${effort.option}=${value}` : null;
}

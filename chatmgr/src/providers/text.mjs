/**
 * Text extraction shared by the JSONL providers. Transcripts differ in shape
 * (Codex response_item, Claude message), so each adapter normalizes its own
 * records to {role, text} and this module only cleans them for display.
 */

const NOISE_PREFIXES = ["<permissions instructions>", "# AGENTS.md instructions", "<environment_context>"];

export function isInjected(text) {
  const head = String(text ?? "").trimStart();
  return NOISE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** Flattens a Claude/Codex content field (string or part array) to plain text. */
export function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("\n")
    .trim();
}

export function cleanTitle(text, max = 80) {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return "(untitled)";
  const plain = first.replace(/^#+\s*/, "").replace(/\s+/g, " ");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function renderTranscript(messages, limit = 30) {
  const tail = messages.slice(-limit);
  return tail
    .map((m) => `${m.role === "user" ? "▶" : "◀"} ${m.role}: ${String(m.text).trim()}`)
    .join("\n\n");
}

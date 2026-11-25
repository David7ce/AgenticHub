// redact.mjs — masks secrets before text reaches a transcript, registry entry or audit line.
//
// Pure and total: redact() and isSecretPath() accept any string, including the
// empty string, and never throw. Matching is by token shape, so a key pasted
// into a prompt or a log line is caught, not only one that a config file names.

// Each shape starts with a fixed prefix at a word boundary, so ordinary words
// such as "task-registry" are left alone.
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

const REDACTED = '[redacted]';
const ENV_FILE = /^\.env(\..+)?$/;
// A path token may be wrapped in opening brackets and followed by punctuation,
// as in "(.env)" or "cat .env;". The wrapping is kept, only the path is masked.
const WRAPPED_TOKEN = /^([([{<]*)(.*?)([;,:)\]}>.!?]*)$/;

/** True for a `.env` or `.env.<name>` file, but not the committed `.env.example` template. */
export function isSecretPath(path) {
  const base = path.split(/[\\/]/).pop();
  return ENV_FILE.test(base) && base !== '.env.example';
}

/** `text` with token shapes and `.env` file paths replaced by `[redacted]`. */
export function redact(text) {
  let out = text;
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out.replace(/[^\s'"`]+/g, (token) => {
    const [, lead, path, trail] = WRAPPED_TOKEN.exec(token);
    return isSecretPath(path) ? lead + REDACTED + trail : token;
  });
}

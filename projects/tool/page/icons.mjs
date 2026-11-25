// icons.mjs — marks that do not come from a repo's remote.
//
// Keys are normalised names (lowercase, alphanumerics only). Pinned owner
// avatars come from local/icons.json; `Works` is a local group and the fork
// projects share one mark.

import { OWNER_ICON_PINS } from '../lib/local.mjs';

const svg = (body) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`,
);

const FORK_MARK = svg(
  '<rect width="16" height="16" rx="4" fill="#2563eb"/>'
  + '<circle cx="5" cy="4" r="1.5" fill="#fff"/><circle cx="5" cy="12" r="1.5" fill="#fff"/>'
  + '<circle cx="11" cy="4" r="1.5" fill="#fff"/>'
  + '<path d="M5 5.5v5M5 8h3c2 0 3-1.5 3-4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
);

const WORKS_MARK = svg(
  '<rect width="16" height="16" rx="4" fill="#d97706"/>'
  + '<rect x="3.2" y="5.8" width="9.6" height="6.4" rx="1.2" fill="none" stroke="#fff" stroke-width="1.3"/>'
  + '<path d="M6 5.8V4.6c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v1.2" fill="none" stroke="#fff" stroke-width="1.3"/>'
  + '<path d="M3.2 8.2h9.6" stroke="#fff" stroke-width="1.1" opacity=".7"/>',
);

export const OWNER_ICONS = {
  ...OWNER_ICON_PINS,
  works: { src: WORKS_MARK, label: 'Works — local group' },
};

export const PROJECT_ICONS = {
  gitfork: { src: FORK_MARK, label: 'Git Fork — clone with commits of the local user' },
  gitclone: { src: FORK_MARK, label: 'Git Clone — reference clone of an upstream repo, no own commits' },
};

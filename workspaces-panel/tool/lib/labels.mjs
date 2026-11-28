// Display names only: repository identifiers and disk paths remain stable.
const WORDS = {
  ai: 'AI', api: 'API', cli: 'CLI', css: 'CSS', cv: 'CV', daw: 'DAW', html: 'HTML',
  http: 'HTTP', iptv: 'IPTV', it: 'IT', js: 'JS', json: 'JSON', mcp: 'MCP',
  ocr: 'OCR', os: 'OS', pkg: 'PKG', pkm: 'PKM', pwa: 'PWA', rss: 'RSS',
  saas: 'SaaS', sql: 'SQL', ssh: 'SSH', tui: 'TUI', tv: 'TV', ui: 'UI', xyz: 'XYZ',
  arksys: 'ArkSys', pkgbuilds: 'Pkgbuilds', mediahub: 'MediaHub',
  wikiterra: 'WikiTerra', compuwiki: 'CompuWiki', agentichub: 'AgenticHub',
  charstudio: 'CharStudio', recipesage: 'RecipeSage', recipebox: 'RecipeBox',
  github: 'GitHub', readme: 'README', audio2score: 'Audio2Score', jsgraph: 'JSGraph',
};

export function displayLabel(value) {
  return String(value ?? '').split('/').map((part) => {
    if (/^workspaces?[-_ ]panel$/i.test(part.trim())) return 'Workspaces Panel';
    const text = part.replace(/^\.github$/i, 'GitHub').replace(/\.github\.io$/i, ' GitHub.io');
    return text.split(/[-_\s]+/).filter(Boolean).map((word) => WORDS[word.toLowerCase()]
      ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }).filter(Boolean).join(' / ');
}

export function withDisplayLabels(row) {
  return { ...row, displayName: displayLabel(row.name), project: displayLabel(row.project) };
}

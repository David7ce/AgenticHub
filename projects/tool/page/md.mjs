// md.mjs — the small Markdown subset the working notes use, rendered to HTML.
//
// Headings (dropping the file's own `#` title), paragraphs, bullet and ordered
// lists nested by indentation, blockquotes, horizontal rules, **bold**, *italics*,
// `code`, [links](target), bare URLs, tables, fenced code blocks and `- [ ]` task
// items. Anything else is plain text: a renderer that guesses is worse than a small one.
//
// Two knobs, because the notes live on disk and link to each other and to repos:
//   idPrefix     every heading id gets this prefix, so two notes cannot collide.
//   resolveHref  rewrites a link target (relative paths become file:// URLs).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ESCAPES[c]);
const unescapeHtml = (text) => String(text).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/** `Carta natal/gematría` -> `carta-natal-gematria`. */
export function slugify(text) {
  return String(text)
    .replace(/`/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const FENCE = /^\s{0,3}```\s*([\w+-]*)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

// A table starts at a line with a pipe whose next line is the `---|---` separator.
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length
  && lines[i + 1].includes('-') && TABLE_SEPARATOR.test(lines[i + 1]);

/** Cells of a table row; a `|` inside a code span does not split. */
function splitRow(line) {
  const cells = [];
  let current = '';
  let inCode = false;
  for (const char of line.trim().replace(/^\|/, '')) {
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() || !line.trim().endsWith('|')) cells.push(current.trim());
  return cells;
}

const isBlockStart = (line) => HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
  || ITEM.test(line) || FENCE.test(line);

/**
 * @param source      Markdown text
 * @param options     { idPrefix, resolveHref }
 * @returns { html, headings: [{ level, text, id }] }
 */
export function renderMarkdown(source, { idPrefix = '', resolveHref = (href) => href } = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  // The page supplies the section title; a leading `# Title` would repeat it.
  if (lines.length && /^#\s+/.test(lines[0])) lines.shift();

  const used = new Set();
  const headings = [];
  const blocks = [];
  let index = 0;

  const anchor = (text) => {
    const base = `${idPrefix}${slugify(text)}` || `${idPrefix}seccion`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  // Inline: code spans first (they protect their content), then links, then
  // emphasis; the placeholders keep `**` inside a code span from becoming bold.
  const inline = (text) => {
    const codes = [];
    let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    const links = [];
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const url = resolveHref(unescapeHtml(href));
      links.push(`<a href="${escapeHtml(url)}">${label}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    });
    // Bare URLs; the `&amp;` of an escaped query stays as written.
    html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g,
      (_, lead, url) => `${lead}<a href="${url}">${url}</a>`);
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return html
      .replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)])
      .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  };

  const renderList = (nodes) => {
    let html = '';
    let tag = null;
    for (const node of nodes) {
      const want = node.ordered ? 'ol' : 'ul';
      if (tag !== want) {
        if (tag) html += `</${tag}>`;
        html += `<${want}>`;
        tag = want;
      }
      const task = node.text.match(TASK);
      const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
      html += `<li>${box}${inline(task ? task[2] : node.text)}${node.children.length ? renderList(node.children) : ''}</li>`;
    }
    if (tag) html += `</${tag}>`;
    return html;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      index += 1; // the closing fence; an unclosed one runs to the end of the text
      const lang = fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : '';
      blocks.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const head = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`;
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push(`<div class="table-wrap"><table><thead><tr>${head.map((t, i) => cell('th', t, i)).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((t, i) => cell('td', t, i)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      // The page already has an h1 (the shell title): a note's `#` is an h2.
      const depth = Math.min(6, heading[1].length + 1);
      const text = heading[2];
      const id = anchor(text);
      headings.push({ level: depth, text, id });
      blocks.push(`<h${depth} id="${escapeHtml(id)}">${inline(text)}</h${depth}>`);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(QUOTE, ''));
        index += 1;
      }
      const inner = renderMarkdown(quoted.join('\n'), { idPrefix, resolveHref }).html;
      blocks.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    if (ITEM.test(line)) {
      const items = [];
      while (index < lines.length) {
        const current = lines[index];
        const item = current.match(ITEM);
        if (item) {
          items.push({ indent: item[1].replace(/\t/g, '  ').length, ordered: /^\d/.test(item[2]), text: item[3] });
          index += 1;
          continue;
        }
        if (!current.trim()) {
          // A blank line inside a list keeps it one list when another item follows.
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          if (next < lines.length && ITEM.test(lines[next])) {
            index = next;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1].text += ` ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      // Flat items -> tree: an item belongs to the last item less indented than it.
      const root = [];
      const stack = [{ indent: -1, nodes: root }];
      for (const item of items) {
        while (item.indent <= stack[stack.length - 1].indent) stack.pop();
        const node = { ordered: item.ordered, text: item.text, children: [] };
        stack[stack.length - 1].nodes.push(node);
        stack.push({ indent: item.indent, nodes: node.children });
      }
      blocks.push(renderList(root));
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) && !isTableStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return { html: blocks.join('\n'), headings };
}

/** Each `###` (an h4 here) and what follows it, up to the next group or project, in an <article>. */
export function wrapProjects(html) {
  const out = [];
  let open = false;
  for (const block of html.split('\n')) {
    const startsProject = block.startsWith('<h4 ');
    if (open && (startsProject || block.startsWith('<h3 '))) {
      out.push('</article>');
      open = false;
    }
    if (startsProject) {
      out.push('<article class="proj">');
      open = true;
    }
    out.push(block);
  }
  if (open) out.push('</article>');
  return out.join('\n');
}

const LABELS = { 'Dueño': 'owner', 'Siguiente': 'next', 'Límite': 'limit', 'Después': 'later', 'Prioridad': 'priority' };

/** `**Dueño:**` and its siblings get a class, so the roadmap can colour who has the ball. */
export function tagLabels(html) {
  return html
    .replace(/<strong>(Dueño|Siguiente|Límite|Después|Prioridad):<\/strong>/g,
      (_, label) => `<strong class="tag tag-${LABELS[label]}">${label}:</strong>`)
    // `Prioridad: P1` -> a coloured pill, so the level reads at a glance.
    .replace(/(<strong class="tag tag-priority">Prioridad:<\/strong>)\s*(P[0-3])\b/g,
      (_, label, level) => `${label} <span class="prio prio-${level.toLowerCase()}">${level}</span>`);
}

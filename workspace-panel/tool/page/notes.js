// notes.js — the notes page: the shared shell plus section links that follow the scroll.

initShell({ tab: 'notes' });

(() => {
  const links = [...document.querySelectorAll('.notes-nav a')];
  const sections = links.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  if (!sections.length) return;

  const mark = () => {
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 70) current = section;
    }
    for (const link of links) {
      if (link.getAttribute('href') === `#${current.id}`) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };
  addEventListener('scroll', mark, { passive: true });
  addEventListener('hashchange', mark);
  mark();
})();

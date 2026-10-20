// The saved theme (and layout), applied before first paint: a classic script in <head>.
// '' is the default palette (each page's :root), 'strudel' is theme.css.
const THEME_STORE = 'strudelui-theme';
const THEME_COLOR = { '': '#0c0d0f', strudel: '#222222' }; // <meta name="theme-color">

function applyTheme(id) {
  if (id) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[id] ?? THEME_COLOR['']);
}

try {
  const saved = localStorage.getItem(THEME_STORE);
  if (saved in THEME_COLOR) applyTheme(saved);
} catch {}

// the layout too (settings.js: code below the sequencer, the default, or beside
// it), so the page doesn't jump after it loads
{
  let layout = 'below';
  try {
    layout = JSON.parse(localStorage.getItem('strudelui-settings'))?.layout ?? layout;
  } catch {}
  if (layout === 'below') document.documentElement.dataset.layout = 'below';
}

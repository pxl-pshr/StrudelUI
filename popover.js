// One floating panel at a time, anchored to the control that opened it:
// below it (above when there's more room there), kept on screen, and a
// bottom sheet on phones. Closes on a click outside, Esc, or when focus
// leaves it, and gives focus back to the anchor.

export const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const PHONE = 760; // matches the stylesheet's phone breakpoint
const MARGIN = 8;
let current = null;

export function popover(anchor, children, { className = '', label = '', role = 'dialog', onClose } = {}) {
  current?.close();
  const el = h('div', `pop ${className}`);
  el.setAttribute('role', role);
  if (label) el.setAttribute('aria-label', label);
  el.append(...children);
  document.body.append(el);
  anchor.setAttribute('aria-expanded', 'true');

  // the visible viewport, without scrollbars (innerWidth/Height include them)
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  if (vw < PHONE) el.classList.add('sheet');
  else {
    const a = anchor.getBoundingClientRect();
    const below = vh - a.bottom - MARGIN * 2;
    const above = a.top - MARGIN * 2;
    const down = below >= el.offsetHeight || below >= above;
    el.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
    el.style.left = `${Math.max(MARGIN, Math.min(a.left, vw - el.offsetWidth - MARGIN))}px`;
    if (down) el.style.top = `${a.bottom + 4}px`;
    else el.style.bottom = `${vh - a.top + 4}px`;
  }

  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const esc = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };
  // Tab out of the panel closes it (focus moving to the anchor doesn't)
  const left = (e) => {
    if (e.relatedTarget && !el.contains(e.relatedTarget) && e.relatedTarget !== anchor) close(false);
  };
  function close(refocus = true) {
    if (current?.el !== el) return;
    current = null;
    document.removeEventListener('pointerdown', outside, true);
    el.removeEventListener('keydown', esc);
    el.removeEventListener('focusout', left);
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus && anchor.isConnected) anchor.focus();
    onClose?.();
  }
  document.addEventListener('pointerdown', outside, true);
  el.addEventListener('keydown', esc);
  el.addEventListener('focusout', left);
  current = { el, close };
  return { el, close };
}

// a list of actions. items: { label, run, danger? }, or '-' for a divider between groups
export function menu(anchor, items, opts = {}) {
  anchor.setAttribute('aria-haspopup', 'menu');
  const children = items.map((item) => {
    if (item === '-') {
      const sep = h('div', 'menu-sep');
      sep.setAttribute('role', 'separator');
      return sep;
    }
    const { label, run, danger } = item;
    const b = h('button', `menu-item${danger ? ' danger' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => {
      pop.close();
      run();
    });
    return b;
  });
  const buttons = children.filter((el) => el.tagName === 'BUTTON');
  const pop = popover(anchor, children, { className: 'menu', role: 'menu', ...opts });
  buttons[0]?.focus();
  // ↑↓ between items
  pop.el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  return pop;
}

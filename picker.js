// Sound picker: search Strudel's registered sounds, audition, pick.
// ↑↓ browse (each one plays), ←→ variation, enter to use, esc to close.

import { catalog, audition, removeUserSound, restoreUserSound, bankName, hasSound } from './sounds.js';
import { popover, h } from './popover.js';

const MAX = 150;
let opened = 0; // for unique option ids

// current: { name, n, bank } of the track; note: pitch to audition with;
// onImport(done): opens the file dialog and calls done(names) with the sounds
// it added, which the list then shows and selects;
// onPreview(sound): try the sound in place of the current one (returns true
// when it did, and the one-shot audition is skipped); onPreview(null) when
// the picker closes without a pick, to put the original back
export function openPicker({ anchor, current, note, onPick, onStatus, onImport, onPreview }) {
  let items = catalog();
  const kitName = current.bank ? bankName(current.bank) : null; // full name, even if the code uses an alias
  const sameKey = (i) => i.name === current.name && (i.bank ?? '').toLowerCase() === (kitName ?? '').toLowerCase();

  const search = h('input', 'picker-search');
  Object.assign(search, { type: 'search', placeholder: `search ${items.length} sounds`, spellcheck: false });
  search.setAttribute('aria-label', 'search sounds');
  const list = h('div', 'picker-list');
  list.setAttribute('role', 'listbox');
  list.id = `sounds-${++opened}`;
  search.setAttribute('aria-controls', list.id);
  const foot = h('div', 'picker-foot');
  const hint = h('span', '', '↑↓ listen · ←→ variation');
  const useBtn = h('button', 'link', 'use');
  useBtn.type = 'button';
  foot.append(hint);
  if (onImport) {
    const importBtn = h('button', 'link', 'import files…');
    importBtn.type = 'button';
    importBtn.title = 'add audio files to your samples';
    importBtn.addEventListener('click', () =>
      onImport((names) => {
        if (!pop?.el.isConnected || !names.length) return;
        items = catalog();
        search.value = '';
        render();
        const idx = shown.findIndex((i) => i.group === 'yours' && i.name === names[0]);
        if (idx !== -1) select(idx, true);
        search.focus();
      }),
    );
    foot.append(importBtn);
  }
  foot.append(useBtn);
  let pop = null;
  let picked = false;
  const close = () => pop?.close();
  const listen = () => onPreview?.(sound()) || audition(sound(), note);

  let shown = []; // selectable items in display order
  let sel = -1;
  let n = 0;

  function sections(q) {
    if (!q) {
      const kit = kitName ? items.filter((i) => i.bank?.toLowerCase() === kitName.toLowerCase()) : [];
      const elsewhere = items.filter((i) => i.bank && i.name === current.name && !kit.includes(i)).slice(0, 40);
      return [
        ['yours', items.filter((i) => i.group === 'yours')],
        [kitName ? `this kit · ${kitName}` : '', kit],
        [`${current.name} in other kits`, elsewhere],
        ['synths', items.filter((i) => i.group === 'synths')],
      ].filter(([, list]) => list.length);
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = items.filter((i) => {
      const text = `${i.bank ?? ''} ${i.name} ${i.group}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const rank = (i) => (i.name === words[0] ? 0 : i.name.startsWith(words[0]) ? 1 : 2);
    hits.sort((a, b) => rank(a) - rank(b) || a.key.length - b.key.length || a.key.localeCompare(b.key));
    return [['', hits.slice(0, MAX)], ...(hits.length > MAX ? [[`${hits.length - MAX} more · keep typing`, []]] : [])];
  }

  function render() {
    const q = search.value.trim();
    list.replaceChildren();
    shown = [];
    for (const [title, group] of sections(q)) {
      if (title) list.append(h('div', 'picker-group', title));
      for (const item of group) {
        const idx = shown.push(item) - 1;
        const row = h('div', 'snd');
        row.setAttribute('role', 'option');
        row.id = `${list.id}-${idx}`;
        row.dataset.idx = idx;
        row.append(h('span', 'snd-name', item.name));
        row.append(h('span', 'snd-meta', where(item)));
        if (item.group === 'yours') {
          const del = h('button', 'snd-del', '×');
          del.type = 'button';
          del.title = `remove ${item.name} from your samples`;
          del.setAttribute('aria-label', `remove ${item.name} from your samples`);
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const rec = await removeUserSound(item.name);
              items.splice(items.indexOf(item), 1);
              const back = hasSound(item.name); // a built-in it had replaced
              onStatus(`removed ${item.name} · ${back ? `the built-in ${item.name} plays again` : 'tracks using it go quiet'}`, false, rec && { label: 'undo', run: () => restoreUserSound(rec) });
              render();
            } catch (err) {
              onStatus(`couldn't remove ${item.name}: ${err.message ?? err}`, true);
            }
            search.focus();
          });
          row.append(del);
        }
        // clicking the ‹ › of the selected row steps variations; any other
        // click selects (and plays) the row. Keys stay with the search box.
        row.addEventListener('click', (e) => {
          const meta = e.target.closest('.snd-meta');
          if (sel === idx && meta && item.count > 1) {
            const r = meta.getBoundingClientRect();
            n = (n + (e.clientX < r.left + r.width / 2 ? -1 : 1) + item.count) % item.count;
            showVariation();
            listen();
          } else select(idx, true);
          search.focus();
        });
        row.addEventListener('dblclick', () => pick());
        list.append(row);
      }
    }
    if (!shown.length) list.append(h('div', 'picker-empty', 'no sounds match'));
    const start = shown.findIndex(sameKey);
    select(start !== -1 ? start : shown.length ? 0 : -1, false, start !== -1 ? current.n : 0);
  }

  function select(idx, play, variation = 0) {
    sel = idx;
    n = variation;
    for (const row of list.querySelectorAll('.snd')) {
      const on = Number(row.dataset.idx) === sel;
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', on);
      if (on) {
        row.scrollIntoView({ block: 'nearest' });
        search.setAttribute('aria-activedescendant', row.id);
      }
    }
    showVariation();
    if (play && shown[sel]) listen();
  }

  const where = (item) => [item.bank ?? item.group, item.count > 1 ? `×${item.count}` : ''].filter(Boolean).join(' ');

  // the selected row swaps its count for a ‹ variation › stepper
  function showVariation() {
    for (const row of list.querySelectorAll('.snd')) {
      const item = shown[Number(row.dataset.idx)];
      const on = Number(row.dataset.idx) === sel && item.count > 1;
      row.querySelector('.snd-meta').textContent = on ? `${item.bank ?? item.group} ‹ ${n + 1}/${item.count} ›` : where(item);
    }
  }

  const sound = () => ({ name: shown[sel].name, n, bank: shown[sel].bank });

  function pick() {
    if (!shown[sel]) return;
    picked = true;
    onPick(sound());
    close();
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    const item = shown[sel];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      select((sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length, true);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && item?.count > 1) {
      e.preventDefault();
      n = (n + (e.key === 'ArrowRight' ? 1 : -1) + item.count) % item.count;
      showVariation();
      listen();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick();
    }
  });
  useBtn.addEventListener('click', pick);

  render(); // before opening, so the panel is placed at its real height
  pop = popover(anchor, [search, list, foot], {
    className: 'picker',
    label: 'pick a sound',
    onClose: () => picked || onPreview?.(null),
  });
  search.focus();
  list.querySelector('.snd.sel')?.scrollIntoView({ block: 'nearest' });
  return { close };
}


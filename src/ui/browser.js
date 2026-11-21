// Photo browser: pick a folder (for example the camera card) and show its
// photos as a strip of thumbnails. The folder is remembered between visits.
import LibRaw from 'libraw-wasm-nothread';
import { el } from './controls.js';

const RAW = /\.(nef|nrw|dng|cr2|cr3|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|mrw)$/i;
const BITMAP = /\.(jpe?g|png|webp)$/i;
const THUMB = 168;                       // longest thumbnail edge, in pixels

/* Tiny key-value store for the remembered folder handle. */
function store(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('photolab', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const req = fn(open.result.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (err) { reject(err); }
    };
  });
}
const remember = (handle) => store('readwrite', (s) => s.put(handle, 'folder')).catch(() => {});
const remembered = () => store('readonly', (s) => s.get('folder')).catch(() => null);

// Photos in a folder and its subfolders (camera cards nest them under DCIM).
async function listPhotos(dir, depth = 0, out = []) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && (RAW.test(entry.name) || BITMAP.test(entry.name))) out.push(entry);
    else if (entry.kind === 'directory' && depth < 4 && !entry.name.startsWith('.')) await listPhotos(entry, depth + 1, out);
  }
  return out;
}

export function initBrowser({ node, openFile, toast, hasEdits }) {
  const supported = !!window.showDirectoryPicker;
  let items = [];                        // { name, getFile, file?, li, img }
  let current = null, decoder = null, queue = Promise.resolve(), generation = 0;

  const title = el('span', { class: 'strip-title' });
  const list = el('ul', { class: 'strip-list' });
  node.append(el('div', { class: 'strip-head' }, title,
    supported ? el('button', { class: 'link', type: 'button', onclick: () => pickFolder() }, 'Change folder') : null,
    el('button', { class: 'link', type: 'button', title: 'Hide the photo strip', 'aria-label': 'Hide the photo strip', onclick: () => { node.hidden = true; } }, '×')), list);

  // Thumbnails are produced one at a time, only for items scrolled into view.
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      const item = items.find((i) => i.li === e.target);
      if (item) { const g = generation; queue = queue.then(() => (g === generation ? loadThumb(item) : null)); }
    }
  }, { root: list, rootMargin: '0px 400px' });

  async function thumbBitmap(file) {
    if (BITMAP.test(file.name)) return { bitmap: await createImageBitmap(file, { resizeWidth: THUMB * 2, imageOrientation: 'from-image' }), flip: 0 };
    // RAW files carry a JPEG preview made by the camera; read that instead of developing the photo.
    decoder ||= new LibRaw();
    await decoder.open(new Uint8Array(await file.arrayBuffer()), {});
    const [meta, thumb] = [await decoder.metadata(false), await decoder.thumbnailData()];
    if (!thumb?.data || thumb.format !== 'jpeg') throw new Error('no preview');
    const bitmap = await createImageBitmap(new Blob([thumb.data], { type: 'image/jpeg' }), { resizeWidth: THUMB * 2 });
    return { bitmap, flip: meta?.flip || 0 };
  }

  async function loadThumb(item) {
    try {
      item.file ||= await item.getFile();
      const { bitmap, flip } = await thumbBitmap(item.file);
      const turned = flip === 5 || flip === 6;                  // portrait: preview is stored sideways
      const k = THUMB / Math.max(bitmap.width, bitmap.height);
      const w = Math.round(bitmap.width * k), h = Math.round(bitmap.height * k);
      const c = el('canvas', { width: turned ? h : w, height: turned ? w : h }), ctx = c.getContext('2d');
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate({ 3: Math.PI, 5: -Math.PI / 2, 6: Math.PI / 2 }[flip] || 0);
      ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
      bitmap.close();
      item.img.replaceChildren(c);
      item.li.classList.toggle('edited', hasEdits(item.file));
    } catch {
      item.img.replaceChildren(el('span', { class: 'nothumb' }, 'No preview'));
    }
  }

  function markCurrent() {
    for (const i of items) i.li.classList.toggle('current', !!current && i.name === current.name && (!i.file || i.file.size === current.size));
  }

  // Show a set of photos. Each entry needs `name` and `getFile()`.
  async function show(entries, label) {
    generation++;
    observer.disconnect();
    const withTime = await Promise.all(entries.map(async (e) => {
      try { const file = await e.getFile(); return { name: e.name, getFile: () => e.getFile(), file, time: file.lastModified }; } catch { return null; }
    }));
    items = withTime.filter(Boolean).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));   // newest first
    list.replaceChildren(...items.map((item) => {
      item.img = el('span', { class: 'thumb' });
      const open = async () => {
        try { item.file = await item.getFile(); openFile(item.file); } catch { toast('That photo can no longer be read. Is the card still inserted?', true); }
      };
      item.li = el('li', {}, el('button', { type: 'button', title: item.name, onclick: open }, item.img, el('span', { class: 'cap' }, item.name)));
      return item.li;
    }));
    title.textContent = `${label}  ·  ${items.length} photo${items.length === 1 ? '' : 's'}, newest first`;
    node.hidden = false;
    list.scrollLeft = 0;
    for (const i of items) observer.observe(i.li);
    markCurrent();
    return items.length;
  }

  async function showFolder(handle) {
    const entries = await listPhotos(handle);
    const n = await show(entries, handle.name || 'Folder');
    if (!n) toast('No photos found in that folder.', true);
    return n;
  }

  async function pickFolder() {
    if (!supported) { toast('Browsing a folder needs Chrome or Edge.', true); return; }
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'photolab-card', mode: 'read' }); } catch { return; }
    try { await showFolder(handle); remember(handle); } catch (err) { toast('Could not read that folder. ' + (err.message || ''), true); }
  }

  // Reopen the remembered folder. Must be called from a click: the browser asks
  // the user to confirm access again after a restart.
  async function reopen() {
    const handle = await remembered();
    if (!handle) return pickFolder();
    try {
      if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
      await showFolder(handle);
    } catch {
      toast(`"${handle.name}" is not available. Insert the card, or choose another folder.`, true);
      pickFolder();
    }
  }

  return {
    supported, pickFolder, reopen, show,
    rememberedName: async () => (await remembered())?.name || null,
    setCurrent: (file) => { current = file; markCurrent(); },
    refreshEdited: () => { for (const i of items) if (i.file) i.li.classList.toggle('edited', hasEdits(i.file)); },
    step: (d) => {                      // open the next or previous photo in the strip
      const at = items.findIndex((i) => i.li.classList.contains('current'));
      const next = items[at + d];
      if (at >= 0 && next) { next.li.scrollIntoView({ inline: 'nearest', block: 'nearest' }); next.li.querySelector('button').click(); }
    },
  };
}

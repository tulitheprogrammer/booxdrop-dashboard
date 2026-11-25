/* BooxDrop dashboard — talks to the device's own REST API.
   Verified against EasyTransfer v1.33 on TabX (Android 11).
   Listing:  GET /api/storage?args={"dir":"<path>","refresh":true}
   Download: GET /api/storage/file?args=<path>
   Upload:   POST /api/storage/upload?args={"dir":"<path>"} (multipart "file")
   Delete:   DELETE /api/storage/delete?args={"path":"<path>"}  (server-cached; WS is what the app uses)
*/
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  base: localStorage.getItem('boox.base') || 'http://192.0.2.10:8085',
  view: 'overview',
  path: '/storage/emulated/0',
  entries: [],
  mediaType: 'Recent',
  online: false,
};

/* Formats the in-app reader can open */
const READABLE = /\.(pdf|epub)$/i;

/* Short uppercase extension for the thumbnail badge ("pdf", "EPUB", ...). */
const fileExt = (name) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
};

const ICON = {  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 3v4.5h4.5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M4 19h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/></svg>',
  img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4.5 4.5L9 13l-6 6"/></svg>',
};

const fmtSize = (b) => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms), diff = (Date.now() - ms) / 86400000;
  if (diff < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 365) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short' });
};

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="d"></span><span></span>`;
  el.lastChild.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }, 3200);
}

function setConn(up, label) {
  const dot = $('#dot'), txt = $('#connTxt');
  dot.className = 'dot ' + (up ? 'up' : 'down');
  txt.textContent = label ?? (up ? 'Connected' : 'Offline');
  state.online = up;
}

/* ---------------- API ---------------- */
const enc = (o) => encodeURIComponent(typeof o === 'string' ? o : JSON.stringify(o));

/* ---------------- cache ----------------
   The device is slow: /api/library/tree alone takes ~1.6 s, and the library
   view needs 36 per-shelf calls on top of it. Responses are mirrored into
   localStorage so the UI paints instantly from the last known state, then
   revalidated in the background ("stale-while-revalidate").
   Cached JSON is keyed by full URL, so a change of device invalidates it. */
const CACHE_PREFIX = 'boox.cache.v1:';
const CACHE_TTL = 5 * 60 * 1000;      // serve from cache without revalidating
const mem = new Map();

function cacheGet(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    mem.set(key, rec);
    return rec;
  } catch { return null; }
}

function cacheSet(key, data) {
  const rec = { t: Date.now(), data };
  mem.set(key, rec);
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(rec));
  } catch {
    // Quota exceeded — drop the oldest half and retry once.
    try {
      pruneCache(0.5);
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(rec));
    } catch { /* give up silently; cache is an optimisation */ }
  }
}

function pruneCache(keepFraction = 0.6) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) {
      let t = 0;
      try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch {}
      keys.push([k, t]);
    }
  }
  keys.sort((a, b) => a[1] - b[1]);           // oldest first
  const drop = Math.floor(keys.length * (1 - keepFraction));
  for (let i = 0; i < drop; i++) {
    localStorage.removeItem(keys[i][0]);
    mem.delete(keys[i][0].slice(CACHE_PREFIX.length));
  }
  return drop;
}

function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  mem.clear();
  return keys.length;
}

/* Version the key when the device URL changes so stale hosts never mix. */
const cacheKey = (url) => `${state.base}|${url}`;

async function api(path, { args, raw, cache = false, ttl = CACHE_TTL } = {}) {
  const url = state.base.replace(/\/$/, '') + path + (args !== undefined ? `?args=${enc(args)}` : '');
  if (raw) {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r;
  }
  if (!cache) {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  const key = cacheKey(url);
  const hit = cacheGet(key);
  const fresh = hit && Date.now() - hit.t < ttl;

  if (fresh) return hit.data;

  if (hit) {
    // Return stale data now, refresh in the background.
    revalidate(url, key).catch(() => {});
    return hit.data;
  }

  return revalidate(url, key);
}

const inflight = new Map();
function revalidate(url, key) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fetch(url, { mode: 'cors' })
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json();
    })
    .then((data) => {
      cacheSet(key, data);
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}


/* Mutations (upload/delete/folder) make the cached library + media stale, so
   drop them and let the next load refetch. Cheap: only matching keys go. */
function invalidateLibrary() {
  const killed = [];
  for (let i = localStorage.length; i--;) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CACHE_PREFIX)) continue;
    const body = k.slice(CACHE_PREFIX.length);
    if (body.includes('/api/library') || body.includes('/api/media') || body.includes('/api/device')) {
      killed.push(k);
    }
  }
  killed.forEach((k) => {
    localStorage.removeItem(k);
    mem.delete(k.slice(CACHE_PREFIX.length));
  });
  aggCache = null;
  return killed.length;
}

async function ping() {
  try {
    const r = await fetch(state.base + '/api/ping', { mode: 'cors' });
    const t = await r.text();
    if (t.trim() === 'ok') { setConn(true); return true; }
    setConn(false); return false;
  } catch { setConn(false); return false; }
}

const listDir = (dir) => api('/api/storage', { args: { dir, refresh: true } });
const getDevice = () => api('/api/device', { cache: true });
const getMedia = () => api('/api/media', { cache: true });
const getMediaList = (mediaType, size = 500) =>
  api('/api/media/list', { args: { mediaType, sortBy: 'CreationTime', page: 0, size }, cache: true });
/* Library metadata is slow on the device (~1.6 s for the tree alone), so these
   are cached and served stale-while-revalidate. */
const getLibraryTree = () => api('/api/library/tree', { cache: true });
/* Books are paged with limit/offset (NOT page/size), and a shelf is selected
   with libraryUniqueId = the shelf's library.idString. Passing page/size works
   but silently ignores shelf filtering and always returns the same 19 books. */
const getLibrary = (libraryUniqueId = null, offset = 0, limit = 60) =>
  api('/api/library', {
    args: { limit, offset, sortBy: 'CreationTime', order: 'Desc', libraryUniqueId },
    cache: true,
  });
const thumbURL = (p) => `${state.base}/api/storage/thumbnail?args=${enc(p)}`;
const fileURL = (p) => `${state.base}/api/storage/file?args=${enc(p)}`;
/* Delete/Rename take `args` as a PLAIN PATH STRING, not a JSON object.
   Sending {"path":...} returns successful:true but does nothing. */
async function deletePath(p) {
  const r = await fetch(`${state.base}/api/storage/delete?args=${enc(p)}`, { method: 'DELETE' });
  return r.json();
}
async function makeFolder(dir, name) {
  const r = await fetch(`${state.base}/api/storage/directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: dir, name }),
  });
  return r.json();
}

/* Upload (multipart). The destination MUST be a form field named "dir" —
   a query param is silently ignored and the file lands in Books/. */
function uploadFile(file, dir, onProgress) {
  return new Promise((resolve, reject) => {
    const url = `${state.base}/api/storage/upload`;
    const fd = new FormData();
    fd.append('dir', dir);
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round(e.loaded / e.total * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve(safeJSON(xhr.responseText)) : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(fd);
  });
}
const safeJSON = (t) => { try { return JSON.parse(t); } catch { return t; } };

/* ---------------- views ---------------- */
function showView(v) {
  state.view = v;
  $$('.view').forEach((e) => e.classList.toggle('on', e.id === 'v-' + v));
  $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const titles = { overview: 'Overview', files: 'Files', library: 'Library', media: 'Media', transfer: 'Transfer' };
  $('#pageTitle').textContent = titles[v] || v;
  if (v === 'overview') loadOverview();
  if (v === 'files') loadFiles();
  if (v === 'library') loadLibrary();
  if (v === 'media') loadMedia();
  if (v === 'transfer') renderDest();
}

async function loadOverview() {
  const recent = $('#ovRecent');
  recent.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try {
    const [dev, root, media, tree] = await Promise.all([
      getDevice().catch(() => null),
      listDir('/storage/emulated/0').catch(() => null),
      getMedia().catch(() => []),
      getLibraryTree().catch(() => null),
    ]);
    if (dev) {
      $('#brandModel').textContent = dev.model || 'TabX';
      const total = parseSize(dev.storageTotal), used = parseSize(dev.storageUsed);
      const pct = total ? Math.round(used / total * 100) : 0;
      $('#ovUsed').innerHTML = `${dev.storageUsed || '—'}<small>/ ${dev.storageTotal || '—'}</small>`;
      $('#ovBar').style.width = pct + '%';
      $('#ovFree').textContent = total ? `${pct}% used · ${fmtSize(total - used)} free` : '—';
      setConn(true, dev.nickname || 'Connected');
    }
    if (media?.length) {
      const totalMedia = media.reduce((a, m) => a + (m.count || 0), 0);
      $('#ovMedia').textContent = totalMedia.toLocaleString();
      $('#ovMediaMeta').textContent = media.filter(m => m.count).map(m => `${m.name} ${m.count}`).join(' · ');
    }
    if (tree) {
      const books = tree.children.reduce((a, c) => a + (c.bookCount || 0), 0);
      $('#ovBooks').textContent = books.toLocaleString();
      $('#ovShelves').textContent = `${tree.children.length} shelves`;
      $('#libBadge').textContent = books;
    }
    if (root) {
      const d = root.data || root;
      $('#ovFiles').textContent = (d.count ?? d.list?.length ?? 0).toLocaleString();
      $('#ovFilesMeta').textContent = `${d.folderCount ?? 0} folders · ${d.fileCount ?? 0} files`;
      recent.innerHTML = '';
      (d.list || []).slice(0, 8).forEach((e) => recent.appendChild(fileRow(e, false)));
      if (!d.list?.length) recent.innerHTML = emptyBox('No files at root');
    }
  } catch (e) {
    recent.innerHTML = emptyBox('Could not load — check the address and connect');
    setConn(false);
  }
}

const parseSize = (s) => {
  if (!s) return 0;
  const m = String(s).match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return parseFloat(m[1]) * mult[m[2].toUpperCase()];
};

function emptyBox(msg, icon = ICON.img) {
  return `<div class="empty">${icon}<div>${msg}</div></div>`;
}

function fileRow(e, withActions = true) {
  const row = document.createElement('div');
  row.className = 'row' + (e.dir ? ' dir' : '');
  row.innerHTML = `
    <span class="ico">${e.dir ? ICON.folder : ICON.file}</span>
    <span class="nm"></span>
    <span class="sz">${e.dir ? '—' : fmtSize(e.size)}</span>
    <span class="dt">${fmtDate(e.updatedAt)}</span>
    <span class="act"></span>`;
  row.querySelector('.nm').textContent = e.name;
  row.querySelector('.nm').onclick = () => {
    if (e.dir) { state.path = e.path; showView('files'); }
    else if (READABLE.test(e.name)) window.BooxReader.open(e.path, e.name);
    else window.open(fileURL(e.path), '_blank');
  };
  const act = row.querySelector('.act');
  if (withActions) {
    if (!e.dir) {
      const dl = document.createElement('button');
      dl.innerHTML = ICON.download; dl.title = 'Download';
      dl.onclick = (ev) => {
        ev.stopPropagation();
        const a = document.createElement('a');
        a.href = fileURL(e.path); a.download = e.name; a.click();
        toast(`Downloading ${e.name}`, 'info');
      };
      act.appendChild(dl);
    }
    const del = document.createElement('button');
    del.innerHTML = ICON.trash; del.title = 'Delete';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${e.name}" from the device?`)) return;
      try {
        const r = await deletePath(e.path);
        if (r.successful === false) throw new Error(r.message || 'failed');
        invalidateLibrary();
        toast(`Deleted ${e.name}`, 'ok');
        loadFiles();
      } catch { toast(`Could not delete ${e.name}`, 'err'); }
    };
    act.appendChild(del);
  }
  return row;
}

async function loadFiles() {
  const box = $('#filesBox');
  box.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  renderCrumbs();
  try {
    const r = await listDir(state.path);
    const d = r.data || r;
    state.entries = d.list || [];
    box.innerHTML = '';
    const q = $('#fileSearch').value.toLowerCase().trim();
    const items = state.entries
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    items.forEach((e) => box.appendChild(fileRow(e)));
    if (!items.length) box.innerHTML = emptyBox(q ? 'No matches' : 'This folder is empty');
  } catch (e) {
    box.innerHTML = emptyBox('Could not read this folder');
    toast('Failed to list folder', 'err');
  }
}

function renderCrumbs() {
  const box = $('#crumbs');
  box.innerHTML = '';
  const parts = state.path.split('/').filter(Boolean);
  let acc = '';
  const rootBtn = document.createElement('button');
  rootBtn.textContent = 'Internal storage';
  rootBtn.onclick = () => { state.path = '/storage/emulated/0'; showView('files'); };
  box.appendChild(rootBtn);
  parts.slice(3).forEach((p, i, arr) => {
    acc += '/' + p;
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '/';
    box.appendChild(sep);
    if (i === arr.length - 1) {
      const cur = document.createElement('span');
      cur.className = 'cur'; cur.textContent = p;
      box.appendChild(cur);
    } else {
      const b = document.createElement('button');
      b.textContent = p;
      const target = '/storage/emulated/0' + acc;
      b.onclick = () => { state.path = target; showView('files'); };
      box.appendChild(b);
    }
  });
}


state.shelf = 'all';
state.books = [];
state.libOffset = 0;
state.libTotal = 0;

async function loadLibrary() {
  const shelves = $('#shelves'), grid = $('#books');
  grid.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  shelves.innerHTML = '';
  try {
    const tree = await getLibraryTree();
    state.shelves = tree.children
      .map((c) => ({
        name: c.library?.name || 'Untitled',
        bookCount: c.bookCount || 0,
        uid: c.library?.idString || null,
        cover: c.library?.coverPath || '',
      }))
      .filter((s) => s.bookCount > 0)
      .sort((a, b) => b.bookCount - a.bookCount);
    const total = state.shelves.reduce((a, c) => a + c.bookCount, 0);
    const chips = [{ name: 'All books', bookCount: total, uid: 'all' }].concat(state.shelves);
    chips.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip' + (c.uid === state.shelf ? ' on' : '');
      b.innerHTML = `${escapeHTML(c.name)} <em>${c.bookCount ?? 0}</em>`;
      b.onclick = () => {
        state.shelf = c.uid;
        $$('.chip', shelves).forEach((x) => x.classList.toggle('on', x === b));
        loadShelf();
      };
      shelves.appendChild(b);
    });
    await loadShelf();
  } catch (e) {
    grid.innerHTML = emptyBox('Could not load library');
  }
}

/* The API's `limit` is a SHARED budget across the 39 shelves AND the books, and
   the book list for `libraryUniqueId:null` is greedy/reverse-sorted, so "all books"
   cannot be paged — it would return a handful and never change. Fetch every shelf
   separately instead and merge. Each shelf is small (max ~39), so limit=300 is safe. */
const SHELF_LIMIT = 300;

/* Aggregation cache: the "all books" view needs 36 shelf responses, so keep the
   merged result in memory keyed by the shelf list. Cache entries already hold
   the raw responses; this avoids re- merging on every visit. */
let aggCache = null; // { sig, books }

const shelvesSig = () => state.shelves.map((s) => s.uid).join(',');

/* Render immediately from cached per-shelf data if anything is available. */
function paintFromCache() {
  if (!state.shelves.length) return false;
  const lists = state.shelves.map((s) => {
    const url = `${state.base}/api/library?args=${enc({
      limit: SHELF_LIMIT, offset: 0, sortBy: 'CreationTime',
      order: 'Desc', libraryUniqueId: s.uid,
    })}`;
    return cacheGet(cacheKey(url));
  });
  if (!lists.some(Boolean)) return false;
  if (state.shelf === 'all') {
    const seen = new Set();
    const books = [];
    lists.forEach((hit) => {
      if (!hit) return;
      (hit.data.visibleBookList || []).forEach((b) => {
        const k = b.metadata?._id || b.name;
        if (k && !seen.has(k)) { seen.add(k); books.push(b); }
      });
    });
    if (!books.length) return false;
    books.sort((a, b) => (b.metadata?.createdAt || '').localeCompare(a.metadata?.createdAt || ''));
    state.books = books;
    state.libTotal = books.length;
  } else {
    const shelf = state.shelves.find((s) => s.uid === state.shelf);
    if (!shelf) return false;
    const url = `${state.base}/api/library?args=${enc({
      limit: SHELF_LIMIT, offset: 0, sortBy: 'CreationTime',
      order: 'Desc', libraryUniqueId: state.shelf,
    })}`;
    const hit = cacheGet(cacheKey(url));
    if (!hit) return false;
    state.books = hit.data.visibleBookList || [];
    state.libTotal = hit.data.bookCount ?? state.books.length;
  }
  renderBooks();
  return true;
}

async function loadShelf() {
  const grid = $('#books');
  // Paint cached results instantly so the view never blocks on the device.
  const painted = paintFromCache();
  if (!painted) {
    grid.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  }
  try {
    if (state.shelf === 'all') {
      const results = await Promise.all(
        state.shelves.map((s) =>
          getLibrary(s.uid, 0, SHELF_LIMIT).catch(() => ({ visibleBookList: [] })))
      );
      const seen = new Set();
      state.books = [];
      results.forEach((r) => {
        (r.visibleBookList || r.data?.visibleBookList || []).forEach((b) => {
          const key = b.metadata?._id || b.name;
          if (key && !seen.has(key)) { seen.add(key); state.books.push(b); }
        });
      });
      state.books.sort((a, b) => (b.metadata?.createdAt || '').localeCompare(a.metadata?.createdAt || ''));
      state.libTotal = state.books.length;
    } else {
      const r = await getLibrary(state.shelf, 0, SHELF_LIMIT);
      state.books = r.visibleBookList || r.data?.visibleBookList || [];
      state.libTotal = r.bookCount ?? state.books.length;
    }
    renderBooks();
  } catch {
    grid.innerHTML = emptyBox('Could not load books');
  }
}

function coverFor(b) {
  if (b.coverPath) return thumbURL(b.coverPath);
  const mc = b.metadata?.bookCovers;
  if (mc && typeof mc === 'object') {
    const first = Object.values(mc).find((v) => typeof v === 'string' && v);
    if (first) return thumbURL(first);
  }
  return null;
}

function renderBooks() {
  const grid = $('#books');
  grid.innerHTML = '';
  if (!state.books.length) { grid.innerHTML = emptyBox('No books on this shelf'); return; }
  state.books.forEach((b) => {
    const name = b.name || b.metadata?._id?.split('/').pop() || 'Untitled';
    const clean = name.replace(/\.(pdf|epub|mobi|azw3?|fb2|djvu|cbz|cbr)$/i, '');
    const author = (b.metadata?.authorList || []).join(', ');
    const pct = parseInt(b.progressPercent) || 0;
    const cover = coverFor(b);
    const el = document.createElement('div');
    el.className = 'book';
    el.title = name;
    el.innerHTML = `
      <div class="cover">
        ${cover ? `<img loading="lazy" alt="" src="${cover}">` : '<div class="t"></div>'}
        <span class="fmt">${escapeHTML(fileExt(name))}</span>
        ${pct ? `<div class="pr"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="cap"><b></b><span></span></div>`;
    if (!cover) el.querySelector('.t').textContent = clean;
    el.querySelector('.cap b').textContent = clean;
    el.querySelector('.cap span').textContent = author || b.progressPercent || 'Not started';
    el.onclick = () => {
      const p = b.metadata?._id;
      if (p) window.BooxReader.open(p, name);
      else toast('No file path available', 'err');
    };
    grid.appendChild(el);
  });
}

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadMedia() {
  const chips = $('#mediaChips'), box = $('#mediaBox');
  box.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  try {
    const cats = await getMedia();
    chips.innerHTML = '';
    cats.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip' + (c.type === state.mediaType ? ' on' : '');
      b.innerHTML = `${escapeHTML(c.name)} <em>${c.count}</em>`;
      b.onclick = () => { state.mediaType = c.type; loadMedia(); };
      chips.appendChild(b);
    });
    const r = await getMediaList(state.mediaType);
    const items = (r.data || r).list || [];
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = emptyBox('Nothing here yet'); return; }
    const grid = document.createElement('div');
    grid.className = 'tiles';
    items.forEach((e) => {
      const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(e.name);
      const t = document.createElement('div');
      t.className = 'tile';
      t.innerHTML = `
        <div class="thumb">${isImg
          ? `<img loading="lazy" src="${thumbURL(e.thumbnail || e.path)}" alt="">`
          : ICON.file}
          <span class="fmt">${escapeHTML(fileExt(e.name))}</span></div>
        <div class="cap"><b></b><span>${fmtSize(e.size)}</span></div>`;
      t.querySelector('.cap b').textContent = e.name;
      t.onclick = () => {
        if (READABLE.test(e.name)) window.BooxReader.open(e.path, e.name);
        else window.open(fileURL(e.path), '_blank');
      };
      grid.appendChild(t);
    });
    box.appendChild(grid);
  } catch { box.innerHTML = emptyBox('Could not load media'); }
}

/* ---------------- transfer ---------------- */
function renderDest() {
  $('#upDest').textContent = state.path;
}
async function doUpload(files) {
  const list = [...files];
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'up';
    row.innerHTML = `<span class="n"></span><span class="p">0%</span><span></span>`;
    row.querySelector('.n').textContent = f.name;
    $('#ups').prepend(row);
    const pct = row.querySelector('.p');
    try {
      await uploadFile(f, state.path, (p) => { pct.textContent = p + '%'; });
      row.classList.add('done'); pct.textContent = 'done';
      invalidateLibrary();
      toast(`Sent ${f.name}`, 'ok');
    } catch (e) {
      row.classList.add('err'); pct.textContent = 'failed';
      toast(`Failed: ${f.name}`, 'err');
    }
  }
  if (state.view === 'files') loadFiles();
}

/* ---------------- wire up ---------------- */
function boot() {
  $('#base').value = state.base.replace(/^https?:\/\//, '');
  $$('.nav button').forEach((b) => b.onclick = () => showView(b.dataset.view));
  $('#btnConnect').onclick = async () => {
    let v = $('#base').value.trim().replace(/^https?:\/\//, '');
    if (!/:\d+$/.test(v)) v += ':8085';
    state.base = 'http://' + v;
    localStorage.setItem('boox.base', state.base);
    toast('Connecting…', 'info');
    if (await ping()) { toast('Connected', 'ok'); showView(state.view); }
    else toast('No response from device', 'err');
  };
  $('#fileSearch').oninput = () => loadFiles();
  $('#btnNewFolder').onclick = async () => {
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    try {
      const r = await makeFolder(state.path, name.trim());
      if (r.successful === false) throw new Error(r.message || 'failed');
      invalidateLibrary();
      toast(`Created ${name.trim()}`, 'ok');
      loadFiles();
    } catch { toast('Could not create folder', 'err'); }
  };
  $('#ovRefresh').onclick = () => loadOverview();
  $('#btnRefreshFiles').onclick = () => loadFiles();
  const cc = $('#btnClearCache');
  if (cc) cc.onclick = () => {
    const n = clearCache();
    aggCache = null;
    state.books = [];
    toast(`Cleared ${n} cached ${n === 1 ? 'entry' : 'entries'}`, 'ok');
    if (state.view === 'library') loadLibrary();
    else loadFiles();
  };  $('#btnBrowse').onclick = () => $('#upFilename').click();
  $('#upFilename').onchange = (e) => { doUpload(e.target.files); e.target.value = ''; };

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('hot');
  }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) doUpload(e.dataTransfer.files); });

  ping().then((up) => { if (up) showView('overview'); else showView('overview'); });
}

document.addEventListener('DOMContentLoaded', boot);

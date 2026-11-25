/* BooxDrop reader — PDF via pdf.js, EPUB via JSZip (own pipeline).
   The device serves files as attachments with Accept-Ranges: none, so every
   reader here fetches the WHOLE file into memory and renders client-side. */
(() => {
  const lib = { pdfjs: null };

  async function loadPdfJs() {
    if (!lib.pdfjs) {
      lib.pdfjs = await import('./vendor/pdf.min.mjs');
      lib.pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    }
    return lib.pdfjs;
  }

  const ext = (name) => (name || '').split('.').pop().toLowerCase();
  const bytesFor = async (path) => {
    const r = await fetch(`${state.base}/api/storage/file?args=${enc(path)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  /* ---------------- reader shell ---------------- */
  let overlay, titleEl, bodyEl, toolsEl, escHandler = null, epubKeyHandler = null, pdfKeyHandler = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'reader';
    overlay.innerHTML = `
      <div class="rdr-bar">
        <div class="rdr-title" id="rdrTitle"></div>
        <div class="rdr-tools" id="rdrTools"></div>
        <button class="rdr-x" id="rdrClose" title="Close (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="rdr-body" id="rdrBody"></div>
      <button class="rdr-edge prev" id="rdrEdgePrev" title="Previous">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>
      </button>
      <button class="rdr-edge next" id="rdrEdgeNext" title="Next">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
      </button>`;
    document.body.appendChild(overlay);
    titleEl = overlay.querySelector('#rdrTitle');
    bodyEl = overlay.querySelector('#rdrBody');
    toolsEl = overlay.querySelector('#rdrTools');
    overlay.querySelector('#rdrClose').onclick = closeReader;
    escHandler = (e) => { if (e.key === 'Escape') closeReader(); };
    document.addEventListener('keydown', escHandler);
  }

  function closeReader() {
    if (escHandler) document.removeEventListener('keydown', escHandler);
    if (epubKeyHandler) document.removeEventListener('keydown', epubKeyHandler);
    if (pdfKeyHandler) document.removeEventListener('keydown', pdfKeyHandler);
    escHandler = epubKeyHandler = pdfKeyHandler = null;
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.style.overflow = '';
  }

  function setTools(html) { toolsEl.innerHTML = html; }

  /* ---- direction handling -------------------------------------------------
     Reading direction controls which on-screen edge means "previous" vs
     "next", and which arrow key advances. RTL is detected from the file's own
     content (EPUB spine `page-progression-direction`, or the chapter text),
     then the language. Left/Right is mirrored for RTL; Space and Up/Down are
     never mirrored because they are not spatial. */
  const RTL_LANG = /^(ar|he|iw|fa|ur|yi|ji|ps|sd|ug|dv|ku|ckb|nqo|rhg|syr|arc|sam|men|prs|pnb|skr|bal|ks|brh|hnd|khw|mzn|az-Arab|pa-Arab|ms-Arab)$/i;

  function detectDir(sampleText, lang, progression) {
    if (progression === 'rtl') return 'rtl';
    if (progression === 'ltr') return 'ltr';
    if (lang && RTL_LANG.test((lang || '').split(/[-_]/)[0])) return 'rtl';
    if (lang && /-(Arab|Hebr|Thaa|Nkoo|Syrc|Adlm|Rohg|Mand|Samr)\b/i.test(lang)) return 'rtl';
    const t = (sampleText || '').replace(/[\s\d\p{P}]/gu, '');
    if (!t) return 'ltr';
    const total = Math.min(t.length, 1200);
    let rtl = 0;
    for (let i = 0; i < total; i++) {
      const c = t.codePointAt(i);
      if ((c >= 0x0590 && c <= 0x08FF) || (c >= 0xFB1D && c <= 0xFDFF) ||
          (c >= 0xFE70 && c <= 0xFEFF) || (c >= 0x10800 && c <= 0x10FFF) ||
          (c >= 0x1E800 && c <= 0x1EFFF)) rtl++;
    }
    return rtl / total > 0.4 ? 'rtl' : 'ltr';
  }

  let readDir = 'ltr';
  let navPrev = null, navNext = null;
  let edgePrevBtn = null, edgeNextBtn = null;

  /* Wire a reader's navigation. `prev`/`next` are the logical operations;
     this maps them onto the correct screen edges for the current direction. */
  function wireNav(prev, next, { canPrev, canNext } = {}) {
    edgePrevBtn = overlay.querySelector('#rdrEdgePrev');
    edgeNextBtn = overlay.querySelector('#rdrEdgeNext');
    const rtl = readDir === 'rtl';

    // In RTL books the "previous" page sits on the RIGHT edge, mirroring how
    // the pages themselves are bound.
    const leftFn = rtl ? next : prev;
    const rightFn = rtl ? prev : next;

    edgePrevBtn.onclick = leftFn;
    edgeNextBtn.onclick = rightFn;
    edgePrevBtn.setAttribute('aria-label', rtl ? 'Next' : 'Previous');
    edgeNextBtn.setAttribute('aria-label', rtl ? 'Previous' : 'Next');
    edgePrevBtn.title = rtl ? 'Next (→)' : 'Previous (←)';
    edgeNextBtn.title = rtl ? 'Previous (←)' : 'Next (→)';

    navPrev = prev;
    navNext = next;

    if (canPrev) {
      edgePrevBtn.disabled = !canPrev();
      edgeNextBtn.disabled = !canNext();
    }
    // Keep `data-dir` (used for arrows/QA) but DO NOT set dir=rtl on the shell:
    // that would mirror the close button, button order and title, and reorder
    // the page counter's input + static text. Only the document body adapts.
    overlay.dataset.dir = readDir;
  }

  function setEdgeEnabled(hasPrev, hasNext) {
    if (!edgePrevBtn || !edgeNextBtn) return;
    // The buttons are positioned on screen, so their enabled state must be
    // mapped through the reading direction — in RTL the left button advances.
    const rtl = readDir === 'rtl';
    edgePrevBtn.disabled = rtl ? !hasNext : !hasPrev;
    edgeNextBtn.disabled = rtl ? !hasPrev : !hasNext;
  }

  function spinner(msg) {
    bodyEl.innerHTML = `<div class="rdr-load"><div class="rdr-spin"></div><div>${msg}</div></div>`;
  }
  function fail(msg) {
    bodyEl.innerHTML = `<div class="rdr-load"><div class="rdr-err">${msg}</div></div>`;
  }

  function openWith(name, runner) {
    ensureOverlay();
    document.body.style.overflow = 'hidden';
    titleEl.textContent = name;
    setTools('');
    spinner('Loading…');
    Promise.resolve().then(runner).catch((e) => fail('Could not open this file.<br><small>' + (e && e.message ? e.message : e) + '</small>'));
  }

  /* ---------------- PDF ---------------- */
  async function openPdf(path, name, startPage = 1) {
    const pdfjs = await loadPdfJs();
    spinner('Fetching PDF…');
    const data = await bytesFor(path);
    spinner('Parsing…');
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;

    let page = Math.min(Math.max(1, startPage), doc.numPages);
    let scale = 1;
    let fitMode = 'page'; // 'page' = fit whole page in window, 'width' = fit width, 'none'
    let rendering = false;

    setTools(`
      <button class="rdr-b" id="rdrPrev">‹</button>
      <span class="rdr-page" dir="ltr"><input id="rdrPageIn" value="${page}"><span class="rdr-of">/ ${doc.numPages}</span></span>
      <button class="rdr-b" id="rdrNext">›</button>
      <span class="rdr-sep"></span>
      <button class="rdr-b" id="rdrZoomOut">−</button>
      <span class="rdr-z" id="rdrZoomLbl">100%</span>
      <button class="rdr-b" id="rdrZoomIn">+</button>
      <button class="rdr-b" id="rdrFit" title="Fit page (F)">Fit</button>`);

    bodyEl.innerHTML = `<div class="rdr-pdfwrap"><canvas id="rdrCanvas"></canvas></div>`;
    const wrap = bodyEl.querySelector('.rdr-pdfwrap');
    const canvas = bodyEl.querySelector('#rdrCanvas');
    const ctx = canvas.getContext('2d');

    const zoomLbl = toolsEl.querySelector('#rdrZoomLbl');
    const pageIn = toolsEl.querySelector('#rdrPageIn');

    async function render() {
      if (rendering) return;
      rendering = true;
      try {
        const p = await doc.getPage(page);
        const base = p.getViewport({ scale: 1 });
        let eff = scale;
        const availW = wrap.clientWidth - 32;
        const availH = wrap.clientHeight - 32;
        if (fitMode === 'width') eff = Math.max(0.2, availW / base.width);
        else if (fitMode === 'page') eff = Math.max(0.2, Math.min(availW / base.width, availH / base.height));
        const vp = p.getViewport({ scale: eff });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = Math.floor(vp.width) + 'px';
        canvas.style.height = Math.floor(vp.height) + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, vp.width, vp.height);
        await p.render({ canvasContext: ctx, viewport: vp }).promise;
        zoomLbl.textContent = Math.round(eff * 100) + '%';
        pageIn.value = page;
        setEdgeEnabled(page > 1, page < doc.numPages);
      } finally { rendering = false; }
    }

    const go = (n) => { page = Math.min(Math.max(1, n), doc.numPages); render(); };
    toolsEl.querySelector('#rdrPrev').onclick = () => go(page - 1);
    toolsEl.querySelector('#rdrNext').onclick = () => go(page + 1);
    toolsEl.querySelector('#rdrZoomIn').onclick = () => { fitMode = 'none'; scale = Math.min(scale * 1.25, 6); render(); };
    toolsEl.querySelector('#rdrZoomOut').onclick = () => { fitMode = 'none'; scale = Math.max(scale / 1.25, 0.2); render(); };
    toolsEl.querySelector('#rdrFit').onclick = () => { fitMode = 'page'; scale = 1; render(); };
    pageIn.onchange = () => go(parseInt(pageIn.value, 10) || 1);

    // Detect reading direction from the first pages' text so the arrow keys and
    // edge buttons follow the book, not the UI language.
    let sample = '';
    try {
      const probe = Math.min(3, doc.numPages);
      for (let i = 1; i <= probe && sample.length < 900; i++) {
        const p = await doc.getPage(i);
        const tc = await p.getTextContent();
        sample += (tc.items || []).map((it) => it.str).join(' ');
      }
    } catch { /* text layer may be absent on scanned PDFs */ }
    readDir = detectDir(sample);

    wireNav(() => go(page - 1), () => go(page + 1));
    setEdgeEnabled(page > 1, page < doc.numPages);

    // ---- keyboard: page nav, zoom, fit, first/last (direction aware) ----
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key;
      const rtl = readDir === 'rtl';
      const fwdKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (k === fwdKey || k === 'PageDown' || k === ' ' || k === 'ArrowDown') { go(page + 1); e.preventDefault(); }
      else if (k === backKey || k === 'PageUp' || k === 'ArrowUp') { go(page - 1); e.preventDefault(); }
      else if (k === 'Home') { go(1); e.preventDefault(); }
      else if (k === 'End') { go(doc.numPages); e.preventDefault(); }
      else if (k === '+' || k === '=') { fitMode = 'none'; scale = Math.min(scale * 1.25, 6); render(); e.preventDefault(); }
      else if (k === '-' || k === '_') { fitMode = 'none'; scale = Math.max(scale / 1.25, 0.2); render(); e.preventDefault(); }
      else if (k === 'f' || k === 'F') { fitMode = 'page'; scale = 1; render(); e.preventDefault(); }
      else if (k === 'w' || k === 'W') { fitMode = 'width'; scale = 1; render(); e.preventDefault(); }
    };
    bodyEl.setAttribute('tabindex', '0');
    bodyEl.focus();
    document.addEventListener('keydown', onKey);
    pdfKeyHandler = onKey;

    const ro = new ResizeObserver(() => { if (fitMode !== 'none') render(); });
    ro.observe(wrap);
    await render();
  }

  /* ---------------- EPUB ---------------- */
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  const joinPath = (base, rel) => {
    if (/^[a-z]+:\/\//i.test(rel)) return rel;
    const parts = (base + rel).split('/');
    const out = [];
    for (const seg of parts) {
      if (seg === '..') out.pop();
      else if (seg !== '.' && seg !== '') out.push(seg);
    }
    return out.join('/');
  };

  async function openEpub(path, name) {
    if (!window.JSZip) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = './vendor/jszip.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    spinner('Fetching EPUB…');
    const raw = await bytesFor(path);
    const zip = await window.JSZip.loadAsync(raw);

    const getText = (p) => zip.file(p) ? zip.file(p).async('string') : Promise.resolve(null);

    // container.xml -> OPF path. Fall back to scanning for any *.opf, because
    // some generators omit or malform container.xml.
    let opfPath = null;
    const container = await getText('META-INF/container.xml');
    if (container) opfPath = (container.match(/full-path="([^"]+)"/) || [])[1] || null;
    if (!opfPath) {
      opfPath = Object.keys(zip.files).find((n) => /\.opf$/i.test(n) && !zip.files[n].dir) || null;
    }
    if (!opfPath) throw new Error('This file has no OPF package document — it may not be an EPUB.');
    let opf = await getText(opfPath);
    if (opf == null) throw new Error(`OPF listed but missing from the archive (${opfPath}).`);
    const opfDir = dirOf(opfPath);

    // Strip a BOM and any XML declaration quirks that make the XML parser bail.
    opf = opf.replace(/^\uFEFF/, '');

    // Parse defensively: try XML, then HTML, then regex.
    const items = [];
    const spineIds = [];
    const parseInto = (dom) => {
      const all = dom.getElementsByTagName('*');
      for (const el of all) {
        const tag = (el.localName || el.nodeName || '').toLowerCase();
        if (tag === 'item') {
          items.push({
            id: el.getAttribute('id'),
            href: el.getAttribute('href'),
            type: el.getAttribute('media-type') || '',
          });
        } else if (tag === 'itemref') {
          spineIds.push(el.getAttribute('idref'));
        }
      }
    };

    let parsed = false;
    for (const mime of ['application/xml', 'text/html']) {
      try {
        const dom = new DOMParser().parseFromString(opf, mime);
        if (dom.querySelector('parsererror')) continue;
        parseInto(dom);
        if (items.length) { parsed = true; break; }
        items.length = 0; spineIds.length = 0;
      } catch { items.length = 0; spineIds.length = 0; }
    }

    // Last-resort regex extraction (works even on malformed markup)
    if (!parsed) {
      const itemRe = /<(?:\w+:)?item\b([^>]*)\/?>/gi;
      let m;
      while ((m = itemRe.exec(opf))) {
        const attrs = m[1];
        const get = (k) => (attrs.match(new RegExp(k + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1] || '';
        const id = get('id'), href = get('href'), type = get('media-type');
        if (href) items.push({ id, href, type });
      }
      const refRe = /<(?:\w+:)?itemref\b[^>]*idref\s*=\s*"([^"]*)"/gi;
      while ((m = refRe.exec(opf))) spineIds.push(m[1]);
      parsed = items.length > 0;
    }

    if (!parsed || !items.length) {
      throw new Error('Could not read the EPUB manifest — the package document is malformed.');
    }

    // manifest: id -> resolved path
    const manifest = {};
    items.forEach((it) => {
      manifest[it.id] = { href: joinPath(opfDir, it.href), type: it.type };
    });

    // Reading direction: EPUB 3 declares it on <spine page-progression-direction>,
    // and the package <dc:language> is a strong hint.
    const spineEl = [...new DOMParser().parseFromString(opf, 'application/xml')
      .getElementsByTagName('*')].find((e) => (e.localName || '').toLowerCase() === 'spine');
    const progression = (spineEl && spineEl.getAttribute('page-progression-direction')) || '';
    const pkgLangEl = [...new DOMParser().parseFromString(opf, 'application/xml')
      .getElementsByTagName('*')].find((e) => (e.localName || '').toLowerCase() === 'language');
    const pkgLang = (pkgLangEl && pkgLangEl.textContent || '').trim();

    // Build the chapter list, being generous about what counts as readable.
    const isDoc = (t) => /html|xml/i.test(t) && !/ncx|opf|page-map|page-template|dtbncx/i.test(t);
    let chapters = spineIds
      .map((id) => manifest[id])
      .filter((m) => m && m.href && zip.file(m.href))
      .filter((m) => isDoc(m.type) || /\.x?html?$/i.test(m.href));
    if (!chapters.length) {
      chapters = items
        .map((it) => manifest[it.id])
        .filter((m) => m && m.href && zip.file(m.href))
        .filter((m) => isDoc(m.type) || /\.x?html?$/i.test(m.href));
    }
    if (!chapters.length) {
      // Absolute last resort: any HTML file in the archive, in name order.
      chapters = Object.keys(zip.files)
        .filter((n) => !zip.files[n].dir && /\.x?html?$/i.test(n))
        .sort()
        .map((n) => ({ href: n, type: 'application/xhtml+xml' }));
    }
    if (!chapters.length) {
      const kinds = [...new Set(items.map((i) => i.type).filter(Boolean))].slice(0, 5).join(', ') || 'none';
      throw new Error(`No readable chapters found (${items.length} manifest items; types: ${kinds}).`);
    }

    // Preload caches
    const htmlCache = new Map();
    const cssCache = new Map();
    const imgCache = new Map();

    async function resourceAsDataURL(p) {
      if (imgCache.has(p)) return imgCache.get(p);
      const f = zip.file(p);
      if (!f) return null;
      const blob = await f.async('blob');
      const url = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
      imgCache.set(p, url);
      return url;
    }

    let idx = 0, fontScale = 1, theme = 'sepia';

    setTools(`
      <button class="rdr-b" id="rdrPrev">‹</button>
      <span class="rdr-page" id="rdrChapLbl"></span>
      <button class="rdr-b" id="rdrNext">›</button>
      <span class="rdr-sep"></span>
      <button class="rdr-b" id="rdrFontDn" title="Smaller">A−</button>
      <button class="rdr-b" id="rdrFontUp" title="Larger">A+</button>
      <button class="rdr-b" id="rdrTheme" title="Theme">◐</button>`);

    bodyEl.innerHTML = `<div class="rdr-epub" id="rdrEpub"></div>`;
    const host = bodyEl.querySelector('#rdrEpub');
    const chapLbl = toolsEl.querySelector('#rdrChapLbl');

    function applyTheme() {
      host.dataset.theme = theme;
    }

    async function show(i) {
      idx = Math.min(Math.max(0, i), chapters.length - 1);
      chapLbl.textContent = `${idx + 1} / ${chapters.length}`;
      const ch = chapters[idx];
      let html = htmlCache.get(ch.href);
      if (html == null) {
        html = (await zip.file(ch.href)?.async('string')) || '<p>(missing chapter)</p>';
        htmlCache.set(ch.href, html);
      }
      const chDoc = new DOMParser().parseFromString(html, 'text/html');

      // Inline stylesheets
      let css = '';
      for (const link of [...chDoc.querySelectorAll('link[rel~="stylesheet"]')]) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const p = joinPath(dirOf(ch.href), href);
        if (!cssCache.has(p)) {
          let t = await getText(p);
          if (t) {
            // rewrite url(...) to data URLs is expensive; leave relative paths broken
            t = t.replace(/@import[^;]+;/gi, '');
            cssCache.set(p, t);
          } else cssCache.set(p, '');
        }
        css += '\n' + (cssCache.get(p) || '');
      }

      // Resolve <img src> to data URLs
      const imgs = [...chDoc.querySelectorAll('img[src]')];
      for (const im of imgs) {
        const p = joinPath(dirOf(ch.href), im.getAttribute('src'));
        const d = await resourceAsDataURL(p);
        if (d) im.setAttribute('src', d);
        else im.remove();
      }

      const inner = chDoc.body ? chDoc.body.innerHTML : html;
      host.innerHTML = `<style>${css}</style><div class="rdr-ch">${inner}</div>`;
      host.scrollTop = 0;
      applyTheme();
      updateNav();

      // Cover pages and section breaks have no text. Show a placeholder rather
      // than a blank white page so it doesn't look like a load failure.
      const chDiv = host.querySelector('.rdr-ch');
      const hasText = (chDiv.innerText || '').trim().length > 0;
      const hasImg = chDiv.querySelectorAll('img').length > 0;
      if (!hasText && !hasImg) {
        chDiv.innerHTML = `<div class="rdr-empty">${idx === 0 ? 'Cover' : 'Section break'}</div>`;
      }
    }

    function updateNav() {
      const p = toolsEl.querySelector('#rdrPrev');
      const n = toolsEl.querySelector('#rdrNext');
      if (p) p.disabled = idx <= 0;
      if (n) n.disabled = idx >= chapters.length - 1;
      setEdgeEnabled(idx > 0, idx < chapters.length - 1);
    }

    toolsEl.querySelector('#rdrFontUp').onclick = () => { fontScale = Math.min(fontScale + 0.1, 2.4); host.style.setProperty('--rdr-fs', fontScale + 'em'); };
    toolsEl.querySelector('#rdrFontDn').onclick = () => { fontScale = Math.max(fontScale - 0.1, 0.7); host.style.setProperty('--rdr-fs', fontScale + 'em'); };
    toolsEl.querySelector('#rdrTheme').onclick = () => {
      theme = theme === 'sepia' ? 'dark' : theme === 'dark' ? 'light' : 'sepia';
      applyTheme();
    };

    // Detect direction from the package metadata first, then refine with the
    // first chapter's actual text.
    readDir = detectDir('', pkgLang, progression);

    const next = () => show(idx + 1);
    const prev = () => show(idx - 1);
    toolsEl.querySelector('#rdrNext').onclick = next;
    toolsEl.querySelector('#rdrPrev').onclick = prev;
    wireNav(prev, next);

    await show(0);

    // If the package did not declare a direction, sample the first chapter that
    // actually has text and re-decide.
    if (!progression) {
      for (const c of chapters.slice(0, 4)) {
        const chHtml = await getText(c.href);
        if (!chHtml) continue;
        const txt = new DOMParser().parseFromString(chHtml, 'text/html').body?.textContent || '';
        if (txt.trim().length > 200) {
          const lang = (chHtml.match(/\blang\s*=\s*"([^"]+)"/i) || [])[1] || pkgLang;
          const detected = detectDir(txt, lang, progression);
          if (detected !== readDir) {
            readDir = detected;
            wireNav(prev, next);
            applyTheme();
          }
          break;
        }
      }
    }

    // ---- keyboard: chapter nav, font size, theme (direction aware) ----
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key;
      const rtl = readDir === 'rtl';
      const fwdKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (k === fwdKey || k === 'PageDown' || k === ' ') { next(); e.preventDefault(); }
      else if (k === backKey || k === 'PageUp') { prev(); e.preventDefault(); }
      else if (k === 'Home') { show(0); e.preventDefault(); }
      else if (k === 'End') { show(chapters.length - 1); e.preventDefault(); }
      else if (k === '+' || k === '=') {
        fontScale = Math.min(fontScale + 0.1, 2.4);
        host.style.setProperty('--rdr-fs', fontScale + 'em'); e.preventDefault();
      } else if (k === '-' || k === '_') {
        fontScale = Math.max(fontScale - 0.1, 0.7);
        host.style.setProperty('--rdr-fs', fontScale + 'em'); e.preventDefault();
      } else if (k === 't' || k === 'T') {
        theme = theme === 'sepia' ? 'dark' : theme === 'dark' ? 'light' : 'sepia';
        applyTheme(); e.preventDefault();
      }
    };
    bodyEl.setAttribute('tabindex', '0');
    bodyEl.focus();
    document.addEventListener('keydown', onKey);
    epubKeyHandler = onKey;
    let sx = null;
    host.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    host.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 60) (dx < 0 ? next : prev)();
      sx = null;
    }, { passive: true });
  }

  /* ---------------- public ---------------- */
  function open(path, name) {
    const e = ext(name || path);
    if (e === 'pdf') return openWith(name || path, () => openPdf(path, name || path));
    if (e === 'epub') return openWith(name || path, () => openEpub(path, name || path));
    if (e === 'azw3' || e === 'mobi' || e === 'djvu' || e === 'fb2' || e === 'cbz' || e === 'cbr') {
      return openWith(name || path, () => {
        fail(`<b>${e.toUpperCase()}</b> isn’t supported in the reader yet.<br><br>
              <small>${e === 'azw3' || e === 'mobi'
                ? 'Kindle files use a proprietary container. Convert to EPUB with Calibre.'
                : e === 'djvu'
                ? 'DjVu needs its own codec. Convert to PDF with DjVuLibre.'
                : 'Try converting this to EPUB or PDF.'}</small>`);
      });
    }
    // Unknown: let the browser try
    window.open(fileURL(path), '_blank');
  }

  window.BooxReader = { open };
})();

/**
 * Global header search — no overlay, two surfaces (see theme.css § GLOBAL
 * HEADER SEARCH for the shapes):
 *   · desktop [data-gs-surface="desktop"] — the icon opens a dropdown card
 *     (.gs-drop) holding the field and results, below the header row so the
 *     nav is never covered, pushed or wrapped;
 *   · mobile  [data-gs-surface="mobile"]  — a strip drops out of the header and
 *     pushes the page down, results flow inside it.
 * Only one is reachable at a time (the header hides the other by breakpoint).
 * The page stays live and scrollable behind both: no backdrop, no scroll lock.
 *
 * Results come from two places:
 *   · the page index (#gsPageIndex JSON) — pages + collections from the brand's
 *     own navigation, matched locally, so this works with no API at all;
 *   · menu-search, for catalog items and outlets (see the API section below).
 *
 * Independent of the menu page's own #searchOverlay, which searches the loaded
 * outlet feed and can add to cart.
 */

// ── API ────────────────────────────────────────────────────────────────────
// GET {searchBase}/search?q=…&parent_id=…  ·  Authorization: sha256(q + salt)
// Verified against the live service: it answers
//   { status: 1, result: { items: [...], merchants: [...] } }
// scoped by parent_id — the brand. (`bid` is an OUTLET id there and returns
// nothing for a brand, so it is not sent.) Base + salt come from .env; with
// either missing the module falls back to page/collection matches only, so a
// mis-set environment degrades instead of erroring at every keystroke.
// Signing happens here because q changes per keystroke — see base.php.
// Every row the service returns is rendered — no client-side cap; the panel
// scrolls instead (a page of 20 is what per_page gives us).
// Query gating: nothing is requested until 3 characters are typed, and each
// keystroke restarts a 300ms debounce — so a word typed at speed costs one
// request, not one per letter. Any in-flight request is aborted when the next
// one starts (see run()/abort()).
const MIN_CHARS   = 3;
const REVEAL_STEP = 6;    // rows shown per group before "See more"; +6 per press
const DEBOUNCE_MS = 300;
const RECENT_KEY  = 'gs_recent';
const RECENT_MAX  = 6;
const DESKTOP_MQ  = '(min-width: 992px)';

const surfaces = [...document.querySelectorAll('[data-gs-surface]')].map((el) => ({
    kind:  el.dataset.gsSurface,
    el,
    input: el.querySelector('[data-gs-input]'),
    panel: el.querySelector('[data-gs-panel]'),
    clear: el.querySelector('[data-gs-clear]'),
    field: el.querySelector('.gs-field'),   // carries .is-loading for the spinner
}));
if (surfaces.length) init();

function init() {
    const pageIndex = readJSON('gsPageIndex') || { pages: [] };
    const header    = document.querySelector('.site-header');
    let live = null, liveTrigger = null;   // the open surface + the button that opened it
    let timer = 0, ctrl = null, lastQuery = '';

    // ── open / close ──
    function open(surface, trigger) {
        if (!surface) return;
        if (live && live !== surface) close();
        live = surface;
        liveTrigger = trigger || triggerFor(surface);
        surface.el.classList.add('is-open');
        // Lifts the header's stacking context so page content can't paint over
        // the card or the strip (see .site-header.gs-searching in theme.css).
        header?.classList.add('gs-searching');
        liveTrigger?.setAttribute('aria-expanded', 'true');
        renderIdle();
        // Deferred focus: iOS Safari ignores focus() while the field is still
        // collapsed, and the desktop field animates its width open.
        setTimeout(() => surface.input.focus(), 80);
    }
    function close() {
        if (!live) return;
        abort();
        live.el.classList.remove('is-open');
        header?.classList.remove('gs-searching');
        liveTrigger?.setAttribute('aria-expanded', 'false');
        live.input.value = '';
        // Completes the reset above: the clear (x) is only meaningful next to a
        // non-empty field. Invisible either way for v1 (its field sits inside the
        // dropdown that just closed), but header_v2's field is persistent, so a
        // stale (x) would sit next to an empty box after every close.
        if (live.clear) live.clear.hidden = true;
        live.panel.hidden = true;
        live.panel.innerHTML = '';
        lastQuery = '';
        live = null;
        liveTrigger = null;
    }
    const surfaceOf = (kind) => surfaces.find((s) => s.kind === kind);
    const triggerFor = (s) => document.querySelector(`[data-gs-toggle="${s.kind}"]`);
    window.openGlobalSearch  = () => open(currentSurface());
    window.closeGlobalSearch = close;

    // ── wiring ──
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-gs-toggle]');
        if (toggle) {
            e.preventDefault();
            const surface = surfaceOf(toggle.dataset.gsToggle);
            if (!surface) return;
            live ? close() : open(surface, toggle);
            return;
        }
        // Click-away closes — but a click on a result row is a navigation, so
        // record the term that produced it first.
        if (!live) return;
        // A target already detached from the document was handled by a control
        // inside the panel that re-rendered itself (e.g. "See more" relabelling
        // its own contents) — it is not a click outside.
        if (!e.target.isConnected) return;
        const row = e.target.closest('.gs-row');
        if (row) {
            // Hand the clicked row to the detail page. /product-detail/{slug}
            // resolves ONE row server-side, and the catalogue repeats slugs
            // across sections at different prices (mini-samosa: 45 in Snacks
            // Items, 59 in NAMKEEN) — so the page can render a different row
            // than the one clicked. productPage.js reads this and corrects the
            // price it shows. Written synchronously, before the browser follows
            // the href; sessionStorage, so it dies with the tab.
            stashClicked(row);
            rememberQuery(lastQuery);
            return;
        }
        if (!live.el.contains(e.target)) close();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && live) { const t = liveTrigger; close(); t?.focus(); return; }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            live ? close() : open(currentSurface());
        }
    });

    // Crossing the breakpoint hides the open surface, so let it go.
    window.matchMedia(DESKTOP_MQ).addEventListener('change', close);

    surfaces.forEach((s) => {
        s.input.addEventListener('input', () => {
            s.clear.hidden = false;
            clearTimeout(timer);
            timer = setTimeout(() => run(s.input.value), DEBOUNCE_MS);
        });
        s.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { clearTimeout(timer); run(s.input.value, true); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); s.panel.querySelector('.gs-row')?.focus(); }
        });
        // Clears the query and returns to the idle panel; the header icon (or
        // Escape / a click away) is what closes the surface itself.
        s.clear.addEventListener('click', () => {
            s.input.value = '';
            lastQuery = '';
            abort();
            renderIdle();
            s.input.focus();
        });
        s.panel.addEventListener('click', (e) => {
            const more = e.target.closest('[data-gs-more]');
            if (more) { revealMore(more.closest('.gs-block')); return; }
            if (e.target.closest('[data-gs-retry]')) { run(lastQuery, true); return; }
            if (e.target.closest('[data-gs-recent-clear]')) { writeRecent([]); renderIdle(); return; }
            const chip = e.target.closest('.gs-chip');
            if (!chip) return;
            s.input.value = chip.dataset.term || chip.textContent.trim();
            s.clear.hidden = false;
            run(s.input.value, true);
        });
        // A dead image URL would render the browser's broken-image glyph: retry
        // once at full resolution (brands without generated crops), then fall
        // back to the placeholder. Capture phase — 'error' doesn't bubble.
        s.panel.addEventListener('error', (e) => {
            const img = e.target;
            if (img.tagName !== 'IMG' || !img.classList.contains('gs-row__img')) return;
            if (img.dataset.full && img.src !== img.dataset.full) { img.src = img.dataset.full; return; }
            img.outerHTML = `<span class="gs-row__img gs-row__img--ph" aria-hidden="true">${ITEM_IC}</span>`;
        }, true);
        // Arrow-key walk through the rows, ArrowUp off the top back to the field.
        s.panel.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const rows = [...s.panel.querySelectorAll('.gs-row')];
            const i = rows.indexOf(document.activeElement);
            e.preventDefault();
            if (e.key === 'ArrowUp' && i === 0) { s.input.focus(); return; }
            rows[e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)]?.focus();
        });
    });

    // ── search ──
    async function run(raw, immediate = false) {
        const q = raw.trim();
        lastQuery = q;
        abort();
        if (q.length < MIN_CHARS) { renderIdle(); return; }

        const local = matchPages(q, pageIndex.pages);
        if (!searchConfigured()) {                  // no base/salt — local only
            paint(local, q);
            if (immediate) rememberQuery(q);
            return;
        }
        show(SKELETON);
        live?.field?.classList.add('is-loading');   // spinner in the field
        ctrl = new AbortController();
        try {
            const remote = await fetchCatalog(q, ctrl.signal);
            if (lastQuery !== q) return;            // a newer keystroke won
            paint([...remote, ...local], q);
            if (immediate) rememberQuery(q);
        } catch (err) {
            if (err.name === 'AbortError' || lastQuery !== q) return;
            // A catalog failure shouldn't hide page/collection hits we already
            // have — only a total blank falls through to the error state.
            if (local.some((g) => g.rows.length)) { paint(local, q); return; }
            show(errorHTML());
        }
    }
    function abort() { ctrl?.abort(); ctrl = null; clearTimeout(timer); stopSpinner(); }
    function stopSpinner() { surfaces.forEach((s) => s.field?.classList.remove('is-loading')); }

    function paint(groups, q) {
        const filled = mergeGroups(groups).filter((g) => g.rows.length);
        show(filled.length ? filled.map(groupHTML).join('') : emptyHTML(q));
    }

    /**
     * Collections can arrive twice — once from the sections the results live in,
     * once from the nav index matching the query text — so fold same-label
     * groups together and drop rows that point at the same place. First
     * occurrence wins, keeping result-derived entries above nav matches.
     */
    function mergeGroups(groups) {
        const byLabel = new Map();
        for (const g of groups) {
            if (!byLabel.has(g.label)) byLabel.set(g.label, []);
            byLabel.get(g.label).push(...g.rows);
        }
        return [...byLabel].map(([label, rows]) => {
            const seen = new Set();
            return { label, rows: rows.filter((r) => {
                // Key on the row id where there is one. Two products can share a
                // href AND a name — til-chikki is 71 in Chikki and 5 in Seasonal
                // Items, both linking to /product-detail/til-chikki — and keying
                // on href+title alone silently dropped the second. Collections
                // carry no id, so they still fold together by destination.
                const key = r.id != null
                    ? 'id:' + r.id
                    : String(r.href || '') + '|' + String(r.title || '').toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }) };
        });
    }

    // Idle = the visitor's own recent searches. Nothing static here, so a
    // first-time visitor gets the hint line instead of an empty panel.
    function renderIdle() {
        const recent = readRecent();
        show(recent.length
            ? `<section class="gs-block">
                   <h3 class="gs-block__head">Recent searches
                       <button type="button" class="gs-block__action" data-gs-recent-clear>Clear</button>
                   </h3>
                   <div class="gs-chips">${recent.map(chipHTML).join('')}</div>
               </section>`
            : '<p class="gs-hint">Type at least 3 characters to search the menu, collections and pages.</p>');
    }

    function show(html) {
        if (!live) return;
        if (html !== SKELETON) stopSpinner();
        live.panel.innerHTML = html;
        live.panel.hidden = false;
    }

    const currentSurface = () => surfaces.find((s) => s.kind === (window.matchMedia(DESKTOP_MQ).matches ? 'desktop' : 'mobile')) || surfaces[0];
}

// ── catalog fetch ─────────────────────────────────────────────────────────
const searchBase = () => (window.AppConfig?.searchBase || '').replace(/\/$/, '');
const searchSalt = () => window.AppConfig?.searchSalt || '';
const searchConfigured = () => !!(searchBase() && searchSalt() && searchSalt() !== 'CHANGE_ME');

/**
 * Scope for the query: the brand's parent id — the only scope the service takes
 * for a storefront, and what its items come back keyed to (parentId = brand).
 */
function searchScope() {
    return window.AppConfig?.businessId || '';
}

async function fetchCatalog(q, signal) {
    const url = `${searchBase()}/search?q=${encodeURIComponent(q)}&parent_id=${encodeURIComponent(searchScope())}`;
    const res = await fetch(url, {
        signal,
        headers: { Authorization: sha256Hex(q + searchSalt()), Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`search ${res.status}`);
    const json = await res.json();
    // Auth / param failures answer 200 with {status: 0, message} — an error
    // state, not "no results".
    // Strict compare: Number(null) and Number(false) are both 0, so a malformed
    // or drifted body would otherwise discard a perfectly good result set.
    // '0' covers a stringified variant.
    if (json && (json.status === 0 || json.status === '0')) throw new Error(json.message || 'search rejected');
    return normalizeCatalog(json);
}

/**
 * { status, result: { items[], merchants[] } } → render groups.
 * Item images are bare filenames served from {cdn}/uploads/{parentId}/…, and
 * an item's own `parentId` is its feed parent, NOT the brand — so the brand id
 * comes from the merchant list (businessId → parentId), falling back to this
 * storefront's own parent.
 */
function normalizeCatalog(json) {
    const res       = json?.result || {};
    const merchants = Array.isArray(res.merchants) ? res.merchants : [];
    const items     = Array.isArray(res.items) ? res.items : [];
    const brandOf   = new Map(merchants.map((m) => [String(m.id), m.parentId]));
    const groups    = [];

    if (items.length) {
        groups.push({
            label: 'Items',
            rows: dedupeItems(items).map((i) => ({
                title: i.itemName || '',
                // Section, plus the outlet name only when the payload names one
                // (campus/multi-brand results). parentName is the brand itself —
                // repeating it on every row of its own storefront is noise.
                sub:   [i.sectionName, i.businessName].filter(Boolean).join(' · '),
                img:   cdnImage(brandIdOf(i, brandOf), i.image),
                price: i.sp ?? i.price ?? null,
                mrp:   i.mrp ?? null,
                href:  itemHref(i, brandOf),
                id:    i.itemId ?? i.id ?? null,
                slug:  i.itemSlug || '',
                section: i.sectionSlug || '',
                sectionName: i.sectionName || '',
                desc:  i.description || '',
                tag:   itemTag(i),
                oos:   !!i.out_of_stock || i.available === false,
            })).filter((r) => r.title),
        });
    }
    // Collections the results themselves sit in. Previously this group came only
    // from the nav index, which matches the QUERY text — so "chikki" surfaced the
    // Chikki collection but never Seasonal Items, even with a Seasonal Items
    // result on screen. Derived from the rows, both appear.
    const sections = new Map();
    for (const i of items) {
        const slug = String(i.sectionSlug || '');
        const name = String(i.sectionName || '').trim();
        if (slug && name && !sections.has(slug)) sections.set(slug, name);
    }
    if (sections.size) {
        groups.push({
            label: 'Collections',
            rows: [...sections].map(([slug, name]) => ({
                title: name,
                href:  `/products/${encodeURIComponent(slug)}`,
                kind:  'page',
            })),
        });
    }

    if (merchants.length) {
        groups.push({
            label: 'Stores',
            rows: merchants.map((m) => ({
                title: m.name || '',
                sub:   [m.locality, m.city].filter(Boolean).join(' · '),
                img:   cdnImage(m.parentId, m.logo),
                href:  m.slug ? `/order/${m.slug}` : '#',
                oos:   Number(m.outlet_open) === 0,
            })).filter((r) => r.title),
        });
    }
    return groups;
}

/**
 * Every distinct product gets its own row — a laddu search returns Motichoor,
 * Banarsi, Sugar Less and so on, and those are five products, not one. Only the
 * exact same record repeated in the payload (same itemId) collapses.
 *
 * Rows sharing an itemSlug are all kept: they are different products at
 * different prices, and itemHref() sends them to their own section page rather
 * than to /product-detail/{slug}, which can only ever resolve one of them.
 */
function dedupeItems(items) {
    const seen = new Map();
    for (const i of items) {
        const key = String(i.itemId ?? i.id ?? '');
        if (key === '') { seen.set(Symbol(), i); continue; }   // nothing to key on
        if (!seen.has(key)) seen.set(key, i);
    }
    return [...seen.values()];
}

/**
 * Brand (parent business) id an item's images live under. Two payload shapes:
 * campus results carry `businessId` and an item-level `parentId` that is a FEED
 * parent, not a brand — so the merchant list resolves the brand; single-brand
 * results carry no businessId and `parentId` IS the brand.
 */
function brandIdOf(item, brandOf) {
    return brandOf.get(String(item.businessId))
        || (item.businessId == null ? item.parentId : null)
        || window.AppConfig?.businessId
        || '';
}

/**
 * Result → the best link we can build.
 *   · this brand's own item → /product-detail/{itemSlug}. For a slug the
 *     catalogue repeats across sections (til-chikki x3) that URL alone resolves
 *     one row, so the click handler also drops the clicked row's master id in
 *     the short-lived pd_item cookie and the controller honours it — same URL,
 *     right row, no intermediate page load;
 *   · another brand's outlet (campus payloads carry `slug`) → that outlet's
 *     menu, deep-linked to the item;
 *   · nothing to key on → the category page, else the ordering entry point.
 */
function itemHref(i, brandOf = new Map()) {
    const sec = i.sectionSlug || '';
    // brandOf must be the POPULATED merchant map: with an empty one brandIdOf
    // falls through to AppConfig.businessId, both sides of the comparison match,
    // and every campus result claims to be ours — a CBTL item would link to
    // /product-detail/latte on Theobroma instead of CBTL's own menu.
    const ours = i.businessId == null || String(brandIdOf(i, brandOf)) === String(window.AppConfig?.businessId ?? '');
    if (ours && i.itemSlug) return `/product-detail/${encodeURIComponent(i.itemSlug)}`;
    if (i.slug && sec && i.itemSlug) return `/order/${i.slug}?section_slug=${encodeURIComponent(sec)}&item_slug=${encodeURIComponent(i.itemSlug)}`;
    if (i.slug && i.itemId != null)  return `/order/${i.slug}?item=${encodeURIComponent(i.itemId)}`;
    if (sec) return `/products/${encodeURIComponent(sec)}`;
    return '/online-order';
}

/** Card-sized crop for a CDN filename, with the full-res original as fallback. */
function cdnImage(parentId, file) {
    if (!file || file === 'null') return null;
    if (/^https?:/.test(file)) return { src: file, full: file };
    const base = `${(window.AppConfig?.cdnBase || '').replace(/\/$/, '')}/uploads/${parentId}`;
    return { src: `${base}/crops/160/${file}.webp`, full: `${base}/${file}` };
}

/** First badge worth showing on an item row. */
function itemTag(i) {
    const custom = [...(i.custom_tags || []), ...(i.tags || [])].find((t) => typeof t === 'string' && t.trim());
    if (custom) return custom.trim();
    if (Number(i.recommended) === 1) return 'Bestseller';
    if (Number(i.newItem) === 1) return 'New';
    return '';
}

// ── local page/collection matching ────────────────────────────────────────
// Prefix hits rank above mid-word hits so "cake" puts "Cakes" before
// "Custom Cakes"; grouped by the index's own group label.
function matchPages(q, pages) {
    const lq = q.toLowerCase();
    const hits = (pages || [])
        .map((p) => ({ p, at: p.t.toLowerCase().indexOf(lq) }))
        .filter((h) => h.at > -1)
        .sort((a, b) => a.at - b.at || a.p.t.length - b.p.t.length)
        .slice(0, REVEAL_STEP * 2);   // two reveal pages' worth
    const byGroup = new Map();
    for (const { p } of hits) {
        const g = p.g || 'Pages';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push({ title: p.t, href: p.u, kind: 'page' });
    }
    return [...byGroup].map(([label, rows]) => ({ label, rows }));
}

// ── markup ────────────────────────────────────────────────────────────────
/**
 * A group renders every row it has but only reveals REVEAL_STEP of them; the
 * rest stay [hidden] until "See more" is pressed, three at a time. The count in
 * the heading says how long the full list is.
 */
function groupHTML(g) {
    const hidden = Math.max(0, g.rows.length - REVEAL_STEP);
    return `<section class="gs-block" data-shown="${Math.min(REVEAL_STEP, g.rows.length)}">
        <h3 class="gs-block__head">${esc(g.label)}${g.rows.length > REVEAL_STEP ? ` <span class="gs-block__count">· ${g.rows.length}</span>` : ''}</h3>
        <div class="gs-rows">${g.rows.map((r, i) => rowHTML(r, i >= REVEAL_STEP)).join('')}</div>
        ${hidden ? moreHTML(Math.min(REVEAL_STEP, hidden)) : ''}
    </section>`;
}

const moreLabel = (n) => `See ${n} more
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const moreHTML = (n) => `<button type="button" class="gs-more" data-gs-more>${moreLabel(n)}</button>`;

/** Reveal the next REVEAL_STEP rows of a group; drop the button once done. */
function revealMore(block) {
    if (!block) return;
    const rows  = [...block.querySelectorAll('.gs-row')];
    const shown = Number(block.dataset.shown || REVEAL_STEP);
    const next  = Math.min(rows.length, shown + REVEAL_STEP);
    for (let i = shown; i < next; i++) rows[i].hidden = false;
    block.dataset.shown = String(next);
    const btn = block.querySelector('[data-gs-more]');
    const left = rows.length - next;
    if (!btn) return;
    // Relabel in place rather than replacing the element: swapping outerHTML
    // detaches the node the click came from, and the document's click-away
    // check then reads it as a click outside the panel and closes everything.
    if (left <= 0) btn.remove();
    else btn.innerHTML = moreLabel(Math.min(REVEAL_STEP, left));
}

function rowHTML(r, hidden = false) {
    const thumb = r.img
        ? `<img class="gs-row__img" src="${esc(r.img.src)}" data-full="${esc(r.img.full)}" alt="" loading="lazy">`
        : `<span class="gs-row__img gs-row__img--ph" aria-hidden="true">${r.kind === 'page' ? PAGE_IC : ITEM_IC}</span>`;
    // No price in the panel: a row is a way in, and the item page carries the
    // live figure. The data is still stashed on click (data-sp/data-mrp) — that
    // is what corrects the detail page — it just isn't drawn here.
    const trail = `<span class="gs-row__go" aria-hidden="true">${CHEVRON}</span>`;
    // data-item-id always rides along for a catalogue item. It cannot be gated on
    // "this slug looked duplicated in the response": search returns one row per
    // match, so a query for samosa yields the NAMKEEN one (59) with no hint that
    // Snacks Items holds another at the same slug (45) — and the detail page then
    // resolved the lowest id. Harmless when the slug IS unique: the lookup
    // requires id AND slug AND brand to agree, so it either names the same row or
    // is ignored.
    const idAttr = [
        r.id != null ? ` data-item-id="${esc(r.id)}"` : '',
        r.slug ? ` data-item-slug="${esc(r.slug)}"` : '',
        r.section ? ` data-section="${esc(r.section)}"` : '',
        r.sectionName ? ` data-section-name="${esc(r.sectionName)}"` : '',
        r.img?.src ? ` data-img="${esc(r.img.src)}"` : '',
        r.desc ? ` data-desc="${esc(r.desc)}"` : '',
        r.price != null && r.price !== '' ? ` data-sp="${esc(r.price)}"` : '',
        r.mrp != null && r.mrp !== '' ? ` data-mrp="${esc(r.mrp)}"` : '',
    ].join('');
    return `<a class="gs-row${r.oos ? ' gs-row--oos' : ''}" href="${esc(r.href || '#')}"${idAttr}${hidden ? ' hidden' : ''}>
        ${thumb}
        <span class="gs-row__body">
            <span class="gs-row__title">${esc(r.title)}${r.tag ? `<em class="gs-row__tag">${esc(r.tag)}</em>` : ''}</span>
            ${r.sub ? `<span class="gs-row__sub">${esc(r.sub)}</span>` : ''}
        </span>
        ${trail}
    </a>`;
}

const chipHTML = (term) => `<button type="button" class="gs-chip" data-term="${esc(term)}">${esc(term)}</button>`;

/**
 * Remember which result row was clicked, for the destination page to read.
 * sessionStorage (not a cookie): nothing reaches the server, so no request
 * varies on it — the page renders exactly as it does today and the correction
 * happens in the browser. Stamped, and treated as stale after 60s.
 */
const CLICK_KEY = 'gs_clicked';
function stashClicked(row) {
    const data = {
        slug:        row.getAttribute('data-item-slug') || '',
        id:          row.getAttribute('data-item-id') || '',
        section:     row.getAttribute('data-section') || '',
        sectionName: row.getAttribute('data-section-name') || '',
        sp:          row.getAttribute('data-sp') || '',
        mrp:         row.getAttribute('data-mrp') || '',
        img:         row.getAttribute('data-img') || '',
        desc:        row.getAttribute('data-desc') || '',
        at:          Date.now(),
    };
    if (!data.slug) return;
    try { sessionStorage.setItem(CLICK_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

const SKELETON = Array.from({ length: 4 }, () =>
    '<div class="gs-skel"><span class="gs-skel__img"></span><span class="gs-skel__lines"><i></i><i></i></span></div>').join('');

const emptyHTML = (q) => `<div class="gs-msg">
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <p class="gs-msg__title">No results for &ldquo;${esc(q)}&rdquo;</p>
    <p class="gs-msg__sub">Check the spelling or try a shorter, more general term.</p>
</div>`;

const errorHTML = () => `<div class="gs-msg">
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>
    <p class="gs-msg__title">Search is unavailable right now</p>
    <p class="gs-msg__sub">Please try again in a moment.</p>
    <button type="button" class="btn btn--secondary gs-msg__retry" data-gs-retry>Try again</button>
</div>`;

const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>';
const PAGE_IC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
const ITEM_IC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h16M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M9 7V5a3 3 0 0 1 6 0v2"/></svg>';

// ── helpers ───────────────────────────────────────────────────────────────
function esc(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function readJSON(id) {
    try { return JSON.parse(document.getElementById(id)?.textContent || 'null'); } catch { return null; }
}
function readRecent() {
    try { return (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).slice(0, RECENT_MAX); } catch { return []; }
}
function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* private mode */ }
}
function rememberQuery(q) {
    q = (q || '').trim();
    if (q.length < MIN_CHARS) return;
    writeRecent([q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())]);
}

/**
 * SHA-256 → lowercase hex. Synchronous, and unlike crypto.subtle it also works
 * over plain http (local dev on a /etc/hosts brand domain is not a secure
 * context).
 *
 * DUPLICATED, deliberately for now: menu.js carries the same routine for its
 * filter-list token. Any fix here must land there too — and vice versa. Not yet
 * extracted to a shared lib because a nested import (../lib/sha256.js) is
 * fetched WITHOUT the ?v= cache-buster that base.php puts on entry points,
 * while nginx caches /src/js for 30 days; the last time a shared module gained
 * an export consumed in the same deploy, returning visitors got a stale copy
 * and the SyntaxError took the page down. Worth doing as its own change, with a
 * cache strategy for the lib path.
 */
function sha256Hex(str) {
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes  = new TextEncoder().encode(str);
    const bitLen = bytes.length * 8;
    const padLen = (((bytes.length + 8) >> 6) + 1) << 6;
    const data   = new Uint8Array(padLen);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const dv = new DataView(data.buffer);
    dv.setUint32(padLen - 4, bitLen >>> 0, false);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padLen; off += 64) {
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ ((~e) & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H = [H[0] + a, H[1] + b, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map((x) => x | 0);
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

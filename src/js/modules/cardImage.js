// ── Render-size-based card image resolver ──────────────────────────────────
// Card thumbnails render with the smallest CDN crop (…/crops/160/…) as their
// initial `src`. After layout we measure each image's ACTUAL rendered width (in
// CSS pixels, deliberately IGNORING devicePixelRatio — a product decision to
// favour smaller payloads over retina sharpness) and upgrade anything that
// renders wider than 160px to the 256 crop.
//
// We don't use srcset/sizes for this: the browser's responsive-image system
// always multiplies the rendered width by the device pixel ratio, so on a 2×
// screen a 130px card would still pull 256. Measuring clientWidth in JS is the
// only way to key the choice off the pure CSS render size.

const CROPS = [160, 256]; // CDN-generated crop widths, ascending

// Smallest available crop >= the rendered width (falls back to the largest).
function pickWidth(rendered) {
    for (const w of CROPS) if (w >= rendered) return w;
    return CROPS[CROPS.length - 1];
}

// Upgrade a single <img> still pointing at the /crops/160/ baseline.
function resolve(img) {
    const src = img.getAttribute('src') || '';
    if (!src.includes('/crops/160/')) return;
    const rendered = img.clientWidth || img.parentElement?.clientWidth || 0;
    if (!rendered) return; // not laid out yet — leave the 160 baseline in place
    const want = pickWidth(rendered);
    if (want !== 160) img.src = src.replace('/crops/160/', `/crops/${want}/`);
}

// Resolve every baseline card image under `root` (default: whole document).
export function resolveCardImages(root = document) {
    (root || document).querySelectorAll('img[src*="/crops/160/"]').forEach(resolve);
}

let raf = 0;
function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; resolveCardImages(document); });
}

// ── Broken-image fallback ──────────────────────────────────────────────────
// CI3 parity: a missing or broken card image must show NOTHING — never the
// browser's broken-image icon + alt text. Card thumbnails point at CDN crops
// that can 404 (crop never generated, bad filename, wrong pId). On failure we
// drop the <img>; the wrapper then collapses via the `:not(:has(img))` rules in
// menu.css. This mirrors menu.js's delegated handler, but covers the static /
// home-widget surfaces (featured rail, etc.) that the menu-grid handler doesn't.
//
// Card-image wrappers we actively manage (retry + sweep for broken thumbnails).
const CARD_WRAP = '.item-img,.feat-img,.fav-row__img,.fav-lg__img,.srch-card-img,.wla-best__image,.featured-image,.op-menu-img,.op-gallery-cell,.op-gallery-thumb';
// Of those, the wrappers whose CSS collapses to nothing once their <img> is gone
// (their empty-state is "show nothing"). `.featured-image` is handled separately
// because its empty-state shows a styled placeholder, not a collapse.
const COLLAPSE_WRAP = '.item-img,.feat-img,.fav-row__img,.fav-lg__img,.srch-card-img,.wla-best__image,.op-menu-img,.op-gallery-cell,.op-gallery-thumb';
// Standalone images (no card wrapper) that should simply vanish when broken
// rather than show the browser's broken-image icon + alt text. The DB-driven
// lead-form header banner is one: many forms store a /uploads/ URL that 404s on
// the CDN, and a broken icon next to its alt text reads as a stray duplicate
// heading above the real <h1>. Collapse it — no logo fallback (forms want the
// banner gone, not replaced). CI3 achieved this server-side via getimagesize().
const DROP_IMG = '.form-page-card__header';

// Reverse cdn_card_crop(): …/uploads/123/crops/160/photo.jpg.webp → …/uploads/123/photo.jpg
// Returns null when the src isn't a generated crop (nothing to fall back to).
function decrop(src) {
    const m = (src || '').match(/^(.*\/uploads\/\d+)\/crops\/\d+\/(.+)\.webp(\?.*)?$/);
    return m ? `${m[1]}/${m[2]}${m[3] || ''}` : null;
}

// Brand logo for the image fallback (menu-popup parity). Prefer the square logo
// since card image wells are ~1:1; fall back to the wordmark logo.
function brandLogo() {
    const c = window.AppConfig || {};
    return String(c.logoSquare || c.logo || '');
}

function dropBroken(img) {
    if (!img || img.tagName !== 'IMG') return;
    // Standalone drop-on-error images (e.g. the form header banner): just remove
    // them so nothing — no broken icon, no alt text — is left behind.
    if (img.matches(DROP_IMG)) { img.remove(); return; }
    if (!img.closest(CARD_WRAP)) return; // only manage card thumbnails
    // The menu page owns broken images inside its grid / popups (menu.js) — don't
    // double-handle and fight its own fallback logic.
    if (img.closest('#dynamicMenuContent,.popup-overlay')) return;
    // A failed CDN crop usually just means the /crops/<w>/ webp was never
    // generated though the original upload exists — retry the original once
    // before giving up, so a missing crop recovers its real image.
    if (img.dataset.imgRetry !== '1') {
        img.dataset.imgRetry = '1';
        const orig = decrop(img.getAttribute('src'));
        if (orig) { img.removeAttribute('srcset'); img.src = orig; return; }
    }
    // Image is unavailable. Fill the well with the grayscaled brand logo, exactly
    // like the menu item popup — nicer than a blank box or "item photo" text.
    const logo = brandLogo();
    if (logo && !img.classList.contains('card-img-fallback')) {
        img.classList.add('card-img-fallback');
        img.removeAttribute('srcset');
        img.alt = '';
        img.src = logo;
        return;
    }
    // No brand logo configured (or the logo itself failed): match each surface's
    // empty-state design. The ue_silver featured rail shows a styled placeholder;
    // other listing surfaces collapse via the page CSS `:not(:has(img))` rules.
    if (img.closest('.featured-image')) {
        const ph = document.createElement('span');
        ph.className = 'feat-img-ph';
        ph.textContent = 'item photo';
        img.replaceWith(ph);
        return;
    }
    if (img.closest(COLLAPSE_WRAP)) img.remove();
}

// Catch images that already errored before our listener attached (the module
// auto-inits, but some thumbnails may have failed during initial parse).
function sweepBroken(root = document) {
    const sel = CARD_WRAP.split(',').map(s => `${s} img`).join(',') + ',' + DROP_IMG;
    (root || document).querySelectorAll(sel)
        .forEach(img => { if (img.complete && img.naturalWidth === 0) dropBroken(img); });
}

let inited = false;
// Wire up the document-level passes: initial layout, a MutationObserver (so
// JS-rendered cards and slick-carousel clones get upgraded as they appear), and
// a debounced resize pass (breakpoints can change a card's rendered width).
// Safe to call repeatedly; only the first call attaches listeners.
export function initCardImages() {
    if (inited) return;
    inited = true;
    // Image 'error' events don't bubble — capture them at the document.
    document.addEventListener('error', e => dropBroken(e.target), true);
    const start = () => {
        schedule();
        sweepBroken(document);
        // childList only — our own src swaps are attribute changes, so they
        // never retrigger this (no feedback loop). rAF coalesces bursts.
        new MutationObserver(muts => {
            for (const m of muts) if (m.addedNodes.length) { schedule(); sweepBroken(document); break; }
        }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState !== 'loading') start();
    else document.addEventListener('DOMContentLoaded', start);
    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(schedule, 200); }, { passive: true });
}

// Auto-init when included directly on a server-rendered page. JS modules that
// import resolveCardImages also trigger init here, which is harmless.
initCardImages();

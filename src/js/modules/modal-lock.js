// Generic detection — any open modal locks the page (no per-id allowlist to
// keep in sync). Every custom dialog/sheet in this codebase carries
// aria-modal="true" and is shown/hidden via the [hidden] attribute (verified:
// none toggle display:none on the container), so `[aria-modal]:not([hidden])`
// catches them all. The remaining entries cover the few overlays/sheets that
// predate the aria-modal convention, plus Bootstrap modals (hidden via
// display:none rather than [hidden], so matched by .show instead).
const OPEN_SELECTOR = [
    '[aria-modal="true"]:not([hidden])',
    '.popup-overlay:not([hidden])',
    '.promo-popup-overlay:not([hidden])',
    '.sheet:not([hidden])',
    '.modal.show',
].join(',');

let _raf = 0;
function sync() {
    if (_raf) return;
    _raf = requestAnimationFrame(() => {
        _raf = 0;
        const open = document.querySelector(OPEN_SELECTOR);
        const on = !!open;
        document.documentElement.classList.toggle('modal-open', on);
        document.body.classList.toggle('modal-open', on);
        // While a modal is open, drop the header's scrolled shadow so it
        // reads as a clean modal layer. On close, restore based on scroll.
        const h = document.querySelector('.site-header');
        if (h) h.classList.toggle('scrolled', !on && window.scrollY > 10);
    });
}

new MutationObserver(sync).observe(document.body, {
    attributes: true,
    attributeFilter: ['hidden', 'class'],
    subtree: true,
    childList: true,
});

sync();

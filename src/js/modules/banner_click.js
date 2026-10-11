/**
 * banner_click.js — banner_clicked analytics for hero/promo banner widgets.
 *
 * Banners are server-rendered anchors with no JS of their own, so campaign banner
 * performance was invisible: we could see landing-page traffic but not which banner
 * sent it. A single delegated listener covers every banner widget on the page,
 * including carousel slides swapped in after load (Bootstrap moves them in the DOM,
 * so per-element listeners would need re-binding; delegation doesn't).
 *
 * Markup contract — set by app/Views/themes/ue_default/widgets/banners.php on LINKED
 * slides only: data-banner-id, data-banner-title. Non-linked banners are passive
 * images and are deliberately not tracked.
 *
 * Analytics goes through the window.Analytics bridge, never an `import`. A nested
 * import of './analytics.js' carries no version query while this file is cache-busted,
 * and nginx caches /src/js for 30 days — a stale analytics.js would throw and break
 * this module. The bridge no-ops instead.
 */

document.addEventListener('click', (e) => {
    const slide = e.target.closest?.('[data-banner-id]');
    if (!slide) return;
    try {
        window.Analytics?.trackBannerClicked?.({
            bannerId: slide.dataset.bannerId,
            title:    slide.dataset.bannerTitle || '',
            url:      slide.getAttribute('href') || '',
        });
    } catch { /* never interfere with the navigation */ }
}, true);   // capture phase: the click navigates away, so run before default handling

/**
 * Scroll-to-top floating button — site-wide (see base.php for the excluded
 * pages, currently checkout + payment). The button ships `hidden` and is
 * revealed once the user scrolls past the fold. Visibility uses the global
 * `hidden` attribute (theme.css `.scroll-top-btn[hidden]`).
 */
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('scrollTopBtn');
    if (!btn) return;

    const toggle = () => { btn.hidden = window.scrollY < 400; };
    window.addEventListener('scroll', toggle, { passive: true });
    btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    toggle();
});

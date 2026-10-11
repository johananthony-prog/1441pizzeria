'use strict';

(function () {
    var sidebar = document.getElementById('profileSidebar');
    var overlay = document.getElementById('profileOverlay');
    if (!sidebar || !overlay) return;

    var nameEl  = document.getElementById('psName');
    var emailEl = document.getElementById('psEmail');

    function getUser() {
        try { return JSON.parse(localStorage.getItem('userdata') || '{}'); }
        catch (e) { return {}; }
    }

    function prefill() {
        var u = getUser();
        if (nameEl)  nameEl.textContent  = u.name || (u.mobile ? '+91 ' + u.mobile : 'Guest');
        if (emailEl) emailEl.textContent = u.email || '';
    }

    // The menu card clears the sticky header on mobile. Header height varies per
    // brand (logo + tagline) and a notification/announcement bar may sit above it,
    // so measure the header's live BOTTOM edge rather than hardcode a height —
    // otherwise a taller header overlaps the card. Desktop uses the in-card layout.
    function syncHeaderOffset() {
        var header = document.querySelector('.site-header');
        if (header && window.matchMedia('(max-width: 767px)').matches) {
            // +8px breathing gap so the card never visually touches the header's
            // bottom border/shadow (which reads as an overlap).
            var offset = Math.max(0, Math.round(header.getBoundingClientRect().bottom)) + 8;
            sidebar.style.setProperty('--profile-header-offset', offset + 'px');
        } else {
            sidebar.style.removeProperty('--profile-header-offset');
        }
    }

    function open() {
        prefill();
        syncHeaderOffset();
        overlay.hidden = false;
        // next frame so transition fires
        requestAnimationFrame(function () {
            overlay.classList.add('is-open');
            sidebar.classList.add('is-open');
            sidebar.setAttribute('aria-hidden', 'false');
            // `clip` (not `hidden`) locks scroll without making <body> a scroll
            // container — `hidden` would break `position: sticky` on the menu's
            // left category rail (see CLAUDE.md sticky/overflow gotcha).
            document.body.style.overflow = 'clip';
            // Mobile keeps the sidebar under the sticky header (z 1020 < 1030) so
            // the header icon stays tappable to close it; the checkout pay bar is
            // also z 1030, so flag the body to hide it while the menu is open.
            document.body.classList.add('profile-sidebar-is-open');
            // Re-measure after the layout settles (overflow:clip applied, sticky
            // header repositioned) so the offset reflects the final on-screen header.
            syncHeaderOffset();
        });
    }

    // Keep the offset correct if the viewport rotates/resizes while the menu is open.
    window.addEventListener('resize', function () {
        if (sidebar.classList.contains('is-open')) syncHeaderOffset();
    });

    function close() {
        overlay.classList.remove('is-open');
        sidebar.classList.remove('is-open');
        sidebar.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        document.body.classList.remove('profile-sidebar-is-open');
        // hide overlay after transition so it doesn't block clicks
        setTimeout(function () {
            if (!overlay.classList.contains('is-open')) overlay.hidden = true;
        }, 280);
    }

    window.toggleProfileSidebar = function () {
        if (sidebar.classList.contains('is-open')) close(); else open();
    };
    window.openProfileSidebar  = open;
    window.closeProfileSidebar = close;

    overlay.addEventListener('click', close);
    document.getElementById('profileSidebarClose')?.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sidebar.classList.contains('is-open')) close();
    });

    document.getElementById('psLogout')?.addEventListener('click', function () {
        // Clear the entry_channel cookie (set by WhatsappOrderAuthFilter on a
        // WhatsApp nonce redeem) — without this, a WhatsApp customer logging out
        // would leave it set, silently mis-attributing whatever they (or the next
        // person on a shared device) do next as a WhatsApp-originated session.
        // Plain cookie, not session data (see wa_entry_channel() in wla_helper.php),
        // so this file — a classic <script>, not a module, can't import the
        // auth-storage.js helper other logout paths use — just clears it directly.
        document.cookie = 'entry_channel=; Max-Age=0; path=/';
        localStorage.removeItem('userdata');
        localStorage.removeItem('token');
        localStorage.removeItem('v4_cart');
        // Fast-checkout last-payment cache — never carry a UPI method across accounts.
        localStorage.removeItem('last_payment_date');
        localStorage.removeItem('last_payment_response');
        // Reset the location journey so a new session re-prompts for outlet selection.
        if (typeof window.resetLocationJourney === 'function') window.resetLocationJourney();
        window.location.href = '/';
    });
})();

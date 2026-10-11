// Global floating cart FAB — CI3 #cart_icon parity.
//
// Reveals a circular cart button (with an item-count badge) on every page once:
//   1. the user is logged in (localStorage `userdata`), AND
//   2. an outlet is selected and its cart (localStorage `v4_cart`) has items.
//
// The cart is outlet-scoped — `v4_cart.bId` is the selected outlet — so a cart
// with items inherently means an outlet was chosen. Click proceeds to checkout
// for that outlet, mirroring menu.js `goToCheckout()`.
//
// Stays hidden on pages that already carry their own cart entry point: the
// menu/grocery page (#floatingCartBar) and the cart/checkout funnel.
(function () {
    const fab = document.getElementById('cartFab');
    if (!fab) return;

    // Pages with their own cart entry point — never show the global (menu) FAB
    // there, or it overlaps and links to the wrong cart. The menu/order pages use
    // one of two bar ids; subscription & prepaid-pack pages carry their own FAB
    // (#subCartFab / #pkgCartFab) driven by their own server cart. The v2 header
    // carries a cart button on every page ([data-hdr2-cart], count kept by
    // headerV2.js), so brands on that header never need the FAB — and would
    // otherwise show two cart entry points at once. No effect on v1 brands: the
    // attribute only exists in templates/header_v2.php.
    const hasOwnCartUi = !!(document.getElementById('floatingCartBar')
        || document.getElementById('floatingCart')
        || document.getElementById('subCartFab')
        || document.getElementById('pkgCartFab')
        || document.querySelector('[data-hdr2-cart]'));
    // Cart funnel + the whole subscription/prepaid-pack section (list, VIEW, and
    // checkout) — those run their own server cart, so the menu FAB must never show.
    const onOwnRoute = /^\/(cart|checkout|payments-page|order-polling|subscriptions?|package|store-locator)\b/.test(location.pathname);
    if (hasOwnCartUi || onOwnRoute) return;

    function isLoggedIn() {
        const ud = localStorage.getItem('userdata');
        if (!ud || ud === 'null' || ud === '') return false;
        try { return !!JSON.parse(ud); } catch { return false; }
    }

    function readCart() {
        try {
            const c = JSON.parse(localStorage.getItem('v4_cart') || 'null');
            if (c && c.bId && Array.isArray(c.items)) return c;
        } catch {}
        return null;
    }

    function refresh() {
        const cart = readCart();
        const count = isLoggedIn() && cart
            ? cart.items.reduce((s, i) => s + (i.qty || 0), 0)
            : 0;
        if (count > 0) {
            const badge = document.getElementById('cartFabCount');
            if (badge) badge.textContent = count > 99 ? '99+' : String(count);
            fab.dataset.bid = String(cart.bId);
            fab.hidden = false;
        } else {
            fab.hidden = true;
        }
    }

    // Proceed to checkout for the cart's outlet (mirrors menu.js goToCheckout).
    fab.addEventListener('click', function () {
        const bId = fab.dataset.bid;
        if (!bId) return;
        if (!isLoggedIn()) { if (window.showLogin) window.showLogin(); return; }
        const ot = localStorage.getItem('orderType') || '1';
        const tid = localStorage.getItem('tableId');
        if (ot === '3' && tid && tid !== 'null' && Number(tid) > 0) {
            location.href = '/checkout/' + bId + '/' + ot + '/' + tid;
        } else {
            location.href = '/checkout/' + bId + '/' + ot;
        }
    });

    // Re-evaluate on cross-tab changes, cart.js's event, and bfcache restores.
    window.addEventListener('storage', function (e) {
        if (!e.key || e.key === 'v4_cart' || e.key === 'userdata') refresh();
    });
    window.addEventListener('cart:updated', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);

    // Allow same-page updaters to force a refresh after writing v4_cart.
    window.refreshCartFab = refresh;

    refresh();
})();

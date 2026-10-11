// header_v2 behaviour — loaded only for brands on the redesigned header
// (web_config.header_file = 'header_v2'). Three small jobs, all additive:
//
//   1. Persistent desktop search — v1's field is an icon that expands via
//      [data-gs-toggle]; v2's is always visible. Opening on focus (rather than
//      wiring a toggle) is deliberate: global_search.js treats a toggle click as
//      "live ? close() : open()", so a second click INTO a persistent field
//      would close the panel the user is trying to use.
//   2. Location chip — filled from the same localStorage keys
//      location_picker.js writes, and opens the picker's changeUserLocation().
//      Read-only on the data; the picker itself stays the single writer.
//   3. Cart count — same v4_cart shape floating_cart.js reads.
//
// It also owns the click behaviour for the profile button (header + drawer),
// Track and Cart. v1 wires its equivalents with inline onclick attributes in the
// markup; v2 keeps views free of JS (CLAUDE.md rule 4) and binds off data-*
// hooks here instead.
//
// Plain IIFE + defer, matching floating_cart.js / usp_toggle.js. Deliberately
// NOT an ES module: nested imports are unversioned and /src/js is cached 30
// days, so adding a shared export is a known way to break a deploy.
(function () {
    'use strict';

    // ── 1. persistent desktop search ─────────────────────────────────────────
    var surface = document.querySelector('.hdr2-search[data-gs-surface="desktop"]');
    var input = surface && surface.querySelector('[data-gs-input]');
    if (input) {
        input.addEventListener('focus', function () {
            // Guard against re-entry: openGlobalSearch() focuses the input itself
            // (deferred, for iOS), which would otherwise bounce back through here.
            if (surface.classList.contains('is-open')) return;
            if (typeof window.openGlobalSearch === 'function') window.openGlobalSearch();
        });
    }

    // ── 1b. voice search ─────────────────────────────────────────────────────
    // The mic ships hidden in the markup and is revealed only here, because the
    // Web Speech API is still absent in Firefox and on iOS Safari — a control
    // that silently does nothing is worse than no control at all.
    //
    // It does not search on its own: it writes the transcript into the field and
    // dispatches `input`, which is the exact event typing raises, so
    // global_search.js debounces and runs it through the same path with no
    // knowledge that a microphone was involved.
    (function voiceSearch() {
        var mic = document.querySelector('[data-hdr2-mic]');
        if (!mic || !input) return;

        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;                       // unsupported — stays hidden

        var rec = null;
        var listening = false;

        function stop(state) {
            listening = false;
            mic.classList.remove('is-listening');
            mic.setAttribute('aria-label', 'Search by voice');
            mic.setAttribute('aria-pressed', 'false');
            if (state === 'abort' && rec) { try { rec.abort(); } catch (e) { /* already stopped */ } }
        }

        mic.addEventListener('click', function () {
            if (listening) { stop('abort'); return; }

            rec = new SR();
            // en-IN rather than the browser locale: the catalogue is Indian food
            // ("laddu", "tilkut", "gajak", "namkeen") and en-US mangles those.
            rec.lang = 'en-IN';
            rec.interimResults = true;         // fill the field as they speak
            rec.maxAlternatives = 1;

            rec.onresult = function (e) {
                var text = '';
                for (var i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
                text = text.trim();
                if (text === '') return;
                input.value = text;
                // Same event typing fires — global_search.js owns what happens next.
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            // onend covers the normal stop, a timeout, and most failures; onerror
            // adds the ones that never reach onend (denied permission, no mic).
            rec.onend = function () { stop(); };
            rec.onerror = function () { stop(); };

            try {
                rec.start();
            } catch (e) {
                stop();                        // start() throws if one is already running
                return;
            }
            listening = true;
            mic.classList.add('is-listening');
            mic.setAttribute('aria-label', 'Stop listening');
            mic.setAttribute('aria-pressed', 'true');
            if (typeof window.openGlobalSearch === 'function') window.openGlobalSearch();
        });

        mic.hidden = false;
        mic.setAttribute('aria-pressed', 'false');
    }());

    // ── 2. location chip ─────────────────────────────────────────────────────
    var locValue = document.querySelector('[data-hdr2-loc-value]');
    var locLabel = document.querySelector('[data-hdr2-loc-label]');
    var locIcon  = document.querySelector('[data-hdr2-loc-icon]');

    function has(v) { return !!v && v !== 'null' && v !== 'undefined'; }

    // Where the customer physically goes, per order type. 1 = Delivery is the only
    // one that comes to them; the rest they travel to, so the chip names the outlet.
    var LOC_LABEL_BY_OT = {
        1: 'Deliver to', 2: 'Pick up from', 3: 'Dine in at',
        // In-car is labelled "Outlet": you are not picking the order up from
        // anywhere, it is brought out to your car at that outlet.
        4: 'Outlet', 5: 'Reserve at', 6: 'Pay at',
    };
    var AT_OUTLET_TYPES = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };

    // The chip's glyph follows the order type too — a pin over "Dine in at" said
    // "address" for something that is a table. Inline paths on currentColor, per the
    // design-system rule for decorative icons; 24x24 viewBox, matching the markup.
    var PIN_ICON = '<path d="M4 10.1433C4 5.64588 7.58172 2 12 2C16.4183 2 20 5.64588 20 10.1433C20 14.6055 17.4467 19.8124 13.4629 21.6744C12.5343 22.1085 11.4657 22.1085 10.5371 21.6744C6.55332 19.8124 4 14.6055 4 10.1433Z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.5"/>';
    var LOC_ICON_BY_OT = {
        2: '<path d="M4 9.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.5 6.5 5 3.5h14l1.5 3a3 3 0 0 1-5.5 2 3 3 0 0 1-6 0 3 3 0 0 1-5.5-2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
        3: '<path d="M7 3v8m0 0v10m0-10a3 3 0 0 0 3-3V3M7 11a3 3 0 0 1-3-3V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M17 21v-8m0 0c2 0 3-1.5 3-4.5S18.5 3 17 3s-3 2.5-3 5.5 1 4.5 3 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
        4: '<path d="M5 17h14M4 13l1.6-4.8A2 2 0 0 1 7.5 7h9a2 2 0 0 1 1.9 1.2L20 13M4 13h16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7.5" cy="17" r="1.5" stroke="currentColor" stroke-width="1.5"/><circle cx="16.5" cy="17" r="1.5" stroke="currentColor" stroke-width="1.5"/>',
        5: '<rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        6: '<rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.5"/>',
    };

    function refreshLocation() {
        if (!locValue) return;
        var addr = localStorage.getItem('userAddress') || '';
        var label = localStorage.getItem('userAddressLabel') || '';
        var locality = localStorage.getItem('locality');
        var city = localStorage.getItem('city');
        var slug = localStorage.getItem('slug');

        // A bare numeric address-type id ("1" = Home, "2" = Office) can land here
        // from the checkout hydration path. location_picker.js maps it; we have no
        // access to that table, so drop it rather than render "1" as a label.
        if (/^\d+$/.test(label)) label = '';

        // WHICH location this chip names depends on the order type. Only delivery
        // comes to the customer; for pickup, dine-in, in-car and reservation the
        // customer goes to the OUTLET, so naming their home address there is simply
        // false ("Pick up from <their house>"). Those types show locality/city — the
        // outlet — which also gives the outlet somewhere to live in this two-slot
        // header, after v2 dropped v1's separate "Selected Outlet" row.
        //
        // Delivery (and an unchosen type, which every downstream consumer treats as
        // delivery) keeps the old behaviour: the committed address, and the saved
        // address TYPE as its label. No fallback to locality/city/slug there —
        // commitAndRedirect() overwrites those with the OUTLET's values, so they can
        // never stand for "where the user is".
        var ot       = localStorage.getItem('orderType');
        var atOutlet = !!AT_OUTLET_TYPES[ot];
        var place, labelText;

        if (atOutlet) {
            place     = has(locality) ? locality + (has(city) ? ', ' + city : '') : '';
            // Nothing stored, but the page may still KNOW the outlet: /order/{slug}
            // reached from a shared link never goes through the location journey,
            // so locality/city are absent while the page plainly is an outlet.
            // OutletConfig is the server's own statement of which one — the same
            // fallback currentOutletBusiness() already makes for the cart badge.
            // Without it the chip read "Pick up from · Set location" directly above
            // an order type that had resolved to Pickup: half the control knew where
            // it was and half did not.
            // Only for the at-outlet types. Delivery names the CUSTOMER's address,
            // and substituting the outlet there would be plainly false.
            if (!place) {
                var oc = window.OutletConfig;
                if (oc && (has(oc.locality) || has(oc.city))) {
                    place = has(oc.locality)
                        ? oc.locality + (has(oc.city) ? ', ' + oc.city : '')
                        : oc.city;
                }
            }
            labelText = LOC_LABEL_BY_OT[ot];
        } else {
            place     = has(addr) ? addr : '';
            // The saved address type (Home/Office) only makes sense for a delivery
            // destination — nobody dines in "at Home".
            labelText = (place && label) ? label : 'Deliver to';
        }

        locValue.textContent = place || 'Set location';
        if (locLabel) locLabel.textContent = labelText;
        if (locIcon) locIcon.innerHTML = LOC_ICON_BY_OT[ot] || PIN_ICON;
        refreshLocBarTag(place, atOutlet ? '' : label);
        refreshLocBarLabel(atOutlet ? labelText : 'Deliver to');
        var barIcon = document.querySelector('[data-hdr2-locbar-icon]');
        // Same glyph as the chip. The bar's paths carry a heavier stroke (1.7 vs
        // 1.5) to hold their own at 22px, so re-weight the shared markup rather
        // than keeping a second set of icons in sync by hand.
        if (barIcon) barIcon.innerHTML = (LOC_ICON_BY_OT[ot] || PIN_ICON).replace(/stroke-width="1\.5"/g, 'stroke-width="1.7"');
    }

    // The mobile bar carries the saved address type ("Home", "Office") in a chip
    // beside its label — v1's arrangement, and the reason a visitor filed under
    // "Other" no longer sees a row whose only heading is the word "Other".
    //
    // Only the CHIP — location_picker.js owns the value there (#headerAddress),
    // and two writers for one element is how they drift apart.
    function refreshLocBarTag(place, label) {
        var el = document.querySelector('[data-hdr2-locbar-tag]');
        if (!el) return;
        var tag = (place && label) ? label : '';
        el.textContent = tag;
        el.hidden = !tag;
    }

    // The bar's heading follows the order type, exactly as the chip's does: this
    // is the SAME control at two widths (bar below 992px, chip above), and a
    // fixed "Your Location" over an outlet the user is picking up FROM said the
    // wrong thing — while the menu page, whose order-type slot reflows the chip
    // into a band at this width, said "Pick up from" a few pixels away. Home and
    // the menu now use one set of words for one control.
    //
    // Delivery keeps a plain "Deliver to" rather than the chip's saved-address
    // type: the tag chip beside it already names the type, and writing it here
    // too would print "Home" twice on one line.
    function refreshLocBarLabel(text) {
        var el = document.querySelector('[data-hdr2-locbar-label]');
        if (el) el.textContent = text;
    }

    // "Add more items" (cart/checkout) points at the outlet the order is for.
    // The server fills this href when the page knows its outlet; the cart page
    // does not — it is driven entirely from client state — so the stored slug is
    // the authority here. Left as rendered when nothing is stored, which is the
    // store-locator fallback rather than a dead link.
    (function addMoreItemsHref() {
        var el = document.querySelector('[data-hdr2-addmore]');
        if (!el) return;
        var slug = localStorage.getItem('slug');
        if (has(slug)) el.setAttribute('href', '/order/' + slug);
    }());

    // The picker is loaded by its own module; guard rather than assume, exactly
    // as the inline handler this replaced did.
    var locBtn = document.querySelector('[data-hdr2-loc]');
    if (locBtn) {
        locBtn.addEventListener('click', function () {
            if (typeof window.changeUserLocation === 'function') window.changeUserLocation();
        });
    }

    // The mobile location bar (templates/location_bar_v2.php) opens the same
    // journey the desktop chip does. Both its halves — the address and Change —
    // carry the hook, because either is a reasonable thing to tap.
    Array.prototype.forEach.call(document.querySelectorAll('[data-hdr2-locbar]'), function (el) {
        el.addEventListener('click', function () {
            if (typeof window.changeUserLocation === 'function') window.changeUserLocation();
        });
    });

    // Order type — the chip's neighbour on desktop, the bar's right half on
    // mobile. Both open the picker's order-type step.
    Array.prototype.forEach.call(document.querySelectorAll('[data-hdr2-ordertype]'), function (el) {
        el.addEventListener('click', function () {
            if (typeof window.changeOrderType === 'function') window.changeOrderType();
        });
    });

    // location_picker.js keeps .headerOrderType in sync, but only inside
    // #locationInfoBar (bar.querySelectorAll) — which covers the mobile bar and
    // misses the desktop chip's copy, since that lives in the header. Label it
    // here from the same key and the same map.
    // CANONICAL order-type labels — must match wla_order_types() in
    // app/Helpers/wla_order_type_helper.php, which is what the menu page's own
    // switcher (.ots) renders into this very control. They did not match: the
    // menu showed "Pickup" and every other page "Pick Up" for the same stored
    // value, in the same chip, in the same place on screen.
    // Duplicated literally in location_picker.js (which labels the mobile
    // location bar) rather than shared through a module: /src/js is cached 30
    // days and nested imports are unversioned, so a shared export is a known way
    // to break a deploy. Change one, change all three.
    var ORDER_TYPE_LABELS = { 1: 'Delivery', 2: 'Pickup', 3: 'Dine-in', 4: 'In-car', 5: 'Reservation', 6: 'Direct Pay' };
    function refreshOrderType() {
        var ot = localStorage.getItem('orderType');
        // No stored type = the user has not chosen one (first visit, or an "Explore
        // Menu" diversion, which sets an outlet but deliberately no order type).
        // "Set order type" — a prompt worded to match the location chip's
        // "Set location" — rather than defaulting to "Delivery", which announced a
        // choice nobody made.
        var label = ORDER_TYPE_LABELS[ot] || 'Set order type';
        Array.prototype.forEach.call(document.querySelectorAll('.hdr2-ot .headerOrderType'), function (el) {
            el.textContent = label;
        });
    }

    // The order type can be written AFTER this script runs: the menu page adopts the
    // outlet's PHP-rendered default on load, and its strip lets the user switch. Neither
    // fires `storage` (same tab), so without these the chip kept prompting
    // "Set order type" over a menu that already had one selected.
    // Both halves: the order type decides WHICH location the chip names, so the
    // location half has to re-render too.
    document.addEventListener('ordertype:changed', function () {
        refreshOrderType();
        refreshLocation();
    });
    // Safety net for any writer that doesn't announce itself.
    window.addEventListener('load', refreshOrderType);
    window.refreshHeaderOrderType = refreshOrderType;

    // ── 3. cart count ────────────────────────────────────────────────────────
    var countEl = document.querySelector('[data-hdr2-cart-count]');

    function isLoggedIn() {
        var ud = localStorage.getItem('userdata');
        if (!ud || ud === 'null' || ud === '') return false;
        try { return !!JSON.parse(ud); } catch (e) { return false; }
    }

    function readCart() {
        try {
            var c = JSON.parse(localStorage.getItem('v4_cart') || 'null');
            if (c && c.bId && Array.isArray(c.items)) return c;
        } catch (e) { /* malformed cart reads as empty */ }
        return null;
    }

    // The count belongs to a SELECTED OUTLET, not to localStorage in general.
    // floating_cart.js assumes "a cart with items inherently means an outlet was
    // chosen", and that does not hold: location_picker.js wipes slug/business on a
    // 60-minute TTL (_LP_TTL_MS) without touching v4_cart. The leftover cart then
    // painted a count next to a chip reading "Set location", and clicking it hit
    // the /cart|/checkout href gate and bounced into the location journey — a
    // badge promising a cart the header could not actually open.
    // Requiring the ids to match also covers the second case: a cart left over
    // from a DIFFERENT outlet than the one now selected is not this outlet's cart.
    // Which outlet the visitor is dealing with right now.
    //
    // Normally that is the one they picked, in localStorage. But arriving on a
    // shared menu link never goes through the location journey, and menu.js only
    // writes `business` for a dine-in QR scan — so on /order/{slug} the key is
    // routinely absent while the page plainly IS an outlet. window.OutletConfig
    // is the server's own statement of which one, so prefer localStorage and fall
    // back to it. The home page has no OutletConfig, so there the rule stays "an
    // outlet must have been selected".
    function currentOutletBusiness() {
        var biz = localStorage.getItem('business');
        if (biz && biz !== 'null') return String(biz);
        // OutletConfig.businessId is THIS outlet. Not AppConfig.businessId — that
        // is the parent brand (68274 for every Pramod outlet), which would match
        // no cart at all.
        var oc = window.OutletConfig;
        return (oc && oc.businessId) ? String(oc.businessId) : '';
    }

    function cartIsForSelectedOutlet(cart) {
        var biz = currentOutletBusiness();
        return !!(cart && biz && String(cart.bId) === biz);
    }

    var cartLink = document.querySelector('[data-hdr2-cart]');

    // Where the cart button actually goes. Mirrors floating_cart.js:64-75 and
    // menu.js's goToCheckout, dine-in tableId segment included.
    //
    // It must never be /cart: that route is not a page. cart_page.js
    // `location.replace()`s to /checkout/{bId}/{orderType} on DOMContentLoaded
    // (or to / with no cart) — its own header calls the route "a payment-screen
    // fallback" — while pages/cart.php still server-renders a full cart-summary
    // shell that PAINTS before the redirect fires. That flash of a different UI
    // on the way to checkout is the reported "redirecting to cart instead of
    // checkout" / "UI looks different for first time", and it is worst on a cold
    // load where the JS is not yet cached.
    function cartDest() {
        var cart = readCart();
        if (cartIsForSelectedOutlet(cart) && cart.items.length) {
            var ot  = localStorage.getItem('orderType') || '1';
            var tid = localStorage.getItem('tableId');
            return (ot === '3' && tid && tid !== 'null' && Number(tid) > 0)
                ? '/checkout/' + cart.bId + '/' + ot + '/' + tid
                : '/checkout/' + cart.bId + '/' + ot;
        }
        // Empty cart: /cart would have bounced to / anyway, so go straight there —
        // or to the chosen outlet's menu, which is where an empty cart wants to
        // send someone.
        var slug = localStorage.getItem('slug');
        return (slug && slug !== 'null') ? '/order/' + slug : '/';
    }

    function refreshCart() {
        var cart = readCart();

        // Rewrite the HREF, not just the click target. The markup ships
        // href="/cart" so the button is a real link with no JS, but leaving it at
        // that meant every navigation the click handler does not own — a click
        // landing before this deferred script runs, middle-click, open-in-new-tab,
        // a crawler — still went through the /cart stub. Keeping the href itself
        // correct is what makes the destination right in all of those.
        if (cartLink) cartLink.setAttribute('href', cartDest());

        if (!countEl) return;
        // NOT gated on login. menu.js lets anyone add to the cart and only asks
        // for an account at goToCheckout(), so a signed-out visitor really does
        // have items — and the menu page's own bar shows them. Requiring login
        // here (inherited from floating_cart.js:51) meant the header sat blank
        // beside a bar counting the same cart, on the same screen. Login is what
        // checking out needs, not what holding a cart needs; the click handler
        // above still asks for it at that point.
        var count = 0;
        if (cartIsForSelectedOutlet(cart)) {
            count = cart.items.reduce(function (s, i) { return s + (i.qty || 0); }, 0);
        }
        countEl.textContent = String(count);
        countEl.hidden = count <= 0;
    }

    // ── 4. Track Order ───────────────────────────────────────────────────────
    // Logged out, Track opens the login modal rather than dropping the user on an
    // order list they can't see — same rule the profile button already follows.
    //
    // Logged in, it goes where the user actually meant, by how many orders are in
    // progress — the same count the badge on this button shows:
    //   1  -> that order's tracker, /past-order/{id}. The list is a detour when
    //         there is only one thing on it.
    //   2+ -> the profile sidebar, which lists them all with live ETAs. Picking
    //         one arbitrarily would be a guess.
    //   0  -> the href, /past-order, unchanged.
    // Also the fallback whenever the snapshot is missing: activeOrders.js polls,
    // so an early click can land before the first response, and the list is the
    // safe answer then.
    var track = document.querySelector('[data-hdr2-track]');
    if (track) {
        track.addEventListener('click', function (e) {
            // Let modified clicks (new tab/window) through untouched.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

            if (isLoggedIn()) {
                var snap = window.hdr2ActiveOrders;
                if (!snap || !snap.count) return;            // none yet — href runs
                e.preventDefault();
                if (snap.count === 1 && snap.ids[0]) {
                    window.location.href = '/past-order/' + encodeURIComponent(snap.ids[0]);
                    return;
                }
                if (typeof window.toggleProfileSidebar === 'function') {
                    window.toggleProfileSidebar();
                    return;
                }
                window.location.href = track.getAttribute('href') || '/past-order';
                return;
            }

            if (typeof window.showLogin !== 'function') return;  // login js not up yet
            e.preventDefault();

            var href = track.getAttribute('href') || '/past-order';
            // base.php calls _onLoginSuccess INSTEAD of reloading, so this carries the
            // user through to the tracker once auth (and the first-login name prompt)
            // completes. Self-clearing on the first line, matching every other module
            // that uses this hook (location_picker, reservation*, preBookingDetail).
            window._onLoginSuccess = function () {
                window._onLoginSuccess = null;
                window.location.href = href;
            };
            window.showLogin('track');
        });
    }

    // ── 5. Cart: login, then outlet ──────────────────────────────────────────
    // Two things stand between a click and a cart, and they are answered in the
    // order the visitor has to satisfy them.
    //
    // LOGIN FIRST. A cart belongs to an account, so a signed-out visitor cannot
    // have one whether or not an outlet is picked — asking them to choose a
    // location before they can even hold a cart is the wrong question first. The
    // floating FAB has gated on login since floating_cart.js:68; the header cart
    // was a bare <a> and did not.
    //
    // THEN OUTLET. With no outlet, cartDest() resolves to '/', so on the home
    // page the click just reloaded it — a control that visibly did nothing.
    // Opening the journey both explains the blocker and removes it, where a
    // tooltip would only explain. changeUserLocation() branches per brand: the
    // modal for a multi-outlet brand, that outlet's menu for a single-outlet one.
    //
    // Modifier-clicks pass straight through in both cases.
    if (cartLink) {
        cartLink.addEventListener('click', function (e) {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

            if (!isLoggedIn()) {
                if (typeof window.showLogin !== 'function') return;  // login js not up yet
                e.preventDefault();
                // base.php calls _onLoginSuccess INSTEAD of reloading, so the user
                // continues through once auth (and the first-login name prompt)
                // completes. Re-clicking rather than caching the href, because
                // logging in can change where the cart should go — and because the
                // outlet gate below then gets its turn. Self-clearing on the first
                // line, like every other module that uses this hook.
                window._onLoginSuccess = function () {
                    window._onLoginSuccess = null;
                    refreshCart();
                    cartLink.click();
                };
                window.showLogin('cart');
                return;
            }

            // Same outlet resolution the badge and cartDest() use — NOT
            // hasSelectedOutlet(), which needs localStorage.slug AND .business.
            // menu.js writes those only for a dine-in QR scan, so on a shared
            // /order/{slug} link they are absent: the badge and the href resolved
            // the outlet through OutletConfig and pointed at /checkout/{bId}/{ot},
            // while this gate still said "no outlet" and opened the location
            // journey instead of the cart. Badge, href and click now agree.
            if (!currentOutletBusiness()) {
                if (typeof window.changeUserLocation === 'function') {
                    e.preventDefault();
                    window.changeUserLocation();
                }
                return;
            }

            // Outlet known — the href is already the right destination, whether
            // that is checkout (a cart for this outlet) or the outlet's menu.
        });
    }

    // ── 6. Profile button (header + drawer) ──────────────────────────────────
    // Signed in -> the profile sidebar; signed out -> the login modal, tagged
    // with which surface opened it. Both buttons share this one handler; the
    // drawer's copy also keeps its data-bs-dismiss, so Bootstrap still closes
    // the offcanvas underneath.
    Array.prototype.forEach.call(document.querySelectorAll('[data-hdr2-profile]'), function (btn) {
        btn.addEventListener('click', function () {
            if (isLoggedIn()) {
                if (typeof window.toggleProfileSidebar === 'function') window.toggleProfileSidebar();
                return;
            }
            if (typeof window.showLogin === 'function') {
                window.showLogin(btn.getAttribute('data-hdr2-login-source') || 'header');
            }
        });
    });

    function refreshAll() { refreshLocation(); refreshOrderType(); refreshCart(); }

    refreshAll();

    // Another tab changed the cart or the chosen location.
    window.addEventListener('storage', refreshAll);
    // Same-tab: most location/cart writes are followed by a navigation, but a
    // bfcache restore replays this page without re-running the IIFE.
    window.addEventListener('pageshow', function (e) { if (e.persisted) refreshAll(); });

    // Escape hatch for flows that mutate localStorage without navigating.
    window.hdr2RefreshHeader = refreshAll;
}());

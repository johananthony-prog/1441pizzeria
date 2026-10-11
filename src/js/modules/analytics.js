/**
 * analytics.js — single, self-contained analytics layer for GA4/GTM, Meta Pixel,
 * and WebEngage. Replaces the per-vendor inline snippets that used to live in base.php.
 *
 * Design — provider registry:
 *   - window.AnalyticsConfig (emitted by base.php from per-brand web_config) carries the IDs.
 *   - Each provider object declares enabled(), init() (loads its own SDK + installs the
 *     vendor stub so calls fired before the heavy SDK lands are buffered), and one method
 *     per semantic event. A provider simply omits events it has no equivalent for.
 *   - Call-sites import the exported track*() helpers and fire SEMANTIC events; they know
 *     nothing about which providers exist. emit() fans each event out to every enabled provider.
 *
 * Adding a new provider later (e.g. LinkedIn) = (1) add its id to AnalyticsConfig in base.php,
 * (2) add one provider object below. No funnel file changes.
 *
 * Every provider call is wrapped in try/catch — analytics must never break the order funnel.
 *
 * CI3 parity reference (legacy repo): wla_new/main.php (SDK init), order_details/checkout/
 * confirmation JS for the event payload shapes.
 */

const rawCfg = window.AnalyticsConfig || {};

/**
 * Repair per-brand tag config before use.
 *
 * 28 of the 76 configured `gtm_tag` values in web_config are not GTM containers: GA4
 * measurement ids (G-…), Google Tag ids (GT-…), the literal strings "null"/"undefined",
 * whole <script> snippets pasted into the field, and values with stray whitespace. All of
 * them made cfg.gtm truthy, so those brands took the dataLayer path while `gtm.js?id=<junk>`
 * failed to load and gtag('config') never ran — every event lost.
 *
 * This only ever RELAXES a broken value. A well-formed `GTM-…` is returned untouched, so
 * correctly-configured brands take byte-identical code paths to before.
 *
 * The data should still be cleaned in web_config; this keeps the frontend resilient to it.
 */
function normalizeConfig(raw) {
    const str = v => String(v ?? '').trim();
    let gtm = str(raw.gtm);
    let ga4 = str(raw.ga4);

    // CI3 imports wrote the literal word rather than an empty value.
    if (/^(null|undefined)$/i.test(gtm)) gtm = '';
    if (/^(null|undefined)$/i.test(ga4)) ga4 = '';

    // Someone pasted the whole install snippet — recover the id from inside it.
    if (gtm.includes('<')) {
        const m = gtm.match(/\b(GTM-[A-Z0-9]+)\b/i) || gtm.match(/\b(G-[A-Z0-9]+)\b/i) || gtm.match(/\b(GT-[A-Z0-9]+)\b/i);
        gtm = m ? m[1] : '';
    }

    // A measurement / Google-Tag id filed under the container column. Route it to gtag —
    // but NEVER overwrite a real google_analytics value that is already set.
    if (/^(G-|UA-|GT-)/i.test(gtm)) {
        if (!ga4) ga4 = gtm;
        gtm = '';
    }

    // Anything still here that isn't a container id cannot load gtm.js. Drop it so we stop
    // requesting a broken container and stop routing events to a dataLayer nobody reads.
    // (Google Ads ids — AW-… — land here deliberately: they are not a GA4 destination and
    // guessing at one would be worse than leaving the brand as it is.)
    if (gtm && !/^GTM-[A-Z0-9]+$/i.test(gtm)) gtm = '';

    return { ...raw, gtm, ga4 };
}

const cfg = normalizeConfig(rawCfg);

const hasGtag = () => typeof window.gtag === 'function';
const hasFbq  = () => typeof window.fbq === 'function';
const hasWe   = () => typeof window.webengage !== 'undefined' && window.webengage;

// ── Payload builders ─────────────────────────────────────────────────────────
// Call-sites pass a normalized item array: [{ id, name, qty, price, category, veg, image }].

/** GA4 ecommerce items[] — mirrors CI3 order_details_new_20240812.js:2686. */
function gtagItems(items) {
    return (items || []).map(i => ({
        item_id:       String(i.id ?? ''),
        item_name:     i.name ?? '',
        quantity:      Number(i.qty ?? 1),
        price:         Number(i.price ?? 0),
        item_category: i.category ?? '',
    }));
}

/** WebEngage "Product Details" array — mirrors CI3 checkoutPage_20250711.js:1036. */
function weProductDetails(items) {
    return (items || []).map(i => ({
        'Product Name':  i.name ?? '',
        'Category Name': i.category ?? '',
        'Price':         Number(i.price ?? 0),
        'Image':         i.image ?? '',
        'Type':          i.veg ?? '',
    }));
}

/** Joined helper strings WebEngage events expect alongside the details array. */
function weJoined(items) {
    const list = items || [];
    return {
        'Product Names':  list.map(i => i.name ?? '').join(', '),
        'Product IDs':    list.map(i => String(i.id ?? '')).join(', '),
        'Category Names': list.map(i => i.category ?? '').join(', '),
        'Product Details': weProductDetails(list),
    };
}

/** Drop undefined/null/'' keys — vendors otherwise receive the literal string "undefined".
 *  Zero is kept: a ₹0 value or a 0 discount is real data. */
function clean(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

/**
 * Meta product parameters — required for Dynamic Product Ads and catalog matching.
 *
 * Returns {} when we can't produce at least one usable id: an EMPTY content_ids array
 * is worse than the key being absent, because it positively asserts "this event carried
 * no products" and Meta then excludes the event from catalog/DPA matching entirely.
 *
 * Call-sites build item arrays in three different shapes (menu.js:200 prefers parentId,
 * checkout.js:201 adds category, orderConfirmation.js a third), so read defensively.
 *
 * NOTE: DPA only actually fires if a Meta product catalog exists whose item ids match
 * these — sending the parameter is necessary but not sufficient.
 */
/**
 * Normalise a payload's product list. Call-sites are inconsistent: most send `items` (an
 * array), but menu.js's removeFromCart sends only `item` (a single object). Reading
 * `p.items` alone silently produced an EMPTY list there — GA4 was shipping
 * remove_from_cart with `items: []`, and Meta would have had no content_ids.
 */
function asItems(p) {
    if (Array.isArray(p?.items) && p.items.length) return p.items;
    return p?.item ? [p.item] : [];
}

function metaProducts(items, extra) {
    const list = (items || []).filter(Boolean);
    const ids  = list.map(i => String(i.id ?? '')).filter(Boolean);
    if (!ids.length) return {};

    const out = { content_ids: ids, content_type: 'product' };
    if (extra?.numItems) out.num_items = list.reduce((s, i) => s + (Number(i.qty) || 1), 0);
    if (extra?.name)     out.content_name = list[0].name ?? '';
    return out;
}

// ── SDK loaders (vendor stubs + async script injection) ──────────────────────
function loadGa4(measurementId, gtmId) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());

    if (gtmId) {
        (function (w, d, s, l, i) {
            w[l] = w[l] || []; w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
            const f = d.getElementsByTagName(s)[0], j = d.createElement(s);
            j.async = true; j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i;
            f.parentNode.insertBefore(j, f);
        })(window, document, 'script', 'dataLayer', gtmId);
    }
    if (measurementId) {
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
        document.head.appendChild(s);
        window.gtag('config', measurementId);
    }
}

function loadMeta(pixelIds) {
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    pixelIds.forEach(px => window.fbq('init', String(px)));
    window.fbq('track', 'PageView');
}

function loadWebEngage(licenseCode) {
    // The official WebEngage v6.0 loader resolves a sibling <script id="_webengage_script_tag">,
    // so we create that anchor first (we load from a module, not an inline tag).
    const anchor = document.createElement('script');
    anchor.id = '_webengage_script_tag';
    document.head.appendChild(anchor);
    /* eslint-disable */
    !function (w, e, b, n, g) {
        function o(e, t) { e[t[t.length - 1]] = function () { r.__queue.push([t.join('.'), arguments]) } }
        var i, s, r = w[b], z = ' ', l = 'init options track screen onReady'.split(z),
            a = 'feedback survey notification'.split(z), c = 'options render clear abort'.split(z),
            p = 'Open Close Submit Complete View Click'.split(z), u = 'identify login logout setAttribute'.split(z);
        if (!r || !r.__v) {
            for (w[b] = r = { __queue: [], __v: '6.0', user: {} }, i = 0; i < l.length; i++) o(r, [l[i]]);
            for (i = 0; i < a.length; i++) { for (r[a[i]] = {}, s = 0; s < c.length; s++) o(r[a[i]], [a[i], c[s]]); for (s = 0; s < p.length; s++) o(r[a[i]], [a[i], 'on' + p[s]]) }
            for (i = 0; i < u.length; i++) o(r.user, ['user', u[i]]);
            setTimeout(function () {
                var f = e.createElement('script'), d = e.getElementById('_webengage_script_tag');
                f.type = 'text/javascript'; f.async = !0;
                f.src = ('https:' == e.location.protocol ? 'https://widgets.in.webengage.com' : 'http://widgets.in.webengage.com') + '/js/webengage-min-v-6.0.js';
                d.parentNode.insertBefore(f, d);
            }, 0);
        }
    }(window, document, 'webengage');
    /* eslint-enable */
    window.webengage.init(String(licenseCode));
}

// Two independent delivery paths — both fire when their respective config is present.
//
//   Layer 1 — google_analytics (cfg.ga4): calls gtag() directly. Events reach GA4 the
//     moment code ships, zero GTM setup required. This is the "day 0" path.
//
//   Layer 3 — gtm_tag (cfg.gtm): pushes to dataLayer. GTM picks it up for Google Ads
//     conversion tags, remarketing, and any other vendor tags in the container.
//     GTM also needs its own trigger to forward events to GA4 (one-time setup per brand).
//
// Brands configure whichever layer(s) they need:
//   • google_analytics only  → gtag direct, day 0, no GTM needed
//   • gtm_tag only           → dataLayer, GTM triggers required for GA4
//   • both                   → Layer 1 owns GA4; Layer 3 feeds Ads/remarketing tags
//
// ⚠️  Double-count guard: brands with BOTH layers configured must NOT enable
//     "Send ecommerce data" on their GTM GA4 config tag — that would forward
//     ecommerce events to GA4 a second time. Custom/auth events (ga4Event) are
//     safe: GTM usually has no conversion tags triggering on login_initiated etc.

function ga4Ecom(eventName, params) {
    if (cfg.gtm) {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ ecommerce: null });              // clear the previous payload
        window.dataLayer.push({ event: eventName, ecommerce: params });
    }
    if (cfg.ga4) {
        window.gtag('event', eventName, params);
    }
}

// Non-ecommerce GA4 events (auth, funnel, discovery). Params sit at the TOP level —
// no `ecommerce` wrapper — so GTM triggers match the event name directly and
// `{ecommerce: null}` is never fired mid-funnel.
function ga4Event(eventName, params) {
    if (cfg.gtm) {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: eventName, ...(params || {}) });
    }
    if (cfg.ga4) {
        window.gtag('event', eventName, params || {});
    }
}

// ── Provider registry ────────────────────────────────────────────────────────
const providers = [
    {
        name: 'ga4',
        // Deliberately reads the RAW config, not the normalized one. A brand whose only tag
        // is junk still activates this provider, so loadGa4() runs and installs the
        // window.gtag / window.dataLayer stubs. Some brand override views call gtag() and
        // fbq() bare with no typeof guard (ue_override/core_views/wow_momos/store_locator.php),
        // and would throw a ReferenceError without those stubs. Normalization must never be
        // able to switch a provider off.
        enabled: () => !!rawCfg.ga4 || !!rawCfg.gtm,
        // init uses the NORMALIZED values: stubs still get installed, but we stop requesting
        // a container id that can't exist.
        init: () => loadGa4(cfg.ga4, cfg.gtm),
        productViewed:   p => ga4Ecom('view_item',         { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        addToCart:       p => ga4Ecom('add_to_cart',       { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        removeFromCart:  p => ga4Ecom('remove_from_cart',  { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        beginCheckout:   p => ga4Ecom('begin_checkout',    { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        addShippingInfo: p => ga4Ecom('add_shipping_info', { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        addPaymentInfo:  p => ga4Ecom('add_payment_info',  { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        purchase:        p => ga4Ecom('purchase', {
            transaction_id: String(p.orderId ?? ''), currency: 'INR',
            value: Number(p.value ?? 0), tax: Number(p.tax ?? 0), shipping: Number(p.shipping ?? 0),
            items: gtagItems(asItems(p)),
        }),
        // Payment failure. `reason` distinguishes an initiation failure (we have the server
        // msg) from an authoritative gateway failure, and — importantly — from the polling
        // TIMEOUT, where the payment may actually have succeeded.
        paymentFailed: p => ga4Event('payment_failed', clean({
            currency: 'INR', value: p.value, reason: p.reason,
            payment_method: p.paymentMethod, transaction_id: p.orderId ? String(p.orderId) : undefined,
        })),
        // Login-method funnel. `method` on login_success is what makes it a funnel rather
        // than two unrelated counters: clicks are split by method, so successes must be too,
        // otherwise there is nothing to divide by. Absent `method` → the event is unchanged.
        loginMethodClicked: p => ga4Event('login_method_clicked', clean({ method: p.method })),
        loginMethodFailed:  p => ga4Event('login_method_failed',  clean({ method: p.method, reason: p.reason })),
        // Routed through ga4Event (NOT ga4Ecom) — see the helper's comment for why.
        login: p => {
            ga4Event('login_success', clean({ method: p.method }));
            // Method-specific aliases. Table 1 lists these as their own rows WITH their own
            // counts alongside login_success, so the app fires both — mirroring that keeps
            // web and app reporting comparable. Anything summing "total logins" must use
            // login_success alone, not the sum.
            if (p.method === 'truecaller') ga4Event('truecaller_success', {});
            if (p.method === 'whatsapp')   ga4Event('whatsapp_success', {});
        },
        otpSent:      () => ga4Event('send_otp', {}),
        otpValidated: () => ga4Event('otp_validated', { event_category: 'otp_validated', event_label: 'OTP Validated', value: 1 }),
        profileUpdated: () => ga4Event('profile_updated', { event_category: 'profile updated', event_label: 'Profile updated by user', value: 1 }),

        // ── Auth funnel, pre-OTP ────────────────────────────────────────────
        // loginInitiated → modal opened; mobileEntered → a valid 10-digit number typed;
        // captchaEntered → captcha filled. Together with send_otp / otp_validated /
        // login_success these give the full drop-off curve of the login flow.
        // NAME CAVEAT: "completed" here means the field was FILLED, not that the captcha
        // was correct. Nothing client-side validates it (base.php only length-gates), and
        // /auth/send-otp returns a generic message, so a wrong captcha is indistinguishable
        // from an SMS outage. Do not read this as a captcha pass-rate. Named to match the
        // tracking spec (audit Table 2).
        loginInitiated: p => ga4Event('login_initiated', clean({ source: p.source })),
        mobileEntered:  () => ga4Event('mobile_entered', {}),
        captchaCompleted: () => ga4Event('captcha_completed', {}),

        // ── Checkout ────────────────────────────────────────────────────────
        // couponStatus previously existed on WebEngage ONLY — GA4 and Meta saw nothing,
        // despite ~6.5k coupon applications a month (a ready-made price-sensitive audience).
        couponStatus: p => ga4Event('coupon_status', clean({
            status: p.status, coupon: p.code, value: Number(p.discount ?? 0),
        })),
        deliveryTypeSelected:  p => ga4Event('delivery_type_selected', clean({ delivery_type: p.deliveryType, source: p.source })),
        paymentMethodSelected: p => ga4Event('payment_method_selected', clean({ payment_method: p.paymentMethod })),

        // Registration = a new customer's FIRST login (there is no separate signup on this
        // platform). Meta and WebEngage already received this; GA4 was the only provider
        // without a method, so emit() silently skipped it. Gated on rows.newUser upstream.
        registration: p => ga4Event('customer_registered', clean({ method: p.method })),
        // Serviceable outlet committed from the location picker — the top of the ordering
        // funnel for users who arrive without an outlet already resolved.
        locationSelected: p => ga4Event('location_selected', clean({
            business_id: p.businessId ? String(p.businessId) : undefined,
            locality: p.locality, city: p.city, order_type: p.deliveryType, method: p.method,
        })),
        // "Send OTP" tapped — fires BEFORE the request, so the gap between this and
        // send_otp is OTP-delivery failure rather than user drop-off.
        otpInitiated: () => ga4Event('otp_initiated', {}),
        // Distinct from add_payment_info: that fires when the pay step is reached, this when
        // a method is chosen and the charge is actually attempted. Doc counts agree
        // (14,603 vs 6,379), so they are different moments, not duplicates.
        paymentStarted: p => ga4Event('payment_started', clean({ payment_method: p.paymentMethod })),
        // The NEW-address subset of add_shipping_info (doc: 3,167 of 6,026).
        addressAdded: p => ga4Event('address_added', clean({ selection_type: p.selectionType })),
        slotSelected: p => ga4Event('slot_select', clean({
            slot_mode: p.mode, slot_date: p.slotDate, slot_label: p.label,
        })),

        // ── Discovery ───────────────────────────────────────────────────────
        // ── Location picker funnel ───────────────────────────────────────────────
        // Four events that together expose the blind spot between session_start and
        // store_viewed: the location picker modal. Previously we had zero visibility into
        // how many users opened the picker and dropped off before selecting an outlet.
        //
        //   opened           → modal is shown (denominator for the whole picker funnel)
        //   search_attempted → user triggered a lookup (GPS tap or ≥3-char text entry)
        //   no_results       → locality search returned zero matches (bad query or typo)
        //   not_serviceable  → area found but no outlet serves it (genuine coverage gap)
        //
        // page_path on opened lets us split by entry point (content page vs /online-order
        // vs homepage) without adding a separate event per surface.
        locationPickerOpened:      p => ga4Event('location_picker_opened',    clean({ page_path: p.pagePath })),
        locationSearchAttempted:   p => ga4Event('location_search_attempted', clean({ method: p.method, query: p.query })),
        locationNoResults:         p => ga4Event('location_no_results',       clean({ query: p.query })),
        locationNotServiceable:    p => ga4Event('location_not_serviceable',  clean({ locality: p.locality, lat: p.lat, lng: p.lng })),

        // Outlet page opened. Distinct from view_item: this is "which store is getting
        // looked at", the top of the ordering funnel and the denominator for menu→cart.
        storeViewed: p => ga4Event('store_viewed', clean({
            business_id: p.businessId ? String(p.businessId) : undefined,
            store_name: p.name, locality: p.locality, city: p.city,
        })),

        // ── Browse ──────────────────────────────────────────────────────────
        // view_cart / view_search_results are GA4's own ecommerce+search event names, so
        // view_cart goes through ga4Ecom (it carries items[]); the rest are plain events.
        cartViewed:    p => ga4Ecom('view_cart', { currency: 'INR', value: p.value, items: gtagItems(asItems(p)) }),
        search:        p => ga4Event('view_search_results', clean({ search_term: p.term, results: p.results })),
        categoryViewed: p => ga4Event('category_viewed', clean({ item_category: p.category, category_id: p.categoryId })),
        filterApplied: p => ga4Event('menu_filter_applied', clean({ filters: p.filters, sort: p.sort })),
        bannerClicked: p => ga4Event('banner_clicked', clean({ banner_id: p.bannerId, banner_title: p.title, link_url: p.url })),
    },
    {
        name: 'meta',
        enabled: () => Array.isArray(cfg.metaPixels) && cfg.metaPixels.length > 0,
        init: () => loadMeta(cfg.metaPixels),
        // All product-bearing events carry content_ids/content_type (+ num_items where a
        // basket size is meaningful). Without them Meta receives a value with no product
        // context: no Dynamic Product Ads, no catalog matching, weaker lookalikes.
        productViewed:  p => window.fbq('track', 'ViewContent', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p), { name: true }),
        })),
        addToCart:      p => window.fbq('track', 'AddToCart', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p), { numItems: true }),
        })),
        // No Meta standard equivalent → trackCustom. Table 1 marks this Meta ✗; pairing it
        // with AddToCart is what makes an accurate "still in cart" audience possible.
        removeFromCart: p => window.fbq('trackCustom', 'RemoveFromCart', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p), { numItems: true }),
        })),
        beginCheckout:  p => window.fbq('track', 'InitiateCheckout', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p), { numItems: true }),
        })),
        addShippingInfo: p => window.fbq('track', 'AddShippingInfo', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p)),
        })),
        addPaymentInfo: p => window.fbq('track', 'AddPaymentInfo', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p)),
        })),
        purchase:       p => window.fbq('track', 'Purchase', clean({
            currency: 'INR', value: Number(p.value ?? 0), ...metaProducts(asItems(p), { numItems: true }),
        })),
        registration:   () => window.fbq('track', 'CompleteRegistration'),
        // Login-method funnel, non-standard events → trackCustom. `login` is included so the
        // funnel is computable on Meta too: clicks without completions can't produce a rate.
        loginMethodClicked: p => window.fbq('trackCustom', 'LoginMethodClicked', clean({ method: p.method })),
        loginMethodFailed:  p => window.fbq('trackCustom', 'LoginMethodFailed',  clean({ method: p.method, reason: p.reason })),
        login:              p => window.fbq('trackCustom', 'LoginSuccess',       clean({ method: p.method })),
        // Non-standard event → trackCustom. Warmest retargeting audience there is:
        // reached payment, didn't complete.
        paymentFailed:  p => window.fbq('trackCustom', 'PaymentFailed', clean({
            currency: 'INR', value: p.value, failure_reason: p.reason, payment_method: p.paymentMethod,
        })),

        // Table 1 marks these Meta ✗. LocationSelected is worth having (a serviceable
        // address is a strong intent signal); OTP/slot stay GA4-only per the doc.
        locationSelected: p => window.fbq('trackCustom', 'LocationSelected', clean({
            content_category: p.city || p.locality, delivery_type: p.deliveryType,
        })),

        // ── Discovery ───────────────────────────────────────────────────────
        // Outlet page opened → ViewContent, per the audit's P1 row (productViewed +
        // storeViewed). content_type is 'product_group', NOT 'product': an outlet id is a
        // collection, and tagging it 'product' would push store ids into the same catalog
        // space Meta matches individual items against, producing unmatched-content-id
        // warnings and diluting product-level DPA.
        // ⚠ This still only matches if the Meta catalog models outlets as product groups
        // keyed by businessId — the same catalog question that gates the other content_ids.
        storeViewed: p => window.fbq('track', 'ViewContent', clean({
            content_type: 'product_group',
            content_ids: p.businessId ? [String(p.businessId)] : undefined,
            content_name: p.name,
            content_category: p.city || p.locality,
        })),

        // ── Auth funnel, pre-OTP ────────────────────────────────────────────
        // "Entered a mobile number but never ordered" is the highest-intent retargeting
        // audience available before login completes.
        loginInitiated: p => window.fbq('trackCustom', 'LoginInitiated', clean({ source: p.source })),
        mobileEntered:  () => window.fbq('trackCustom', 'MobileNumberEntered'),
        captchaCompleted: () => window.fbq('trackCustom', 'CaptchaCompleted'),

        // ── Checkout ────────────────────────────────────────────────────────
        // Two events, not one with a status param — the audit specifies CouponApplied /
        // CouponFailed, and separate events make Meta audience building simpler (target
        // failures directly instead of filtering on a parameter).
        couponStatus: p => window.fbq('trackCustom',
            String(p.status).toLowerCase() === 'applied' ? 'CouponApplied' : 'CouponFailed',
            clean({ currency: 'INR', coupon_code: p.code, value: Number(p.discount ?? 0) })),
        deliveryTypeSelected:  p => window.fbq('trackCustom', 'DeliveryTypeSelected', clean({ delivery_type: p.deliveryType })),
        paymentMethodSelected: p => window.fbq('trackCustom', 'PaymentMethodSelected', clean({ payment_method: p.paymentMethod })),

        // ── Browse ──────────────────────────────────────────────────────────
        // Search is a Meta STANDARD event (search_string), so it feeds optimisation
        // directly; the rest have no standard equivalent → trackCustom.
        search:        p => window.fbq('track', 'Search', clean({ search_string: p.term })),
        cartViewed:    p => window.fbq('trackCustom', 'CartViewed', clean({
            currency: 'INR', value: p.value, ...metaProducts(asItems(p), { numItems: true }),
        })),
        categoryViewed: p => window.fbq('trackCustom', 'MenuCategoryViewed', clean({ content_category: p.category })),
        filterApplied: p => window.fbq('trackCustom', 'MenuFilterApplied', clean({ filters: p.filters, sort: p.sort })),
        bannerClicked: p => window.fbq('trackCustom', 'BannerClicked', clean({ banner_id: p.bannerId, banner_title: p.title })),
    },
    {
        name: 'webengage',
        enabled: () => !!cfg.webengage,
        init: () => loadWebEngage(cfg.webengage),
        productViewed: p => window.webengage.track('Product Viewed', {
            'Product Name': p.item?.name, 'Product ID': String(p.item?.id ?? ''),
            'Category Name': p.item?.category, 'Category ID': p.item?.categoryId,
            'Price': Number(p.item?.price ?? 0), 'Image URL': p.item?.image, 'Type': p.item?.veg,
        }),
        addToCart: p => window.webengage.track('Added To Cart', {
            'Product Name': p.item?.name, 'Product ID': String(p.item?.id ?? ''),
            'Category Name': p.item?.category, 'Price': Number(p.item?.price ?? 0),
            'Image URL': p.item?.image, 'Type': p.item?.veg, 'Quantity': p.item?.qty, 'Store ID': p.businessId,
        }),
        removeFromCart: p => window.webengage.track('Removed From Cart', {
            'Product Name': p.item?.name, 'Product ID': String(p.item?.id ?? ''),
            'Category Name': p.item?.category, 'Price': Number(p.item?.price ?? 0),
            'Image URL': p.item?.image, 'Type': p.item?.veg,
        }),
        beginCheckout:   p => window.webengage.track('Checkout Started', { ...weJoined(p.items), 'Cart Total': Number(p.value ?? 0), 'Delivery Type': p.deliveryType }),
        addShippingInfo: p => window.webengage.track('Address Added', {
            'Locality': p.address?.city, 'Address Type': p.address?.name, 'House': p.address?.line1,
            'Landmark': p.address?.line2, 'Phone': p.address?.mobile, 'Selection Type': p.selectionType,
        }),
        // MIGRATION WINDOW — 'Fulfillmet Type' is a typo, but live WebEngage segments and
        // campaigns are keyed on it, and renaming creates a NEW property that silently stops
        // matching them. Both keys are emitted until those are migrated; then drop the
        // misspelled one. (beginCheckout above calls the same value 'Delivery Type' — a third
        // name for one field. Consolidating all three is the WebEngage owner's call.)
        addPaymentInfo: p => window.webengage.track('Payment Started', {
            ...weJoined(p.items), 'Cart Total': Number(p.value ?? 0),
            'Fulfillmet Type': p.deliveryType,
            'Fulfilment Type': p.deliveryType,
        }),
        purchase: p => window.webengage.track('Order Placed', {
            ...weJoined(p.items), 'Payment Method': p.paymentMethod, 'Total': Number(p.value ?? 0),
            'Coupon Discount': Number(p.discount ?? 0),
        }),
        couponStatus:  p => window.webengage.track('Coupon Status', { 'Status': p.status, 'Coupon Code': p.code, 'Discount Amount': Number(p.discount ?? 0) }),
        registration:  p => window.webengage.track('Customer Registered', { 'Phone Number': p.mobile }),
        profileUpdated: p => window.webengage.track('Form Filled', {
            'Phone Number': p.mobile, 'Email': p.email, 'First Name': p.name,
            'Birth Date': p.dob, 'Anniversary Date': p.anniversary,
        }),
        identify: p => {
            if (!p.mobile) return;
            const phone = '+91' + String(p.mobile).replace(/^\+?91/, '');
            window.webengage.user.login(phone);
            window.webengage.user.setAttribute('we_phone', phone);
            if (p.email)       window.webengage.user.setAttribute('we_email', p.email);
            if (p.name)        window.webengage.user.setAttribute('we_first_name', p.name);
            if (p.dob)         window.webengage.user.setAttribute('we_birth_date', p.dob);
            if (p.gender)      window.webengage.user.setAttribute('we_gender', p.gender);
            if (p.anniversary) window.webengage.user.setAttribute('we_anniversary_date', p.anniversary);
        },
    },
];

// ── Init enabled providers once, on module load ──────────────────────────────
const active = providers.filter(p => { try { return p.enabled(); } catch { return false; } });
// This module loads under two URLs — base.php loads it as `analytics.js?v=<filemtime>` and
// the funnel modules import it as `analytics.js?v=<pinned>`. Two URLs = two module instances
// = two top-level runs, which would double-fire each SDK init (e.g. fbq('init') → "Duplicate
// Pixel ID"). Guard the side-effecting init() to run once; `active` is still built
// per-instance so each instance's emit()/track* helpers keep dispatching through the shared
// window globals.
//
// ⚠ The nested import MUST stay versioned. It used to be a bare `./analytics.js`, which is a
// URL nginx caches for 30 days — so a fresh menu.js could pair with a month-old analytics.js
// whose bridge lacked the newer methods. That shipped as a production outage: the menu died on
// "window.Analytics?.trackStoreViewed is not a function". Two rules came out of it:
//   1. WHEN YOU ADD AN EXPORT HERE, BUMP THE ?v= IN EVERY IMPORTER (grep "analytics.js?v=").
//   2. Call the bridge as `window.Analytics?.method?.(…)` — the optional CALL. Plain `?.` only
//      guards a missing window.Analytics, not a missing method, and throws either way.
if (!window.__ueAnalyticsInit) {
    window.__ueAnalyticsInit = true;
    active.forEach(p => { try { p.init && p.init(); } catch (e) { /* never break the page */ } });
}

// ── Fan-out ──────────────────────────────────────────────────────────────────
function emit(event, payload) {
    for (const p of active) {
        if (typeof p[event] === 'function') {
            try { p[event](payload || {}); } catch (e) { /* swallow — analytics must not break the funnel */ }
        }
    }
}

// ── Public semantic API ──────────────────────────────────────────────────────
export const trackProductViewed   = p => emit('productViewed', p);
export const trackAddToCart        = p => emit('addToCart', p);
export const trackRemoveFromCart   = p => emit('removeFromCart', p);
export const trackBeginCheckout    = p => emit('beginCheckout', p);
export const trackAddShippingInfo  = p => emit('addShippingInfo', p);
export const trackAddPaymentInfo   = p => emit('addPaymentInfo', p);
export const trackPurchase         = p => emit('purchase', p);
export const trackPaymentFailed    = p => emit('paymentFailed', p);
export const trackLogin            = p => emit('login', p);
export const trackLoginMethodClicked = p => emit('loginMethodClicked', p);
export const trackLoginMethodFailed  = p => emit('loginMethodFailed', p);
export const trackOtpSent          = p => emit('otpSent', p);
export const trackOtpValidated     = p => emit('otpValidated', p);
export const trackRegistration     = p => emit('registration', p);
export const trackCouponStatus     = p => emit('couponStatus', p);
export const trackProfileUpdated   = p => emit('profileUpdated', p);
export const identifyUser          = p => emit('identify', p);
// Discovery
export const trackStoreViewed      = p => emit('storeViewed', p);
export const trackLocationSelected = p => emit('locationSelected', p);
export const trackOtpInitiated     = p => emit('otpInitiated', p);
export const trackSlotSelected     = p => emit('slotSelected', p);
export const trackPaymentStarted   = p => emit('paymentStarted', p);
export const trackAddressAdded     = p => emit('addressAdded', p);
// Auth funnel (pre-OTP)
export const trackLoginInitiated   = p => emit('loginInitiated', p);
export const trackMobileEntered    = p => emit('mobileEntered', p);
export const trackCaptchaCompleted = p => emit('captchaCompleted', p);
// Checkout
export const trackDeliveryTypeSelected  = p => emit('deliveryTypeSelected', p);
export const trackPaymentMethodSelected = p => emit('paymentMethodSelected', p);
// Browse
export const trackCartViewed       = p => emit('cartViewed', p);
export const trackSearch           = p => emit('search', p);
export const trackCategoryViewed   = p => emit('categoryViewed', p);
export const trackFilterApplied    = p => emit('filterApplied', p);
export const trackBannerClicked    = p => emit('bannerClicked', p);
// Location picker funnel
export const trackLocationPickerOpened    = p => emit('locationPickerOpened', p);
export const trackLocationSearchAttempted = p => emit('locationSearchAttempted', p);
export const trackLocationNoResults       = p => emit('locationNoResults', p);
export const trackLocationNotServiceable  = p => emit('locationNotServiceable', p);

// Bridge for non-module callers (base.php inline auth scripts can't `import`).
//
// Also the safe way for an EXISTING module to reach a NEW event: modules import
// './analytics.js' with no version query while they are themselves cache-busted, and
// nginx caches /src/js for 30 days — so importing a brand-new export can pair a fresh
// caller with a stale analytics.js and throw SyntaxError, taking the whole caller down.
// Reading it off this bridge degrades to a no-op instead. (See trackPaymentFailed
// call-sites in checkout.js / payment_screen.js / order_polling.js.)
window.Analytics = {
    trackProductViewed, trackAddToCart, trackRemoveFromCart, trackBeginCheckout,
    trackAddShippingInfo, trackAddPaymentInfo, trackPurchase, trackPaymentFailed,
    trackLogin, trackLoginMethodClicked, trackLoginMethodFailed, trackOtpSent,
    trackOtpValidated, trackRegistration, trackCouponStatus, trackProfileUpdated,
    identifyUser,
    trackStoreViewed, trackLocationSelected, trackOtpInitiated, trackSlotSelected,
    trackPaymentStarted, trackAddressAdded,
    trackLoginInitiated, trackMobileEntered, trackCaptchaCompleted,
    trackDeliveryTypeSelected, trackPaymentMethodSelected,
    trackCartViewed, trackSearch, trackCategoryViewed, trackFilterApplied, trackBannerClicked,
    trackLocationPickerOpened, trackLocationSearchAttempted,
    trackLocationNoResults, trackLocationNotServiceable,
};

// Unblock any callers (e.g. base.php showLogin()) that ran before this module loaded
// and queued their events on this event rather than drop them silently.
window.dispatchEvent(new CustomEvent('analytics:ready'));

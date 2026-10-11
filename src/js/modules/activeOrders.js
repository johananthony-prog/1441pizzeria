/**
 * activeOrders.js — the "Active Orders" section inside the profile sidebar.
 *
 *   GET {apiBase}/client/getActiveOrders?contactMappingId&token&mobileNo&parentBusinessId
 *       → { status, active_orders: [ …order ] }
 *   GET {apiBase}/client/getOrderRiderTracking?…   (only while out for delivery)
 *       → { status, est_time, deatils: [ … ] }     ← backend's spelling, not a typo here
 *
 * Markup shell: app/Views/themes/ue_default/partials/active_orders.php,
 *               included from partials/profile_sidebar.php.
 * Card markup:  ./activeOrderCard.js
 * Styles:       public/assets/css/home_active_orders.css
 * Loaded by:    an unconditional <script type="module"> in base.php, next to
 *               floating_cart.js — not per-page $jsModule, and with no route
 *               exclusions (unlike floating_cart.js, which does hide the cart
 *               FAB on cart/checkout — this section stays up everywhere).
 *
 * One design on every breakpoint — the sidebar itself is already responsive.
 * No fixed position, no slider: orders stack vertically, capped at 2 visible
 * with a "See N more" toggle to reveal the rest.
 *
 * Deliberately generic: wired on every page the profile sidebar renders on
 * (i.e. all of them, base.php includes it unconditionally) — including
 * cart/checkout/past-order/package/subscriptions. Those pages have their own
 * order/payment UI too, but a customer can still have OTHER active orders in
 * flight while browsing any of them, so the section stays live everywhere.
 *
 * Nothing here imports from a pre-existing shared module by design. Adding an
 * export to one and consuming it in the same deploy breaks the page — nested
 * imports carry no ?v= cache-buster and nginx holds /src/js for 30 days.
 * activeOrderCard.js ships in this same commit, so it was never cached.
 */

import { cardHtml, istMs, num, isSet, isTerminal, isCancelled, fallbackEtaMin } from './activeOrderCard.js';
import { clearEntryChannel } from './auth-storage.js';

const API_BASE = (window.AppConfig?.apiBase || '').replace(/\/$/, '');
const ACTIVE_PATH = '/client/getActiveOrders';
const RIDER_PATH  = '/client/getOrderRiderTracking';

const POLL_MS = 30_000;
const VISIBLE_CAP = 2;

function getUser() {
    for (const key of ['userdata', 'authState']) {
        try {
            const raw = localStorage.getItem(key);
            if (raw && raw !== 'null') {
                const obj = JSON.parse(raw);
                if (obj && (obj.contactMappingId || obj.contact_mapping_id)) return obj;
            }
        } catch { /* corrupt entry — try the next key */ }
    }
    return null;
}

// ── API ───────────────────────────────────────────────────────────────

function authHeaders(token) {
    // One token header only. fetch() merges case-variant duplicates (token + Token)
    // into a comma-joined value the API rejects as invalid.
    return { token: token || '', Authorization: 'Bearer ' + (token || '') };
}

function clearSession() {
    clearEntryChannel();
    localStorage.removeItem('userdata');
    localStorage.removeItem('token');
}

async function fetchActiveOrders(user) {
    const params = new URLSearchParams({
        contactMappingId: String(user.contactMappingId ?? user.contact_mapping_id ?? ''),
        token:            String(user.token ?? ''),
        // This endpoint wants `mobileNo`; userdata stores it as `mobile`
        // (base.php patches it in after verify-otp, which doesn't echo it back).
        mobileNo:         String(user.mobile ?? user.mobileNo ?? ''),
        // Parent id, never the outlet id — window.AppConfig.businessId IS the parent.
        parentBusinessId: String(window.AppConfig?.businessId ?? ''),
    });

    const res = await fetch(`${API_BASE}${ACTIVE_PATH}?${params}`, {
        headers: authHeaders(user.token),
    });
    if (!res.ok) throw new Error(`getActiveOrders HTTP ${res.status}`);
    const json = await res.json();

    if (Number(json?.force_logout) === 1) {
        // Dead token. Drop the session silently — a background poll has no business
        // throwing a login modal at someone browsing the site.
        clearSession();
        return null;
    }
    return Array.isArray(json?.active_orders) ? json.active_orders : [];
}

/**
 * Live ETA + rider name for one out-for-delivery order, or null.
 * The token must ride in the query string here — header-only gets
 * "The token field is required" from this endpoint.
 *
 * `o.riderId`/`o.riderName` on the order object itself (from getActiveOrders)
 * are only reliable as an existence check ("is a rider assigned at all"),
 * not as a display value — many dispatched orders carry them empty. The
 * actual name lives in this endpoint's own `deatils[0]` (backend's spelling,
 * not a typo here) — but only comes back once `parentBusinessId` + `path`
 * ride along too; pastOrders.js's live rider panel (fetchRiderTracking)
 * sends both and gates on `status === 1` before trusting `deatils`. Without
 * them this endpoint still returns `est_time` (why the ETA badge always
 * worked) but `deatils` comes back empty.
 */
async function fetchRiderInfo(o, user) {
    const params = new URLSearchParams({
        orderId:          String(o.orderId ?? o.id ?? ''),
        businessId:       String(o.businessId ?? ''),
        parentBusinessId: String(window.AppConfig?.businessId ?? ''),
        contactMappingId: String(user.contactMappingId ?? user.contact_mapping_id ?? ''),
        token:            String(user.token ?? ''),
        version:          '2.0',
        path:             '1',
    });
    try {
        const res = await fetch(`${API_BASE}${RIDER_PATH}?${params}`, {
            headers: authHeaders(user.token),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const mins = parseInt(json?.est_time, 10);
        const d = Number(json?.status) === 1 && Array.isArray(json?.deatils) ? json.deatils[0] : null;
        const name = d ? ((d.firstName || '') + (d.lastname ? ' ' + d.lastname : '')).trim() : '';
        return { mins: Number.isFinite(mins) ? mins : null, name: name || null };
    } catch {
        return null; // fall back to the quoted buffer, no rider chip
    }
}

// ── DOM ───────────────────────────────────────────────────────────────

const el = { root: null, list: null, toggle: null, toggleLabel: null };

let polling = false;
let inFlight = false;
let timer = null;
let expanded = false;

// Every header carries its own copy of the badge (desktop nav, mobile top bar,
// mobile drawer bar) — a shared class, not an id, since ids can't repeat.
function updateProfileBadge(count) {
    document.querySelectorAll('.js-profile-order-badge').forEach((el) => {
        el.hidden = count <= 0;
        if (count > 0) el.textContent = String(count);
    });
}

function hideWidget() {
    if (el.root) el.root.hidden = true;
    expanded = false;
    el.root?.classList.remove('is-expanded');
    updateProfileBadge(0);
    publishSnapshot([]);
}

// Published for the v2 header's Track button, which routes by how many orders
// are actually in progress: one goes straight to its tracker, several open the
// sidebar that lists them all with live ETAs. Built from the SAME stillLive set
// the badge counts, so the number on the button and the behaviour behind it can
// never disagree. A plain window global, like every other cross-module hook
// here (hdr2RefreshHeader, changeUserLocation) — deliberately not an export,
// since nested imports are unversioned and /src/js is cached 30 days.
function publishSnapshot(live) {
    window.hdr2ActiveOrders = {
        count: live.length,
        ids: live.map((o) => String(o.orderId ?? o.id ?? '')).filter(Boolean),
    };
}

function toggleLabelText(extraCount) {
    return expanded ? 'Show less' : `See ${extraCount} more order${extraCount === 1 ? '' : 's'}`;
}

function setExpanded(next, extraCount) {
    expanded = next;
    el.root.classList.toggle('is-expanded', expanded);
    if (el.toggleLabel) el.toggleLabel.textContent = toggleLabelText(extraCount);
}

// ── Render ────────────────────────────────────────────────────────────

async function render(orders, user) {
    if (!orders.length) { hideWidget(); return false; }

    // Newest first, so the order the user just placed leads.
    const sorted = [...orders].sort((a, b) => (istMs(b.invoicedAt) || 0) - (istMs(a.invoicedAt) || 0));

    // Only orders genuinely on the road get a rider lookup — usually zero or one.
    const riderInfo = await Promise.all(sorted.map((o) => {
        const onRoad = user && num(o.orderType) === 1 && !isTerminal(o)
            && (isSet(o.dispatchedTime) || num(o.deliveryStatus) === 2);
        return onRoad ? fetchRiderInfo(o, user) : Promise.resolve(null);
    }));

    // Rider est_time where we have it; otherwise the order's own quoted buffer.
    // The third arg tells the card which of the two it got — the difference
    // between "Arrived early" and a plain "Arrived". The fourth marks cards
    // beyond the default 2-visible cap so CSS keeps them collapsed. The fifth
    // is the live rider name (see fetchRiderInfo) — o.riderName alone isn't
    // reliably populated.
    el.list.innerHTML = sorted
        .map((o, i) => cardHtml(
            o,
            riderInfo[i]?.mins ?? fallbackEtaMin(o),
            riderInfo[i]?.mins != null,
            i >= VISIBLE_CAP,
            riderInfo[i]?.name,
        ))
        .join('');

    const extraCount = Math.max(0, sorted.length - VISIBLE_CAP);
    if (el.toggle) {
        el.toggle.hidden = extraCount === 0;
        if (el.toggleLabel) el.toggleLabel.textContent = toggleLabelText(extraCount);
    }
    // Collapse back whenever the set no longer needs expanding (e.g. an order
    // completed and dropped off the list on the next poll).
    if (extraCount === 0 && expanded) setExpanded(false, 0);

    el.root.hidden = false;

    // Badge = orders still moving, not the full list — a delivered card stays
    // visible in the sidebar (for rating) but shouldn't count as "in progress".
    const stillLive = sorted.filter((o) => !isTerminal(o));
    updateProfileBadge(stillLive.length);
    publishSnapshot(stillLive);

    return stillLive.length > 0;
}

/**
 * Deferred purchase event recovery — fires `purchase` for orders whose confirmation
 * page was killed before analytics.js could fire (most common cause: UPI deep-link
 * redirect closes the tab before the event sends).
 *
 * Strategy:
 *   orderConfirmation.js writes localStorage['purchase_tracked_{id}'] = '1' when it
 *   fires successfully. This function checks every active order against that flag.
 *   Any order in the active list is a confirmed placed order, so firing purchase here
 *   is safe. Rejected orders (deliveryStatus 4/5) are skipped.
 *
 * Uses window.Analytics bridge (not a direct import) — activeOrders.js runs on every
 * page via base.php and must not carry a bare analytics.js import with no ?v= buster
 * (nginx caches /src/js for 30 days; a version mismatch would silently use stale code).
 *
 * Fires at most once per order: the localStorage flag is written immediately after so
 * subsequent polls and page loads skip it.
 */
// Minimum age before recovery fires — gives the confirmation page time to fire first.
// Without this, the 30s poller can win the race against a slow-loading confirmation
// page, write the flag with value=0/no-items, and permanently block the richer event.
const RECOVERY_MIN_AGE_MS  = 90_000;  // 90 s — comfortably after any confirmation load
const RECOVERY_MAX_AGE_MS  = 4 * 60 * 60 * 1000; // 4 h — active orders clear faster, but be safe

function recoverMissedPurchases(orders) {
    const track = window.Analytics?.trackPurchase;
    if (typeof track !== 'function') return;

    const now = Date.now();

    for (const o of orders) {
        const id = String(o.orderId ?? o.id ?? '');
        if (!id) continue;

        // isCancelled covers both deliveryStatus 4|5 AND cancelledTime being set
        // (restaurant-cancelled orders where status propagation may lag).
        // isTerminal is intentionally NOT used here: it also matches isDelivered (ds=3)
        // and delivered orders are exactly what we want to recover purchase events for.
        if (isCancelled(o)) continue;

        const key = 'purchase_tracked_' + id;
        try {
            if (localStorage.getItem(key) === '1') continue;
            if (sessionStorage.getItem(key) === '1') continue;
        } catch { continue; }

        // Age gate: fail closed — if the timestamp is absent we cannot bound the order
        // age, so skip rather than risk misfiling an ancient order on today's date.
        const ts = o.invoicedAt ?? o.createdAt ?? '';
        if (!ts) continue;
        const placed = istMs(ts); // istMs is already imported from activeOrderCard.js
        if (isNaN(placed)) continue;
        const age = now - placed;
        if (age < RECOVERY_MIN_AGE_MS) continue;  // too fresh — let confirmation page win
        if (age > RECOVERY_MAX_AGE_MS) continue;  // too old — don't corrupt today's date

        // Fire with whatever financial data the API returned; items are omitted because
        // getActiveOrders does not carry the line-item array. The transaction_id alone
        // is sufficient for GA4 dedup and conversion counting.
        // totalAmt is the canonical field; fall back through alternatives defensively.
        try {
            track({
                orderId:       id,
                value:         Number(o.totalAmt ?? o.total ?? o.amount ?? o.grandTotal ?? o.invoice_amount ?? 0),
                paymentMethod: String(o.paymentMode ?? o.payment_mode ?? ''),
                items:         [],
            });
            localStorage.setItem(key, '1');
        } catch { /* analytics must never break the page */ }
    }
}

async function refresh() {
    if (inFlight) return;

    const user = getUser();
    if (!user?.token) { hideWidget(); stop(); return; }

    inFlight = true;
    try {
        const orders = await fetchActiveOrders(user);
        if (orders === null) { hideWidget(); stop(); return; } // force_logout

        // Run recovery before render so the flag is set even if the widget is hidden.
        recoverMissedPurchases(orders);

        const stillLive = await render(orders, user);
        if (!stillLive) stop();
    } catch {
        hideWidget(); // never let a failed poll break the page
    } finally {
        inFlight = false;
    }
}

function tick() { if (!document.hidden) refresh(); }

function start() {
    if (polling) return;
    polling = true;
    timer = setInterval(tick, POLL_MS);
}

function stop() {
    polling = false;
    if (timer) { clearInterval(timer); timer = null; }
}

// ── Wiring ────────────────────────────────────────────────────────────

function wire() {
    el.toggle?.addEventListener('click', () => {
        const extraCount = Math.max(0, el.list.children.length - VISIBLE_CAP);
        setExpanded(!expanded, extraCount);
    });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    // Login / logout in another tab.
    window.addEventListener('storage', (e) => {
        if (!e.key || e.key === 'userdata') { start(); refresh(); }
    });
}

function init() {
    // Generic — wired on every page (see header comment). No route gate: the
    // profile sidebar renders unconditionally, so this just needs the DOM to
    // be there.
    el.root = document.querySelector('[data-ao-root]');
    if (!el.root) return;
    el.list        = el.root.querySelector('[data-ao-list]');
    el.toggle      = el.root.querySelector('[data-ao-toggle]');
    el.toggleLabel = el.root.querySelector('[data-ao-toggle-label]');

    wire();
    refresh();
    start();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

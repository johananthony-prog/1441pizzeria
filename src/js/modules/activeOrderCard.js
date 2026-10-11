/**
 * activeOrderCard.js — state derivation + markup for one Active Orders row.
 *
 * Split out of activeOrders.js, which owns fetching, polling and the
 * slider. Everything here is pure: (order, eta) → html string.
 *
 * One row design on every breakpoint: [icon | label + ETA | rating (delivered
 * orders only) | CTA text link]. No step tracker — the label already says
 * where the order is. CSS: home_active_orders.css.
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// invoicedAt & friends are IST wall-clock with no zone ("2026-07-13 11:11:03").
// Bare `new Date(s)` reads them as the viewer's local time (5h30m out for anyone
// abroad) and Safari rejects the space separator outright — hence both fixes.
export const istMs = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + '+05:30') : NaN);

export const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export const isSet = (v) => v !== null && v !== undefined && v !== '' && v !== '0'
    && String(v).toLowerCase() !== 'null';

// Cosmetic only. The backend has no "preparing" flag — acceptedTime is the sole
// signal — so the mockup's separate Accepted / Preparing cards are a time split.
const ACCEPTED_WINDOW_MS = 2 * 60 * 1000;
const ALMOST_THERE_MIN = 5;

/** Tracker rails, per order type. Delivery is the only 5-step journey. */
const STEPS = {
    1: ['Received', 'Accepted', 'Prepared', 'Dispatched', 'Delivered'],
    2: ['Received', 'Accepted', 'Prepared', 'Pickup'],
    3: ['Received', 'Accepted', 'Prepared', 'Served'],
    4: ['Received', 'Accepted', 'Prepared', 'Curbside'],
};

/**
 * The order field each rail position's time comes from — same shape as STEPS.
 * Only delivery has a real "dispatched" moment distinct from completion;
 * pickup/dine-in/in-car's last step IS the completion timestamp.
 */
const STEP_TIME_FIELDS = {
    1: ['invoicedAt', 'acceptedTime', 'preparedTime', 'dispatchedTime', 'deliveredTime'],
    2: ['invoicedAt', 'acceptedTime', 'preparedTime', 'deliveredTime'],
    3: ['invoicedAt', 'acceptedTime', 'preparedTime', 'deliveredTime'],
    4: ['invoicedAt', 'acceptedTime', 'preparedTime', 'deliveredTime'],
};

const ICONS = {
    inbox:    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h5l1.5 2h5L16 13h5"/><path d="M12 5v5m0 0 2-2m-2 2-2-2"/>',
    check:    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>',
    chef:     '<path d="M6 14a4 4 0 1 1 1.2-7.8 4 4 0 0 1 7.6 0A4 4 0 1 1 18 14v5H6v-5Z"/><path d="M6 17h12"/>',
    scooter:  '<path d="M5 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M9 18h6M3 6h9v9M12 9h4l3 3v6"/>',
    pin:      '<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    bag:      '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    cloche:   '<path d="M3 17h18"/><path d="M4.5 17a7.5 7.5 0 0 1 15 0"/><path d="M12 9.5V8"/>',
    party:    '<path d="m4 20 5-13 8 8-13 5Z"/><path d="M15 4.5 16 6M19 8l1.5-.5M17.5 11l1.8.8M19.5 4.5 18 6"/>',
    cancel:   '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 9 6 6m0-6-6 6"/>',
    wallet:   '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
};

// Membership plans / benefit redemptions: no prep, no delivery, nothing to track.
// Same guard pastOrders.js uses so both surfaces agree on what "an order" is.
export const isMembership = (o) => num(o.orderType) === 5 || num(o.cart_type) === 2;

export const isDelivered = (o) => isSet(o.deliveredTime) || num(o.deliveryStatus) === 3;
export const isCancelled = (o) => isSet(o.cancelledTime) || [4, 5].includes(num(o.deliveryStatus));
export const isTerminal  = (o) => isDelivered(o) || isCancelled(o);

/**
 * Minutes left on the promise, from the order's own quoted buffer.
 * Superseded by the rider's live est_time whenever we have one.
 */
export function fallbackEtaMin(o) {
    const placed = istMs(o.invoicedAt || o.updatedAt);
    if (!Number.isFinite(placed)) return null;
    const buffer = num(o.totalDeliveryBufferTime) || num(o.onlineDeliveryTime);
    if (!buffer) return null;
    return Math.round((placed + buffer * 60_000 - Date.now()) / 60_000);
}

/**
 * Label, icon, tracker position and card kind for one order. First match wins.
 *
 * `eta` is minutes remaining — rider-supplied where we have it, otherwise
 * derived from the order's own quoted buffer — and applies to every order
 * type, not delivery alone: the reference design shows the countdown on the
 * very first "Order has been received" row too, before any travel leg
 * exists, so it's read as "time to completion", not "time on the road".
 * `etaLive` says whether the number came from the rider, which is the
 * difference between "Arrived early" and a bare "Arrived".
 */
export function deriveState(o, eta, etaLive) {
    const state = computeState(o, eta, etaLive);
    // Only the rider-arrived branch sets its own badge, and only membership/
    // rate/cancelled cards intentionally carry no time. Every other in-progress
    // row falls back to the countdown here instead of repeating `eta` in each
    // branch above.
    if (state.kind === 'progress' && state.eta === undefined && !state.badge) {
        state.eta = eta;
    }
    return state;
}

function computeState(o, eta, etaLive) {
    const ot = num(o.orderType);
    const ds = num(o.deliveryStatus);
    const delivery = ot === 1;
    const last = (STEPS[ot] || STEPS[1]).length - 1;

    if (isMembership(o)) {
        return { kind: 'plain', label: 'Purchased', icon: 'wallet', step: -1 };
    }

    if (isCancelled(o)) {
        return { kind: 'cancelled', label: 'Order Has Been Cancelled', icon: 'cancel', step: 1 };
    }

    if (isDelivered(o)) {
        const label = delivery ? 'Yay! Your order is delivered.'
            : ot === 2 ? 'Yay! Picked up successfully'
            : ot === 3 ? 'Yay! Your order is Served.'
            : ot === 4 ? 'Yay! Delivered to your car'
            : 'Yay! Your order is complete.';
        return { kind: 'rate', label, icon: 'party', step: last };
    }

    // ── On the road (delivery only) ──
    if (delivery && (isSet(o.dispatchedTime) || ds === 2)) {
        if (eta !== null && eta <= 0) {
            return {
                kind: 'progress', label: 'Your rider has arrived', icon: 'pin', step: 3,
                // "Early" is only true when the RIDER says they're here and the
                // promised window hasn't run out. With no rider feed, eta<=0 just
                // means the estimate lapsed — the opposite of early.
                badge: etaLive ? 'Arrived early' : 'Arrived',
            };
        }
        // `showName` marks the two branches that get the customer-name chip in
        // the meta line (see cardHtml) — not "Rider assigned" (pre-dispatch,
        // below) or the arrived branch above, which keep their own wording.
        if (eta !== null && eta <= ALMOST_THERE_MIN) {
            return { kind: 'progress', label: 'Your order is almost there', icon: 'scooter', step: 3, eta, showName: true };
        }
        return { kind: 'progress', label: 'Out for delivery', icon: 'scooter', step: 3, eta, showName: true };
    }

    // ── Ready / handover (non-delivery). ds 2 means "prepared" for these types. ──
    if (!delivery && ds === 2) {
        if (ot === 2) return { kind: 'progress', label: 'Ready at the counter',   icon: 'bag',    step: 3 };
        if (ot === 4) return { kind: 'progress', label: 'Bringing it to your car', icon: 'bag',    step: 3 };
        // Dine-in "Served" is the terminal step, so serving-now stays on Prepared.
        if (ot === 3) return { kind: 'progress', label: 'Serving your order now',  icon: 'cloche', step: 2 };
        return { kind: 'progress', label: 'Your order is ready', icon: 'bag', step: 3 };
    }

    if (isSet(o.preparedTime)) {
        if (delivery) {
            return (isSet(o.riderId) || isSet(o.riderName))
                ? { kind: 'progress', label: 'Rider assigned to your order', icon: 'scooter', step: 2, eta }
                : { kind: 'progress', label: 'Prepared and ready for dispatch', icon: 'chef', step: 2, eta };
        }
        const label = ot === 2 ? 'Prepared and ready to collect'
            : ot === 3 ? 'Prepared and ready to serve'
            : ot === 4 ? 'Prepared for curbside handoff'
            : 'Your order is ready';
        return { kind: 'progress', label, icon: 'chef', step: 2 };
    }

    if (isSet(o.acceptedTime) || ds === 1) {
        const acceptedAt = istMs(o.acceptedTime);
        const justAccepted = Number.isFinite(acceptedAt)
            && Date.now() - acceptedAt <= ACCEPTED_WINDOW_MS;
        return justAccepted
            ? { kind: 'progress', label: 'Order accepted successfully', icon: 'check', step: 1 }
            : { kind: 'progress', label: 'Preparing your fresh order',  icon: 'chef',  step: 1 };
    }

    if (ds === 0 || !ds) {
        return { kind: 'progress', label: 'Order has been received', icon: 'inbox', step: 0 };
    }

    // Unknown state — defer to the server's own wording rather than guess.
    const msg = String(o.status_message || '').trim();
    return { kind: 'progress', label: msg || 'Order in progress', icon: 'inbox', step: 0 };
}

// ── Fragments ─────────────────────────────────────────────────────────

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" '
    + 'stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

function iconHtml(name) {
    return '<span class="ao-card__icon" aria-hidden="true">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
        + 'stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.inbox) + '</svg>'
        + '</span>';
}

/**
 * "11:11 AM" in the viewer's own timezone. `istMs` already converts the
 * backend's zoneless IST wall-clock string to a correct UTC instant, so a
 * plain `toLocaleTimeString()` here does the right thing for a visitor
 * anywhere in the world — no separate zone handling needed.
 */
function fmtTime(raw) {
    const ms = istMs(raw);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function etaHtml(state) {
    if (state.badge) return '<span class="ao-eta ao-eta--text">' + esc(state.badge) + '</span>';
    // A lapsed or negative countdown (the quoted buffer has already passed —
    // routine on a genuinely slow order, guaranteed on the months-old rows
    // this endpoint still calls "active") has nothing honest to say. Showing
    // no badge beats a wrong or confusing one.
    if (state.eta === undefined || state.eta === null || state.eta <= 0) return '';
    return '<span class="ao-eta"><strong>' + state.eta + '</strong><small>min</small></span>';
}

function stepsHtml(o, state) {
    const ot = num(o.orderType);
    const rail = STEPS[ot] || STEPS[1];
    const timeFields = STEP_TIME_FIELDS[ot] || STEP_TIME_FIELDS[1];
    const timeAt = (i) => fmtTime(o[timeFields[i]]);

    if (state.kind === 'cancelled') {
        // Received lands, then the journey stops red at position 1. The remaining
        // rail still shows so the card keeps the same width as its siblings.
        return '<ol class="ao-steps ao-steps--cancelled">'
            + rail.map((label, i) => {
                if (i === 0) return step('is-done', label, true, timeAt(0));
                if (i === 1) return step('is-cancelled', 'Cancelled', false, fmtTime(o.cancelledTime));
                return step('', label, false, '');
            }).join('')
            + '</ol>';
    }

    // A step's own timestamp exists once its event has fired — that's true for
    // the active step too (e.g. "Prepared" only becomes active because
    // preparedTime is already set), not just the fully-done ones before it.
    return '<ol class="ao-steps">'
        + rail.map((label, i) => {
            const cls = i < state.step ? 'is-done' : i === state.step ? 'is-active' : '';
            const time = i <= state.step ? timeAt(i) : '';
            return step(cls, label, i < state.step, time);
        }).join('')
        + '</ol>';
}

function step(cls, label, done, time) {
    return '<li class="ao-step ' + cls + '">'
        + '<span class="ao-step__dot">' + (done ? CHECK : '') + '</span>'
        + '<span class="ao-step__label">' + esc(label) + '</span>'
        + '<span class="ao-step__time">' + (time ? esc(time) : '&nbsp;') + '</span>'
        + '</li>';
}

/**
 * Rating row for a delivered order.
 *
 * The stars are a link, not a form: /client/submitRating requires food AND app
 * ratings (plus delivery for OT 1), so a single tap here can't complete one.
 * It deep-links to /past-order/{id}?rate=1, which pastOrders.js already opens
 * the full rate modal for.
 */
function rateHtml(o) {
    const id = String(o.orderId ?? o.id ?? '');
    const filled = Math.max(0, Math.min(5, num(o.rating)));
    const stars = Array.from({ length: 5 }, (_, i) =>
        '<span class="ao-star' + (i < filled ? ' is-on' : '') + '">'
        + '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">'
        + '<path d="m12 3.5 2.6 5.6 6 .8-4.4 4.2 1.1 6.1-5.3-2.9-5.3 2.9 1.1-6.1L3.4 9.9l6-.8L12 3.5Z"/>'
        + '</svg></span>').join('');

    return '<div class="ao-rate">'
        + '<span class="ao-rate__q">How was your experience?</span>'
        + '<a class="ao-stars" href="/past-order/' + encodeURIComponent(id) + '?rate=1"'
        + ' aria-label="Rate this order">' + stars + '</a>'
        + '</div>';
}

// ── Card ──────────────────────────────────────────────────────────────

/**
 * `isExtra` marks a card beyond the sidebar's default 2-visible cap — the
 * card still renders (so "See more" is instant, no re-fetch) but CSS
 * (.ao-card--extra) keeps it out of layout until the section is expanded.
 *
 * `riderName` comes from the same rider-tracking call activeOrders.js
 * already makes for the ETA (fetchRiderInfo) — the order's own riderName
 * field isn't reliably populated, so this is the only trustworthy source.
 */
export function cardHtml(o, eta, etaLive, isExtra, riderName) {
    const state = deriveState(o, eta, etaLive);
    const id = String(o.orderId ?? o.id ?? '');
    const href = id ? '/past-order/' + encodeURIComponent(id) : '';

    const ctaLabel = state.kind === 'rate' ? 'View Details'
        : state.kind === 'cancelled' ? 'View Order'
        : 'Track';

    const mid = state.kind === 'rate' ? rateHtml(o)
        : state.step < 0 ? ''
        : stepsHtml(o, state);

    // Delivered cards: the .ao-card--plain hook (home_active_orders.css) hides
    // the icon and the message text, leaving the order id — already rendered
    // below — as the only heading. Content is unchanged here; CSS decides
    // what's visible.
    const isPlain = state.kind === 'rate';

    // The reference design has one leading visual, not two: the coloured
    // countdown/status chip where there is one (nearly every progress card,
    // since deriveState backfills `eta` onto all of them), falling back to
    // the plain icon only for kinds that carry no time at all (rate/cancelled/
    // membership).
    const lead = etaHtml(state) || iconHtml(state.icon);

    const meta = (state.showName && riderName)
        ? '<span class="ao-chip">' + esc(riderName) + '</span> is on the way'
            + (id ? ' &middot; Order #' + esc(id) : '')
        : (id ? 'Order #' + esc(id) : '');

    const cls = 'ao-card' + (isPlain ? ' ao-card--plain' : '') + (isExtra ? ' ao-card--extra' : '');

    return '<article class="' + cls + '" role="listitem" data-ao-card="' + esc(id) + '">'
        + lead
        + '<span class="ao-card__label">'
        + '<span class="ao-card__title">' + esc(state.label) + '</span>'
        + (meta ? '<span class="ao-card__id">' + meta + '</span>' : '')
        + '</span>'
        + (mid ? '<div class="ao-card__mid">' + mid + '</div>' : '<div class="ao-card__mid"></div>')
        + (href ? '<a class="ao-cta" href="' + href + '"><span>' + ctaLabel + '</span>' + CHEVRON + '</a>' : '')
        + '</article>';
}

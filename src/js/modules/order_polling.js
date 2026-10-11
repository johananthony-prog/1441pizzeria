// Polls api.uengage.in for the order's status until the gateway's S2S webhook
// flips it to 1 (paid) or -1 (failed/refunded). Routes the user accordingly.
//
// Cadence: 2.5s. A 2-minute countdown (CI3 StartTimer) shows "M:SS mins remaining";
// when it runs out — or the status comes back failed — we show the CI3 vw_failure
// screen ("We couldn't place your order!"). Polling pauses when the tab is hidden.
import { getApiBase } from './config.js';
import { clearOrderedCart } from './cart_reset.js';

const POLL_INTERVAL_MS  = 2500;
const FALLBACK_AFTER_MS = 30_000;
const TIMER_TOTAL_S     = 120;                 // CI3 totalSeconds = 120 (2 min)
const FAIL_AFTER_MS     = TIMER_TOTAL_S * 1000; // fail when the countdown hits 0:00

const STATUS_PAID   = 1;
const STATUS_FAILED = -1;

function userToken() {
    try { return JSON.parse(localStorage.getItem('userdata') || 'null')?.token ?? ''; }
    catch { return ''; }
}

function userMappingId() {
    try { return JSON.parse(localStorage.getItem('userdata') || 'null')?.contactMappingId ?? ''; }
    catch { return ''; }
}

function userMobile() {
    try { return JSON.parse(localStorage.getItem('userdata') || 'null')?.mobile ?? ''; }
    catch { return ''; }
}

function paymentContext() {
    try { return JSON.parse(sessionStorage.getItem('paymentContext') || '{}') || {}; }
    catch { return {}; }
}

// uMoney recharge polling. Primary signal is paymentContext.flow, but that lives in
// sessionStorage and can be dropped across the cross-origin Razorpay round-trip (in-app
// webviews / Safari ITP) — so the callback_url also carries ?source=umoney as a fallback.
function isUmoneyFlow() {
    if (String(paymentContext().flow || '') === 'umoney') return true;
    try { return new URLSearchParams(window.location.search).get('source') === 'umoney'; }
    catch { return false; }
}

// Consumes the "top up, then pay for this order" hand-off the payment screen writes
// when a short uMoney balance sends the user to /umoney. Returns the checkout URL to
// resume, or '' for a standalone recharge or a hand-off older than the TTL. Key and
// TTL kept in sync with payment_screen.js — deliberately duplicated rather than
// shared, since a new export on a nested import breaks returning visitors against
// the 30-day CDN cache (see cart_reset.js).
const UM_RETURN_KEY    = 'umoney_checkout_return';
const UM_RETURN_TTL_MS = 30 * 60 * 1000;

function takeUmoneyReturn() {
    try {
        const raw = localStorage.getItem(UM_RETURN_KEY);
        if (!raw) return '';
        localStorage.removeItem(UM_RETURN_KEY);
        const { url, ts } = JSON.parse(raw) || {};
        if (typeof url !== 'string' || !url.startsWith('/checkout/')) return '';
        return Date.now() - Number(ts || 0) <= UM_RETURN_TTL_MS ? url : '';
    } catch { return ''; }
}

async function fetchStatus(orderId) {
    const ctx = paymentContext();
    // Prepaid PACK orders aren't in the normal orders table — getOrderStatus returns
    // "Invalid OrderId". package_checkout stashes {type:'pack'} in paymentContext, so
    // poll the pack status API instead. current_status "1" = paid.
    if (ctx.type === 'pack') return fetchPackStatus(orderId, ctx);

    // uMoney recharge — the orderId is a umoney_history id, not an addo order, so
    // getOrderStatus can't find it. Detected via paymentContext.flow or ?source=umoney.
    if (isUmoneyFlow()) return fetchUmoneyStatus(orderId, ctx);

    // getOrderStatus matches the order's OUTLET businessId (required), not the parent.
    // checkout.js stashes the outlet id in sessionStorage.paymentContext.businessId
    // (state.order.businessId) before redirecting here. AppConfig.businessId is the
    // PARENT id ($wc['pId']) → it goes in parentBusinessId, never in businessId.
    const businessId       = ctx.businessId ?? '';
    const parentBusinessId = ctx.parentId ?? window.AppConfig?.businessId ?? '';
    const params = new URLSearchParams({
        orderId:          String(orderId),
        token:            userToken(),
        contactMappingId: String(userMappingId()),
        mobileNo:         String(userMobile()),
        businessId:       String(businessId),
        parentBusinessId: String(parentBusinessId),
    });
    const res = await fetch(`${getApiBase()}/client/getOrderStatus?${params}`, { method: 'GET' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
}

// Prepaid-pack payment status (PackageConfiguration/checkOrderPaymentStatus).
// Normalised to the polling loop's shape: current_status "1" → {status: STATUS_PAID}.
async function fetchPackStatus(orderId, ctx) {
    const body = new URLSearchParams({
        orderId:          String(orderId),
        businessId:       String(ctx.businessId ?? ''),
        parentBusinessId: String(ctx.parentId ?? window.AppConfig?.businessId ?? ''),
        contactMappingId: String(userMappingId()),
    });
    const res = await fetch(`${getApiBase()}/PackageConfiguration/checkOrderPaymentStatus`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Token': userToken() },
        body,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const paid = String(data?.current_status ?? '') === '1';
    return { status: paid ? STATUS_PAID : 0 };   // not-paid → keep polling until timeout
}

// uMoney recharge payment status (umoney/checkOrderPaymentStatus). Reads umoney_history:
// paymentStatus 'success' (current_status 1) → paid, 'failed' (2) → failed, else processing.
// Normalised to the polling loop's shape. NOTE: the top-level `status` is request-ok, not
// the payment outcome — read paymentStatus/current_status.
async function fetchUmoneyStatus(orderId, ctx) {
    const params = new URLSearchParams({
        orderId:          String(orderId),
        contactMappingId: String(userMappingId()),
        parentBusinessId: String(ctx.parentId ?? ctx.parentBusinessId ?? window.AppConfig?.businessId ?? ''),
    });
    const res = await fetch(`${getApiBase()}/umoney/checkOrderPaymentStatus?${params}`, {
        method:  'GET',
        headers: { 'Token': userToken() },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const ps = String(data?.paymentStatus ?? '');
    const cs = String(data?.current_status ?? '');
    if (ps === 'success' || cs === '1') return { status: STATUS_PAID };
    if (ps === 'failed'  || cs === '2') return { status: STATUS_FAILED };
    return { status: 0 };   // processing → keep polling until timeout
}

export function init() {
    const root = document.querySelector('[data-page="polling"]');
    if (!root) return;

    const orderId = Number(root.dataset.orderId || 0);

    const waitingEl  = document.getElementById('pollingWaiting');
    const fallbackEl = document.getElementById('pollingFallback');
    const failedEl   = document.getElementById('pollingFailed');
    const retryBtn   = document.getElementById('pollingRetryBtn');
    const timerEl    = document.getElementById('pollingTimer');

    const startedAt = Date.now();
    let stopped    = false;
    let inFlight   = false;
    let timer      = null;
    let countdown  = null;

    // Must come AFTER the declarations above: showFailed() reads stopped / countdown /
    // waitingEl / failedEl, so calling it earlier threw a TDZ ReferenceError and the
    // failure screen never rendered — the user just sat on the "waiting" card forever.
    if (orderId <= 0) {
        showFailed('no_order_id');
        return;
    }

    function fmtClock(totalSeconds) {
        const s   = Math.max(0, totalSeconds);
        const min = Math.floor(s / 60);
        const sec = s % 60;
        return `${min}:${sec < 10 ? '0' : ''}${sec}`;
    }

    // CI3 StartTimer/Timer_Tick — count down from 2:00, synced to startedAt so a
    // hidden/throttled tab still shows the right time on return.
    function tickCountdown() {
        if (!timerEl) return;
        const remaining = TIMER_TOTAL_S - Math.floor((Date.now() - startedAt) / 1000);
        timerEl.textContent = fmtClock(remaining);
        if (remaining <= 0 && countdown) { clearInterval(countdown); countdown = null; }
    }

    // CI3 vw_failure: the "Go to Menu Page" link returns to the last viewed outlet.
    // location_picker stashes the outlet under localStorage 'slug'; productPage stashes
    // { webSlug } under ue_outlet_<pId> — check both so the link survives either path.
    function menuHref() {
        try {
            let slug = localStorage.getItem('slug') || '';
            if (!slug) {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('ue_outlet_')) {
                        try { slug = JSON.parse(localStorage.getItem(k) || '{}')?.webSlug || ''; } catch { /* skip */ }
                        if (slug) break;
                    }
                }
            }
            if (!slug) return '/';
            return (slug.startsWith('order/') || slug.startsWith('reservation/')) ? `/${slug}` : `/order/${slug}`;
        } catch { return '/'; }
    }

    function showFallback() { if (fallbackEl) fallbackEl.hidden = false; }
    /**
     * @param {string} reason Why we gave up — kept distinct because they are NOT the same
     *   event: 'gateway_failed' is the server confirming failure, while 'timeout' means the
     *   2-minute countdown expired and the payment may in fact have gone through. Treating
     *   them alike would poison any retargeting audience built on this event.
     *   Called via the window.Analytics bridge rather than an import — see analytics.js.
     */
    function showFailed(reason)   {
        try {
            const ctx = paymentContext();
            window.Analytics?.trackPaymentFailed?.({
                orderId,
                reason: reason || 'unknown',
                value: parseFloat(ctx.amount || ctx.totalAmount) || undefined,
            });
        } catch { /* analytics must never block the failure screen */ }
        stopped = true;
        if (countdown) { clearInterval(countdown); countdown = null; }
        if (waitingEl) waitingEl.hidden = true;
        const menuBtn = document.getElementById('pollingMenuBtn');
        if (menuBtn) menuBtn.href = menuHref();
        if (failedEl) failedEl.hidden = false;
    }

    async function tick() {
        if (stopped || inFlight) return;
        if (document.hidden) return;

        const elapsed = Date.now() - startedAt;
        if (elapsed >= FAIL_AFTER_MS) {
            showFailed('timeout');
            return;
        }
        if (elapsed >= FALLBACK_AFTER_MS) showFallback();

        inFlight = true;
        try {
            const data = await fetchStatus(orderId);
            const status = Number(data?.status ?? data?.order?.status ?? 0);
            if (status === STATUS_PAID) {
                stopped = true;
                // uMoney top-up that was started from an unpaid order's payment screen:
                // what just got paid is the recharge, not the food order. Resume that
                // checkout so the user can pay with the balance they just added — and
                // leave the cart + slot keys alone, since nothing was ordered yet.
                const umResume = isUmoneyFlow() ? takeUmoneyReturn() : '';
                if (umResume) {
                    try { sessionStorage.removeItem('paymentContext'); } catch { /* ignore */ }
                    window.location.replace(umResume);
                    return;
                }
                // Order is paid — reset the local food cart + slot keys so the next
                // checkout starts clean (see clearOrderedCart). Harmless for pack/uMoney
                // flows, which don't use these keys.
                clearOrderedCart();
                // Pack orders have no normal-order confirmation page (getOrderDetails
                // wouldn't find them) — send the user to the Active Packs tab, where
                // their newly purchased pack shows. The packs list restores this tab.
                if (paymentContext().type === 'pack') {
                    try {
                        localStorage.setItem('activeSubscriptionTab', 'active');
                        sessionStorage.removeItem('paymentContext');
                    } catch { /* ignore */ }
                    window.location.replace('/package');
                } else if (isUmoneyFlow()) {
                    // Standalone uMoney recharge — no order-confirmation page; return to
                    // the wallet with a ?recharged flag for the success gratification.
                    const uctx = paymentContext();
                    const added = parseFloat(uctx.amount || uctx.totalAmount) || 0;
                    try { sessionStorage.removeItem('paymentContext'); } catch { /* ignore */ }
                    const q = added > 0 ? '?recharged=1&amount=' + encodeURIComponent(added) : '?recharged=1';
                    window.location.replace('/umoney' + q);
                } else {
                    window.location.replace(`/order-confirmation/${orderId}`);
                }
                return;
            }
            if (status === STATUS_FAILED) {
                showFailed('gateway_failed');
                return;
            }
        } catch (err) {
            console.warn('[polling] status check failed:', err);
        } finally {
            inFlight = false;
        }
    }

    retryBtn?.addEventListener('click', () => { tick(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    // "Go Back" from the polling waiting card. Strip the auto-run UPI flags from
    // paymentContext so the payment screen shows the normal picker instead of
    // re-launching GPay/PhonePe when history.back() reloads it.
    document.getElementById('pollingBackBtn')?.addEventListener('click', () => {
        stopped = true;
        clearInterval(timer);
        clearInterval(countdown);
        try {
            const ctx = paymentContext();
            delete ctx.autoUpiVpa;
            delete ctx.autoUpiApp;
            delete ctx.autoUpiIntentApp;
            sessionStorage.setItem('paymentContext', JSON.stringify(ctx));
        } catch { /* ignore */ }
        history.back();
    });

    tick();
    tickCountdown();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    countdown = setInterval(tickCountdown, 1000);
    window.addEventListener('beforeunload', () => { stopped = true; clearInterval(timer); clearInterval(countdown); });
}

if (document.querySelector('[data-page="polling"]')) init();

// Payment helpers — browser-side gateway launchers.
//
// All payment-gateway logic (order creation, signature verification, refund)
// lives on api.uengage.in. This module only contains the browser-side actions
// that must happen after api.uengage.in returns a payment context:
//   - openRazorpayCheckout(apiResponse, onDismiss): launches Razorpay overlay
//   - submitPaytmForm(data): submits the redirect form to Paytm's gateway
// Razorpay's callback_url drives the post-payment redirect — the user lands
// on /order-polling/<orderId>, which polls api.uengage.in for status.

import { getPaytmProcessUrl } from './config.js';

// Resolve the logo Razorpay shows in its header.
//
// The /pay/initiate response returns business_logo/logo as a BARE FILENAME
// (e.g. "logo-7175-….png") — Razorpay resolves that relative to the page and
// 404s. The page header instead uses window.AppConfig.logo, which CI3WebConfigModel
// has already prefixed to a full CDN URL (cdn.uengage.io/brand_logo/…) and is
// proven to load. So prefer the AppConfig brand logo, and only fall back to the
// API value when it is itself an absolute URL. undefined → Razorpay shows no image
// rather than a broken one.
function razorpayLogo(apiResponse) {
    const cfg   = (typeof window !== 'undefined' && window.AppConfig) || {};
    const brand = cfg.logoSquare || cfg.logo;
    if (brand) return brand;
    const api = apiResponse.business_logo || apiResponse.logo || '';
    return /^https?:\/\//i.test(api) ? api : undefined;
}

const RAZORPAY_SDK        = 'https://checkout.razorpay.com/v1/checkout.js';   // Standard Checkout — .open()
const RAZORPAY_CUSTOM_SDK = 'https://checkout.razorpay.com/v1/razorpay.js';   // Custom Checkout — createPayment()
let sdkPromise       = null;
let customSdkPromise = null;

// Custom Checkout SDK — exposes createPayment() and getSupportedUpiIntentApps(),
// neither of which exist on the Standard Checkout SDK (checkout.js). Loaded on
// demand for the custom-UI flow (payment_gateway_direct === 0) + UPI-intent
// detection. Keyed off its own <script src>, so it loads even when checkout.js
// has already defined window.Razorpay (razorpay.js then overrides the global).
export function loadRazorpayCustomSdk() {
    if (customSdkPromise) return customSdkPromise;
    customSdkPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${RAZORPAY_CUSTOM_SDK}"]`);
        if (existing) {
            if (existing.dataset.rzpLoaded === '1') { resolve(); return; }
            existing.addEventListener('load',  () => resolve());
            existing.addEventListener('error', () => reject(new Error('Razorpay custom SDK failed to load')));
            return;
        }
        const script = document.createElement('script');
        script.src = RAZORPAY_CUSTOM_SDK;
        script.async = true;
        script.onload  = () => { script.dataset.rzpLoaded = '1'; resolve(); };
        script.onerror = () => reject(new Error('Razorpay custom SDK failed to load'));
        document.head.appendChild(script);
    });
    return customSdkPromise;
}

export function loadRazorpaySdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
        if (typeof window.Razorpay !== 'undefined') {
            resolve();
            return;
        }
        const existing = document.querySelector(`script[src="${RAZORPAY_SDK}"]`);
        if (existing) {
            existing.addEventListener('load',  () => resolve());
            existing.addEventListener('error', () => reject(new Error('Razorpay SDK failed to load')));
            return;
        }
        const script = document.createElement('script');
        script.src = RAZORPAY_SDK;
        script.async = true;
        script.onload  = () => resolve();
        script.onerror = () => reject(new Error('Razorpay SDK failed to load'));
        document.head.appendChild(script);
    });
    return sdkPromise;
}

/**
 * Open the Razorpay Standard Checkout overlay.
 *
 * @param {object}   apiResponse  Response from api.uengage.in/pay/initiate/json.
 *                                Expected keys: razorpay_key, business_name, business_logo,
 *                                customer_name, color, account_id?, json{...rzp options}.
 * @param {Function} [onDismiss]  Called when the user closes the overlay without paying.
 * @returns {Promise<void>}       Resolves once the overlay is open. Razorpay handles redirect.
 */
export async function openRazorpayCheckout(apiResponse, onDismiss) {
    await loadRazorpaySdk();

    const j = apiResponse.json || {};

    const options = {
        key:          apiResponse.razorpay_key,
        order_id:     j.order_id,
        amount:       j.amount,
        currency:     j.currency || 'INR',
        name:         apiResponse.business_name || '',
        description:  j.description || 'Online Transaction',
        // Logo precedence: the /pay/initiate response returns `business_logo`
        // (raw response) or `logo` (payment_screen pre-normalised). Both can be
        // blank or a non-loadable URL for a brand, which renders an empty box on
        // Razorpay — so fall back to the known-good brand logo from AppConfig.
        image:        razorpayLogo(apiResponse),
        prefill: {
            name:    apiResponse.customer_name || '',
            email:   j.email   || '',
            contact: j.contact || '',
        },
        notes:        j.notes || {},
        theme:        { color: apiResponse.color || j.theme?.color || '#3399cc' },
        callback_url: j.callback_url,
        redirect:     true,
        modal: {
            ondismiss() { onDismiss?.(); },
        },
    };

    // Do NOT pass account_id here. The /pay/initiate response always hands us the
    // MERCHANT's OWN key (rtnArr.razorpay_key) together with that same merchant's
    // account_id. Razorpay's account_id is only valid when a PLATFORM/partner key
    // charges on behalf of a LINKED account — pairing an account's own key with its
    // own account_id makes Standard Checkout's POST /v2/standard_checkout/preferences
    // return 401, and the overlay then falls back to a "sign in on api.razorpay.com"
    // prompt. The merchant key already scopes the account, so account_id is redundant
    // here. (The custom createPayment() flow never calls /preferences, so it doesn't
    // 401 — which is why this only ever surfaced on the Standard Checkout overlay.)

    // NOTE: do NOT pass customer_id / remember_customer here. On Standard
    // Checkout (.open()) those flags switch on Razorpay's Saved-Cards / trusted-
    // login experience, which forces the customer to verify via OTP ("sign in to
    // Razorpay") before they can pay. CI3 never did this on the overlay — it only
    // attached customer_id inside the custom createPayment() card-token flow.
    // Saved-card support, if needed, belongs in createRazorpayPayment(), not here.

    // Pre-selected payment method (set by payment screen when user picks UPI/card/etc).
    if (j.method === 'netbanking' && j.bank) {
        options.method = { netbanking: { bank: j.bank } };
    } else if (j.method === 'wallet' && j.wallet) {
        options.method = { wallet: { wallet: j.wallet } };
    } else if (j.method) {
        options.method = { [j.method]: true };
    }

    new window.Razorpay(options).open();
}

/**
 * Custom-UI Razorpay flow (payment_gateway_direct === 0). The method was already
 * chosen on our own screen, so we drive Razorpay's createPayment() directly —
 * NO Razorpay overlay. Mirrors CI3 process(): options come from `data.json`, with
 * the VPA (UPI collect) / saved-card token merged in client-side and `{app}` for
 * UPI intent. `redirect: true` + callback_url send the browser to /order-polling.
 *
 * @param {object} apiResponse  /pay/process response (razorpay_key|key, json, logo, account_id).
 * @param {object} methodArgs   { upi_address?, paymentintent_type?, card_token?, card? } from the click.
 *                              `card` = { name, number, expiry_month, expiry_year, cvv } for a new card.
 */
export async function createRazorpayPayment(apiResponse, methodArgs = {}, hooks = {}) {
    await loadRazorpayCustomSdk();   // razorpay.js — required for createPayment()

    const j   = apiResponse.json || {};
    const key = apiResponse.razorpay_key || apiResponse.key;
    const merchantOrderId = j.notes?.merchant_order_id || apiResponse.orderId || '';

    // Prefer a backend-supplied callback_url; otherwise return to the SAME origin
    // the user is browsing (so the post-payment redirect keeps their session) —
    // not notes.domain, which is the brand's configured/production domain and
    // would bounce a UAT session to prod.
    const callbackUrl = j.callback_url || `${window.location.origin}/order-polling/${merchantOrderId}`;

    // UPI-intent (app-switch) must NOT use redirect:true/callback_url — that makes
    // Razorpay auto-redirect to the callback (polling) on its own failure timeout,
    // which would override our "Unable to Open App" sheet (and fire even after the
    // user dismisses it). CI3 builds the UPI-intent Razorpay object WITHOUT redirect;
    // we drive navigation ourselves from the event handlers below. Every other method
    // keeps redirect:true so the browser hands off to the gateway/bank page.
    const isUpiIntent = !!methodArgs.paymentintent_type;
    const rzpConfig = { key, image: razorpayLogo(apiResponse) };
    if (!isUpiIntent) {
        rzpConfig.callback_url = callbackUrl;
        rzpConfig.redirect     = true;
    }
    const rzp = new window.Razorpay(rzpConfig);

    if (typeof rzp.createPayment !== 'function') {
        // Wrong SDK won the global (Standard Checkout). Surface clearly instead of
        // a cryptic "createPayment is not a function".
        throw new Error('Razorpay Custom Checkout SDK unavailable — createPayment() missing');
    }

    const options = { ...j };
    if (methodArgs.upi_address) options.vpa = methodArgs.upi_address;
    if (methodArgs.card_token) {
        const custId = j.notes?.razorpay_customer_id;
        if (custId) options.customer_id = custId;
        options.token = methodArgs.card_token;
    }
    // New card collected by our own modal — attach the raw card fields to the
    // createPayment options (CI3 process(): options['card[number]'] etc.). `save`
    // follows the backend's json.save (driven by the save_card param + can_save_card).
    if (methodArgs.card) {
        const c = methodArgs.card;
        const custId = j.notes?.razorpay_customer_id;
        if (custId) options.customer_id = custId;
        options['card[name]']         = c.name;
        options['card[number]']       = c.number;
        options['card[expiry_month]'] = c.expiry_month;
        options['card[expiry_year]']  = c.expiry_year;
        options['card[cvv]']          = c.cvv;
        options.save = j.save == 1 ? 1 : 0;
    }
    // Skip account_id when it's uEngage's own platform account (order collected on
    // our MID) — sending it would be a self-reference. The platform account id is
    // env-driven (AppConfig.razorpayPlatformAccount), not a hardcoded brand literal,
    // so it differs correctly between live and UAT/test.
    const platformAccount = (typeof window !== 'undefined' && window.AppConfig?.razorpayPlatformAccount) || '';
    if (apiResponse.account_id && apiResponse.account_id !== platformAccount) {
        options.account_id = apiResponse.account_id;
    }

    // Razorpay returns 400 on a blank customer_id — only send it when set
    // (it can arrive empty via the spread of `json` or json.notes).
    if (!options.customer_id) delete options.customer_id;

    const goPolling = () => { if (merchantOrderId) window.location.href = `/order-polling/${merchantOrderId}`; };

    // UPI-intent app launch (gpay / phonepe / paytm). Mirrors CI3 process(): detect
    // whether the app actually opened (page goes hidden on the app-switch), route
    // success/failed to polling, but on a launch error or "app never opened" KEEP the
    // user on the payment screen so they can pick another app or method — CI3's
    // openErrorPage / showOtherApps. Never strand them on the failed-polling page.
    if (methodArgs.paymentintent_type) {
        const app = methodArgs.paymentintent_type;
        let appOpened = false;
        let settled   = false;
        const onVis = () => { if (document.hidden) appOpened = true; };
        document.addEventListener('visibilitychange', onVis);
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('visibilitychange', onVis);
            fn();
        };

        rzp.on('payment.success', () => finish(goPolling));
        rzp.on('payment.failed',  () => finish(goPolling));
        rzp.on('payment.error', (resp) => finish(() => {
            console.error('[payment] UPI intent error:', resp?.error?.reason || resp?.error?.description || resp);
            hooks.onUpiAppFailed?.(app);     // stay on screen, let the user retry
        }));
        rzp.on('payment.cancel', () => finish(() => {}));   // user backed out → stay

        rzp.createPayment(options, { app });

        // CI3's 5s decision: app opened → assume payment in progress → poll; app never
        // opened → likely not installed → stay and prompt another app/method.
        setTimeout(() => finish(() => {
            if (appOpened) goPolling();
            else hooks.onUpiAppFailed?.(app);
        }), 5000);
        return;
    }

    // Non-intent methods (netbanking / wallet / card / UPI-collect). redirect:true
    // takes the browser to the gateway; these handlers are a safety net.
    rzp.on('payment.success', goPolling);   // captured → poll for final status
    rzp.on('payment.failed',  goPolling);   // failed at gateway → poll page shows outcome
    rzp.on('payment.error', (resp) => {     // SDK/initiation error (e.g. risk check)
        console.error('[payment] Razorpay error:', resp?.error?.description || resp?.error?.reason || resp);
        goPolling();
    });
    rzp.on('payment.cancel', () => {        // user dismissed — stay so they can retry
        console.log('[payment] Razorpay payment cancelled by user');
    });
    rzp.createPayment(options);
}

export function submitPaytmForm(data) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = getPaytmProcessUrl();
    form.style.display = 'none';

    for (const [key, value] of Object.entries(data.paytm_params || {})) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    return { success: true, redirecting: true };
}

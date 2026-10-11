/**
 * config.js — AppConfig accessor module
 *
 * Single source of truth for all JS modules that need to read
 * window.AppConfig injected by base.php.
 *
 * Usage:
 *   import { getConfig, getApiBase, getBusinessId, getFeatures } from './config.js';
 *
 * window.AppConfig shape (set by BrandConfig::toAppConfig()):
 * {
 *   apiBase:      'https://api.uengage.in',
 *   businessId:   5,
 *   theme:        'ue_silver',
 *   mapsKey:      '...',
 *   firebase:     { apiKey, authDomain, projectId, ... },
 *   recaptchaKey: '...',
 *   features:     { delivery, pickup, dineIn, inCar, reservation, reservationCount, directPay },
 *   flags:        { ecomm, uMoney, checkoutNew, loginFlow, mapsFlow, outletSelector, ... },
 *   loyalty:      { walletName, rewards, rewardProgramName, singleMilestone, milestones },
 * }
 */

const _config = window.AppConfig ?? {};

// ─────────────────────────────────────────────────────────────
// Core accessors
// ─────────────────────────────────────────────────────────────

/** Full AppConfig object */
export function getConfig() {
    return _config;
}

// All endpoint values come from window.AppConfig, which is populated from .env
// via base.php. Empty fallback ('') means a missing .env key fails loudly at
// the first network call rather than silently using a stale default.

/** Base URL for all API calls → api.uengage.in (from .env: uengage.apiBase) */
export function getApiBase() {
    return _config.apiBase ?? '';
}

/** Static menu/feed CDN base (from .env: uengage.menuFeedBase) */
export function getMenuFeedBase() {
    return _config.menuFeedBase ?? '';
}

/** CRM API base (from .env: uengage.crmBase) */
export function getCrmBase() {
    return _config.crmBase ?? '';
}

/** Image CDN base, no trailing slash (from .env: uengage.cdnBase) */
export function getCdnBase() {
    return _config.cdnBase ?? '';
}

/** Paytm gateway redirect URL (from .env: paytm.processUrl) */
export function getPaytmProcessUrl() {
    return _config.paytmProcessUrl ?? '';
}

/** Static API key for menu-feed / slots calls. Browser-exposed; not a secret. */
export function getStaticApiKey() {
    return _config.staticApiKey ?? '';
}

/** CRM authorization token (loyalty rules endpoint). Browser-exposed; not a secret. */
export function getCrmAuthToken() {
    return _config.crmAuthToken ?? '';
}

/** Truecaller partner key (per-brand). Empty string = Truecaller login disabled. */
export function getTruecallerKey() {
    return _config.truecallerKey ?? '';
}

/** WhatsApp login toggle (per-brand, addo_business.whatsapp_login). */
export function isWhatsappLoginEnabled() {
    return Number(_config.whatsappLogin ?? 0) === 1;
}

export function getBusinessId() {
    return _config.businessId ?? null;
}

export function getTheme() {
    return _config.theme ?? 'ue_default';
}

export function getMapsKey() {
    return _config.mapsKey ?? '';
}

export function getRecaptchaKey() {
    return _config.recaptchaKey ?? '';
}

export function getFirebaseConfig() {
    return _config.firebase ?? {};
}

// ─────────────────────────────────────────────────────────────
// Feature flags
// ─────────────────────────────────────────────────────────────

export function getFeatures() {
    return _config.features ?? {};
}

export function isDeliveryEnabled() {
    return !!_config.features?.delivery;
}

export function isPickupEnabled() {
    return !!_config.features?.pickup;
}

export function isDineInEnabled() {
    return !!_config.features?.dineIn;
}

export function isInCarEnabled() {
    return !!_config.features?.inCar;
}

export function isReservationEnabled() {
    return !!_config.features?.reservation;
}

export function isDirectPayEnabled() {
    return !!_config.features?.directPay;
}

// ─────────────────────────────────────────────────────────────
// Flow flags
// ─────────────────────────────────────────────────────────────

export function getFlags() {
    return _config.flags ?? {};
}

/** Generic flag check — looks up a key in window.AppConfig.flags (backed by web_feature_flags). */
export function isFlagEnabled(key) {
    return !!(_config.flags && _config.flags[key]);
}

export function isEcomm() {
    return !!_config.flags?.ecomm;
}

export function isUMoney() {
    return !!_config.flags?.uMoney;
}

export function isCheckoutNew() {
    return !!_config.flags?.checkoutNew;
}

export function getLoginFlow() {
    return _config.flags?.loginFlow ?? 0;
}

export function getMapsFlow() {
    return _config.flags?.mapsFlow ?? 0;
}

export function isOutletSelector() {
    return !!_config.flags?.outletSelector;
}

// ─────────────────────────────────────────────────────────────
// Loyalty
// ─────────────────────────────────────────────────────────────

export function getLoyalty() {
    return _config.loyalty ?? {};
}

export function getWalletName() {
    return _config.loyalty?.walletName ?? 'Wallet';
}

// ─────────────────────────────────────────────────────────────
// Fetch helper — all API calls go through this
// ─────────────────────────────────────────────────────────────

/**
 * Make an authenticated API call to api.uengage.in.
 *
 * @param {string} endpoint        e.g. '/menu/items'
 * @param {object} [body]          POST body (omit for GET)
 * @param {string} [method='POST'] HTTP method
 * @returns {Promise<any>}
 */
export async function apiCall(endpoint, body = null, method = 'POST') {
    const url = getApiBase() + endpoint;

    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Accept':        'application/json',
        },
    };

    if (body !== null && method !== 'GET') {
        // Inject businessId on every request (matches mobile app auth contract)
        options.body = JSON.stringify({
            businessId: getBusinessId(),
            ...body,
        });
    }

    const res = await fetch(url, options);

    if (!res.ok) {
        throw new Error(`API error ${res.status} on ${endpoint}`);
    }

    return res.json();
}

/**
 * POST form-encoded data to api.uengage.in.
 *
 * Use this for legacy CI3 endpoints that read inputs via $this->input->get_post()
 * (which only populates from application/x-www-form-urlencoded, not JSON). Arrays
 * and objects in the body are JSON-stringified into their form field — same shape
 * CI3 sees when it does json_decode($this->input->post('items'), true).
 *
 * Optional `extraHeaders` lets a caller add request headers (e.g. `userToken`
 * for PackageConfiguration/* endpoints, which read the auth token from headers
 * rather than the form body).
 */
export async function apiCallForm(endpoint, body = {}, extraHeaders = {}) {
    const params = new URLSearchParams();
    params.set('businessId', String(getBusinessId() ?? ''));
    for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        params.set(k, (typeof v === 'object') ? JSON.stringify(v) : String(v));
    }

    const res = await fetch(getApiBase() + endpoint, {
        method:  'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept':       'application/json',
            ...extraHeaders,
        },
        body:    params.toString(),
    });

    if (!res.ok) throw new Error(`API error ${res.status} on ${endpoint}`);
    return res.json();
}

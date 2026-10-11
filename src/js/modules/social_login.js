/**
 * social_login.js — WhatsApp + Truecaller login for the base.php login modal.
 *
 * Routing: per project rule, no internal CI4 AJAX and no api.uengage.in for these
 * flows — both ride the CRM surface (crm.uengage.in/crm_api/*) with the browser-exposed
 * crmAuthToken + parent_id, exactly like loyalty.js. WhatsApp also needs one brand-origin
 * landing page (wb_login) because localStorage is origin-scoped; that page is served by
 * Web\WhatsappLoginController and finishes via wa_login_return.js.
 *
 * Visibility (mirrors CI3 wla_*.js):
 *   - Truecaller: Android only, not in-app social webviews, and only if a truecallerKey is set.
 *   - WhatsApp:   any mobile, and only if the brand has whatsapp_login = 1.
 *
 * CI3 references (legacy repo):
 *   truecallerLogin / getTruecallerLoginStatus / whatsappLogin in
 *   assets/themes/ue_default/js/wla_20260417.js
 */
import { getConfig, getCrmBase, getCrmAuthToken, getTruecallerKey, isWhatsappLoginEnabled } from './config.js';

const cfg          = getConfig();
const PARENT_ID    = cfg.businessId ?? 0;
const BRAND_NAME   = cfg.brandName ?? '';
const CRM_BASE     = (getCrmBase() || '').replace(/\/$/, '') + '/crm_api';
const CRM_AUTH_TOK = getCrmAuthToken();
const TRUECALLER_KEY = getTruecallerKey();

const ua = navigator.userAgent || '';
const isAndroid = /android/i.test(ua);
const isMobile  = /android|iphone|ipad|ipod/i.test(ua);
// In-app browsers (Instagram/FB/Twitter/Snapchat) can't launch the Truecaller intent.
const isSocialWebview = ['Instagram', 'FBAN', 'FBAV', 'Twitter', 'Snapchat'].some(a => ua.includes(a));
// Layout breakpoint (CI3 parity: social-first below 768px). UA-mobile always counts.
const isMobileView = () => isMobile || window.innerWidth < 768;
const tcEligible   = TRUECALLER_KEY && isAndroid && !isSocialWebview;

// ── Endpoints ────────────────────────────────────────────────────────────────
// WhatsApp link generation — direct browser → CRM. CRM requires an HMAC-SHA256
// JWT (Bearer) keyed by a shared secret; the JWT is minted server-side at page
// render and handed to JS via window.AppConfig.waJwt (see base.php).
const WA_LOGIN_URL = CRM_BASE + '/check/whatsapp/login';
// Truecaller status poll — CI3 used the internal /client/getTrueCallerStatus backed by the
// truecaller_web_logins table. No internal endpoints allowed here, so this must live on CRM.
// TODO(CRM): confirm this path + response shape, and that the Truecaller partner-dashboard
// webhook is pointed at CRM (it writes the row this endpoint reads).
const TC_STATUS_URL = CRM_BASE + '/check/truecaller/status';

const $ = id => document.getElementById(id);

// Analytics is reached through the window.Analytics bridge, NEVER by importing
// './analytics.js'. This module is cache-busted but a nested import is not, and nginx
// caches /src/js for 30 days — pairing a fresh social_login.js with a stale analytics.js
// that lacks these exports throws SyntaxError and kills the whole module, which would
// break WhatsApp and Truecaller LOGIN, not merely its tracking. The bridge no-ops instead.
const track = (fn, payload) => { try { window.Analytics?.[fn]?.(payload); } catch { /* never block login */ } };
const trackClick  = method            => track('trackLoginMethodClicked', { method });
const trackFailed = (method, reason)  => track('trackLoginMethodFailed', { method, reason });

/** Ask CRM directly for the WhatsApp deep link using the page-rendered JWT. */
async function fetchWaLink() {
    const jwt = (window.AppConfig && window.AppConfig.waJwt) || '';
    if (!jwt) return { status: 0, msg: 'WhatsApp login is not configured for this brand.' };

    try {
        const res = await fetch(WA_LOGIN_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + jwt,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ source: 'web' }).toString(),
        });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { status: 0, msg: 'Bad response' }; }
    } catch {
        return { status: 0, msg: 'Network error. Please try again.' };
    }
}

/** POST form-encoded to CRM with the loyalty.js auth convention. Returns parsed JSON. */
async function crmPost(url, params) {
    const body = new URLSearchParams({ parent_id: String(PARENT_ID), source: 'web', ...params });
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'authorization': CRM_AUTH_TOK, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: 0, msg: 'Bad response' }; }
}

// ── WhatsApp ────────────────────────────────────────────────────────────────
let waLoginUrl = '';

async function whatsappLogin() {
    const btn = $('whatsappLoginBtn');
    if (btn && btn.disabled) return; // brand has whatsapp_login = 0 (shown greyed)
    const label = $('whatsappBtnLabel');
    const original = label ? label.innerHTML : '';
    if (label) label.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Opening WhatsApp…';
    if (btn) btn.disabled = true;

    // Remember where to return the user after they finish in WhatsApp.
    localStorage.setItem('wa_redirect_url', window.location.href);

    try {
        if (!waLoginUrl) {
            const res = await fetchWaLink();
            if (Number(res.status) === 1 && res.whatsapp_message) {
                waLoginUrl = res.whatsapp_message;
            } else {
                // Clicked WhatsApp but CRM never returned a deep link — the user never
                // reached WhatsApp at all, so this is a dropout we own, not theirs.
                trackFailed('whatsapp', 'link_failed');
                showError(res.msg || 'WhatsApp login is unavailable right now.');
                return;
            }
        }
        window.open(waLoginUrl, '_blank');
    } catch {
        showError('Network error. Please try again.');
    } finally {
        if (label) label.innerHTML = original;
        if (btn) btn.disabled = false;
    }
}

// ── Truecaller ──────────────────────────────────────────────────────────────
let tcRequestId = '';
let tcPollTimer = null;

function truecallerLogin() {
    if (!TRUECALLER_KEY) return;
    tcRequestId = PARENT_ID + '-' + Math.floor(Math.random() * 1e8);

    // Launch the Truecaller app via its SDK deeplink (Android intent).
    window.location = 'truecallersdk://truesdk/web_verify'
        + '?type=btmsheet'
        + '&requestNonce=' + encodeURIComponent(tcRequestId)
        + '&partnerKey=' + encodeURIComponent(TRUECALLER_KEY)
        + '&partnerName=' + encodeURIComponent(BRAND_NAME)
        + '&lang=en&loginPrefix=continue&loginSuffix=login'
        + '&ctaPrefix=proceedwith&ctaColor=%230099ff&ctaTextColor=%23ffffff'
        + '&btnShape=Round&skipOption=Later';

    // If the page still has focus after the deeplink attempt, the app isn't installed.
    setTimeout(() => {
        if (document.hasFocus()) {
            trackFailed('truecaller', 'app_missing');
            tcRequestId = '';   // terminal — see cancelTruecaller on why this must be cleared
            showError('Truecaller is not installed on this device.');
        } else {
            openTruecallerModal();
            pollTruecallerStatus(0);
        }
    }, 700);
}

function pollTruecallerStatus(attempt) {
    const MAX = 12; // ~12s, mirrors CI3's bounded poll
    if (attempt >= MAX) {
        trackFailed('truecaller', 'timed_out');
        // Terminal: clear the id so closing the (still-open) timed-out modal doesn't ALSO
        // record a 'cancelled' for the same attempt. Retrying calls truecallerLogin(),
        // which mints a fresh id anyway.
        tcRequestId = '';
        setTcStatus('Timed out. Please try again.');
        return;
    }
    tcPollTimer = setTimeout(async () => {
        if (!tcRequestId) return; // cancelled
        try {
            const res = await crmPost(TC_STATUS_URL, { requestId: tcRequestId });
            if (Number(res.status) === 1 && res.rows) {
                tcRequestId = '';   // cleared BEFORE _completeLogin so the modal-hide it
                                    // triggers reads this as a success, not a cancel
                window._completeLogin(res.rows, 'truecaller');
                return;
            }
        } catch { /* keep polling */ }
        pollTruecallerStatus(attempt + 1);
    }, 1000);
}

function openTruecallerModal() {
    const el = $('truecallerModal');
    if (el && window.bootstrap) new bootstrap.Modal(el).show();
}

function setTcStatus(msg) {
    const el = $('truecallerStatusText');
    if (el) el.textContent = msg;
}

function cancelTruecaller() {
    // Only a real abandon — NOT every invocation. This runs from the cancel button AND
    // from the modal's `hidden.bs.modal`, and _completeLogin hides that same modal on
    // SUCCESS, so firing unconditionally would log a "cancelled" after every successful
    // Truecaller login and invert the metric. pollTruecallerStatus clears tcRequestId the
    // moment it succeeds, so a still-set id is exactly "in flight and gave up".
    if (tcRequestId) trackFailed('truecaller', 'cancelled');
    tcRequestId = '';
    if (tcPollTimer) clearTimeout(tcPollTimer);
}

// ── UI wiring ─────────────────────────────────────────────────────────────
function showError(msg) {
    const el = $('loginError');
    if (el) { el.textContent = msg; el.hidden = false; setTimeout(() => el.hidden = true, 5000); }
}

// Toggle d-none only — buttons keep their own inline `display:flex` (icon + label
// centering), which the !important d-none rule covers when hidden.
const show = el => el && el.classList.remove('d-none');
const hide = el => el && el.classList.add('d-none');

// Either checkbox satisfies the consent gate — the OTP-view (#loginConsent) and
// the mobile-social-view (#loginConsentSocial) are kept in lockstep by base.php,
// but reading both here removes any reliance on that sync having run yet.
const consentChecked = () => !!($('loginConsent')?.checked || $('loginConsentSocial')?.checked);

/** Green/clickable only when whatsapp_login = 1 AND consent is checked; greyed + inert otherwise. */
function setWhatsappState(wa) {
    if (!wa) return;
    const on = isWhatsappLoginEnabled() && consentChecked();
    wa.disabled = !on;
    wa.style.background = on ? '#25d366' : '#b0b4c0';
    wa.style.borderColor = on ? '#25d366' : '#b0b4c0';
    wa.style.cursor = on ? 'pointer' : 'not-allowed';
}

/** Re-gate WhatsApp whenever the consent checkbox toggles. Truecaller is not consent-gated. */
function updateConsentGating() {
    setWhatsappState($('whatsappLoginBtn'));
}

/** Reset the modal to its default view: form-first on desktop, social-first on mobile. */
function applyLayout() {
    const tc = $('truecallerBtn'), wa = $('whatsappLoginBtn'), or = $('socialLoginOr');
    const phoneBtn = $('loginWithOtpBtn'), form = $('otpFormSection'), back = $('backToMethodsLink');
    const socialConsent = $('loginConsentSocialWrap');

    const waEligible = isWhatsappLoginEnabled();

    // No social option available (desktop always, or a mobile brand with neither
    // Truecaller nor WhatsApp) → skip the "Phone Number" gate and show the number
    // entry directly. A lone "Phone Number" button that just reveals the same form
    // is a pointless extra tap.
    if (!isMobileView() || (!tcEligible && !waEligible)) {
        [tc, wa, or, phoneBtn, back, socialConsent].forEach(hide);
        show(form);
        return;
    }
    // Mobile — social options first; the OTP form is hidden until "Phone Number".
    // WhatsApp only appears for brands with whatsapp_login = 1 (CI3 parity: the button
    // was hidden until /client/checkWhatsappLogin confirmed it). Showing it greyed for
    // brands without the flag makes consent look broken — it can never enable.
    hide(form); hide(back);
    show(phoneBtn);
    tcEligible  ? show(tc) : hide(tc);
    waEligible  ? show(wa) : hide(wa);
    // The "OR" divider and the social-consent box only make sense with a social button.
    (tcEligible || waEligible) ? show(or) : hide(or);
    (tcEligible || waEligible) ? show(socialConsent) : hide(socialConsent);
    if (waEligible) updateConsentGating();
}

/** "Phone Number" tapped — swap to the OTP form. */
function showOtpForm() {
    show($('otpFormSection')); show($('backToMethodsLink'));
    [$('truecallerBtn'), $('whatsappLoginBtn'), $('socialLoginOr'), $('loginWithOtpBtn'), $('loginConsentSocialWrap')].forEach(hide);
    setTimeout(() => $('loginPhone')?.focus(), 100);
}

function init() {
    // Login-method clicks — the top of the per-method funnel. One event with a `method`
    // param rather than three separate events, so "WhatsApp vs Truecaller" is one report;
    // the OTP arm comes free and acts as the baseline.
    //
    // NOTE: a disabled button fires no click event, and WhatsApp is disabled until the
    // consent box is ticked (setWhatsappState) — so "wanted WhatsApp, hadn't consented"
    // is NOT captured here. Would need a listener on the wrapper.
    $('truecallerBtn')?.addEventListener('click', () => { trackClick('truecaller'); truecallerLogin(); });
    $('whatsappLoginBtn')?.addEventListener('click', () => { trackClick('whatsapp'); whatsappLogin(); });
    $('loginWithOtpBtn')?.addEventListener('click', () => { trackClick('otp'); showOtpForm(); });
    $('backToMethodsLink')?.addEventListener('click', applyLayout);
    $('loginConsent')?.addEventListener('change', updateConsentGating);
    $('loginConsentSocial')?.addEventListener('change', updateConsentGating);
    $('truecallerCancel')?.addEventListener('click', cancelTruecaller);
    $('truecallerModal')?.addEventListener('hidden.bs.modal', cancelTruecaller);
    // Reset to the default view each time the modal opens (CI3 resets on open).
    // loginModal is now a .popup-overlay; window.showLogin() dispatches a custom event.
    $('loginModal')?.addEventListener('loginmodal:shown', applyLayout);
    applyLayout();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/**
 * utm.js — UTM / campaign attribution capture (loaded site-wide via base.php).
 *
 * On every landing it reads campaign params + ad click IDs from the URL and, if any are
 * present, writes a first-party `utm_data` cookie on the brand domain (base64-encoded JSON,
 * 30 days). The cookie name + encoding mirror CI3 so the value stays portable.
 *
 * Attribution model: Last Tagged Click (first-untagged for new visitors).
 *   - New tagged visit (any UTM / click ID) → always overwrites (fresh campaign wins).
 *   - Untagged visit, cookie exists          → keeps existing cookie (campaign retains credit).
 *   - No cookie yet                          → captures referrer / direct as first touch so EVERY
 *                                             order is attributed (organic / referral / direct).
 * Note: organic and referral visits do NOT overwrite a stored campaign — this means a
 * campaign touch from day 1 retains credit even if the user comes back organically on day 29.
 * This matches CI3 behaviour and Shopify's "Last Click" mode. It is NOT GA4 Last Non-Direct
 * Click (which would overwrite Direct with a later Organic touch).
 *
 * Storage: cookie (30 days) + localStorage mirror (30 days).
 * localStorage restores the cookie after Safari ITP purges or manual cookie clears,
 * using the remaining TTL so attribution cannot extend beyond the original 30-day window.
 *
 * The order API (api.uengage.in) is cross-origin, so the cookie can't ride the order call.
 * Instead it's a same-origin cookie that the CI4 confirmation page reads server-side
 * (OrderStatusController::confirmOrder → OrderUtmModel) to write the order_utm_source_mapping row.
 * referer_url + start_slug are captured here because the server can't recover the
 * original landing referrer at confirmation time.
 *
 * CI3 parity: header_config.php:40-49 (param list) + the utm_data cookie.
 * Note: CI3 still writes this cookie with a 24h TTL (header_config.php:115). Only CI4-served
 * pages get the 30-day window — the JS handles both by always using the cookie's own expiry.
 */
(function () {
    'use strict';

    // 5 utm_* params + ad click IDs (Google gclid/wbraid/gbraid, Microsoft msclkid,
    // Meta fbclid, TikTok ttclid, LinkedIn li_fat_id, Criteo cto_pld).
    var PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
        'gclid', 'wbraid', 'gbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id', 'cto_pld',
    ];
    var COOKIE  = 'utm_data';
    var MAX_AGE = 2592000; // 30 days — matches Shopify / Google Ads default; covers Meta's 7-day window
    var secure  = window.location.protocol === 'https:' ? '; Secure' : '';

    // --- localStorage helpers (30-day backup) ------------------------------------
    // Stored as { v: <base64-cookie-value>, e: <unix-seconds-expiry> }.
    // lsRead() returns the full entry so callers can use the remaining TTL.
    // Silently no-ops in private mode or when storage is full.

    function lsRead() {
        try {
            var raw = localStorage.getItem(COOKIE);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (!entry || !entry.v || !entry.e) return null;
            if (Date.now() / 1000 > entry.e) { localStorage.removeItem(COOKIE); return null; }
            return entry;
        } catch (e) { return null; }
    }

    function lsWrite(value) {
        try {
            localStorage.setItem(COOKIE, JSON.stringify({ v: value, e: Math.floor(Date.now() / 1000) + MAX_AGE }));
        } catch (e) {} // storage full or private mode — silently skip
    }

    // --- URL param capture -------------------------------------------------------

    var qs    = new URLSearchParams(window.location.search);
    var found = {};
    var any   = false;
    PARAMS.forEach(function (k) {
        var v = qs.get(k);
        if (v) { found[k] = v; any = true; }
    });

    // --- Cookie presence (restore from localStorage if Safari ITP purged it) -----

    var hasCookie = document.cookie.split('; ').some(function (c) {
        return c.indexOf(COOKIE + '=') === 0;
    });

    if (!hasCookie) {
        var lsEntry = lsRead();
        if (lsEntry) {
            // Restore using remaining TTL — never extends beyond the original 30-day window.
            var remaining = Math.max(1, lsEntry.e - Math.floor(Date.now() / 1000));
            document.cookie = COOKIE + '=' + lsEntry.v + '; path=/; max-age=' + remaining + '; SameSite=Lax' + secure;
            hasCookie = true;
        }
    }

    // --- Write rules (Last Tagged Click) -----------------------------------------
    //  - Tagged params present    → always write (new paid/campaign click wins).
    //  - No params + no cookie yet → first untagged entry: capture referrer/direct.
    //  - No params + cookie exists → keep it (organic/direct don't steal campaign credit).
    if (!any && hasCookie) {
        // Mirror to localStorage for any existing-cookie holder who hasn't been backed up yet.
        if (!lsRead()) {
            var existing = document.cookie.split('; ').reduce(function (val, c) {
                return c.indexOf(COOKIE + '=') === 0 ? c.substring(COOKIE.length + 1) : val;
            }, null);
            if (existing) { lsWrite(existing); }
        }
        return;
    }

    found.referer_url = document.referrer || '';
    found.start_slug  = window.location.pathname || '';
    found.created_at  = new Date().toISOString();

    var value;
    try {
        value = btoa(unescape(encodeURIComponent(JSON.stringify(found))));
    } catch (e) {
        return; // never let attribution capture throw on a page
    }

    document.cookie = COOKIE + '=' + value + '; path=/; max-age=' + MAX_AGE + '; SameSite=Lax' + secure;
    lsWrite(value); // mirror to localStorage as 30-day backup
})();

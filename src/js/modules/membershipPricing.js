/**
 * membershipPricing.js — menu-item-level membership slashed pricing.
 *
 * Ports the mobile app's MembershipUtils menu helpers to the web menu. All data
 * lands on api.uengage.in directly — no internal CI4 endpoint.
 *
    /addo_membership_customer/getMenuMemberPricing
 *     ├─ member: POST form body  businessId&parentBusinessId&contactMappingId&token   (no preflight)
 *     └─ guest:  GET  ?businessId&parentBusinessId  + header  X-Salt-Key: sha256hex(businessId + SALT)
 *   Only the guest path sends a custom header, so only it incurs a CORS preflight
 *   (OPTIONS) the endpoint must answer — verify api.uengage.in allows `X-Salt-Key`.
 *
 * Response: { status, mode:"member"|"guest", buckets:[{
 *   benefit_id, discount_type:"percentage"|"fixed", discount_value, max_discount_amount,
 *   membership_plan_id, applies_to:"all"|"sections"|"items", section_ids[], item_ids[] }] }
 *
 * The two getMembershipDiscount* helpers are pure + null-safe and are the single
 * source of truth for whether an item/variant gets the membership treatment.
 */

import { getApiBase } from './config.js';

// Matches the backend spec (same literal the mobile app uses).
export const SALT = 'uengage-membership-salt-2026';

// Accepts only non-zero finite numbers (rejects null/undefined/0/"0"/""/NaN).
function isValidNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0;
}

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function userField(u, ...keys) {
    if (!u) return '';
    for (const k of keys) {
        if (u[k] !== undefined && u[k] !== null && u[k] !== '') return u[k];
    }
    return '';
}

// sha256(text) → lowercase hex. Prefers Web Crypto (native, audited) but falls
// back to a pure-JS digest when crypto.subtle is unavailable — that happens on
// insecure-context origins (plain http:// that isn't localhost), e.g. a local
// dev domain like http://uengage.test, where the guest salt-key would otherwise
// never compute and the request would silently never fire.
export async function sha256Hex(text) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch { /* fall through to the JS implementation */ }
    }
    return sha256HexJs(text);
}

// Self-contained SHA-256 over a UTF-8 string. Standard FIPS 180-4; no external
// deps, works in any context. Inputs here are short (businessId + salt), so the
// 32-bit length encoding is always sufficient.
const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256HexJs(str) {
    const ror = (n, b) => (n >>> b) | (n << (32 - b));
    const bytes = new TextEncoder().encode(str);
    const l = bytes.length;
    const total = (((l + 8) >> 6) + 1) << 6; // multiple of 64, room for 0x80 + 64-bit length
    const m = new Uint8Array(total);
    m.set(bytes);
    m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 4, (l * 8) >>> 0, false);
    dv.setUint32(total - 8, Math.floor((l * 8) / 0x100000000), false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
            const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(hex).join('');
}

/**
 * Fetch menu member-pricing for the current outlet. Returns { mode, buckets } or
 * null (no auth path available, network/parse failure, or status !== 1). Silent
 * on failure — the menu simply renders regular prices.
 */
export async function fetchMenuMemberPricing({ businessId, parentBusinessId, user }) {
    if (!businessId) return null;

    const params = new URLSearchParams({
        businessId:       String(businessId),
        parentBusinessId: String(parentBusinessId ?? ''),
    });

    const cmId  = userField(user, 'contactMappingId', 'contact_mapping_id');
    const token = userField(user, 'token');
    const base  = `${getApiBase()}/addo_membership_customer/getMenuMemberPricing`;

    try {
        let res;
        if (cmId && token) {
            // Member — contactMappingId + token sent in the form BODY (POST). A
            // form-urlencoded body is a CORS-safelisted content type, so no custom
            // header and no preflight.
            params.set('contactMappingId', String(cmId));
            params.set('token', String(token));
            res = await fetch(base, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    params.toString(),
            });
        } else {
            // Guest — no token available, so authenticate with the salt-key header.
            // NOTE: this custom header triggers a CORS preflight (OPTIONS) the
            // endpoint must allow; we silently no-op if it fails.
            let saltKey;
            try { saltKey = await sha256Hex(String(businessId) + SALT); } catch { return null; }
            res = await fetch(`${base}?${params.toString()}`, { headers: { 'X-Salt-Key': saltKey } });
        }
        if (!res.ok) return null;
        const json = await res.json();
        if (String(json?.status) !== '1') return null;
        return {
            mode:    json.mode === 'member' ? 'member' : 'guest',
            buckets: Array.isArray(json.buckets) ? json.buckets : [],
        };
    } catch {
        return null;
    }
}

// Does this bucket cover this item? all → every item; sections → item.sectionId
// in section_ids; items → item.id in item_ids. All compared as lowercased strings.
function bucketCoversItem(bucket, id, sectionId) {
    const applies = String(bucket?.applies_to ?? '').toLowerCase();
    if (applies === 'all') return true;
    const idStr = String(id ?? '').toLowerCase();
    if (applies === 'sections') {
        return (bucket.section_ids || []).some((s) => String(s).toLowerCase() === String(sectionId ?? '').toLowerCase());
    }
    if (applies === 'items') {
        return (bucket.item_ids || []).some((s) => String(s).toLowerCase() === idStr);
    }
    return false;
}

// Apply a matched bucket's discount to a base price. Returns the member price (2 dp).
function applyDiscount(bucket, base) {
    const dv   = Number(bucket.discount_value);
    const type = String(bucket?.discount_type ?? '').toLowerCase();
    let memberPrice;
    if (type === 'fixed') {
        memberPrice = Math.max(0, base - dv);
    } else {
        // default to percentage
        memberPrice = base * (1 - dv / 100);
        if (isValidNumber(bucket.max_discount_amount)) {
            memberPrice = Math.max(memberPrice, base - Number(bucket.max_discount_amount));
        }
    }
    return round2(memberPrice);
}

/**
 * Per-item membership discount, or null when it doesn't apply.
 * `item` is a normalized menu.js item (id, sectionId, sp, mrp, isBogo, …).
 * Returns { memberPrice, savings, mrp, bucket, mode }.
 */
export function getMembershipDiscountForItem(item, pricing) {
    if (!pricing || !pricing.buckets?.length || !item) return null;
    // Wizard combos (mobile viewType === "3") opt out of item-level membership pricing.
    if (item.isBogo) return null;

    const base      = Number(item.mrp) > 0 ? Number(item.mrp) : Number(item.sp);
    const currentSp = Number(item.sp);
    if (!(base > 0)) return null;

    const bucket = pricing.buckets.find(
        (b) => isValidNumber(b?.discount_value) && bucketCoversItem(b, item.id, item.sectionId),
    );
    if (!bucket) return null;

    const memberPrice = applyDiscount(bucket, base);
    // POS slash already beats membership → leave the regular price alone.
    if (!(currentSp > 0) || memberPrice >= currentSp) return null;

    return { memberPrice, savings: round2(base - memberPrice), mrp: base, bucket, mode: pricing.mode };
}

/**
 * Per-variant membership discount. Bucket-matches on the PARENT item (buckets carry
 * only parent ids per product direction) but does the math on the variant's own
 * mrp/sp. Returns { memberPrice, savings, mrp, bucket, mode } or null.
 */
export function getMembershipDiscountForVariant(parentItem, variant, pricing) {
    if (!pricing || !pricing.buckets?.length || !parentItem || !variant) return null;
    if (parentItem.isBogo) return null;

    const base      = Number(variant.mrp) > 0 ? Number(variant.mrp) : Number(variant.sp);
    const currentSp = Number(variant.sp);
    if (!(base > 0)) return null;

    const bucket = pricing.buckets.find(
        (b) => isValidNumber(b?.discount_value) && bucketCoversItem(b, parentItem.id, parentItem.sectionId),
    );
    if (!bucket) return null;

    const memberPrice = applyDiscount(bucket, base);
    if (!(currentSp > 0) || memberPrice >= currentSp) return null;

    return { memberPrice, savings: round2(base - memberPrice), mrp: base, bucket, mode: pricing.mode };
}

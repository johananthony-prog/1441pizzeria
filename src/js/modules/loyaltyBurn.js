/**
 * loyaltyBurn.js — item-wise loyalty figures for the cart screen.
 *
 * Transport + lookup only: this module fetches the CRM earn/burn catalog and
 * answers "what does this item earn, and what would it cost in points". It owns
 * no DOM and no state machine — checkout.js decides what to paint.
 *
 * Read-only by design for now. Redemption is a wallet deduction scoped to a cart
 * line (the points ledger IS `wallet.available`, which /client/applyWallet
 * already spends), and it needs a per-line column on addo_order_items before it
 * can be recorded. Until that lands the cart shows the figures and nothing here
 * writes anything.
 *
 * A new file rather than exports bolted onto an existing module: base.php
 * cache-busts only the ENTRY module, nginx serves /src/js with a 30-day
 * max-age, and a consumer that imports a name a cached copy doesn't export
 * throws and takes the whole payment screen down. A path nginx has never served
 * cannot be a stale hit. Keep the exports below stable for the same reason.
 */
import { getConfig, getCrmBase } from './config.js';

/**
 * Fetch the outlet's earn/burn catalog.
 *
 * Identical call to the menu's — the endpoint is scoped by parent + outlet, not
 * by page, so the cart reuses it as-is. Sending the customer pair switches the
 * response from guest pricing (lowest active tier) to this customer's own tier
 * and returns their live balance.
 *
 * Silent on every failure path: the endpoint 400s for a brand with the flag off
 * and on any internal error, and a cart that can't price its points figures must
 * still be a working cart.
 *
 * @returns {Promise<{mode:string, items:Map<string,object>, walletBalance:number|null,
 *                    allocationPct:number, blockedReason:string|null} | null>}
 */
export async function fetchBurnCatalog({ parentId, businessId, user } = {}) {
    const cfg  = getConfig();
    const base = String(cfg.loyaltyBase || getCrmBase() || '');
    const tok  = String(cfg.loyaltyAuthToken || '');
    if (!base || !tok || !parentId) return null;

    const body = { parent_id: Number(parentId) || parentId, business_id: Number(businessId) || businessId };
    // Both halves of the pair or neither — one alone leaves the endpoint in guest
    // mode anyway and just puts the token on the wire for nothing.
    if (user && user.contactMappingId && user.token) {
        body.contactMappingId = user.contactMappingId;
        body.token = user.token;
    }

    let payload = null;
    try {
        const res = await fetch(`${base}/crm_api/loyalty/item_wise/earn_burn_catalog`, {
            method: 'POST',
            // `token`, not `authorization`: this route's middleware differs from the
            // rest of crm_api, which is why the CRM auth token 401s here.
            headers: { 'Content-Type': 'application/json', token: tok },
            body: JSON.stringify(body),
        });
        if (res.ok) payload = await res.json();
    } catch { /* cart must survive a dead catalog */ }

    const result = payload && payload.status === true ? payload.result : null;
    if (!result || !Array.isArray(result.items) || !result.items.length) return null;

    const items = new Map();
    result.items.forEach(row => { if (row && row.item_slug) items.set(String(row.item_slug), row); });

    return {
        mode: String(result.mode || 'guest'),
        items,
        walletBalance: result.wallet_balance == null ? null : Math.floor(+result.wallet_balance || 0),
        allocationPct: parseFloat(result.allocation_pct || 0) || 0,
        // An order-level block (no active tier, no allocation) zeroes every item —
        // callers should show nothing rather than a cart full of "0 pts".
        blockedReason: result.earn_blocked_reason || null,
    };
}

// What a brand calls its points, for use directly after a numeral: "195 Hearts",
// "195 GIPL Coins". From wallet_rules.walletName, which reaches the browser as
// OutletConfig.walletName on the menu, CheckoutConfig.wallet_name at checkout and
// LoyaltyConfig.walletName on /loyalty — hence the three reads rather than one
// config object.
//
// Defaults to "pts", and falls back to it for "Points"/"Wallet" too: the model
// layer already substitutes those when the column is empty, so an unnamed brand
// would otherwise print a long form everywhere it used to print the short one.
//
// NOT exported, and copied rather than imported by menu.js / checkout.js /
// loyalty.js on purpose. Nested imports carry no version query and nginx caches
// /src/js for 30 days, so a consumer that imports a name an already-cached copy
// of this file doesn't export throws and takes the page down. Six lines in four
// files beats that risk; see the header note on keeping these exports stable.
function pointsUnit() {
    const w = window;
    const raw = String(w.OutletConfig?.walletName
                    || w.CheckoutConfig?.pts_unit || w.CheckoutConfig?.wallet_name
                    || w.LoyaltyConfig?.walletName || '').trim();
    return (!raw || /^(points?|wallet)$/i.test(raw)) ? 'pts' : raw;
}

/**
 * The catalog row for an item slug, or null when it has none.
 *
 * `earn_multiplier: null` means the item carries no rule at all — a different
 * state from a configured 0% rate, and one that must render no figure anywhere.
 */
export function burnRowFor(catalog, slug) {
    if (!catalog || !slug) return null;
    const row = catalog.items.get(String(slug));
    if (!row || row.earn_multiplier == null) return null;
    return row;
}

/** Points this line earns: the per-unit figure times the quantity ordered. */
export function earnPointsForLine(row, qty) {
    const per = Math.floor(+(row && row.earn_point) || 0);
    if (per <= 0) return 0;
    return per * (Math.max(1, Number(qty) || 1));
}

/** Points that would make one unit of this line free, or 0 when it can't be redeemed. */
export function redeemPointsForLine(row) {
    if (!row || !row.is_redeemable) return 0;
    return Math.floor(+row.redeem_at_point || 0);
}

// The strip markup. Single source for both surfaces: the menu renders it on item
// cards and in the item sheet, the checkout on cart rows and recommendation cards.
// Two halves of the same loyalty story — what the item costs in points today, and
// what buying it earns. Either half stands alone (the "OR" divider only renders
// when both do); nothing at all when the item is unconfigured or configured at a
// zero rate, which says nothing a customer can act on.
// The brand's coin illustration, served as a FILE rather than inlined. It is a
// five-path two-colour drawing (~8KB); the menu paints this strip on every card,
// so inlining it would put megabytes of identical markup in the DOM for one
// picture the browser can cache once. Root-relative: every tenant serves the app
// from the domain root, and these modules have no base_url() to call.
// Fixed colours by design — it is artwork, not a glyph, so nothing tints it the
// way the old stroked ring was tinted.
const COIN_ICON  = '<img class="pts-coin earn-strip__coin" src="/assets/img/loyalty-coin.svg" width="16" height="16" alt="" aria-hidden="true">';
// The earn mark, same deal as the coin above: brand-supplied artwork served as a
// file, carrying its own colours, so nothing tints it.
const HEART_ICON = '<img class="pts-heart" src="/assets/img/loyalty-heart.svg" width="16" height="16" alt="" aria-hidden="true">';
// The claim band's mark. Same heart artwork, drawn larger and in place of the
// coin: on the one band that says "this item is free" the picture is the whole
// headline, not a bullet in front of a figure. It keeps the .earn-strip__coin
// class so every surface that sizes the leading mark keeps sizing it.
const CLAIM_ICON = '<img class="pts-heart earn-strip__coin" src="/assets/img/loyalty-heart.svg" width="24" height="24" alt="" aria-hidden="true">';

// `plain` opts a surface out of the claim treatment entirely: both halves always,
// and none of the highlight. Browse surfaces (menu cards, rec cards) take the claim
// treatment — on a claimable item the claim is plainly the better deal and the
// alternative only argues against it. A CHECKOUT CART ROW does not: it's a compact
// pill in the price column, it's where the customer actually chooses, and the points
// forfeited by redeeming are half of that choice. It keeps the look it has always had.
// `redeemLabel` lets a surface name the action in its own words, overriding both
// defaults below. The cart row says "Redeem" — the customer is already holding the
// item, so a label promising to make it free describes a thing that has happened.
export function burnStripHTML(row, { qty = 1, balance = null, plain = false, redeemLabel = null } = {}) {
    if (!row) return '';
    const earnPts   = earnPointsForLine(row, qty);
    const redeemPts = redeemPointsForLine(row);
    if (earnPts <= 0 && redeemPts <= 0) return '';

    // Can this customer claim it TODAY? That, not the item's price, is what makes
    // the claim half the whole story: with 2,619 points every item priced at or
    // under 2,619 is something they can walk away with now, and offering "or earn
    // 14 back by paying full price" alongside argues against the better deal.
    //
    // The catalog sets `affordable` itself in customer mode. `balance` is the
    // caller's own copy of the figure, used when the field is absent — guest
    // responses carry no balance at all, so nothing is claimable and every item
    // keeps both halves, which is correct: there are no points to spend yet.
    // The catalog's own verdict WINS when it gives one, including a `false`: it can
    // know things the raw figure can't (a hold on the balance, an expiry, a tier
    // rule). The balance is consulted only when the field is absent altogether.
    const bal = balance == null ? null : Math.max(0, Math.floor(Number(balance) || 0));
    const affordableByBalance = bal !== null && bal > 0 && redeemPts <= bal;
    const claimable = !plain && redeemPts > 0
        && (typeof row.affordable === 'boolean' ? row.affordable : affordableByBalance);

    // The two bands say different things because they ARE different things. On the
    // amber claim band the figure is a price the balance already covers, so the
    // label states the outcome and when: "Free Now for 650 Hearts". On the tinted
    // band it's a target the balance hasn't reached, and "Get free for" read as an
    // offer on both — the same words under a number the customer can't spend yet.
    // "Unlock at" names it as the threshold it is.
    //
    // CLAIM-LABEL — the claim wording is duplicated in loyalty.js (railCardHTML,
    // the .er-card__lbl span). Grep that tag before rewording: the rail card's
    // claim foot is styled to be pixel-identical to .earn-strip--redeem-only, so
    // the two surfaces must read identically.
    //
    // They cannot share a constant. The loyalty page loads loyalty.js as a CLASSIC
    // script (see the note beside cartAdd.js in pages/loyalty.php) so it cannot
    // import, and THIS module is not on that page at all — only menu and checkout
    // pull it in — so there is no global for it to read either. Exporting a label
    // from here would reach neither.
    const label = redeemLabel || (claimable ? 'Free Now for' : 'Unlock at');

    // The wording is a separate element so narrow cards can drop it and keep just
    // icon + number (see .earn-strip__label).
    const redeem = redeemPts > 0
        ? `<span class="earn-strip__half earn-strip__redeem">${claimable ? CLAIM_ICON : COIN_ICON}<span class="earn-strip__label">${label}</span><b>${redeemPts} ${pointsUnit()}</b></span>`
        : '';
    const earn = (earnPts > 0 && !claimable)
        ? `<span class="earn-strip__half earn-strip__earn"><span class="earn-strip__label">Earn</span><b>+${earnPts}</b>${HEART_ICON}</span>`
        : '';
    const or = (redeem && earn) ? '<span class="earn-strip__or">OR</span>' : '';
    // Signed-in and the balance already covers this one — the redeem half stops
    // being aspirational, so the strip says so.
    const afford = row.affordable === true ? ' earn-strip--affordable' : '';
    const single = (redeem && earn) ? '' : ' earn-strip--single';
    const claim  = claimable ? ' earn-strip--redeem-only' : '';
    return `<div class="earn-strip${single}${afford}${claim}">${redeem}${or}${earn}</div>`;
}

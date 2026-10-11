/**
 * Checkout module — cart display, bill API, address/slot/car/table flows, payment.
 * Calls /client/cart for server-computed totals (delivery charges, GST, packaging, etc.)
 */
// getConfig / getCrmBase are long-standing exports of config.js — safe to import.
// Never add a NEW export there and consume it in the same deploy: config.js is
// imported unversioned and nginx caches /src/js for 30 days.
import { apiCall, getApiBase, getMenuFeedBase, getCdnBase, getConfig, getCrmBase } from './config.js';
import { fetchMenuMemberPricing, getMembershipDiscountForItem } from './membershipPricing.js';
import { createAddressForm } from './addressForm.js';
import { requestGeolocation } from './geo.js?v=20260923a';
import { openRazorpayCheckout } from './payment.js?v=20260615c';
import { trackBeginCheckout, trackAddShippingInfo, trackAddPaymentInfo, trackCouponStatus } from './analytics.js?v=20260829';
// Pinned version: a new module today, but the import must keep resolving against a
// 30-day nginx cache when this file is next cache-busted. Bump on every edit to it.
import { fetchBurnCatalog, burnRowFor, earnPointsForLine, redeemPointsForLine, burnStripHTML } from './loyaltyBurn.js?v=20261008a';

// ─── v4_cart helpers (same storage as menu.js) ────────────────
// menu.js writes to localStorage key 'v4_cart' with items having .id field.
// We normalize to .itemId so the rest of checkout can use a consistent name.
function getV4Cart() {
    try {
        const s = localStorage.getItem('v4_cart');
        if (!s) return { items: [] };
        const p = JSON.parse(s);
        return { ...p, items: (p.items || []).map(i => ({ ...i, itemId: String(i.itemId || i.id) })) };
    } catch { return { items: [] }; }
}

function saveV4Cart(cart) {
    cart.total = (cart.items || []).reduce((s, i) => s + i.price * i.qty, 0);
    localStorage.setItem('v4_cart', JSON.stringify(cart));
    // Keep the v2 header's cart badge in step — a same-tab setItem fires no
    // `storage` event, so it cannot see this on its own. No-op on v1 brands.
    if (typeof window.hdr2RefreshHeader === 'function') window.hdr2RefreshHeader();
}

// Write each /client/cart line's effective price back to the matching v4_cart entry. Server's
// checkMaxPriceWidget zeroes the BOGO parent's subTotal correctly (= MAX variant price), but
// the per-row subTotal on the variant orderItems comes back at their original price. We must
// skip those variants when summing addons, otherwise the line's effective price double-counts.
// Identify variants by matching server subItem.itemId → local entry.subItem with sp=0 or step.
function syncLocalPricesFromServer(lines) {
    let cart;
    try { cart = JSON.parse(localStorage.getItem('v4_cart') || ''); } catch { return; }
    if (!cart || !Array.isArray(cart.items)) return;
    const byItemId = new Map();
    (lines || []).forEach(li => { if (li && li.itemId != null) byItemId.set(String(li.itemId), li); });
    let dirty = false;
    cart.items.forEach(it => {
        const li = byItemId.get(String(it.id)) || byItemId.get(String(it.parentId || it.id));
        if (!li) return;
        const baseSub = Number(li.subTotal);
        if (!Number.isFinite(baseSub) || baseSub < 0) return;
        const subsArr = Array.isArray(li.subItems)
            ? li.subItems
            : (li.subItems && typeof li.subItems === 'object' ? Object.values(li.subItems) : []);
        // BOGO bookkeeping: build a set of itemIds the LOCAL cart marks as variants
        // (sp === 0 OR has a `step` field). Server returns these at full subTotal but
        // they're already represented by parent line.subTotal — must exclude from sum.
        const isBogo = Number(li.viewType) === 3 || Number(it.viewType) === 3;
        const variantIds = new Set();
        if (isBogo && Array.isArray(it.subItems)) {
            it.subItems.forEach(s => {
                if (!s) return;
                if (Number(s.sp) === 0 || s.step !== undefined) variantIds.add(String(s.itemId));
            });
        }
        const addonsSub = subsArr.reduce((s, c) => {
            if (!c) return s;
            if (variantIds.has(String(c.itemId))) return s; // skip BOGO variants
            const v = Number(c.subTotal);
            return Number.isFinite(v) && v > 0 ? s + v : s;
        }, 0);
        // v4_cart.price is PER-UNIT (menu.js sums price × qty). For a variant/addon line the
        // server's subTotal is already per-unit, so base + addons stands. For a SIMPLE line the
        // server bakes qty into subTotal (matching renderCartLineHTML, which does NOT × qty for
        // no-subItem lines, and menu.js reconcileCartFromServer, which divides it back out) —
        // divide back to per-unit here too, else returning to the menu multiplies by qty a
        // second time and doubles the line total.
        const qty = Number(li.qty) || Number(it.qty) || 1;
        let effective = subsArr.length ? baseSub + addonsSub : (qty > 0 ? baseSub / qty : baseSub);
        // All-inclusive brand (aiFlag=1): the server subTotals are NET of tax. Gross the reconciled
        // net (which already reflects BOGO-zeroing + addons) up to the tax-inclusive figure using the
        // per-item factor menu.js stamped on the v4_cart entry (incF). Without it we can't know the
        // item's tax rate here, so skip this line rather than write the de-taxed net — the inclusive
        // price menu.js stored stays put (and menu.js re-syncs authoritatively on return).
        if (Number(cfg.aiFlag) === 1) {
            const f = Number(it.incF) || 0;
            if (f > 1) effective = Math.round(effective * f * 100) / 100;
            else return;
        }
        if (Number(it.price) !== effective) { it.price = effective; dirty = true; }
    });
    if (dirty) {
        cart.total = cart.items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
        localStorage.setItem('v4_cart', JSON.stringify(cart));
    }
}

// Customization signature for a local v4_cart line, comparable across the local (menu.js)
// and server subItem shapes — both carry itemId + itemName. Mirrors menu.js subItemsSig
// closely enough to tell two variants of the same item apart (same itemId, different chosen
// sub-items). WITHOUT this, the qty/remove helpers below key on itemId alone, so a single
// remove wipes EVERY variant of that item from the local cart — emptying it while the server
// still holds the other variant. That flips the bottom CTA to "Cart is Empty" with items
// still on screen, and corrupts the shared v4_cart so the surviving variant vanishes on the
// menu too. (sp is deliberately excluded: the server re-prices per clone, so it isn't stable.)
function v4LineSig(subItems) {
    const arr = Array.isArray(subItems)
        ? subItems
        : (subItems && typeof subItems === 'object' ? Object.values(subItems) : []);
    if (!arr.length) return '';
    return arr.map(s => `${s?.itemId ?? ''}_${s?.itemName ?? s?.name ?? ''}`).sort().join('|');
}

// Index of the single matching line by id (+ customization sig when given). Returns -1 when
// absent. A null sig matches on id alone (non-customized items / legacy callers).
function v4FindLineIndex(items, itemId, sig) {
    return (items || []).findIndex(i =>
        String(i.id) === String(itemId) && (sig == null || v4LineSig(i.subItems) === sig));
}

function v4UpdateQty(itemId, qty, sig = null) {
    try {
        const raw = localStorage.getItem('v4_cart');
        if (!raw) return;
        const p   = JSON.parse(raw);
        const idx = v4FindLineIndex(p.items, itemId, sig);
        if (idx < 0) return;
        p.items[idx].qty = qty;
        if (p.items[idx].qty <= 0) p.items.splice(idx, 1);
        saveV4Cart(p);
    } catch {}
}

function v4RemoveItem(itemId, sig = null) {
    try {
        const raw = localStorage.getItem('v4_cart');
        if (!raw) return;
        const p   = JSON.parse(raw);
        const idx = v4FindLineIndex(p.items, itemId, sig);
        if (idx < 0) return;
        p.items.splice(idx, 1);
        saveV4Cart(p);
    } catch {}
}

// Byte-for-byte the menu's subItemsSig (menu.js): v4_cart is shared with the menu
// page, so the two must agree on when two lines are the same line. Diverging here
// would let the menu merge what checkout kept apart, and lose a selection.
function v4SubSig(subItems) {
    const arr = Array.isArray(subItems) ? subItems
        : (subItems && typeof subItems === 'object' ? Object.values(subItems) : []);
    if (!arr.length) return '';
    return arr.map(s => `${s?.itemId ?? ''}_${s?.itemName ?? ''}_${Number(s?.sp ?? 0)}`).sort().join('|');
}

function v4AddItem(itemId, name, price, veg, subItems) {
    try {
        const raw = localStorage.getItem('v4_cart');
        const p   = raw ? JSON.parse(raw) : { bId: cfg.businessId, items: [], total: 0 };
        // Two lines of the same item with DIFFERENT add-ons are different lines —
        // merging on id alone would bump the qty of someone else's customisation.
        // Same signature the menu uses to decide that (menu.js subItemsSig).
        const sig = v4SubSig(subItems);
        const existing = (p.items || []).find(i => String(i.id) === String(itemId)
                                                && v4SubSig(i.subItems) === sig);
        if (existing) { existing.qty++; }
        else {
            // Cloud kitchen: stamp current brand so the new item groups under the
            // active brand section instead of creating a stray "Items" group.
            let brandId = '', brandName = '', brandLogo = '';
            if (cfg.isCloud) {
                try { brandId = sessionStorage.getItem('cloud_brand_id_' + cfg.businessId) || ''; } catch {}
                if (brandId) {
                    const peer = (p.items || []).find(i => String(i.brandId || '') === brandId);
                    brandName = peer?.brandName || '';
                    brandLogo = peer?.brandLogo || '';
                }
            }
            const entry = {
                id: String(itemId), parentId: String(itemId), name,
                price: +price || 0, qty: 1, veg: veg || '',
                brandId, brandName, brandLogo,
            };
            if (subItems && subItems.length) entry.subItems = subItems;
            p.items.push(entry);
        }
        saveV4Cart(p);
    } catch {}
}

// Undo exactly one v4AddItem: the line it merged into gives back the unit it
// gained, and a line it created goes away. Matched the way v4AddItem matched
// (id + add-on signature), so a second, differently customised line of the same
// item is left where it is.
function v4UndoAdd(itemId, subItems) {
    try {
        const raw = localStorage.getItem('v4_cart');
        if (!raw) return;
        const p   = JSON.parse(raw);
        const sig = v4SubSig(subItems);
        const idx = (p.items || []).findIndex(i => String(i.id) === String(itemId)
                                                && v4SubSig(i.subItems) === sig);
        if (idx < 0) return;
        p.items[idx].qty = (p.items[idx].qty || 1) - 1;
        if (p.items[idx].qty <= 0) p.items.splice(idx, 1);
        saveV4Cart(p);
    } catch {}
}

const cfg = window.CheckoutConfig || {};

// ─── State ────────────────────────────────────────────────────
const state = {
    order: null,
    lastPaymentMethod: null, // { name, logo, vpa } when the user has a re-usable last UPI method (fast checkout)
    lines: [],       // orderItemDetails from last cart API call
    selectedAddressId: null,
    selectedAddressText: '',
    selectedAddressLat: '',   // coords of the selected delivery address — drive the cart's
    selectedAddressLng: '',   // serviceability/tax calc, NOT the stale home userLat/userLng
    selectedAddressDeliverable: true, // false when server says deliveryAvailable==0 for the selected address
    serverAddrHydrated: false, // server cart hydrates the address exactly once (cold load); later recalcs must not re-adopt a deleted/stale deliveryAddressId
    selectedSlot: null,      // slot ID (0 = deliver now)
    selectedSlotDate: '',
    selectedSlotStartH: 0,   // slot start hour (float, e.g. 12.5) — used to build the selected_slot ISO datetime
    selectedSlotEndH: 0,     // slot window end hour (float) — used to detect a slot whose window has fully elapsed
    slotExpired: false,      // a previously-chosen later-slot elapsed → force a fresh pick, don't silently default to Deliver Now
    selectedSlotText: '',
    carNumber: '',
    // In-car ONLY: the customer's live GPS fix (CI3 window.realLat/realLng). Checked by the
    // server against the outlet's inCarRadius, so it must be where the CAR is, never the
    // saved delivery address in userLat/userLng. Not persisted — a stored fix goes stale the
    // moment the customer drives anywhere.
    carLat: '',
    carLng: '',
    selectedTableId: null,    // table chosen via modal (numeric id returned by API, or null)
    selectedTableName: '',    // display name for the selected table (persisted across refresh)
    tableSkipped: false,      // user clicked "Continue without table number"
    walletApplied: false,
    burnCatalog: null,       // item-wise loyalty figures (loyaltyBurn.js), null until fetched
    grandSavingsAmount: 0,   // set by renderBillFull, read by renderPointsStrip — see there
    appliedPromo: '',
    giftDetails: null,
    promos: [],
    suggs: [],
    validation: null,        // rows.validation from cart API ({status, msg}) — CI3 contract
    // Dine-in running order (open tab). The server swaps rows.orderItemDetails for
    // rows.orderItemDetails_running once the tab is open, so these two are set together:
    //   isRunningOrder — the response came back in the _running shape
    //   alreadyAdded   — items_already_added: KOT groups already sent to the kitchen (server-only)
    // state.lines then holds items_added (the still-editable new items).
    isRunningOrder: false,
    alreadyAdded: [],
    // Maps local parentId → server orderItemId (from orderItemDetails response)
    serverItemIds: {},
};

// Analytics: normalize server order lines + grand total for begin_checkout / payment / purchase events.
function analyticsItems() {
    return (state.lines || []).map(li => ({
        id:       li.itemId,
        name:     li.itemName,
        qty:      Number(li.qty || 1),
        price:    Number(li.subTotal || 0),
        category: li.sectionName || '',
        veg:      li.vegNonvegBoth || '',
    }));
}
function analyticsTotal() { return Number(state.order?.totalAmt || 0); }

// ─── Init ─────────────────────────────────────────────────────

// Measure the brand header height so the sticky mobile co-header can dock flush
// against its bottom edge. Stored on <html> as --site-header-h for CSS to read.
function syncHeaderHeight() {
    const h = document.querySelector('.site-header');
    if (!h) return;
    const px = Math.round(h.getBoundingClientRect().height);
    if (px > 0) document.documentElement.style.setProperty('--site-header-h', px + 'px');
}

// Pre-booking checkout (/checkout/…?cart_type=3&eventId=…): return the user to the
// EVENT detail page (not the outlet menu) for back / add-more / empty-cart. Empty when
// not a pre-booking checkout. eventId alone drives the detail page (slug is cosmetic).
function prebookingReturnUrl() {
    const q = new URLSearchParams(location.search);
    const ev = q.get('eventId');
    return (q.get('cart_type') === '3' && ev) ? '/pre-bookings/event?id=' + encodeURIComponent(ev) : '';
}

// Pre-booking checkout gate: cart_type is exactly '3' (the pre-booking bucket) AND
// an eventId is present. Reused wherever a checkout section (recs, wallet, promos)
// must not show for a pre-booking cart.
function isPrebookingCheckout() {
    const q = new URLSearchParams(location.search);
    return q.get('cart_type') === '3' && !!q.get('eventId');
}

export async function init() {
    if (!document.querySelector('[data-page="checkout"]')) return;
    syncHeaderHeight();
    window.addEventListener('resize', syncHeaderHeight, { passive: true });
    // Pre-booking: point back / add-more / empty-state links at the event detail page.
    const _pbUrl = prebookingReturnUrl();
    if (_pbUrl) {
        ['.co-back', '#addMoreItemsLink', '#orderNowLink'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (a) { a.setAttribute('href', _pbUrl); });
        });
    }
    // Slot restore runs FIRST: restoreAddressSelection paints the address ETA chip, which
    // suppresses the now-ETA when a scheduled slot is active. Restoring the address first
    // would flash "Home in 45 mins" until the cart response re-rendered the chip.
    restoreSlotSelection();
    restoreAddressSelection();
    restoreTableSelection();
    restoreCarSelection();
    setupOrderType();
    buildOtsMenus();
    bindEvents();
    setupOutletNameMarquee();
    setupBannerPlacement('savingsSection');
    // Cart items render ONLY from the /client/cart response — never from localStorage.
    // If the API rejects the cart (status=0) or fails outright, the empty state shows.
    // This prevents a stale local snapshot from being payable when the server has
    // already invalidated it. loadCartSummary calls renderCartItems on every outcome.
    const feedPromise = loadFeedMap();
    // Member-pricing runs in parallel; it repaints the rail itself once it lands.
    loadMemberPricing();
    // Points figures need the feed (it carries the slug that joins a cart line to the
    // loyalty catalog), so this waits on it rather than racing the cart. Repaints itself.
    feedPromise.then(() => loadBurnCatalog());
    // In-car needs the live fix BEFORE the first cart call: the server rejects a coordless
    // in-car cart, so locating afterwards costs a wasted round trip and a flash of the empty
    // cart. No-op, and no await cost, for every other order type.
    await ensureInCarLocation();
    await loadCartSummary();
    // Cart viewed — fired HERE, once, rather than inside loadCartSummary(), which re-runs on
    // every promo / qty / address change and would emit a dozen times per session.
    // Note this is the checkout page: /cart is a 27-line redirect and cart.js is dead code,
    // so checkout IS the cart-review screen on this platform.
    if (state.lines?.length) {
        window.Analytics?.trackCartViewed?.({ value: analyticsTotal(), items: analyticsItems() });
    }
    // CI3 parity: capture location on checkout load for any order type — but only silently
    // when permission was already granted; never force a popup. See ensureCheckoutLocation().
    ensureCheckoutLocation();
    // Re-render recs once feed resolves (ensures MRP, OOS filter, and images are correct)
    feedPromise.then(() => {
        if (state.suggs.length) renderRecommendations(state.suggs, state.lines);
    });
    // Validate the restored address against the server's saved-address list on load.
    // We restore the selected address from localStorage (restoreAddressSelection) for an
    // instant render, but that key is NOT cleared when the address is deleted elsewhere
    // (e.g. Profile → Manage Addresses), so a deleted address would otherwise keep showing
    // here until the modal is opened. loadAddresses() reconciles it: a still-valid address
    // with matching persisted coords is a no-op (no extra /client/cart — the coord guard at
    // L2372 only reloads on a real mismatch); a deleted/empty one is cleared and the bill
    // recomputed. The one-shot serverAddrHydrated flag stops applyCartResp from re-adopting
    // the stale server-cart deliveryAddressId during that recompute.
    if (state.selectedAddressId) loadAddresses();
}

// ─── Helpers ──────────────────────────────────────────────────

// CI3 parity — no thousand separators. Whole numbers render plain (₹2550); decimals keep 2dp (₹75.75).
const fmt    = (n) => '₹' + (Number(n) || 0).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 2 });
const fmtDec = (n) => (Number(n) || 0).toFixed(2);

// Points, grouped — a four-figure balance reads as a quantity, not a price, so it
// gets separators where fmt() deliberately drops them for rupee amounts.
//
// This was called in 17 places before it was ever defined. Every call sat behind
// the points-balance strip, whose markup was missing, so renderPointsBalance hit
// its `if (!stripEl) return` and no call was ever reached. Adding the markup made
// the path live and the missing helper surfaced as a ReferenceError on checkout.
const pts    = (n) => (Math.floor(Number(n)) || 0).toLocaleString('en-IN');
// What this brand calls its points ("Hearts", "GIPL Coins"), for use straight after
// a numeral. Copied rather than imported from loyaltyBurn.js — a nested import
// carries no version query against a 30-day cache, so importing a newly added name
// is how a stale child kills the page.
const ptsUnit = () => {
    const raw = String(window.CheckoutConfig?.pts_unit
                    || window.CheckoutConfig?.wallet_name || '').trim();
    return (!raw || /^(points?|wallet)$/i.test(raw)) ? 'pts' : raw;
};
/** `195 Hearts` / `195 pts` — a figure and its unit, already formatted. */
const ptsU = (n) => `${pts(n)} ${ptsUnit()}`;

function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
}

function el(id)      { return document.getElementById(id); }
// Mirror selected display strings into their mobile-header chip counterparts so
// the mobile chip stays in sync without every call site needing to touch both.
const MOBILE_MIRRORS = {
    selectedAddressDisplay:  'selectedAddressMobile',
    selectedCarNumberDisplay:'selectedCarMobile',
    tableNoDisplay:          'selectedTableMobile',
};
function set(id, v)  { const e = el(id); if (e) e.textContent = v; const mid = MOBILE_MIRRORS[id]; if (mid) { const m = el(mid); if (m) m.textContent = v; } }

// Marquee the mobile-header outlet name only when it overflows its container.
function setupOutletNameMarquee() {
    const title = document.querySelector('.co-header--mobile .co-header__title');
    const inner = title?.querySelector('.co-header__title-text');
    if (!title || !inner) return;
    const check = () => { title.classList.toggle('is-marquee', inner.scrollWidth > title.clientWidth + 1); };
    check();
    window.addEventListener('resize', check, { passive: true });
}

// Savings banner ("You are saving ₹X") lives in the bill body on desktop, but on
// mobile (<768px) the pay CTA is a fixed bottom bar — so the banner would scroll
// away from it. Relocate the banner into the sticky pay bar on mobile so it stays
// pinned directly above the button; move it back into the body on larger screens.
// Relocates a .co-savings-banner-shaped element between its body position and
// the pay footer on mobile — shared by the savings banner and the earn-only
// banner below it, so both land directly over the Pay button once the screen
// narrows rather than sitting mid-scroll where a CTA-adjacent message reads
// as decoration.
function setupBannerPlacement(id) {
    const banner = el(id);
    const payBar = el('payBtns');
    if (!banner || !payBar) return;
    const home = banner.parentElement;           // original body location
    const anchor = banner.nextElementSibling;    // restore exact body position
    const mq = window.matchMedia('(max-width: 767px)');
    const place = () => {
        if (mq.matches) {
            if (banner.parentElement !== payBar) payBar.prepend(banner);
        } else if (banner.parentElement !== home) {
            home.insertBefore(banner, anchor);
        }
    };
    place();
    mq.addEventListener('change', place);
}
function show(id)    { const e = el(id); if (e) e.hidden = false; }
function hide(id)    { const e = el(id); if (e) e.hidden = true; }

// ─── Bill recalculation loader ────────────────────────────────
// Every bill recalc (qty change, promo apply/remove, wallet toggle, suggestion
// adds, slot/address changes, initial load) runs through callCartApi, which
// toggles this flag. While it's set, CSS lays a global shimmer overlay across the
// whole checkout page (body.co-cart-updating) — one clear "updating" signal that
// also blocks interaction so the user can't act on stale totals or race the
// server. Counter-based so overlapping/nested calls (e.g. loadCartSummary's
// auto-heal double-fetch) don't clear it early.
let _billUpdateInflight = 0;
function setBillUpdating(on) {
    _billUpdateInflight = Math.max(0, _billUpdateInflight + (on ? 1 : -1));
    document.body.classList.toggle('co-cart-updating', _billUpdateInflight > 0);
}

// Qty-stepper serialization gate. A single stepper mutation (optimistic edit →
// server delete/update → reconcile) must fully settle before the next click is
// processed. Without this, rapid clicks on a high-qty line race: the local
// v4_cart drains to 0 while a lagging server response repopulates state.lines,
// leaving the row visible but the CTA flipped to "Cart is Empty" (the two cart
// mirrors disagree). See handleCartQtyClick.
let _qtyMutationInflight = false;

// Returns CSS modifier + aria-label for a veg/non-veg/egg item, plus `known`.
// Accepts: item.veg string ('veg','non-veg','egg'), item.vegNonvegBoth string, or item.is_veg number (1=veg,0=non-veg,2=egg).
// `known: false` means the item carries NO diet value — wrapper rows like a BOGO deal
// always do. Those get no marker at all (see vegMarkerHTML): the old default rendered
// the plain green dot, which claimed "veg" for items the merchant never marked.
// Canonicalises the vegnonvegboth/veg string field to 'veg' | 'non-veg' | 'egg',
// or '' when the merchant never marked it. Server rows carry the column raw, so the
// dirty DB spellings ('Non_Veg', 'nonveg', 'non veg') and that column's numeric
// encoding ('2'/'0' non-veg, '3' egg, '1' veg) all arrive here — the same set
// pastOrders.js normalises, kept in step so a cart line and the order-history line
// for the identical item can never disagree.
//
// NOT to be confused with `is_veg` below, a DIFFERENT field whose numbers mean
// something else entirely (1 veg, 0 non-veg, 2 egg); that branch is left alone.
function normDiet(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    if (t === 'veg' || t === '1') return 'veg';
    if (t === 'egg' || t === '3') return 'egg';
    if (t === 'non-veg' || t === 'non_veg' || t === 'nonveg' || t === 'non veg'
        || t === '2' || t === '0') return 'non-veg';
    return '';
}

function vegInfo(item) {
    // Lowercased/trimmed once here so EVERY caller is case-safe — cart rows, sub-rows,
    // the KOT list and the "Craving more?" cards all reach the marker through this, and
    // a feed that sends "Veg" must not fall through to "unknown" and drop the dot.
    const v = normDiet(item?.veg || item?.vegNonvegBoth || '');
    if (v === 'egg')     return { cls: ' veg-marker--egg',    label: 'Egg',     known: true };
    if (v === 'non-veg') return { cls: ' veg-marker--nonveg', label: 'Non-veg', known: true };
    if (v === 'veg')     return { cls: '',                     label: 'Veg',     known: true };
    // Numeric fallback from server suggestions (is_veg: 1=veg, 0=non-veg, 2=egg)
    const n = item?.is_veg;
    if (n === 2 || n === '2') return { cls: ' veg-marker--egg',    label: 'Egg',     known: true };
    if (n === 0 || n === '0') return { cls: ' veg-marker--nonveg', label: 'Non-veg', known: true };
    if (n === 1 || n === '1') return { cls: '',                     label: 'Veg',     known: true };
    return { cls: '', label: '', known: false };
}

// A veg dish customised with a non-veg add-on is not a veg line any more, so the
// marker on the PARENT row follows what was actually added to it. Promotion only
// ever moves up the severity ladder (veg → egg → non-veg) and never downgrades: a
// non-veg dish stays non-veg whatever its add-ons are. Sub-rows are untouched —
// each add-on keeps showing its own diet beneath the parent.
//
// Display only. The filters are a menu-level facet over dishes and are deliberately
// left alone, and nothing here rewrites what was stored or sent to the server.
// Deliberately a local copy rather than a shared export: nested imports under
// /src/js are unversioned and cached for 30 days, so a new cross-module export
// consumed in the same deploy breaks the page.
function promoteVegFromSubs(veg, subs) {
    const own = normDiet(veg);
    if (own === 'non-veg') return own;
    // Checkout prefers the SERVER sub-items over the local ones, and those carry the
    // column exactly as the DB holds it — so these must go through normDiet, not a bare
    // lowercase compare, or a non-veg add-on returned as '2' or 'Non_Veg' leaves the
    // parent green here while order history correctly shows it non-veg.
    const diets = (Array.isArray(subs) ? subs : []).map(s =>
        normDiet(s && (s.vegnonvegboth || s.vegNonvegBoth || s.veg)));
    if (diets.includes('non-veg')) return 'non-veg';
    if (own !== 'egg' && diets.includes('egg')) return 'egg';
    return own;
}

// The marker span for an item, or '' when its diet is unknown.
function vegMarkerHTML(item, { hidden = false } = {}) {
    const { cls, label, known } = vegInfo(item);
    if (!known) return '';
    return hidden
        ? `<span class="veg-marker${cls}" aria-hidden="true"></span>`
        : `<span class="veg-marker${cls}" role="img" aria-label="${label}"></span>`;
}

function userData() {
    try { return JSON.parse(localStorage.getItem('userdata') || 'null') || {}; }
    catch { return {}; }
}

// Welcome-form name check — mirrors firstLoginProfile.js / CI3 validateUserProfile:
// a name is "missing" when it's blank, the string "null", or the placeholder "user".
function nameMissing(name) {
    const n = String(name || '').trim().toLowerCase();
    return n === '' || n === 'null' || n === 'user';
}

// ─── Last payment method (fast checkout) ──────────────────────
// "Pay using last UPI method" — the web port of the app's handleLastPaymentFlow.
// Fetches the user's most-recent UPI VPA (client/getLastPaymentMethod), caches it
// for 15 min, and exposes state.lastPaymentMethod so updatePayCta can render the
// two-part footer (PAY USING … | Pay Securely). UPI-only — the API only ever
// returns a VPA (payment category 5). The saved VPA is charged on the payment
// screen via the existing VPA-collect path (payment_screen: upi_address → createPayment).
const LP_DATE_KEY = 'last_payment_date';
const LP_RESP_KEY = 'last_payment_response';
const LP_TTL_MS     = 15 * 60 * 1000;   // doc §4 — positive result cached 15 min
const LP_NEG_TTL_MS = 60 * 1000;        // negative result reused 60s — long enough to absorb
                                        // a burst of cart mutations (promo/qty/address/slot),
                                        // short enough that a freshly-added method still shows.

// Fast-checkout diagnostics — silent unless the brand runs with AppConfig.debug
// (same gate payment_screen.js uses). Enable in console: window.AppConfig.debug = true.
const fpDbg = (...a) => { if (typeof window !== 'undefined' && window.AppConfig?.debug) console.log('[fastpay]', ...a); };

// VPA @suffix → UPI app display name + logo. Logos already ship under
// cdn.uengage.io/payments/ (payment_screen.js references the same files).
const UPI_SUFFIX_APPS = {
    upi:         { name: 'BHIM',        logo: 'upi.png' },
    paytm:       { name: 'Paytm',       logo: 'paytm.jpg' },
    ptyes:       { name: 'Paytm',       logo: 'paytm.jpg' },
    ptaxis:      { name: 'Paytm',       logo: 'paytm.jpg' },
    okaxis:      { name: 'GPay',        logo: 'gpay_logo.png' },
    okhdfcbank:  { name: 'GPay',        logo: 'gpay_logo.png' },
    okicici:     { name: 'GPay',        logo: 'gpay_logo.png' },
    oksbi:       { name: 'GPay',        logo: 'gpay_logo.png' },
    ybl:         { name: 'PhonePe',     logo: 'phonepe.jpg' },
    ibl:         { name: 'PhonePe',     logo: 'phonepe.jpg' },
    axl:         { name: 'PhonePe',     logo: 'phonepe.jpg' },
};

// VPA @suffix → Razorpay UPI-intent app key. Used on mobile to open the app
// directly (intent) instead of sending a VPA-collect request.
const VPA_INTENT_MAP = {
    okaxis: 'gpay', okhdfcbank: 'gpay', okicici: 'gpay', oksbi: 'gpay',
    ybl: 'phonepe', ibl: 'phonepe', axl: 'phonepe',
    paytm: 'paytm', ptyes: 'paytm', ptaxis: 'paytm',
    upi: 'bhim',
};

// Parse a VPA into a display descriptor. Unknown suffixes fall back to a generic
// "UPI" label + the plain UPI mark, so a new provider still renders sensibly.
function upiAppFromVpa(vpa) {
    const suffix = String(vpa || '').split('@')[1]?.toLowerCase() || '';
    const meta   = UPI_SUFFIX_APPS[suffix];
    return {
        name: meta?.name || 'UPI',
        logo: `${getCdnBase()}/payments/${meta?.logo || 'upi.png'}`,
        vpa:  String(vpa),
    };
}

function clearLastPaymentCache() {
    try { localStorage.removeItem(LP_DATE_KEY); localStorage.removeItem(LP_RESP_KEY); } catch {}
}

// Cache-or-fetch the last payment method (doc §4 algorithm). The cached response
// is keyed to the current contactMappingId, so a different user logging in on the
// same browser never sees the previous user's VPA even before the cache expires.
async function fetchLastPaymentMethod() {
    const ud       = userData();
    const parentId = cfg.parentId || cfg.parentBusinessId || window.AppConfig?.businessId || '';
    if (!ud.token || !ud.contactMappingId || !parentId) {
        fpDbg('fetch skipped — missing', { token: !!ud.token, contactMappingId: ud.contactMappingId || null, parentId: parentId || null });
        return null;
    }

    try {
        const ts        = Number(localStorage.getItem(LP_DATE_KEY) || 0);
        const cachedRaw = localStorage.getItem(LP_RESP_KEY);
        if (ts && cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            const age    = Date.now() - ts;
            if (String(cached?._cmid || '') === String(ud.contactMappingId)) {
                // Positive result: trusted for 15 min (doc §4). Negative result: reused for
                // only 60s so a chatty cart doesn't re-hit the API on every mutation, yet a
                // freshly-added UPI method still surfaces shortly after.
                const isPositive = String(cached?.status) === '1';
                if ((isPositive && age < LP_TTL_MS) || (!isPositive && age < LP_NEG_TTL_MS)) {
                    fpDbg('using cached response (no network call)', cached);
                    return cached;
                }
            }
        }
    } catch { /* fall through to a fresh fetch */ }

    try {
        const url = `${getApiBase()}/client/getLastPaymentMethod/${encodeURIComponent(parentId)}/${encodeURIComponent(ud.contactMappingId)}`;
        fpDbg('fetching', url);
        const res = await fetch(url, {
            method:  'GET',
            headers: { 'Accept': 'application/json', 'Token': String(ud.token || '') },
        });
        const data = await res.json().catch(() => null);
        fpDbg('response', data);
        if (data && Number(data.force_logout) === 1) { clearLastPaymentCache(); return null; }
        if (data) {
            data._cmid = String(ud.contactMappingId);   // bind the cache to this user
            localStorage.setItem(LP_DATE_KEY, String(Date.now()));
            localStorage.setItem(LP_RESP_KEY, JSON.stringify(data));
        }
        return data;
    } catch { return null; }
}

// Resolve the fast-checkout method for the current cart and refresh the CTA.
// Fire-and-forget from the cart-render path; silently no-ops (leaving the standard
// Pay button) on any skip condition or failure (doc §5.2 / §11).
async function handleLastPaymentFlow(order) {
    state.lastPaymentMethod = null;

    const ud = userData();
    fpDbg('handleLastPaymentFlow', { hasOrder: !!order, token: !!ud.token, contactMappingId: ud.contactMappingId || null, wallet_as_payment_mode: order?.wallet_as_payment_mode });
    if (!ud.token || !ud.contactMappingId) return;                       // not logged in
    if (String(order?.wallet_as_payment_mode ?? '') === '1') return;     // wallet covers full payment

    const data = await fetchLastPaymentMethod();
    if (!data || String(data.status) !== '1') { fpDbg('no usable method (status != 1)', data); return; }

    const vpa = data.details?.val || '';
    if (!vpa || !vpa.includes('@')) { fpDbg('not a UPI VPA', vpa); return; }

    state.lastPaymentMethod = upiAppFromVpa(vpa);
    fpDbg('last method resolved → footer will show once pay-gates pass', state.lastPaymentMethod);
    updatePayCta(state.order);   // re-evaluate the footer now the fast option is known
}

// ─── Address persistence ──────────────────────────────────────
// Stores the last selected delivery address in localStorage so it
// survives page refreshes without needing an extra API call.

function addrStorageKey() {
    const ud = userData();
    // Saved delivery addresses are brand-scoped (getDeliveryAddress is per-contact /
    // per-parent, not per-outlet), so the selection key is parent-scoped too. This is
    // the SAME key the home-page location flow writes (location_picker.js, pId =
    // AppConfig.businessId = parent), so a pick on either screen is seen by the other.
    const brandId = cfg.parentId || cfg.businessId;
    return ud.contactId ? `co_addr_${brandId}_${ud.contactId}` : null;
}

function saveAddressSelection(id, text, name, lat, lng, deliverable = true) {
    const key = addrStorageKey();
    if (!key || !id) return;
    // Persist coords + deliverability: getDeliveryAddress is not fetched on cart load
    // (CI3 parity), so coords drive serviceability/tax, and deliverable gates Pay Securely
    // on page load before the address modal has been opened.
    // Stamp the outlet this selection was made for. The blob lives under a brand-scoped
    // key (shared with the home location bar), so without this stamp a pick on outlet A
    // leaks onto outlet B's checkout. restoreAddressSelection() refuses to adopt a blob
    // stamped for a different outlet — mirroring CI3's addressManager_lastBusinessId guard.
    try { localStorage.setItem(key, JSON.stringify({
        id: String(id), text: text || '', name: name || '',
        lat: lat ? String(lat) : '', lng: lng ? String(lng) : '',
        deliverable: deliverable !== false,
        bId: cfg.businessId ? String(cfg.businessId) : '',
    })); } catch {}
    // Keep the canonical home keys in sync so the header location info bar
    // (location_picker.js updateHeaderInfoBar) reflects an address changed here.
    // location_picker writes both co_addr_* and these keys; checkout must too,
    // otherwise the home "Your Location" bar shows the stale prior address.
    try {
        if (text) localStorage.setItem('userAddress', text);
        // `name` may be a numeric address-type id (1=Home, 2=Office, …) when it
        // comes from the server cart's `order.addressType`. The home location bar
        // (location_picker.js updateHeaderInfoBar) renders userAddressLabel verbatim,
        // so normalise to the human label here — otherwise the bar shows a bare "1".
        if (name) localStorage.setItem('userAddressLabel', addrTypeLabel(name));
        if (lat)  localStorage.setItem('userLat', String(lat));
        if (lng)  localStorage.setItem('userLng', String(lng));
    } catch {}
    // The home bar only RENDERS when an outlet is known (slug / business / locality+city) —
    // see location_picker.js updateHeaderInfoBar's hasLocation gate. A store reached WITHOUT
    // going through the home location picker (e.g. a direct /order/{slug} link) never wrote
    // those keys, so the bar stays hidden and the address just added here won't show on
    // return to home. Checkout always knows its outlet (cfg) — persist its identity so the
    // bar is visible and reflects the new address.
    try {
        if (cfg.slug)       localStorage.setItem('slug',     String(cfg.slug));
        if (cfg.businessId) localStorage.setItem('business', String(cfg.businessId));
        if (cfg.locality)   localStorage.setItem('locality', String(cfg.locality));
        if (cfg.city)       localStorage.setItem('city',     String(cfg.city));
    } catch {}
}

function restoreAddressSelection() {
    if ((cfg.orderType || 'delivery') !== 'delivery') return;
    const key = addrStorageKey();
    if (!key) return;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        // Outlet-change guard (CI3 parity): a selection stamped for a different outlet must
        // NOT carry over — outlet B should show the "Select address" CTA, not outlet A's pick.
        // Home-written blobs carry no bId, so they still adopt (intended home→checkout carry).
        if (saved?.bId && cfg.businessId && String(saved.bId) !== String(cfg.businessId)) return;
        if (saved?.id && !state.selectedAddressId) {
            state.selectedAddressId          = saved.id;
            state.selectedAddressText        = saved.text || '';
            state.selectedAddressName        = saved.name || '';
            state.selectedAddressLat         = saved.lat || '';
            state.selectedAddressLng         = saved.lng || '';
            state.selectedAddressDeliverable = saved.deliverable !== false;
            set('selectedAddressDisplay', state.selectedAddressText);
            updateDeliveryETA(state.selectedAddressName);
        }
    } catch {}
}

// True when a persisted later-slot's window has already fully elapsed — the slot's window
// END (start hour, if end unknown) is at or before now. slotDate is a local "YYYY-MM-DD";
// build the boundary in local time (matching slotSelectedIso/menu.js) so the comparison is
// wall-clock, not UTC. A stale slot must NOT stay silently selected: a user who picked
// "Today 10–11 AM" hours ago and returns after 11 AM would otherwise sail past the Pay CTA
// with an unfulfillable past window.
function slotWindowPast(slotDate, startH, endH) {
    if (!slotDate) return false;
    const [yr, mo, dy] = slotDate.split('-').map(Number);
    if (!yr || !mo || !dy) return false;
    const boundary = (Number(endH) > 0 ? Number(endH) : Number(startH) || 0);
    const h = Math.floor(boundary), m = Math.round((boundary - h) * 60);
    const end = new Date(yr, mo - 1, dy, h, m, 0);
    return !isNaN(end.getTime()) && end.getTime() <= Date.now();
}

// ─── Deliver-now cutoff (actual outlet hours − prep buffer) ──
// The cart API derives `deliver_now_option` from the outlet's ACTUAL kitchen hours
// (actual_opening/closing_hours+min) minus a 30-minute prep buffer — NOT the wider
// online-ordering window (onlineOrdersStart/EndHours) that drives cfg.outlet_open.
// Most brands leave the ordering window at 00:00–23:59, so outlet_open alone lets an
// immediate order through long after the kitchen has shut. Backend ref: api
// client.php:8755 (client/cart), CI3 wla.php:1610 — same formula, same 30 minutes.
//
// The server flag is only as fresh as the last cart sync, so a tab left open across
// the cutoff keeps a stale "Deliver Now". Re-derive the same window from the hours the
// cart response already carries and re-check it against the clock.
const PREP_BUFFER_MINS = 30;
const MINS_PER_DAY     = 1440;

// Minutes-since-midnight in the OUTLET's timezone, not the device's. Every hours column
// involved (actual_opening_hours, slot startHours) is stored in the platform's own zone
// and the backend compares it against PHP date() on the API server, so reading the
// visitor's local clock would disagree with the server for anyone outside that zone —
// an NRI ordering for family in India would see Deliver Now vanish for the whole
// session. cfg.timezone comes from App::$appTimezone. Falls back to the device clock
// only if Intl rejects the zone, which would mean the config itself is wrong.
let _tzFmt = null, _tzFmtZone = '';
function outletNowMins() {
    const zone = cfg.timezone || 'Asia/Kolkata';
    try {
        if (!_tzFmt || _tzFmtZone !== zone) {
            _tzFmt = new Intl.DateTimeFormat('en-GB', {
                timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            });
            _tzFmtZone = zone;
        }
        const [h, m] = _tzFmt.format(new Date()).split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
    } catch { /* unknown zone / no Intl — fall through */ }
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

// Wrap a minutes-of-day value back into 0–1439. Subtracting the prep buffer can push a
// boundary negative — a kitchen closing at 00:15 gives −15 — and a negative `close`
// would read as "overnight" and hold the window open until 23:59 instead of cutting off
// at 23:45. (The backend has the same edge, since strtotime('00:15 - 30 minute') rolls
// back a day; this is the one place the two deliberately disagree, in the safe
// direction. Worth fixing on the backend so they converge.)
function wrapDayMins(v) { return ((v % MINS_PER_DAY) + MINS_PER_DAY) % MINS_PER_DAY; }

function deliverNowWindowOpen(order) {
    const openH  = order?.actual_opening_hours;
    const closeH = order?.actual_closing_hours;
    // Either end missing: the backend skips this check entirely, so do we and let the
    // server flag decide. (A missing CLOSING time is the dangerous half — treating it
    // as 0 would read as "open until midnight".) Note "0" is a real hour, not blank.
    if (blankHour(openH) || blankHour(closeH)) return true;
    const open  = wrapDayMins(Number(openH)  * 60 + Number(order.actual_opening_min || 0) - PREP_BUFFER_MINS);
    const close = wrapDayMins(Number(closeH) * 60 + Number(order.actual_closing_min || 0) - PREP_BUFFER_MINS);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return true;
    const mins = outletNowMins();
    // Overnight kitchens (e.g. 18:00–02:00) wrap past midnight.
    return close < open ? (mins >= open || mins < close) : (mins >= open && mins < close);
}

function blankHour(v) { return v === null || v === undefined || String(v).trim() === ''; }

// "Deliver Now" / "Pick up Now" is orderable only when the server offers it, the brand
// quotes a real ETA, and the kitchen is still inside its prep-adjusted window.
// Order-object fallback mirrors slotsOfferedFor(): a partial object (the no-cart-data
// branch passes `{ totalAmt }`) carries no flag, so defer to the authoritative state.order
// rather than read `undefined` as "not offered".
function deliverNowAllowed(order) {
    const o = (order && order.deliver_now_option !== undefined) ? order : (state.order || {});
    return Number(o.deliver_now_option ?? 0) === 1
        && !etaIsZero(o.onlineDeliveryTime)
        && deliverNowWindowOpen(o);
}

// True when the user still owes a slot pick: nothing selected at all, or a selected
// "Deliver Now" (slot 0) that has since fallen outside the prep-adjusted window.
// Callers have already established that slots are offered for this order type.
function slotPickNeeded(order) {
    return state.selectedSlot === null
        || (Number(state.selectedSlot) === 0 && !deliverNowAllowed(order));
}

// A previously chosen "Deliver Now" that stopped being orderable while the tab sat open.
function isStaleNowSlot(order) {
    return state.selectedSlot !== null
        && Number(state.selectedSlot) === 0
        && slotsOfferedFor(cfg.orderType || 'delivery', order)
        && !deliverNowAllowed(order);
}

// Drop it and put the summary row back to unselected, so the Pay CTA gate re-fires.
function clearStaleNowSlot() {
    state.selectedSlot     = null;
    state.selectedSlotText = '';
    set((cfg.orderType || 'delivery') === 'pickup' ? 'pickupSlot' : 'deliverySlot', 'Slot not selected');
}

// One wording for the cutoff, shared by the slot modal and the Pay gate.
function nowClosedMsg() {
    const verb = (cfg.orderType || 'delivery') === 'pickup' ? 'pick-up' : 'delivery';
    return `The outlet has stopped taking immediate orders. Please choose a ${verb} time.`;
}

function restoreSlotSelection() {
    // NOTE: do NOT gate on cfg.is_slot_based. Optional-slot brands (deliver_now_option=1
    // with "Deliver Later" slots) also persist a chosen later-slot and must restore it on
    // reload — otherwise applyCartResp's deliver-now default wins and the slot is lost.
    // "Deliver Now" clears these keys, so a stored slot_id always means a real later-slot.
    try {
        const slotId    = localStorage.getItem('slot_id')    || '';
        const slotDate  = localStorage.getItem('slot_date')  || '';
        const slotLabel = localStorage.getItem('slot_label') || '';
        const slotStartH = localStorage.getItem('slot_startH') || '0';
        const slotEndH   = localStorage.getItem('slot_endH')   || '0';
        if (!slotId || !slotDate) return;
        // Drop a stale (fully-elapsed) later-slot: clear the persisted keys and leave
        // selectedSlot null so the Pay CTA gate re-fires and forces a fresh pick. Mark it
        // expired so applyCartResp does NOT silently default to "Deliver Now" — the user
        // deliberately scheduled a later slot; switching them to now-delivery is not our call.
        if (slotWindowPast(slotDate, parseFloat(slotStartH), parseFloat(slotEndH))) {
            ['slot_id','slot_date','slot_label','slot_startH','slot_endH'].forEach(k => localStorage.removeItem(k));
            state.slotExpired = true;
            return;
        }
        state.selectedSlot       = slotId;
        state.selectedSlotDate   = slotDate;
        state.selectedSlotStartH = parseFloat(slotStartH) || 0;
        state.selectedSlotEndH   = parseFloat(slotEndH) || 0;
        state.selectedSlotText   = slotLabel;
        const displayId = (cfg.orderType || 'delivery') === 'pickup' ? 'pickupSlot' : 'deliverySlot';
        set(displayId, slotLabel);
    } catch {}
}

// ─── Table persistence (sessionStorage — per browser session) ─
// Dine-in table selection should survive a page refresh but not carry
// over to a new visit, so sessionStorage is the right scope.

function tableStorageKey() { return `co_table_${cfg.businessId}`; }

function saveTableSelection(name, id) {
    try { sessionStorage.setItem(tableStorageKey(), JSON.stringify({ name: name || '', id: id || '' })); } catch {}
}

function restoreTableSelection() {
    if ((cfg.orderType || 'delivery') !== 'dine_in') return;
    if (cfg.tableId) return; // URL already carries table — no modal restore needed
    try {
        const saved = JSON.parse(sessionStorage.getItem(tableStorageKey()) || 'null');
        if (!saved) return;
        if (saved.skipped) {
            // User explicitly chose to skip — honour that across refresh
            state.tableSkipped = true;
        } else if (saved.name) {
            state.selectedTableName = saved.name;
            state.selectedTableId   = saved.id || saved.name;
            set('tableNoDisplay', saved.name);
        }
    } catch {}
}

// ─── Modals ───────────────────────────────────────────────────

function openModal(id)  { const e = el(id); if (e) e.hidden = false; }
function closeModal(id) { const e = el(id); if (e) e.hidden = true; }

// Auto-dismissing toast modals — CI3 ref:
//   #promocouponapplied — success (wallet applied, promo applied, etc.)
//   #promonotapplied    — failure
// See assets/themes/ue_default/js/checkoutPage_20251023_2.js:9402-9456
// A success message that names a saved amount (e.g. "You saved Rs.125.00")
// earns the celebratory treatment — popping disc, spark burst, hero amount.
// Plain success toasts ("Instructions saved!") stay quiet.
const _AMOUNT_RE = /(?:₹|Rs\.?\s*)\d[\d,]*(?:\.\d{1,2})?/;
// Highlight fallback for celebrate toasts only: server messages often name the benefit
// as a bare number ("You will get the cashback of 250"), which _AMOUNT_RE misses. Used
// purely to pick the hero number — never to decide the variant.
const _AMOUNT_BARE_RE = /\d[\d,]*(?:\.\d{1,2})?/;

// Success-modal icons. The glyph sits on a 64px disc with 13px padding (~38px of drawing),
// so detail-heavy shapes turn to mush — two earlier attempts failed here: a struck-through
// price tag read as a grey blob, and a ring-plus-down-arrow read as "download".
const _ICON_CHECK = '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
// Ring + cross. Same geometry as the error toast's own icon (checkout.php:923), so removal
// and "coupon not applicable" share a glyph and are told apart by the disc instead: slate
// + sink + inward ring here, red + pop there. Keep that separation intact if either is
// restyled — the glyph alone no longer distinguishes them.
const _ICON_REMOVE = '<circle cx="12" cy="12" r="10"/>'
                   + '<line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>';

// Confetti palette — brand first so every white-label site celebrates in its own colour.
const _CONFETTI_COLORS = ['var(--brand)', '#22c55e', '#fbbf24', '#3b82f6', '#ec4899'];

// Full-overlay confetti for the celebrate toast. Pure CSS animation over injected spans
// (no Lottie, no canvas): the sheet itself is only ~120px tall, so the fall needs the
// whole dimmed overlay to read as a celebration. Spread is deterministic — random
// offsets add nothing here and make the burst unreproducible when tuning.
function addToastConfetti(wrap) {
    wrap.querySelector('.co-confetti')?.remove();
    const layer = document.createElement('div');
    layer.className = 'co-confetti';
    layer.setAttribute('aria-hidden', 'true');
    let html = '';
    for (let i = 0; i < 36; i++) {
        const left  = (i * 17 + (i % 4) * 5) % 100;
        const color = _CONFETTI_COLORS[i % _CONFETTI_COLORS.length];
        const delay = ((i % 9) * 0.07).toFixed(2);
        const dur   = (1.5 + (i % 6) * 0.16).toFixed(2);
        const rot   = `${(i % 2 ? 1 : -1) * (140 + (i % 7) * 34)}deg`;
        html += `<span class="co-confetti__piece" style="left:${left}%;background:${color};`
              + `animation-delay:${delay}s;animation-duration:${dur}s;--co-rot:${rot}"></span>`;
    }
    layer.innerHTML = html;
    wrap.insertBefore(layer, wrap.firstChild);
}

// Promo copy is two tiers: a small caps eyebrow naming the code, then the benefit as the
// hero line. CI3's modal (ue_silver core_views/checkout.php:2413-2417) also carried a
// "Keep using <CODE> to save more in future" footnote — deliberately dropped, it was
// filler in a toast that auto-dismisses in ~3s. Apply and remove share the structure and
// diverge only in register, so the two moments read as a matched pair.
const _TOAST_TIERS = {
    celebrate: code => `<strong>${esc(code)}</strong> applied!`,
    removed:   code => `<strong>${esc(code)}</strong> removed`,
};

// The Savings-Corner caption is prefixed with the code ('"cbnew" applied — saving ₹250')
// because it stands alone there. In the toast the code gets its own header line, so the
// prefix would say it twice — strip it whenever a header is rendered.
const _PROMO_PREFIX_RE = /^"[^"]*"\s*applied\s*[—–-]\s*/i;

let _toastTimer = null;
function showApplyToast(kind, msg, opts = {}) {
    const id   = kind === 'success' ? 'promocouponapplied' : 'promonotapplied';
    const wrap = el(id);
    if (!wrap) return;
    const text = msg || (kind === 'success' ? 'Applied' : 'Could not apply');
    // 'failed'    = any error (coupon invalid, membership not applicable, …) → red disc + cross.
    // 'removed'   = caller-requested (any remove action) → green disc + minus + ring pulse.
    //               Explicit, so it wins over amount auto-detection (a "₹50 removed"
    //               message must not light up the savings sparks).
    // 'celebrate' = a saved amount with no explicit variant → spark burst + hero number.
    const variant   = kind === 'error' ? 'failed'
                    : opts.variant ? opts.variant
                    : _AMOUNT_RE.test(text) ? 'celebrate'
                    : null;
    const celebrate = variant === 'celebrate';
    const toast = wrap.querySelector('.co-toast');
    // Tear down the injected eyebrow BEFORE resolving the message <p> — it is a <p> too, so
    // a leftover header from a previous toast would be picked up as the message node and the
    // real message would never update.
    toast?.querySelector('.co-toast__code')?.remove();
    const p = wrap.querySelector('p');
    // The eyebrow only appears when the caller names the promo — plain toasts
    // ("Instructions saved!") have no code and stay single-line.
    const tier = opts.code ? _TOAST_TIERS[variant] : null;
    const body = tier ? String(text).replace(_PROMO_PREFIX_RE, '') : text;
    if (p) {
        // The hero class carries the promo toasts' body type; without it the shared
        // `.co-toast p` rule would also style the eyebrow.
        p.classList.toggle('co-toast__hero', celebrate || variant === 'removed');
        if (celebrate) {
            const hero = _AMOUNT_RE.test(body) ? _AMOUNT_RE : _AMOUNT_BARE_RE;
            p.innerHTML = esc(body).replace(hero, m => `<span class="co-toast__amt">${m}</span>`);
        } else {
            p.textContent = body;
        }
    }
    if (tier && toast && p) {
        const head = document.createElement('p');
        head.className = 'co-toast__code';
        head.innerHTML = tier(opts.code);
        toast.insertBefore(head, p);
    }
    // Swap the success-modal icon: cross for removed, checkmark otherwise.
    if (kind === 'success') {
        const svg = toast?.querySelector('svg');
        if (svg) svg.innerHTML = variant === 'removed' ? _ICON_REMOVE : _ICON_CHECK;
    }
    // Confetti belongs to the overlay, not the sheet — clear any leftover layer first so a
    // rapid apply → remove → apply doesn't stack three sets of falling pieces.
    wrap.querySelector('.co-confetti')?.remove();
    if (celebrate) addToastConfetti(wrap);
    if (toast) {
        // Restart the entry animations on every (re)show by clearing + reflowing.
        toast.classList.remove('co-toast--celebrate', 'co-toast--removed', 'co-toast--failed', 'co-toast--saved');
        toast.querySelector('.co-burst')?.remove();
        if (variant) {
            void toast.offsetWidth; // force reflow so the animation replays
            if (variant === 'celebrate') {
                const burst = document.createElement('div');
                burst.className = 'co-burst';
                for (let i = 0; i < 10; i++) {
                    const s = document.createElement('span');
                    s.className = 'co-spark';
                    s.style.setProperty('--a', `${i * 36}deg`);
                    burst.appendChild(s);
                }
                toast.insertBefore(burst, toast.firstChild);
            }
            toast.classList.add(`co-toast--${variant}`);
        }
    }
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    // Make sure the other one is closed if it was lingering
    closeModal(kind === 'success' ? 'promonotapplied' : 'promocouponapplied');
    openModal(id);
    // Celebrate rides a little longer — the confetti fall alone runs ~2.4s (longest
    // delay + duration) and shouldn't be cut off mid-air.
    _toastTimer = setTimeout(() => {
        closeModal(id);
        wrap.querySelector('.co-confetti')?.remove();
    }, celebrate ? 3600 : variant ? 3000 : 2500);
}

function closeAllModals() {
    document.querySelectorAll('.popup-overlay:not([hidden])').forEach(m => { m.hidden = true; });
}

// ─── Order type ───────────────────────────────────────────────

const OT_NUM   = { delivery: 1, pickup: 2, dine_in: 3, in_car: 4 };
const OT_LABEL = { delivery: 'Delivery', pickup: 'Pickup', dine_in: 'Dine-In', in_car: 'In-Car' };

function setupOrderType() {
    const ot    = cfg.orderType || 'delivery';
    const label = OT_LABEL[ot] || 'Delivery';

    // Reconcile localStorage + cookie with the URL's OT so the menu page sees the same
    // value if the user goes back. Without this, the menu's reconciliation IIFE would
    // restore the old OT and silently send it to the next /checkout navigation.
    try {
        localStorage.setItem('orderType', String(OT_NUM[ot] || 1));
        const cookieKey = ot === 'pickup' ? 'pick_up' : ot;
        document.cookie = `order_type=${cookieKey};path=/;max-age=2592000`;
    } catch {}

    // Show only the relevant detail section
    ['deliveryDetails', 'carDetails', 'pickupDetails', 'tableDetails'].forEach(id => hide(id));
    const sectionMap = { delivery: 'deliveryDetails', in_car: 'carDetails', pickup: 'pickupDetails', dine_in: 'tableDetails' };
    show(sectionMap[ot]);
    // Mobile header info chip — one chip per order type. The non-delivery chips
    // (pickup directions / car / table) sit in the same slot as the delivery
    // address chip; only the one matching the active order type is visible.
    const MOBILE_CHIPS = { delivery: 'selectAddressMobileCta', pickup: 'storeDirectionsMobileCta', in_car: 'selectCarMobileCta', dine_in: 'selectTableMobileCta' };
    Object.values(MOBILE_CHIPS).forEach(hide);
    const mobChipId = MOBILE_CHIPS[ot];
    if (mobChipId) show(mobChipId);

    // Re-sync the "<Type> in <N> Mins" chip — populates when ot==delivery & an
    // address is selected, clears otherwise. updateDeliveryETA reads cfg.orderType
    // and state.selectedAddressId itself, so a single call covers both directions.
    updateDeliveryETA(state.selectedAddressName);

    // Hide both slot rows until the cart API tells us slotsAvailable == 1.
    // CI3 ref: ue_silver/js/checkout.js updateSlotDisplay() — only shows the slot
    // group when the outlet's slotsAvailable flag is set.
    hide('slotRow');
    hide('pickupSlotRow');

    // Order type toggle labels
    set('orderTypeToggleLabel', label);
    set('orderTypeToggleLabelDesktop', label);

    // Delivery charge row is shown only for the delivery flow, and only after the user
    // has picked an address (handled in renderBillFull). There is no "Pickup Charges" concept.
    const deltext = el('deltext');
    if (deltext) deltext.textContent = 'Delivery Charges';
    if (ot !== 'delivery') hide('deliveryLi');

    // Populate pickup store address + directions link
    if (ot === 'pickup') {
        const addrParts = [cfg.bName, cfg.locality, cfg.city].filter(Boolean);
        set('storeAddress', [cfg.locality, cfg.city].filter(Boolean).join(', ') || cfg.bName || '—');
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addrParts.join(', '))}`;
        const dirEl  = el('getStoreDirections');
        if (dirEl)  dirEl.href  = mapsUrl;
        const dirMob = el('storeDirectionsMobileCta');
        if (dirMob) dirMob.href = mapsUrl;
        // Pickup tooltip (header chip): full address + Get Directions link.
        const fullAddr = [cfg.bName, cfg.address, cfg.locality, cfg.city, cfg.postal_code].filter(Boolean).join(', ');
        set('pickupTipAddr', fullAddr || addrParts.join(', '));
        const tipDir = el('pickupTipDir');
        if (tipDir) tipDir.href = mapsUrl;
    }
}

// ─── Cart rendering ───────────────────────────────────────────

// Signature for matching identical customizations across cloned cart rows.
// CI3 silver ref: checkout.js:22803-22837 hasSameCustomizations.
function customizationSignature(subItems) {
    const arr = Array.isArray(subItems) ? subItems : [];
    if (!arr.length) return '';
    // Mirror CI3 createSignature EXACTLY (ue_silver checkout.js:22851-22863): key each
    // subItem on its stable menu id (`id`/`subItemId`/`orderSubItemId`) and, only when no id
    // is present, fall back to category+name+price. The earlier port keyed on `itemId` + `sp`,
    // but for combo components those vary per server clone (each qty-increase clones a fresh
    // order_sub_item row), so two identical combos produced different signatures and never
    // merged into one qty-2 row. `id` is stable across clones, so CI3 always merged correctly.
    return arr
        .map(s => {
            const id = s?.id || s?.subItemId || s?.orderSubItemId || '';
            if (id) return `id_${id}`;
            const name = s?.itemName || s?.name || '';
            const cat  = s?.categoryName || s?.category || '';
            const price = Number(s?.sp ?? s?.price ?? 0);
            return `${cat}_${name}_${price}`;
        })
        .sort()
        .join('|');
}

// Group cloned server rows into one display entry. CI3 server clones a fresh
// addo_order_items row on every "update" qty-increase (see client.php
// updateCartRow ~L7724), so a combo with qty 3 returns three separate rows from
// /client/cart. CI3's silver client merges them back into one row before
// rendering (groupCartItems checkout.js:22844-22887); CI4 must do the same or
// the user sees duplicate rows on every + click.
function groupCartLines(lines) {
    const groups = [];
    (lines || []).forEach(li => {
        const sig = customizationSignature(li?.subItems);
        // Key on itemId + customization signature + membership_benefit_id. Identical selections
        // (incl. BOGO, once empty clones are backfilled in renderCartItems) share a signature and
        // merge; different selections carry different subItems → different signature → separate rows.
        const key = `${String(li?.itemId ?? '')}|${sig}|${String(li?.membership_benefit_id ?? '')}`;
        let entry = groups.find(g => g._key === key);
        if (!entry) {
            // Spread the first clone — `subTotal`, `mrp`, `sp`, `taxes` etc. are
            // PER-UNIT on each cloned row, and renderCartLineHTML re-multiplies by
            // qty (`qty * subTotal` for combos, `qty * mrp` for the strikethrough).
            // Summing them here would double-count. CI3 silver ref
            // (checkout.js:22844-22887 groupCartItems) only sums qty.
            entry = { ...li, qty: 0, _key: key, _groupOrderItemIds: [], _groupSubtotal: 0 };
            groups.push(entry);
        }
        entry.qty += Number(li?.qty || 1);
        // Sum each grouped clone's own subTotal — this is the group's authoritative line total
        // (it also sums, across all groups, to the bill's Item Total). Preferred over the ×qty
        // heuristic for multi-clone groups, where per-unit-vs-line-total is ambiguous once clones
        // with different qtys merge. CI3 groupCartItems sums qty only; CI4 also tracks the subtotal.
        entry._groupSubtotal += Number(li?.subTotal || 0);
        entry._groupOrderItemIds.push(li?.orderItemId);
    });
    // Buttons read data-order-item-id off the visible row → use the first orderItemId
    // in the group so the existing handler keeps working (server's update/delete on
    // any one of the group's rows clones / deletes that single row).
    groups.forEach(g => { g.orderItemId = g._groupOrderItemIds[0]; });
    return groups;
}

// Shared blocked-status test (mirrors renderCartLineHTML): CI3 uses loose `== 0`, which
// treats null/undefined as NOT blocked. Guard explicitly so combo sub-items with null
// validateStatus aren't wrongly flagged.
function isCartStatusBlocked(v) {
    return v !== null && v !== undefined && Number(v) === 0;
}

// True when a cart line is no longer valid (out of stock / not available in slot) — either
// the line itself or any of its sub-items is blocked. Used to peel these rows out into the
// grouped "no longer available" section. Keep in sync with renderCartLineHTML's isUnavailable.
function isCartLineUnavailable(li, localItem) {
    const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
    const serverSubs = toArr(li.subItems);
    const localSubs  = toArr(localItem && localItem.subItems);
    const subItems   = serverSubs.length ? serverSubs : localSubs;
    return isCartStatusBlocked(li.validateStatus) || subItems.some(s => isCartStatusBlocked(s?.validateStatus));
}

function renderCartItems() {
    const container = el('cartItemsContainer');
    if (!container) return;

    const rawLines  = state.lines;
    const flatLines = Array.isArray(rawLines)
        ? rawLines
        : (rawLines && typeof rawLines === 'object' ? Object.values(rawLines) : []);
    // Group strictly on each server line's OWN subItems (via customizationSignature) — CI3 parity
    // (groupCartItems + hasSameCustomizations). We do NOT backfill an empty line's subItems from a
    // same-itemId sibling: a same itemId can legitimately hold DIFFERENT customizations (e.g. one
    // pizza plain, another with "Onions"; or plain vs addon BOGO), so borrowing a sibling's subItems
    // would wrongly merge distinct items (plain ← customized) and show the wrong addons. Identical
    // items still merge because addToCart re-sends the FULL wire on a qty-bump, so the server keeps
    // their subItems (same signature); a no-customization item stays a distinct empty-signature row.
    const lines     = groupCartLines(flatLines);

    // Server is the source of truth. No server lines → empty state, regardless of what
    // localStorage holds. This covers: pre-API initial paint, API error, server-rejected
    // cart (status=0), and a truly empty cart. Rendering from localStorage on error would
    // let the user attempt to pay for a cart the server already invalidated.
    if (!lines.length) {
        container.innerHTML = '';
        const oosSection = el('cartUnavailableSection');
        if (oosSection) { oosSection.innerHTML = ''; oosSection.hidden = true; }
        hide('coLayout');
        show('lowerdv');
        updatePayCta(null);
        return;
    }
    show('coLayout');
    hide('lowerdv');
    show('cartSection');

    // Local index — borrows veg / parent-name fields when the server line is missing them.
    const localItems = (getV4Cart().items || []);
    const localByItemId = new Map();
    const localCountByItemId = new Map();
    localItems.forEach(it => {
        if (it && it.id != null) {
            const id = String(it.id);
            localByItemId.set(id, it);
            localCountByItemId.set(id, (localCountByItemId.get(id) || 0) + 1);
        }
    });

    // The local index is keyed by itemId, so it's AMBIGUOUS whenever the same itemId has more than
    // one local entry — i.e. the same item added with different customizations (a plain pizza + an
    // "Olives" pizza; or plain vs addon BOGO). In that case do NOT borrow a local entry as the
    // fallback: its subItems could belong to a DIFFERENT customization and would render on the wrong
    // row (e.g. a plain pizza showing "Olives" it doesn't have — priced at base, the tell). Only
    // supply the fallback when it's unambiguous (a single local entry for that itemId); otherwise
    // render strictly from the server line's own subItems.
    const localFor = li => {
        const m = localByItemId.get(String(li.itemId)) || null;
        if (m && (localCountByItemId.get(String(li.itemId)) || 0) > 1) return null;
        return m;
    };

    // Peel out lines that are no longer valid (out of stock / unavailable in slot). They render
    // in a single grouped section at the bottom with one shared "remove all" control instead of
    // a per-row trash button, so the user can clear the whole block in one tap.
    // A closed outlet is a GLOBAL state (the floating closed banner conveys it), not a per-item
    // stock problem — yet the server still stamps every line validateStatus=0 + "Outlet is
    // Currently Closed!". Don't peel those into the grouped "not in stock" block with its shared
    // remove-all control; render them as normal rows. Per-item OOS grouping only applies when
    // the outlet is open.
    const outletClosed = !cfg.outlet_open;
    const validLines  = [];
    const blockedLines = [];
    lines.forEach(li =>
        ((!outletClosed && isCartLineUnavailable(li, localFor(li))) ? blockedLines : validLines).push(li));

    // Cloud kitchen degrades a price-invalid line to a stub: the server strips itemId, itemName,
    // sp and qty, returning only validateStatus=0 + validateMsg ("This Item Price is no Longer
    // Valid"). With no id there's nothing to render a name/price from — so recover them from the
    // local cart by elimination: every local item NOT matched to a VALID server line is, by
    // definition, one of the rejected items. Map those leftovers to the stub blocked lines in
    // order. A blocked line that still has its own itemId (e.g. normal OOS) resolves normally.
    const accounted = new Set();
    validLines.forEach(li => {
        if (li.itemId   != null && li.itemId   !== '') accounted.add(String(li.itemId));
        if (li.parentId != null && li.parentId !== '') accounted.add(String(li.parentId));
    });
    const leftoverLocals = localItems.filter(it =>
        it && !accounted.has(String(it.id)) && !accounted.has(String(it.parentId)));
    let leftoverIdx = 0;
    const localForBlocked = li =>
        (li.itemId != null && li.itemId !== '')
            ? (localByItemId.get(String(li.itemId)) || null)
            : (leftoverLocals[leftoverIdx++] || null);

    // Server-driven render: each top-level orderItemDetails entry becomes one cart row.
    // This is the source of truth — fixes BOGO duplicate-itemId where two distinct server
    // lines share the same itemId but carry different variants/addons (each gets its own row).
    const lineHtml = li => renderCartLineHTML(li, localFor(li));

    let html;
    if (cfg.isCloud) {
        // Cloud kitchen: group valid server lines by brand and render one section per brand.
        const groups = new Map();
        validLines.forEach(li => {
            const k = String(li.brandId || '');
            if (!groups.has(k)) {
                groups.set(k, { brandName: li.brandName || '', brandLogo: li.brandLogo || '', lines: [] });
            }
            groups.get(k).lines.push(li);
        });
        html = [...groups.values()].map(g => {
            const count = g.lines.reduce((s, li) => s + Number(li.qty || 1), 0);
            const logoHtml = g.brandLogo
                ? `<span class="cart-brand-hdr__logo"><img src="${esc(g.brandLogo)}" alt="" loading="lazy"></span>`
                : `<span class="cart-brand-hdr__logo cart-brand-hdr__logo--ph">${esc((g.brandName || '?').charAt(0).toUpperCase())}</span>`;
            const itemsHtml = g.lines.map(lineHtml).join('');
            return `<div class="cart-brand-section">
                <div class="cart-brand-hdr">
                    ${logoHtml}
                    <span class="cart-brand-hdr__name">${esc(g.brandName || 'Items')}</span>
                    <span class="cart-brand-hdr__count">${count} item${count > 1 ? 's' : ''}</span>
                </div>
                <div class="cart-brand-section__body">${itemsHtml}</div>
            </div>`;
        }).join('');
    } else {
        html = validLines.map(lineHtml).join('');
    }

    // Every line is unavailable → the card body would be blank. Show a clear message instead
    // (the blocked items still render in their own #cartUnavailableSection below).
    if (!validLines.length) html = renderNoValidItemsHTML(blockedLines.length);

    container.innerHTML = html;

    // Out-of-stock / unavailable lines live in their OWN card (#cartUnavailableSection),
    // separate from the "Items Added" card — not appended inside it.
    const oosSection = el('cartUnavailableSection');
    if (oosSection) {
        const oosHtml = renderUnavailableGroupHTML(blockedLines, localForBlocked);
        oosSection.innerHTML = oosHtml;
        oosSection.hidden = !oosHtml;
    }
}

// Empty "Items Added" body shown when every cart line is unavailable. The blocked items
// still render in their own #cartUnavailableSection below — this just replaces the otherwise
// blank card body with a clear explanation + next step.
function renderNoValidItemsHTML(blockedCount) {
    const n    = Number(blockedCount) || 0;
    const lead = n === 1 ? 'The item in your cart is' : 'All items in your cart are';
    return `<div class="co-cart-empty">
  <span class="co-cart-empty__icon" aria-hidden="true">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18l-1.4 13a2 2 0 0 1-2 1.8H6.4a2 2 0 0 1-2-1.8L3 6Z"/><path d="M8 6V5a4 4 0 0 1 8 0v1"/><line x1="9.5" y1="11" x2="14.5" y2="16"/><line x1="14.5" y1="11" x2="9.5" y2="16"/></svg>
  </span>
  <p class="co-cart-empty__title">${lead} currently unavailable</p>
  <p class="co-cart-empty__sub">They're currently unavailable. Remove them below, or add available items to continue.</p>
</div>`;
}

// Grouped "no longer available" block — all out-of-stock / invalid lines collected under one
// header with a single shared remove control (delete-all). Individual rows here are rendered
// without their own trash button (`grouped: true`). Returns '' when nothing is blocked.
function renderUnavailableGroupHTML(blockedLines, localResolver) {
    if (!blockedLines.length) return '';
    const rowsHtml = blockedLines
        .map(li => renderCartLineHTML(li, localResolver(li), { grouped: true }))
        .join('');
    const count = blockedLines.length;
    return `<div class="cart-oos-group" data-oos-group>
  <div class="cart-oos-group__hdr">
    <span class="cart-oos-group__title">${count} item${count > 1 ? 's are' : ' is'} not in stock</span>
    <button type="button" class="cart-oos-group__remove-all" data-action="remove-all-unavailable" aria-label="Remove all unavailable items" title="Remove all">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>
  </div>
  <div class="cart-oos-group__body">${rowsHtml}</div>
</div>`;
}

// Server-line cart row — title is `parentName[itemName]` when a parent exists, else just
// `itemName`. Customizations from `subItems[]` render in an expandable panel below the title.
// Slash pricing: qty × mrp strikethrough above the qty × subTotal line.
function renderCartLineHTML(li, localItem, opts = {}) {
    // `grouped` rows live inside the shared "no longer available" block, which carries one
    // common remove control — so the per-row trash button is suppressed for them.
    const grouped = !!opts.grouped;
    const qty       = Number(li.qty || (localItem && localItem.qty) || 1);
    // Promo-granted free item (addo_order_items.freeItems = 1): its qty/price are fixed by
    // the promo, so show a freebie tag + read-only "Qty: N" instead of the editable stepper
    // and a misleading "₹0". CI3 ref: ue_silver/js/checkout.js:28239, 28295-28303.
    const isFreebie = String(li.freeItems) === '1';
    const mrpUnit   = Number(li.mrp || 0);
    const spUnit    = Number(li.sp  || 0);
    // CI3 ref: ue_silver/js/checkout.js:28176, 28204-28208 — itemTotal = subTotal || sp,
    // multiplied by qty only when subItems exist (variants/addons store per-unit subTotal).
    const itemTotal = Number(li.subTotal) || spUnit || 0;
    // Prefer server-supplied subItems; fall back to local v4_cart entry's subItems (e.g. BOGO
    // wizard stores the variant + addon breakdown locally even when the server response omits it).
    // PHP associative arrays serialize as objects, so normalise both shapes to a plain array.
    const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
    const serverSubs = toArr(li.subItems);
    const localSubs  = toArr(localItem && localItem.subItems);
    const subItems = serverSubs.length ? serverSubs : localSubs;
    const hasSubItems = subItems.length > 0;
    // BOGO line total: server keeps variant subTotals at original price, so itemTotal alone
    // (= parent.subTotal = MAX variant price) misses the addons. Add per-addon subtotals,
    // skipping variants (identified via the local subItem with sp=0 or `step`).
    const isBogo = Number(li.viewType) === 3 || Number(localItem && localItem.viewType) === 3;
    // BOGO addon uplift: the pizza (main) rows are BOGO-zeroed (subTotal 0); the priced rows
    // (subTotal > 0) are their addons. Sum the addons off the SERVER subItems so the line total
    // includes them even when localSubs isn't available (multiple BOGO deals share one itemId, so
    // the local fallback is withheld to avoid cross-deal contamination). Was previously gated on
    // localSubs, which dropped the addon price (e.g. "Double Burst") from the row total.
    let bogoAddonsSub = 0;
    if (isBogo && serverSubs.length) {
        bogoAddonsSub = serverSubs.reduce((sum, c) => {
            const v = Number(c && c.subTotal);
            return Number.isFinite(v) && v > 0 ? sum + v : sum;
        }, 0);
    }
    // BOGO savings: the cheaper of the two picked items is free, so the line total already
    // excludes it. saving = Σ(variant prices) − max(variant price). Read from the local
    // bogoWire (real, un-zeroed prices) so the "You saved" badge + strike are coherent.
    let bogoSaving = 0;
    if (isBogo) {
        const vPrices = toArr(localItem && localItem.bogoWire)
            .map(w => Number(w && w.price) || 0).filter(p => p > 0);
        if (vPrices.length > 1) bogoSaving = vPrices.reduce((a, b) => a + b, 0) - Math.max(...vPrices);
    }
    // Dynamic combo (viewType 2 + dynamic_combo 1): the line price IS the sum of the selected
    // components (Σ subItems.subTotal), not the parent's `subTotal`/`sp` — that's only the
    // default-selection price and goes stale when a pricier item is picked. Matches renderBillFull
    // §5.1 + the menu combo popup, so the row, the bill subtotal, and the menu all agree.
    const isDynCombo = String(li.viewType) === '2' && String(li.dynamic_combo) === '1';
    const comboSub = isDynCombo
        ? subItems.reduce((s, c) => { const v = Number(c && c.subTotal); return Number.isFinite(v) && v > 0 ? s + v : s; }, 0)
        : 0;
    const effectiveItemTotal = isDynCombo ? comboSub : (isBogo ? itemTotal + bogoAddonsSub : itemTotal);
    // CI3 parity (ue_silver/js/checkout.js:28243-28247): multiply by qty ONLY when the SERVER
    // line carries subItems — its subTotal is then PER-UNIT. A flat server line bakes qty into
    // subTotal, so it must NOT be multiplied even when the LOCAL cart attached default
    // customization subItems. Keying the multiply on the merged `hasSubItems` (server OR local)
    // double-counted customisable items added via the stepper: the row read ₹1750 (= ₹350 × 5)
    // while the bill correctly showed ₹350.
    const serverPricedPerUnit = serverSubs.length > 0;
    let lineTotal = isDynCombo ? comboSub * qty : (serverPricedPerUnit ? effectiveItemTotal * qty : effectiveItemTotal);
    // Multi-clone group (combo/variant cloned per add): the server gives each clone its own subTotal,
    // so the true line total is their SUM — which is exactly what the bill charges. Prefer it over the
    // ×qty heuristic above, which mis-prices once clones with mixed qtys merge. BOGO is EXCLUDED (it's
    // never merged — see the backfill guard — and its cross-line server totals are unreliable);
    // dynamic-combo stays on comboSub. Single-line groups (length 1) keep their client-side pricing.
    if (!isBogo && !isDynCombo
        && Array.isArray(li._groupOrderItemIds) && li._groupOrderItemIds.length > 1
        && Number.isFinite(Number(li._groupSubtotal)) && Number(li._groupSubtotal) > 0) {
        lineTotal = Number(li._groupSubtotal);
    }
    // Price-invalid cloud stub: server returns subTotal=sp=0, so recover the displayed price
    // from the local cart (qty already fell back to localItem.qty above). Only kicks in when
    // the server truly gave no price — valid lines always carry a non-zero total.
    if (!(lineTotal > 0) && localItem && Number(localItem.price) > 0) {
        lineTotal = Number(localItem.price) * qty;
    }
    // Membership-priced rows keep mrp == sp (the discount lives in saving_total), so the
    // POS-slash check alone misses them. When a non-combo row carries a saving_total, show
    // the pre-discount strike = subTotal + saving_total (this equals mrp×qty for a regular
    // slash, and the pre-discount line total for a member row). Combos keep their own path.
    const savingTotal = Number(li.saving_total);
    const showPosStrike    = mrpUnit > spUnit && spUnit > 0;
    const showMemberStrike = !isBogo && !isDynCombo && !showPosStrike
        && Number.isFinite(savingTotal) && savingTotal > 0;
    // BOGO line shows the free item's value as the saving: strike = paid total + saved.
    const showBogoStrike = isBogo && bogoSaving > 0;
    const strikeAmount = showMemberStrike ? (lineTotal + savingTotal)
        : (showBogoStrike ? (lineTotal + bogoSaving) : (mrpUnit * qty));
    const mrpLineHtml = (showPosStrike || showMemberStrike || showBogoStrike)
        ? `<span class="cart-row__mrp">${fmt(strikeAmount)}</span>`
        : '';
    // Per-row saving chip ("You saved ₹X") shown alongside the slashed price.
    // POS slash (mrp > sp): the saving is strike − paid total; mirrors the member/BOGO chips
    // so a regular discounted line isn't the only one missing the badge beside its price.
    const posSaving = showPosStrike ? (strikeAmount - lineTotal) : 0;
    const savedChipHtml = showMemberStrike
        ? `<span class="cart-row__save">You saved ${fmt(savingTotal)}</span>`
        : (showBogoStrike ? `<span class="cart-row__save">You saved ${fmt(bogoSaving)}</span>`
        : (showPosStrike && posSaving > 0 ? `<span class="cart-row__save">You saved ${fmt(posSaving)}</span>` : ''));

    // Item-wise points redemption, server-confirmed (/client/cart echoes
    // wallet_points_redeemed per line). Label only — undoing it lives in ONE place,
    // the Savings Corner band (#loyaltyBand), which removes the order's redemption
    // as a whole rather than offering the same action once per line.
    //
    // A redeemed line drops both of the row's other points surfaces (see the
    // markup below): the "You saved ₹X" chip, because the line is free and there
    // is no rupee saving to state, and the "Get free for N pts OR Earn +M" strip,
    // because it's an offer that has already been taken.
    const redeemedPts = Math.floor(Number(li.wallet_points_redeemed || 0));
    const redeemedChipHtml = redeemedPts > 0
        ? `<span class="cart-row__redeemed">
             <span class="cart-row__redeemed-pts">${ptsU(redeemedPts)} redeemed</span>
           </span>`
        : '';

    // Use the local v4_cart item's id for qty buttons (matches existing handleCartQtyClick).
    const localId = esc(String((localItem && (localItem.id || localItem.itemId)) || li.itemId));

    // Promoted from the line's own add-ons — a veg base with a non-veg add-on shows
    // the non-veg marker (see promoteVegFromSubs).
    const veg = promoteVegFromSubs(li.vegnonvegboth || (localItem && localItem.veg) || '', subItems);

    const parentName = String(li.parentName || '').trim();
    // Fall back to the local cart name when the server line omits it — a price-invalid cloud
    // line is returned as a stub with no itemName (see localForBlocked in renderCartItems).
    const itemName   = String(li.itemName || '').trim() || String((localItem && localItem.name) || '').trim();
    const title = (parentName && parentName !== 'null')
        ? `${esc(parentName)}<span class="cart-row__variant">[${esc(itemName)}]</span>`
        : esc(itemName);

    // CI3 parity: rows.orderItemDetails carries per-item slot-availability flags from
    // pay_model.php (validateStatus=0 + validateMsg when prep_time exceeds the chosen slot).
    // Mirror Render._singleItemHTML (CI3 checkout.js:30562-30672): swap +/− with a Remove
    // button and show a red banner under the row.
    // CI3 uses loose `== 0`, which treats null/undefined as NOT blocked (null == 0 is false).
    // A naive `Number(x) === 0` breaks parity because Number(null) === 0 is true — that wrongly
    // flags combo sub-items whose validateStatus is null, swapping the qty stepper for a Remove
    // button and surfacing the parent's "Success" validateMsg in the error banner. Guard explicitly.
    const isBlocked = (v) => v !== null && v !== undefined && Number(v) === 0;
    const subUnavailable = subItems.find(s => isBlocked(s?.validateStatus));
    // A closed outlet flags every line validateStatus=0, but that's a global closure (shown via
    // the floating banner), not per-item unavailability — keep the normal qty stepper and skip
    // the red "Outlet is Currently Closed!" per-row notice in that case. Per-item OOS treatment
    // (Remove button + error notice) only kicks in while the outlet is open.
    const isUnavailable = cfg.outlet_open ? (isBlocked(li.validateStatus) || !!subUnavailable) : false;
    // When a sub-item is the trigger, show ITS message (CI3 subItemErrorMsg), not the parent's.
    const errMsg = String(
        (isBlocked(li.validateStatus) ? li.validateMsg : (subUnavailable && subUnavailable.validateMsg))
        || li.validateMsg || 'Not available in the selected slot'
    );

    // Per-item applicability notice. CI3 ref: ue_silver/js/checkout.js:28220-28226 +
    // checkoutPage_20251121.js:7758-7782. CI3 renders the pill per sub-item inside the
    // combo's inner loop — meaning a combo whose ONE sub-item belongs to a wallet-blocked
    // master_menu_section shows the pill even when the parent line's own flag is 1. CI4
    // shows a single pill per cart row, so aggregate: parent OR any sub-item blocked.
    const subBlocks = (key) => subItems.some(s => isBlocked(s?.[key]));
    const promoNA  = isBlocked(li.promo_applicable_master)  || subBlocks('promo_applicable_master');
    const walletNA = isBlocked(li.wallet_applicable_master) || subBlocks('wallet_applicable_master');
    let noticeText = '';
    if      (promoNA && walletNA) noticeText = 'Promos and wallet not applicable on this item';
    else if (walletNA)            noticeText = 'Wallet is not applicable on this item';
    else if (promoNA)             noticeText = 'Promos are not applicable on this item';
    const noticeHtml = noticeText && !isUnavailable
        ? `<p class="cart-row__notice">${noticeText}</p>` : '';
    const errNoticeHtml = isUnavailable
        ? `<p class="cart-row__notice cart-row__notice--err">${esc(errMsg)}</p>` : '';

    // Membership informational notices (lower priority than slot-availability and the
    // promo/wallet notice — shown only when those aren't already occupying the slot):
    //   • membership_limit_exceeded → the item was eligible but the redemption cap is hit.
    //   • mov_failed_benefits       → eligible items haven't reached the benefit's min order
    //     value, so the discount can't apply yet (contextual upsell).
    const limitExceeded = String(li.membership_limit_exceeded) === '1';
    const movBenefit = (state.order?.mov_failed_benefits || []).find(b =>
        Array.isArray(b?.item_ids)
        && b.item_ids.some(id => String(id) === String(li.itemId))
        && Number.isFinite(Number(b?.shortfall)) && Number(b.shortfall) > 0);
    let memberNoticeText = '';
    if      (limitExceeded) memberNoticeText = 'Discount not applied – benefit redemption limit reached';
    else if (movBenefit)    memberNoticeText = `Add items worth ${fmt(Number(movBenefit.shortfall))} more to avail member benefit`;
    const memberNoticeHtml = (memberNoticeText && !isUnavailable && !noticeText)
        ? `<p class="cart-row__notice cart-row__notice--member">${memberNoticeText}</p>` : '';

    // Each server line is identified uniquely by its orderItemId. The buttons carry both:
    //   data-order-item-id → authoritative server line key (handles BOGO duplicate-itemId case)
    //   data-item-id       → local v4_cart key for optimistic UI updates
    const oid = esc(String(li.orderItemId || ''));
    const rightHtml = isUnavailable
        // Inside the grouped OOS block the shared "Remove all" control handles deletion, so the
        // per-row trash button is omitted; a standalone unavailable row keeps its own button.
        ? (grouped ? ''
            : `<button type="button" class="cart-row__remove-btn" data-action="remove" data-order-item-id="${oid}" data-item-id="${localId}" aria-label="Remove item" title="Remove">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`)
        : isFreebie
        // Free item: no stepper — the promo controls its quantity. Show the freebie tag only.
        ? `<span class="cart-row__freebie">🎁 Freebie</span>`
        : `<div class="cart-row__qty">
      <button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="decrease" data-order-item-id="${oid}" data-item-id="${localId}" aria-label="Decrease quantity">−</button>
      <span class="mono">${qty}</span>
      <button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="increase" data-order-item-id="${oid}" data-item-id="${localId}" aria-label="Increase quantity">+</button>
    </div>`;

    // Variant-only line (e.g. "Cheezy-7 Pizza" with subItems=[Regular]) already shows the
    // variant inlined in the title bracket — don't double-render it as a customization row.
    const inlinedVariant = (parentName && parentName !== 'null') ? itemName : '';
    const realSubItems = inlinedVariant
        ? subItems.filter(s => String(s.itemName || '').trim() !== inlinedVariant)
        : subItems;
    const hasCustomizations = realSubItems.length > 0;

    // BOGO only: identify the variant pizzas (zeroed sp / have a `step`) from the local
    // breakdown so the customizations panel can nest each variant's add-ons under it.
    const bogoCustomOpts = isBogo
        ? { variantIds: new Set(
              localSubs.filter(s => s && (Number(s.sp) === 0 || s.step !== undefined))
                       .map(s => String(s.itemId))) }
        : null;

    return `<div class="cart-row${isUnavailable ? ' cart-row--unavailable' : ''}" data-item-id="${localId}">
  <div class="cart-row__top">
    <div class="cart-row__main">
      <h4 class="cart-row__title">
        ${vegMarkerHTML({ veg })}
        <span class="cart-row__name">${title}</span>
      </h4>
      ${errNoticeHtml}
      ${noticeHtml}
      ${memberNoticeHtml}
    </div>
    <div class="cart-row__right">
      <div class="cart-row__priceqty">
        ${rightHtml}
        ${isFreebie
          ? `<div class="cart-row__price cart-row__freeqty">Qty: ${qty}</div>`
          : redeemedPts > 0
          // Redeemed line: ₹0 with the original struck beneath it, never a
          // discounted rupee figure. The line keeps its own subTotal server-side
          // (the discount lands at order level via walletAmtUsed), so the ₹0 here
          // is the customer-facing truth, not the row's stored price.
          ? `<div class="cart-row__price"><span class="cart-row__mrp">${fmt(lineTotal)}</span><br>${fmt(0)}</div>`
          : `<div class="cart-row__price">${mrpLineHtml ? mrpLineHtml + '<br>' : ''}${fmt(lineTotal)}</div>`}
      </div>
      ${redeemedPts > 0 ? redeemedChipHtml : (isFreebie ? '' : savedChipHtml)}
      ${(isFreebie || redeemedPts > 0) ? '' : lineStripHTML(li, qty, localItem)}
    </div>
  </div>
  ${!hasCustomizations ? ''
    : (isBogo && localSubs.length
        ? renderBogoCustomizationsHTML(localSubs, serverSubs, qty)
        : renderCustomizationsHTML(subItems, qty, li.orderItemId, isBogo ? { variantIds: bogoServerVariantIds(subItems) } : undefined))}
</div>`;
}

// BOGO server subItems arrive FLAT and in order: [pizza, its addons…, pizza, its addons…]. The
// pizza (main) rows are the ones BOGO zeroes (subTotal 0); priced rows (subTotal > 0) are their
// addons. Return the pizza itemIds so renderCustomizationsHTML's ordered walk nests each pizza's
// addons beneath it. Used when localSubs (which carries `step` markers) isn't available — i.e.
// multiple BOGO deals share one itemId, so we can't safely borrow the local structure.
function bogoServerVariantIds(subItems) {
    const ids = new Set();
    (Array.isArray(subItems) ? subItems : []).forEach(s => {
        const total = (s && s.subTotal != null && s.subTotal !== '') ? Number(s.subTotal) : Number(s && (s.sp ?? s.price) || 0);
        if (s && s.itemId != null && total === 0) ids.add(String(s.itemId));
    });
    return ids;
}

// Render one customization row. Price is suppressed when the server returned subTotal=0 (e.g.
// BOGO variants zeroed by checkMaxPriceWidget) — CI3 parity, see checkout.js:28319-28362.
function renderCustomizationRow(s, itemQty, nested, isParent) {
    const name = esc(String(s.itemName || s.name || ''));
    // Prefer server's subTotal (authoritative post-discount); fall back to sp/price only when
    // subTotal is absent (local-only cart, before first /client/cart response).
    const unit = (s.subTotal != null && s.subTotal !== '')
        ? Number(s.subTotal)
        : Number(s.sp || s.price || 0);
    const veg  = s.vegnonvegboth || s.vegNonvegBoth || s.veg || '';
    const priceTxt = unit <= 0
        ? ''
        : (itemQty > 1 ? `${fmt(unit)} × ${itemQty}` : fmt(unit));
    const nestCls = nested ? ' cart-row__custom-row--nested' : '';
    const parentCls = isParent ? ' cart-row__custom-row--parent' : '';
    return `<div class="cart-row__custom-row${nestCls}${parentCls}">
      ${vegMarkerHTML({ veg })}
      <span class="cart-row__custom-name">${name}</span>
      <span class="cart-row__custom-price">${priceTxt}</span>
    </div>`;
}

// BOGO hierarchy from the AUTHORITATIVE local structure: the flat local subItems preserve
// insertion order (each main item followed by its addons) and tag main items with `step`.
// We rebuild the 2-level tree from that order — main item at depth 1, its addons nested at
// depth 2 — instead of trusting the server's parentItemId, which reparents ₹0 "choice"
// addons (e.g. Jain) to the BOGO root and renders them flat. Display prices come from the
// server line (authoritative, post-discount) matched by itemId, falling back to local sp.
function renderBogoCustomizationsHTML(localSubs, serverSubs, qty) {
    const itemQty = Number(qty) || 1;
    const srvByItem = new Map();
    (serverSubs || []).forEach(s => {
        if (s && s.itemId != null && !srvByItem.has(String(s.itemId))) srvByItem.set(String(s.itemId), s);
    });
    const merge = s => {
        const srv = srvByItem.get(String(s.itemId));
        return srv && srv.subTotal != null && srv.subTotal !== '' ? { ...s, subTotal: srv.subTotal } : s;
    };
    let rowsHtml = '';
    localSubs.forEach(s => {
        if (!s) return;
        // `step` is present only on main items (BOGO variants); addons follow their main item.
        rowsHtml += renderCustomizationRow(merge(s), itemQty, s.step === undefined);
    });
    return `<div class="cart-row__customs cart-row__customs--open">
    <button type="button" class="cart-row__customs-toggle" aria-expanded="true">
      <span>Customizations</span>
      <svg class="cart-row__customs-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="cart-row__customs-list">${rowsHtml}</div>
  </div>`;
}

// When parentOrderItemId is provided, try to render the CI3-style 2-level hierarchy:
// variants (direct children of the BOGO parent) at depth 1, addons (children of variants) at
// depth 2. Falls back to flat rendering if no hierarchy is detected.
function renderCustomizationsHTML(subItems, qty, parentOrderItemId, bogoOpts) {
    if (!Array.isArray(subItems) || !subItems.length) return '';
    const itemQty = Number(qty) || 1;

    let rowsHtml = '';
    let hierarchical = false;

    // BOGO: the server returns a FLAT subItems list (parentItemId=0) — each variant pizza
    // followed by its own add-ons. The parentItemId-based hierarchy below can't see that link,
    // so reconstruct the 2-level view by walking in order: a variant (itemId in variantIds)
    // opens a group as a bold parent; the non-variant rows after it nest under it as add-ons.
    if (bogoOpts && bogoOpts.variantIds && bogoOpts.variantIds.size) {
        const vIds = bogoOpts.variantIds;
        let started = false;
        subItems.forEach(s => {
            if (!s) return;
            if (vIds.has(String(s.itemId))) { started = true; rowsHtml += renderCustomizationRow(s, itemQty, false, true); }
            else rowsHtml += renderCustomizationRow(s, itemQty, started, false);
        });
        hierarchical = true;
    }
    if (!hierarchical && parentOrderItemId != null) {
        const pOid = String(parentOrderItemId);
        const variants = [];
        const variantOids = new Set();
        subItems.forEach(s => {
            if (s && String(s.parentItemId) === pOid) {
                variants.push(s);
                if (s.orderItemId != null) variantOids.add(String(s.orderItemId));
            }
        });
        if (variants.length) {
            hierarchical = true;
            const addonsByVariant = new Map();
            const orphanAddons = [];
            subItems.forEach(s => {
                if (!s || String(s.parentItemId) === pOid) return;
                const pid = String(s.parentItemId);
                if (variantOids.has(pid)) {
                    if (!addonsByVariant.has(pid)) addonsByVariant.set(pid, []);
                    addonsByVariant.get(pid).push(s);
                } else {
                    orphanAddons.push(s);
                }
            });
            variants.forEach(v => {
                rowsHtml += renderCustomizationRow(v, itemQty, false);
                const kids = addonsByVariant.get(String(v.orderItemId)) || [];
                kids.forEach(k => { rowsHtml += renderCustomizationRow(k, itemQty, true); });
            });
            orphanAddons.forEach(o => { rowsHtml += renderCustomizationRow(o, itemQty, false); });
        }
    }
    if (!hierarchical) {
        rowsHtml = subItems.map(s => renderCustomizationRow(s, itemQty, false)).join('');
    }

    return `<div class="cart-row__customs cart-row__customs--open">
    <button type="button" class="cart-row__customs-toggle" aria-expanded="true">
      <span>Customizations</span>
      <svg class="cart-row__customs-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="cart-row__customs-list">${rowsHtml}</div>
  </div>`;
}

// ─── Cart API core ────────────────────────────────────────────
// Commit the chosen delivery address server-side BEFORE recomputing the bill — CI3
// parity (selectAddress → GET /client/setDeliveryAddress → add_to_cart). The legacy
// server persists the selection against the session, so the follow-up /client/cart
// resolves the right delivery charges + serviceability. Without this commit, a freshly
// added address never gets delivery charges (DC = 0). GET, query-string params, no body,
// no lat/lng — the server resolves coords from the saved record (CI3 checkoutPage
// selectAddress:5673 / addressManager selectAddress:792). Best-effort: a failure here
// must not block the recompute (the cart call still carries deliveryAddressId).
async function commitDeliveryAddress(addressId) {
    if (!addressId) return;
    const ud = userData();
    const p  = new URLSearchParams({
        businessId:        cfg.businessId,
        contactMappingId:  ud.contactMappingId || '',
        token:             ud.token            || '',
        contactId:         ud.contactId        || '',
        deliveryAddressId: addressId,
    });
    try {
        await fetch(`${getApiBase()}/client/setDeliveryAddress?${p}`, {
            method: 'GET', headers: { 'Accept': 'application/json' },
        });
    } catch (err) {
        console.warn('[checkout] setDeliveryAddress failed:', err);
    }
}

// Low-level helper — builds params and fires one /client/cart POST (all params,
// incl. deliveryAddressId + coords, travel in the FormData body — never a query string).
async function callCartApi(extra = {}) {
    const ud = userData();
    const ot = cfg.orderType || 'delivery';
    const p  = new URLSearchParams({
        businessId:             cfg.businessId,
        contactMappingId:       ud.contactMappingId || '',
        token:                  ud.token            || '',
        contactId:              ud.contactId        || '',
        isNew:                  1,
        orderType:              OT_NUM[ot] || 1,
        subOrderType:           ot === 'pickup' ? 1 : '',
        pickup_time:            '',
        is_slot_based_ordering: cfg.is_slot_based || 0,
        ...extra,
    });
    // Pre-booking hand-off: /checkout/{b}/{ot}?cart_type=3&eventId=… — forward these so
    // the server returns the pre-booking cart bucket. Without them the regular cart loads
    // and the pre-booked item isn't visible. Gated on presence → no effect on normal carts.
    const _pbq = new URLSearchParams(location.search);
    if (_pbq.get('cart_type')) p.set('cart_type', _pbq.get('cart_type'));
    if (_pbq.get('eventId'))   p.set('eventId',   _pbq.get('eventId'));
    if (ot === 'delivery' && state.selectedAddressId) p.set('deliveryAddressId', state.selectedAddressId);
    // Delivery and in_car both carry latitude/longitude, from DIFFERENT sources: the picked
    // delivery location vs a live GPS fix. CI3 ref ue_silver/js/checkout.js getCart(~L30190),
    // which splits them the same way (localStorage.lat/lng vs window.realLat/realLng).
    if (ot === 'delivery') {
        // The legacy server uses these to determine the outlet's tax jurisdiction — without
        // them it falls back to a different delivery-charge tax rate, which is why CI4 was
        // showing a ₹2.50 delivery tax line where CI3 shows ₹2.00 on the same cart.
        // The selected delivery address's own coords win — they decide serviceability
        // ("Not Delivering to Particular Area") and the tax jurisdiction. Falling back to
        // userLat/userLng (the home-page pick) would check the cart against the wrong
        // location whenever the user picks a different address here. CI3 parity:
        // ue_silver/js/checkout.js updateLocationData() rewrites coords on every pick.
        const lat = state.selectedAddressLat || localStorage.getItem('userLat') || localStorage.getItem('lat') || '';
        const lng = state.selectedAddressLng || localStorage.getItem('userLng') || localStorage.getItem('lng') || '';
        if (lat) p.set('latitude',  lat);
        if (lng) p.set('longitude', lng);
    }
    if (ot === 'in_car') {
        // ONLY the live fix. The server measures these coords against the outlet's
        // inCarRadius to answer "is the customer's car outside THIS outlet right now" —
        // a question no stored address can answer, and userLat/userLng carries no outlet
        // stamp, so it survives an outlet switch.
        if (state.carLat) p.set('latitude',  state.carLat);
        if (state.carLng) p.set('longitude', state.carLng);
    }
    if (ot === 'dine_in') {
        p.set('tableId',   cfg.tableId || 0);
        p.set('tableName', state.selectedTableName || cfg.tableName || '');
    }
    if (ot === 'in_car' && state.carNumber) p.set('carNumber', state.carNumber);
    if (state.selectedSlot) {
        // selected_slot must be the ISO datetime of the slot start, not the slot ID —
        // the server validates item prepTime against it (CI3 parity, ue_silver checkout.js).
        const iso = slotSelectedIso();
        if (iso) p.set('selected_slot', iso);
        // Pickup orders also carry the raw slot ID as pickup_time (CI3 parity).
        if (ot === 'pickup') p.set('pickup_time', String(state.selectedSlot));
    }
    // Wallet apply/remove is now persisted server-side via /client/applyWallet
    // & /client/removeWallet (see toggleWallet); /client/cart no longer needs a flag.
    const fd = new FormData();
    for (const [k, v] of p) fd.append(k, v);
    // Every bill recalc — qty change, promo apply/remove, wallet toggle, suggestion
    // adds, slot/address changes, initial load — funnels through here, so the bill +
    // pay-CTA loader lives here once. The flag clears in finally (covers the thrown
    // paths below); the caller's applyCartResp() writes the fresh amounts in the same
    // task, so the shimmer→real-value swap paints in one frame (no ₹0.00 flash).
    setBillUpdating(true);
    try {
        const res = await fetch(`${getApiBase()}/client/cart`, {
            method: 'POST',
            headers: { 'Accept': 'application/json' },
            body: fd,
        });
        if (!res.ok) throw new Error(`Cart API ${res.status}`);
        const body = await res.json();
        // CI3 contract: top-level `status === 0` means a logical failure (item OOS, MOV
        // not met, invalid address, expired session, etc.). HTTP 200 alone is not enough.
        // Without this guard, the catch path is never hit and the cart silently renders
        // against stale localStorage. CI3 ref: ue_silver/js/checkout.js:30207-30217.
        if (Number(body?.status) === 0) {
            throw new Error(body?.msg || body?.message || 'Cart unavailable');
        }
        return body;
    } finally {
        setBillUpdating(false);
    }
}

// Parse a cart API response: update serverItemIds map, return key data.
function parseCartResp(resp) {
    const rows  = resp?.result?.rows ?? resp?.rows ?? resp ?? {};
    const order = rows?.orderDetails?.[0]  ?? null;
    let lines   = rows?.orderItemDetails   ?? [];
    // Cloud-kitchen responses nest items by sub-brand:
    //   [ { brandId, businessName, logo, items: [{ itemId, validateStatus, validateMsg, ... }] }, ... ]
    // Single-brand responses are already a flat list. Detect the nested shape and flatten so
    // downstream (linesByItemId + renderCartLineHTML) sees one consistent structure.
    // CI3 ref: ue_default/js/checkoutPage_20251224.js:7711-7751 (the isCloud branch).
    if (Array.isArray(lines) && lines.length && lines[0] && Array.isArray(lines[0].items)) {
        lines = lines.flatMap(group => (group.items || []).map(it => ({
            ...it,
            brandId:   it.brandId   ?? group.brandId,
            brandName: it.brandName ?? group.businessName,
            brandLogo: it.brandLogo ?? group.logo,
        })));
    }
    const suggs = rows?.suggestions        ?? [];
    const promos = rows?.promoCodes        ?? [];
    // CI3 contract: validation is a SIBLING of orderDetails (rows.validation), not nested inside it.
    // status=0 means cart-level failure (e.g. item not available in selected slot, MOV not met).
    const validation = rows?.validation    ?? null;
    lines.forEach(li => {
        if (li.itemId && li.orderItemId) {
            state.serverItemIds[String(li.itemId)] = String(li.orderItemId);
        }
    });
    return { order, lines, suggs, promos, validation };
}

// Render bill + recs from a parsed response.
function applyCartResp({ order, lines, suggs, promos, validation }, localItems, fallbackSubtotal) {
    state.order  = order;
    state.lines  = lines || [];
    syncLocalPricesFromServer(state.lines);
    state.suggs  = suggs || [];
    state.validation = validation || null;
    // Hydrate applied-promo from server every render. CI3 ref: ue_silver/js/checkout.js:17770
    // (orderDetails.promoCodeId/code). This fixes:
    //  (a) Applied state survives page refresh
    //  (b) Remove button has a code to send when clicked
    //  (c) Switch confirmation knows the correct "current" code on cold load
    const hasAppliedServer = order?.promoCodeId != null && Number(order.promoCodeId) !== 0;
    state.appliedPromo = hasAppliedServer ? String(order.code || order.promoCode || '') : '';
    if (order) {
        // Restore saved gift details so they survive a page refresh (see fn defn).
        hydrateGiftFromServer(order);
        // Restore selected address from the server cart when local state is empty — but
        // ONLY on the first cart load of the page (cold-load hydration). The cart response
        // carries deliveryAddressId + addressLine1/locality/city for the address the server
        // is computing delivery against; without this, a refreshed page shows "No address
        // selected" while Grand Total silently includes delivery charges.
        // It must NOT fire on later recalcs: deleting an address from the address book does
        // not clear it from the server cart, so a recalc right after we cleared a deleted
        // address would re-adopt that ghost id and overwrite the freshly-cleared display.
        if (!state.serverAddrHydrated) {
            state.serverAddrHydrated = true;
            if ((cfg.orderType || 'delivery') === 'delivery'
                && !state.selectedAddressId
                && order.deliveryAddressId
                && String(order.deliveryAddressId) !== '0') {
                state.selectedAddressId = String(order.deliveryAddressId);
                const text = [order.addressLine1, order.addressLine2, order.locality, order.city, order.pincode]
                    .filter(addrNotZero).join(', ').replace(/,\s*,/g, ',').replace(/,\s*$/, '');
                state.selectedAddressText = text;
                state.selectedAddressName = order.name || order.addressType || '';
                set('selectedAddressDisplay', text);
                saveAddressSelection(state.selectedAddressId, text, state.selectedAddressName, state.selectedAddressLat, state.selectedAddressLng);
                updateDeliveryETA(state.selectedAddressName);
            }
        }
        // Authoritative staleness: if the chosen later-slot is no longer among the slots the
        // backend offers (e.g. an ongoing-but-unbookable window like 12:30–1:30 PM at 1:00 PM),
        // drop it and force a fresh pick. slotWindowPast (restore/pay-time) only catches fully
        // elapsed windows; this closes the gap. Mirrors menu.js slotStillOffered().
        if (state.selectedSlot !== null && Number(state.selectedSlot) !== 0) {
            const days = order.slotsDetails || [];
            const day  = days.find(d => d.date === state.selectedSlotDate);
            const stillOffered = !!day && (day.slots || []).some(s => s && Object.keys(s).length > 0 && String(s.id) === String(state.selectedSlot));
            if (days.length && !stillOffered) {
                state.selectedSlot = null;
                state.selectedSlotText = '';
                state.slotExpired = true;
                set((cfg.orderType || 'delivery') === 'pickup' ? 'pickupSlot' : 'deliverySlot', 'Slot not selected');
                ['slot_id','slot_date','slot_label','slot_startH','slot_endH'].forEach(k => localStorage.removeItem(k));
            }
        }
        // A "Deliver Now" picked earlier in the session stops being orderable once the kitchen's
        // prep cutoff passes (deliverNowWindowOpen). Nothing else clears it — the auto-select
        // below only runs when NO slot is chosen — so a tab left open across the cutoff would
        // sail past the Pay CTA with an immediate order for a closed kitchen. Drop it here so
        // the CTA gate re-fires and the user picks a real slot.
        if (isStaleNowSlot(order)) clearStaleNowSlot();
        // Auto-select "Now" as default slot when available — CI3 never requires explicit confirm
        // for the immediate option. Only blocks on slot selection when deliver_now_option=0.
        // Skip when onlineDeliveryTime=0 (deliver-now card is suppressed in loadSlots for that
        // case) — auto-selecting it here would desync the hidden default from the rendered UI.
        // Also skip when a scheduled slot just expired (state.slotExpired): the user chose a
        // later slot, so re-prompt via the Pay CTA gate rather than silently switching to now.
        if (state.selectedSlot === null && !state.slotExpired) {
            const ot = cfg.orderType || 'delivery';
            if ((ot === 'delivery' || ot === 'pickup') && deliverNowAllowed(order)) {
                // Shared with the slot modal's card and the confirm handler, so the summary
                // row and the modal can never disagree about the same cart.
                state.selectedSlot     = 0;
                state.selectedSlotText = nowOptionLabel(order);
                set(ot === 'pickup' ? 'pickupSlot' : 'deliverySlot', state.selectedSlotText);
            }
        }
        renderBillFull(order, fallbackSubtotal);
        // Pre-booking checkout (cart_type=3 & eventId): wallet, promos and
        // membership savings are not applicable — hide those sections and skip
        // their renderers. Every other checkout is unchanged.
        if (isPrebookingCheckout()) {
            hide('walletDiv');
            hide('promo_list');
            hide('membership_promo_list');
            hide('pointsStrip');
            hide('loyaltyBand');
            hide('promoEarnBanner');
            hide('pointsBalanceStrip');
        } else {
            renderWallet(order);
            renderPointsStrip(order);
            renderPointsBalance();
            renderMembershipSavings(order, promos);
            renderSavingsCorner(order, promos);
            // Runs AFTER wallet + promo sections so it sees the final applied state and
            // greys out whichever section can't be used alongside the other.
            renderWalletPromoExclusivity();
        }
        renderRecommendations(suggs, localItems);
        renderCartItems();   // re-render with sp/mrp from server lines for slash pricing
        applySlotVisibility(order);
        updatePayCta(order);
        // Fast checkout: resolve the user's last UPI method (cached, 15-min TTL) and
        // swap in the two-part footer if available. Async + fire-and-forget so it
        // never blocks the bill render; falls back to the standard Pay button.
        handleLastPaymentFlow(order);
        updateDeliveryETA(state.selectedAddressName);
        // After an order-type switch the backend keeps a now-invalid promo attached
        // (order.promoCodeId + discount still in the bill) but drops it from the
        // order-type-filtered promoCodes list and flags the cart invalid. Detach it
        // so the discount clears. Fire-and-forget — it re-syncs the cart itself.
        maybeAutoRemoveOrphanPromo();
    } else {
        // API returned no order data — show local subtotal only
        ['walletLi','discountTr','effectiveSubtotalTr','service_chargesTr',
         'packingTr','cashbackPossible','savingsSection','pointsStrip','loyaltyBand','promoEarnBanner','pointsRedeemTr','pointsBalanceStrip','gstTr','deliveryLi'].forEach(hide);
        const s = fmt(fallbackSubtotal);
        set('subTotalSpan', s); set('gstSpan', '—');
        set('totalSpan', s);   set('totalcost', s); set('totalcost_bill', s);
        updatePayCta({ totalAmt: fallbackSubtotal });
    }
}

// Guard against an orphaned promo after an order-type switch. The switch reloads
// /checkout/{bId}/{ot} and the server re-hydrates the cart: it still reports the
// promo as applied (order.promoCodeId + a discount row) yet OMITS it from the
// order-type-filtered promoCodes list and returns validation.status=0
// ("Not valid on this order mode"). The bill then shows a discount the user can't
// clear. Detect that exact state — applied code absent from the offered list AND
// cart flagged invalid — and remove the promo so the bill recomputes clean.
// A still-valid promo (regular OR membership) stays in promoCodes, so it's untouched.
let _autoRemovingPromo = false;
let _autoRemoveAttempted = ''; // last code we tried to auto-remove — stops a retry loop if the server ignores the removal
async function maybeAutoRemoveOrphanPromo() {
    if (_autoRemovingPromo) return;
    const code = state.appliedPromo;
    if (!code || code === _autoRemoveAttempted) return;
    const cartInvalid  = state.validation && Number(state.validation.status) === 0;
    const stillOffered = (state.promos || []).some(p => p.code === code);
    if (!cartInvalid || stillOffered) return;
    _autoRemovingPromo  = true;
    _autoRemoveAttempted = code;
    try {
        await callApplyPromoApi(code, 0);
        state.appliedPromo = '';
        hide('promoAppliedBlock');
        showApplyToast('error', `"${code}" isn't valid for ${OT_LABEL[cfg.orderType || 'delivery'] || 'this order type'} — removed.`);
        await loadCartSummary(); // recompute bill without the stale discount
    } catch {
        /* leave server state as-is on failure — it remains authoritative */
    } finally {
        _autoRemovingPromo = false;
    }
}

// Toggle Customizations panel for a server-driven cart row.
// CI3 ref: ue_silver/js/checkout.js toggleCustomizations (~L2550).
function handleCustomizationsToggle(e) {
    const btn = e.target.closest('.cart-row__customs-toggle');
    if (!btn) return;
    const wrap = btn.closest('.cart-row__customs');
    if (!wrap) return;
    const list = wrap.querySelector('.cart-row__customs-list');
    if (!list) return;
    const isOpen = !list.hidden;
    list.hidden = isOpen;
    btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    wrap.classList.toggle('cart-row__customs--open', !isOpen);
}

// ─── Cart qty buttons ─────────────────────────────────────────
// Attached once at document level so re-renders don't break it.
async function handleCartQtyClick(e) {
    const btn = e.target.closest('#cartItemsContainer button[data-action]');
    if (!btn) return;
    // Gate: only one stepper mutation at a time. Drop clicks that arrive while a
    // mutation is still settling so every handler reads consistent, post-reconcile
    // state (see _qtyMutationInflight). The co-cart-updating shimmer (toggled in
    // callCartApi) gives the user the "updating" feedback during the round-trip.
    if (_qtyMutationInflight) return;
    _qtyMutationInflight = true;
    try {
        await applyCartQtyMutation(btn);
    } finally {
        _qtyMutationInflight = false;
    }
}

// Performs a single stepper mutation: optimistic update on state.lines + v4_cart,
// then the server delete/update, then reconcile from the response. Serialized by
// handleCartQtyClick's gate so concurrent clicks can't interleave the two mirrors.
async function applyCartQtyMutation(btn) {
    const action      = btn.dataset.action;
    const orderItemId = btn.dataset.orderItemId || '';
    const itemId      = btn.dataset.itemId      || '';

    // Prefer the server line addressed by orderItemId — this is the only correct path when
    // multiple server lines share the same itemId (BOGO wizard run twice with different
    // variants). Fall back to the local v4_cart entry only before the first cart API response.
    const serverLine  = orderItemId
        ? (state.lines || []).find(l => String(l.orderItemId) === String(orderItemId))
        : null;
    // Multiple local entries can share this itemId (same item added with different
    // variants/options). Disambiguate by customization signature against the clicked server
    // line so the optimistic mutation hits the exact variant — keying on itemId alone would
    // wipe every variant and empty the local cart (the "Cart is Empty" CTA bug).
    const localCandidates = (getV4Cart().items || []).filter(i => String(i.itemId) === String(itemId));
    const clickedSig  = serverLine ? v4LineSig(serverLine.subItems) : null;
    const localItem   = (localCandidates.length > 1 && clickedSig !== null)
        ? (localCandidates.find(i => v4LineSig(i.subItems) === clickedSig) || localCandidates[0])
        : (localCandidates[0] || null);
    const startQty    = Number(serverLine?.qty || localItem?.qty || 1);

    // For a grouped cart row (combos cloned on every +), `serverLine` is one raw row
    // belonging to the group. `groupMembers` is every raw row that visually folds into
    // the same display entry — used for the "remove" action (delete all clones) and
    // any other group-wide operations.
    const sig          = customizationSignature(serverLine?.subItems);
    const groupMembers = serverLine
        ? (state.lines || []).filter(l =>
              String(l.itemId) === String(serverLine.itemId)
              && customizationSignature(l.subItems) === sig)
        : [];

    // Optimistic update on state.lines (drives the visible row) + local v4_cart (cart pill etc.)
    if (serverLine) {
        if (action === 'increase') {
            serverLine.qty = startQty + 1;
        } else if (action === 'decrease') {
            if (startQty <= 1) state.lines = state.lines.filter(l => l !== serverLine);
            else               serverLine.qty = startQty - 1;
        } else if (action === 'remove') {
            // Drop every clone in this group so the display matches what we're about
            // to ask the server to delete.
            state.lines = state.lines.filter(l => !groupMembers.includes(l));
        }
    }
    if (localItem) {
        const lsig = v4LineSig(localItem.subItems);
        const newQty = action === 'remove' ? 0
            : (action === 'increase' ? localItem.qty + 1 : localItem.qty - 1);
        if (newQty <= 0) v4RemoveItem(itemId, lsig);
        else             v4UpdateQty(itemId, newQty, lsig);
    }
    renderCartItems();

    // Resolve the orderItemId to send to the server. Prefer the data-attribute (per-row,
    // unique). Fall back to the legacy serverItemIds map for the pre-server-response case.
    const apiOrderItemId = orderItemId
        || state.serverItemIds[String(localItem?.parentId || itemId)]
        || state.serverItemIds[String(itemId)];

    // Loader is handled centrally in callCartApi (covers every recalc path).
    try {
        // CI3 parity: the mutation response carries the full updated cart state,
        // so we render directly from it — no separate view fetch needed.
        let resp;
        if (apiOrderItemId) {
            if (action === 'remove') {
                // Each clone on the server has qty=1 (server clones on every +), so one
                // delete drops exactly one row. Loop through every group member's
                // orderItemId; the original single-row case still works because
                // groupMembers === [serverLine] in that case.
                const ids = groupMembers.length
                    ? groupMembers.map(m => m.orderItemId).filter(Boolean)
                    : [apiOrderItemId];
                for (const id of ids) {
                    resp = await callCartApi({ action: 'delete', itemId: id });
                }
            } else {
                const apiAction = action === 'increase' ? 'update' : 'delete';
                resp = await callCartApi({ action: apiAction, itemId: apiOrderItemId });
            }
        } else {
            resp = await callCartApi({ action: 'add', cart: '{"items":[]}' });
        }
        const parsed = parseCartResp(resp);
        const localItems = getV4Cart().items || [];
        const subtotal   = localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
        applyCartResp(parsed, localItems, subtotal);
    } catch (err) {
        console.warn('[checkout] Qty update failed:', err);
        // Pre-booking ONLY: the server rejects an over-limit increase (e.g. "You can
        // prebook a maximum of 5 …"). callCartApi throws with the server's msg —
        // surface it instead of silently keeping the optimistic +1, and roll the cart
        // back to the server's authoritative state. Normal carts keep the prior
        // behaviour (unchanged) so this can't affect the regular checkout journey.
        if (isPrebookingCheckout()) {
            const reason = String((err && err.message) || '').trim();
            if (reason && reason !== 'Cart unavailable') showApplyToast('error', reason);
            try {
                const reread   = await callCartApi({ action: 'add', cart: '{"items":[]}' });
                const li       = getV4Cart().items || [];
                applyCartResp(parseCartResp(reread), li, li.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
            } catch (e2) {
                renderCartItems();   // last resort — re-render from current state
            }
        }
    }
}

// "Remove all" control on the grouped out-of-stock card — clears every invalid/OOS line.
// CI3 parity (ue_silver/js/checkout.js updateCartItem('delete', orderItemId)): there is NO
// bulk delete_invalid action — invalid lines are removed one at a time by orderItemId. The
// bulk action only recognises HARD out-of-stock (status=-1); a slot-prep-time-unavailable
// line (validateStatus=0 but still in stock) is invisible to it, so it returns
// removed_count:0 and removes nothing — while we'd already cleared the local cart, leaving
// local empty + server full (the "Cart is Empty on checkout but items reappear on menu" bug).
// So delete each blocked line by its own orderItemId; fall back to delete_invalid only for
// cloud price-invalid stubs that carry no orderItemId. Reconcile from the LAST server
// response (authoritative) rather than from the optimistic clear.
async function handleRemoveInvalidClick(e) {
    const btn = e.target.closest('[data-action="remove-all-unavailable"]');
    if (!btn) return;
    // Share the qty-mutation gate so this can't interleave with a stepper round-trip.
    if (_qtyMutationInflight) return;
    _qtyMutationInflight = true;
    try {
        // Optimistic clear: drop blocked lines from state + local v4_cart so the UI updates
        // immediately, then let the server response reconcile the authoritative state.
        const localItems = getV4Cart().items || [];
        const localById  = new Map(localItems.map(i => [String(i.id), i]));
        const localFor   = li => localById.get(String(li.itemId)) || null;
        const lines      = state.lines || [];
        const blocked    = lines.filter(li => isCartLineUnavailable(li, localFor(li)));
        if (!blocked.length) return;
        const blockedSet = new Set(blocked);
        state.lines = lines.filter(li => !blockedSet.has(li));

        // Remove blocked items from the local cart too. A blocked line with its own itemId
        // (normal OOS) removes directly; a price-invalid cloud stub carries no itemId, so
        // remove by elimination — every local item NOT backing a VALID line is a rejected one.
        const accounted = new Set();
        lines.filter(li => !blockedSet.has(li)).forEach(li => {
            if (li.itemId   != null && li.itemId   !== '') accounted.add(String(li.itemId));
            if (li.parentId != null && li.parentId !== '') accounted.add(String(li.parentId));
        });
        localItems.forEach(it => {
            if (it && !accounted.has(String(it.id)) && !accounted.has(String(it.parentId))) {
                v4RemoveItem(it.id, v4LineSig(it.subItems));
            }
        });
        renderCartItems();

        // ONE bulk call first: now that the slot is persisted server-side, delete_invalid can
        // recognise slot-unavailable lines and drop them all in a single request (also covers
        // cloud price-invalid stubs that carry no orderItemId). Avoids firing one call per item.
        // Guarded: removing the cart's last line makes the server reply status=0 ("cart is
        // empty"), which callCartApi throws on — that's an expected outcome here, not a failure.
        let resp = null, removed = 0;
        try {
            resp    = await callCartApi({ action: 'delete_invalid' });
            removed = Number(resp?.removed_count ?? resp?.result?.removed_count ?? 0);
        } catch (err) {
            console.warn('[checkout] delete_invalid:', err);
        }

        if (removed > 0 && resp) {
            // Bulk worked — reconcile straight from its response. No extra calls.
            const freshLocals = getV4Cart().items || [];
            applyCartResp(parseCartResp(resp), freshLocals,
                freshLocals.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
        } else {
            // Fallback: delete each blocked line by its orderItemId the way the per-row trash
            // button does (action=delete) — which the server always honours for slot-unavailable
            // lines. Each call is guarded so deleting the LAST line (status=0 "cart is empty")
            // can't abort the loop and strand the cart in the optimistically-cleared state.
            const orderItemIds = [...new Set(
                blocked.flatMap(li => (li._groupOrderItemIds && li._groupOrderItemIds.length)
                    ? li._groupOrderItemIds
                    : [li.orderItemId])
                    .filter(id => id != null && id !== ''))];
            let lastResp = null;
            for (const id of orderItemIds) {
                // Each delete returns the full updated cart. Keep the last SUCCESSFUL one to
                // reconcile from — avoids an extra round-trip. A delete that empties the cart
                // throws (status=0 "cart is empty"); that's expected, so clear lastResp and let
                // the empty-cart branch below settle it without an API call.
                try { lastResp = await callCartApi({ action: 'delete', itemId: id }); }
                catch (err) { console.warn('[checkout] remove invalid item:', err); lastResp = null; }
            }
            const freshLocals = getV4Cart().items || [];
            if (freshLocals.length && lastResp) {
                // Valid items remain — reconcile straight from the last delete's response.
                applyCartResp(parseCartResp(lastResp), freshLocals,
                    freshLocals.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
            } else {
                // Cart emptied (or response lost): loadCartSummary returns early with NO API
                // call when the local cart is empty, rendering the empty state without throwing.
                // This prevents the "cart shows empty but still has items" desync.
                await loadCartSummary();
            }
        }
    } catch (err) {
        console.warn('[checkout] Remove invalid items failed:', err);
    } finally {
        _qtyMutationInflight = false;
    }
}

// ─── Bill API ─────────────────────────────────────────────────
// CI3 parity: a single /client/cart call with action=add&cart= (empty) returns
// the full server cart state. Menu/grocery already sync each mutation, so by the
// time we land here the server cart matches localStorage — no reconciliation needed.
// CI3 ref: ue_silver/js/checkout.js loadCart() ~L22655.
async function loadCartSummary() {
    const localItems = getV4Cart().items || [];
    const subtotal   = localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0);

    // Pre-booking hand-off (/checkout/…?cart_type=3&eventId=…): the pre-booking cart
    // lives ONLY server-side — nothing is written to the local v4_cart — so we must
    // still call the cart API even with an empty local cart. callCartApi forwards
    // cart_type + eventId (both required to retrieve the pre-booking bucket).
    const _pbq = new URLSearchParams(location.search);
    const isPrebooking = !!(_pbq.get('cart_type') && _pbq.get('eventId'));

    // Same story for a dine-in running order: once every item has been pushed to the kitchen the
    // local v4_cart is empty, but the tab still exists server-side (items_already_added) and still
    // owes payment. Skipping the API here would strand the user on the empty-cart screen with no
    // way to reach Request Bill. Gated on the outlet flag so no other brand pays for the call.
    const maybeRunning = Number(cfg.running_order) === 1 && (cfg.orderType || '') === 'dine_in';

    if (!localItems.length && !isPrebooking && !maybeRunning) {
        state.lines = [];
        state.order = null;
        state.serverItemIds = {};
        // No API call on this path, so nothing refreshes the running-order buckets — clear them
        // rather than let renderCartItems repaint a stale tab from the previous response.
        state.isRunningOrder = false;
        state.alreadyAdded   = [];
        ['walletLi','discountTr','effectiveSubtotalTr','service_chargesTr',
         'packingTr','cashbackPossible','savingsSection','pointsStrip','loyaltyBand','promoEarnBanner','pointsRedeemTr','pointsBalanceStrip','gstTr','deliveryLi'].forEach(hide);
        const s = fmt(0);
        set('subTotalSpan', s); set('gstSpan', '—');
        set('totalSpan', s);   set('totalcost', s); set('totalcost_bill', s);
        updatePayCta(null);
        renderCartItems();
        return;
    }

    try {
        let resp   = await callCartApi({ action: 'add', cart: '{"items":[]}' });
        let parsed = parseCartResp(resp);

        // Defensive auto-heal: if server cart is empty but local cart has items, the
        // earlier sync (menu/grocery side) was dropped — typically the grocery is_slot_based
        // flag was missing. Force-push the local items now so the server cart catches up
        // and the bill reflects the right totals on this load. CI3 ref: cart bulk-add.
        if ((!parsed.lines || parsed.lines.length === 0) && localItems.length > 0) {
            const payload = JSON.stringify({
                items: localItems.flatMap(it => {
                    const qty  = Math.max(1, Math.round(Number(it.qty)) || 1);
                    const line = { itemId: String(it.parentId || it.id), qty };
                    if (Array.isArray(it.bogoWire) && it.bogoWire.length) {
                        // BOGO carries a pre-built NESTED wire (each step's addons nested in its
                        // main item) — prefer it over the flat local subItems. parentItemId/viewType
                        // are what make the server run BOGO logic on the line; sending the wire
                        // without them (as this path used to) ships a line the server prices flat.
                        line.parentItemId = '0'; line.viewType = 3; line.subItems = it.bogoWire;
                    } else if (Array.isArray(it.subItems) && it.subItems.length) {
                        if (it.subItems.some(s => s && s.isCombo)) {
                            // Combo components go up in their own wire shape, not raw local
                            // subItems — raw ones carry `sp`/no parentItemId and mis-parent the
                            // children. Mirrors menu.js comboWireSubs().
                            line.parentItemId = '0';
                            line.subItems = it.subItems.map(s => ({
                                itemId: String(s.itemId), qty: String(+s.qty || 1), parentItemId: '0',
                                price: String(+s.sp || 0), subItems: [], isCombo: true,
                            }));
                        } else {
                            line.subItems = it.subItems;
                        }
                    }
                    // A customized line goes up as qty copies of a qty-1 line — same reason, and
                    // same ceiling, as menu.js cartEntryToWireLines: insertIntoCart() stores a
                    // sub-item's qty as sent, so one qty-N parent over a qty-1 child desyncs on
                    // the first "−" and hands the POS an add-on with quantity 0 (RCA: 48792947).
                    if (!line.subItems) return [line];
                    return Array.from({ length: Math.min(qty, 99) }, () => ({ ...line, qty: 1 }));
                }),
            });
            resp   = await callCartApi({ action: 'add', cart: payload });
            parsed = parseCartResp(resp);
        }

        applyCartResp(parsed, localItems, subtotal);
    } catch (err) {
        console.warn('[checkout] Cart summary failed:', err);
        // CRITICAL: cart MUST NOT render from localStorage when the API fails. Clear
        // server state, show the empty cart, disable Pay, and surface the server's
        // reason. Letting a stale local cart render is a payment-integrity bug —
        // the user could submit a cart the server has already invalidated.
        state.lines = [];
        state.order = null;
        state.serverItemIds = {};
        ['walletLi','discountTr','effectiveSubtotalTr','service_chargesTr',
         'packingTr','cashbackPossible','savingsSection','pointsStrip','loyaltyBand','promoEarnBanner','pointsRedeemTr','pointsBalanceStrip','gstTr','deliveryLi'].forEach(hide);
        const s = fmt(0);
        set('subTotalSpan', s); set('gstSpan', '—');
        set('totalSpan', s);   set('totalcost', s); set('totalcost_bill', s);
        updatePayCta(null);
        renderCartItems();
        showError(err?.message || 'Could not load your cart. Please try again.');
    }
}

// ─── Bill rendering ───────────────────────────────────────────

// The delivery charge that was waived when an order qualifies for free delivery.
// Prefer the server's pre-waiver `slash_delivery_charges`; fall back to the outlet's
// base delivery charge + any surge (same source the membership-savings block uses).
// Returns 0 when nothing was actually waived (so the strike/saving is suppressed).
function waivedDeliveryCharge(o) {
    const slash = Number(o?.slash_delivery_charges);
    if (Number.isFinite(slash) && slash > 0) return slash;
    const base = Number(o?.onlineOrdersDeliveryCharges || 0) + Number(o?.dc_surge_applied || 0);
    return base > 0 ? base : 0;
}

function renderBillFull(o, localSubtotal) {
    // Trust the server's subTotal by default. Two cases where we override:
    //   1. BOGO present — server inflates order-level subTotal by summing all subItems
    //      (including variants that should be zeroed). Recompute from line-level data.
    //   2. Dynamic combo present — server double-counts the combo (parent + components).
    // Invalid / out-of-stock lines are NOT excluded from the displayed Item Total: CI3
    // shows the full orderDetails.subTotal (checkout.js:30726) including blocked items and
    // gates checkout via the Pay button instead. Excluding them produced a misleading
    // "Item Total ₹0" when an OOS combo was the only item in the cart.
    const lines = state.lines || [];
    const hasBogoLine = lines.some(li => Number(li.viewType) === 3)
        || (state.cart?.items || []).some(it => Number(it.viewType) === 3);
    // Dynamic combo (viewType 2 + dynamic_combo 1): the server inflates the ORDER-level
    // subTotal by adding the combo's components ON TOP of the combo line (₹239 line → 478
    // order). App parity (consumption spec §5.1): the combo line sell = Σ subItems.subTotal,
    // never parent + subItems. Recompute the bill subtotal from line data when present.
    // NOTE: display-only — the charge derives from the server's stored order (orderId), so
    // this corrects the shown bill but NOT the amount charged until the stored order is fixed.
    const hasComboLine = lines.some(li => String(li.viewType) === '2' && String(li.dynamic_combo) === '1');
    const serverSubTotal = Number(o.subTotal || 0);
    let subTotal;
    if ((hasBogoLine || hasComboLine) && lines.length) {
        const localCart = (() => { try { return JSON.parse(localStorage.getItem('v4_cart') || '{}'); } catch { return {}; } })();
        const localById = new Map();
        (localCart.items || []).forEach(it => localById.set(String(it.id || it.parentId), it));
        subTotal = lines.reduce((sum, li) => {
            // Invalid/OOS lines stay IN the displayed Item Total (CI3 parity — see fn header).
            // The Pay button is blocked separately by updatePayCta → anyLineUnavailable().
            const base = Number(li.subTotal) || 0;
            const qty  = Number(li.qty) || 1;
            const subs = Array.isArray(li.subItems) ? li.subItems : Object.values(li.subItems || {});
            const hasSubs = subs.length > 0;
            // BOGO variant exclusion (matches syncLocalPricesFromServer logic)
            const isBogo = Number(li.viewType) === 3;
            const isDynCombo = String(li.viewType) === '2' && String(li.dynamic_combo) === '1';
            const variantIds = new Set();
            if (isBogo) {
                const localItem = localById.get(String(li.itemId));
                const localSubs = localItem && (Array.isArray(localItem.subItems) ? localItem.subItems : Object.values(localItem.subItems || {}));
                (localSubs || []).forEach(s => {
                    if (s && (Number(s.sp) === 0 || s.step !== undefined)) variantIds.add(String(s.itemId));
                });
            }
            const addonsSub = subs.reduce((s, c) => {
                if (!c) return s;
                if (variantIds.has(String(c.itemId))) return s;   // skip BOGO variants
                const v = Number(c.subTotal);
                return Number.isFinite(v) && v > 0 ? s + v : s;
            }, 0);
            // Dynamic combo: the line price IS the components (Σ subItems.subTotal). Adding
            // `base` (the parent combo price) on top is the server's double-count, so use the
            // component sum only. Otherwise CI3 convention (also in renderCartLineHTML): with
            // subItems, li.subTotal is per-unit (× qty); without, it's the full line total.
            const lineTotal = isDynCombo ? addonsSub * qty : (hasSubs ? (base + addonsSub) * qty : base);
            return sum + lineTotal;
        }, 0);
    } else {
        subTotal = serverSubTotal > 0 ? serverSubTotal : (Number(localSubtotal) || 0);
    }

    const discount = Number(o.discount || 0);
    const wallet   = Number(o.wallet_amount || 0);
    const delivery = Number(o.deliveryCharges || 0);
    const service  = Number(o.serviceCharges || 0);
    const packing  = Number(o.packaging_charges || 0);
    let   taxes    = Number(o.taxes || 0);
    // Cashback promos (discount_type 5/6) credit the wallet post-delivery rather than
    // discounting the bill. The server returns the amount as `cashbackvalue` (CI3
    // getOrderDetails / pay_model.php); `cashback` never exists → the row stayed hidden.
    const cashback = Number(o.cashbackvalue ?? o.cashback ?? 0);
    // GST + Grand Total: always trust the server's authoritative values. `o.taxes` is
    // the official tax that composes `o.totalAmt` (what the payment gateway charges).
    // `taxBreakUp` is informational only — it may include extra rows (delivery-tax,
    // packaging-tax, independently-rounded CGST/SGST halves) that aren't reflected in
    // `o.taxes` or `o.totalAmt`. Inflating the headline GST or Grand Total to match the
    // breakup sum causes the checkout to show a higher amount than the next /payment
    // screen, where ₹o.totalAmt is what's actually charged. CI3 ref: checkoutPage_*.js
    // `$('#gstSpan').html(currency + orderDetails['taxes'])` — direct display.
    const breakup  = Array.isArray(o.taxBreakUp) ? o.taxBreakUp : [];
    let   total    = Number(o.totalAmt || 0);
    // Override (server bug workaround): when we corrected subTotal because of BOGO
    // double-counting or because an OOS line shouldn't be charged, the server's tax
    // and total are still based on the inflated subTotal. Scale tax proportionally
    // and rebuild total so the bill stays internally consistent.
    if ((hasBogoLine || hasComboLine) && serverSubTotal > 0 && subTotal !== serverSubTotal) {
        const ratio = subTotal / serverSubTotal;
        taxes = +(taxes * ratio).toFixed(2);
        // Rebuild total from corrected pieces: subTotal + taxes + fixed charges (delivery,
        // service, packing) − discount − wallet. These fixed charges don't depend on subTotal.
        total = +(subTotal + taxes + delivery + service + packing - discount - wallet).toFixed(2);
    }
    const gstTotal = taxes;

    set('subTotalSpan', fmt(subTotal));

    // Wallet
    if (wallet > 0) { set('walletUsed', '− ' + fmt(wallet)); show('walletLi'); }
    else hide('walletLi');

    // Item-wise points redemption — summed from the lines, since the order level
    // carries nothing for it (totalAmt/wallet_amount/grandSaving all ignore it,
    // see docs/Loyalty-Item-Wise-Local-Verification.md §9). Grand Total below still
    // comes from the server untouched: it is what /pay/initiate charges, and a
    // client-side subtraction here would put a different number on the two screens.
    const redeemedPts = committedBurnPoints();
    const redeemedAmt = redeemedBillAmount();
    if (redeemedPts > 0 && redeemedAmt > 0) {
        set('pointsRedeemPts', ptsU(redeemedPts));
        set('pointsRedeemAmt', fmt(redeemedAmt));
        show('pointsRedeemTr');
    } else {
        hide('pointsRedeemTr');
    }

    // Promo discount
    if (discount > 0) {
        set('discountSpan', fmt(discount));
        show('discountTr');
    } else {
        hide('discountTr');
    }

    // Effective Sub Total — shown when a discount OR wallet reduces the item total,
    // and nets out BOTH. CI3 parity: ue_silver/checkout.js →
    // `if (discount > 0 || walletAmount > 0) { subtotal - discount - walletAmount }`.
    // Wallet-only carts (discount = 0) still get the row; the old port hid it.
    if (discount > 0 || wallet > 0) {
        set('effectiveSubtotalSpan', fmt(subTotal - discount - wallet));
        show('effectiveSubtotalTr');
    } else {
        hide('effectiveSubtotalTr');
    }

    // Delivery charge — only relevant for the delivery flow, and only once the user has
    // selected an address (server-computed charges are address-dependent). No "Pickup Charges".
    const ot = cfg.orderType || 'delivery';
    if (ot === 'delivery' && state.selectedAddressId) {
        const delEl  = el('freeDeliveryTr');
        const delRow = el('deliveryLi');
        if (delEl) {
            if (delivery === 0) {
                // Free delivery — one label for every reason it's waived (membership,
                // promo, MOV threshold, brand default). Strike through the charge that
                // was waived (when known) so the customer sees the benefit.
                const label  = 'Yay! free delivery';
                const waived = waivedDeliveryCharge(o);
                delEl.innerHTML = waived > 0
                    ? `<span class="bill__strike">${fmt(waived)}</span><span class="bill__free">${label}</span>`
                    : label;
            } else {
                delEl.textContent = fmt(delivery);
            }
        }
        if (delRow) delRow.classList.toggle('bill__row--positive', delivery === 0);
        show('deliveryLi');
    } else {
        hide('deliveryLi');
    }

    // Service, packaging
    if (service > 0) { set('service_charges', fmt(service)); show('service_chargesTr'); }
    else hide('service_chargesTr');

    if (packing > 0) { set('packingChargSpan', fmt(packing)); show('packingTr'); }
    else hide('packingTr');

    // GST + breakup. Headline value is `o.taxes` (authoritative); the tooltip below
    // iterates the full `taxBreakUp` array (CGST, SGST, "5% GST on Delivery Charge",
    // "18% GST on Packaging Charges", etc.) for transparency. CI3 ref: ue_silver/js/
    // checkout.js:28886-28900.
    if (gstTotal > 0) {
        set('gstSpan', fmt(gstTotal));
        const host = el('gstBreakupRows');
        if (host) {
            // CI3 displays breakup values without trailing zeros (e.g. "₹2.5", not "₹2.50").
            // Use the same locale formatter as the main bill rows so 5% delivery tax matches
            // CI3's rendering and the visual line totals reconcile cleanly.
            const numFmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
            if (breakup.length) {
                host.innerHTML = breakup.map(b => {
                    const title = String(b?.title || b?.code || '');
                    const value = Number(b?.value ?? b?.amount ?? 0);
                    return `<div class="between"><span>${esc(title)}</span><span>₹${esc(numFmt(value))}</span></div>`;
                }).join('');
            } else {
                // Fallback for outlets that return no breakup — split equally (CI3 commented fallback).
                const half = numFmt(gstTotal / 2);
                host.innerHTML = `<div class="between"><span>CGST</span><span>₹${half}</span></div>
                                  <div class="between"><span>SGST</span><span>₹${half}</span></div>`;
            }
        }
        show('gstTr');
    } else {
        hide('gstTr');
    }

    // Cashback
    if (cashback > 0) {
        set('cashbackSpan', 'Cashback');
        set('cashbackEarned', fmt(cashback));
        show('cashbackPossible');
    } else {
        hide('cashbackPossible');
    }

    // Totals
    set('totalSpan',      fmt(total));
    set('totalcost',      fmt(total));
    set('totalcost_bill', fmt(total));

    // Savings banner — prefer the server's pre-computed `grandSaving` which already
    // bundles MRP-vs-SP item savings, promo discount, wallet, and BOGO saving_total.
    // CI3 ref: client.php:6062 sets grandSaving = saving + discount + wallet_amount
    // + saving_total. Falling back to discount+wallet preserves the prior behavior
    // for any outlet whose response doesn't carry the field.
    const grandSaving = Number(o.grandSaving || 0);
    let   savings     = grandSaving > 0 ? grandSaving : (discount + wallet);
    // Fold the waived delivery charge into the headline savings. grandSaving (CI3:
    // client.php:6062) bundles item + promo + wallet + saving_total but NOT delivery,
    // so add it here when an address-selected delivery order qualifies for free delivery.
    if (ot === 'delivery' && state.selectedAddressId && delivery === 0) {
        savings += waivedDeliveryCharge(o);
    }
    // …and the item-wise redemption, for the same reason: grandSaving is computed
    // order-level and knows nothing about per-line points (client.php:6062).
    savings += redeemedAmt;
    // Stashed for renderPointsStrip (runs after this), which folds the earn
    // figure into this SAME banner rather than showing a second one — see there.
    state.grandSavingsAmount = savings;
    if (savings > 0) {
        const msgEl = el('savingsMessage');
        if (msgEl) msgEl.innerHTML = `You are saving <strong>${fmt(savings)}</strong> on this Order!`;
        show('savingsSection');
    } else {
        hide('savingsSection');
    }
}

// ─── Slot visibility ──────────────────────────────────────────
// CI3 ref: assets/themes/ue_silver/js/checkout.js updateSlotDisplay() ~L8560.
// The slot row only appears when the outlet has slotsAvailable=1 AND the
// current order type qualifies (delivery + onlineDeliveryOn/Delivery,
// pickup + !pick_drive + selfPickup, in_car + inCarOrders). Dine-in never gets one.
// A slot is OFFERED for the given order type when the outlet has slotsAvailable=1 AND the
// order type qualifies. CI3 ref: isSlotsAvailable() + getCurrentOrderType() in
// ue_silver/js/checkout.js. This — NOT cfg.is_slot_based — is the authoritative signal for
// both showing the slot row and gating the Pay CTA. is_slot_based is too narrow: brands that
// offer slots without that flag (e.g. Good Meat Company) would otherwise skip the slot gate.
// Reads slot fields from the passed order when present, else the authoritative state.order.
function slotsOfferedFor(ot, order) {
    const o = (order && order.slotsAvailable !== undefined) ? order : (state.order || {});
    if (Number(o.slotsAvailable ?? 0) !== 1) return false;
    if (ot === 'delivery') return Number(o.onlineDeliveryOn ?? 0) === 1 && Number(o.onlineOrdersDelivery ?? 0) === 1;
    if (ot === 'pickup')   return Number(o.pick_drive ?? 0) === 0 && Number(o.onlineOrdersSelfPickup ?? 0) === 1;
    if (ot === 'in_car')   return Number(o.inCarOrders ?? 0) === 1;
    // dine_in: never shows slot row
    return false;
}

function applySlotVisibility(order) {
    const ot           = cfg.orderType || 'delivery';
    const showDelivery = ot === 'delivery' && slotsOfferedFor('delivery', order);
    const showPickup   = ot === 'pickup'   && slotsOfferedFor('pickup', order);
    if (showDelivery) show('slotRow');       else hide('slotRow');
    if (showPickup)   show('pickupSlotRow'); else hide('pickupSlotRow');
}

// ─── Promo / wallet applicability gating ─────────────────────
// CI3 ref: ue_silver/js/checkout.js:27994-28038 — null/undefined means enabled,
// only an explicit '0' (string or number) marks a line as blocked.
function isAllBlocked(lines, key) {
    if (!Array.isArray(lines) || lines.length === 0) return false;
    return lines.every(li => {
        const v = li?.[key];
        if (v === null || v === undefined) return false; // null = enabled per CI3
        const s = String(v).trim();
        return s === '0' || s === '';
    });
}
const isPromoBlockedByCart  = () => isAllBlocked(state.lines, 'promo_applicable_master');
const isWalletBlockedByCart = () => isAllBlocked(state.lines, 'wallet_applicable_master');

// CI3 parity (Phase 8.30, ue_silver/js/checkout.js:85 `isWalletPromoCombinedAllowed`):
// parent-level flag allowing a wallet redemption and a promo to stack on one order.
// Default false — wallet and promo are mutually exclusive unless the outlet opts in.
const isWalletPromoCombinedAllowed = () =>
    String(state.order?.wallet_promo_combined_allowed ?? '') === '1';

// Wallet spend of EITHER kind. state.walletApplied only tracks the order-level
// wallet (it's set from wallet_amount), which an item-wise redemption never moves —
// the points land on the lines instead. Reading it alone let a promo through on a
// cart whose items were already paid for in points: the server then recalculated
// those lines and the ₹0 the customer had redeemed for came back as a charge.
// An item-wise redemption IS a wallet deduction (the points ledger is the wallet),
// so it belongs on the same side of the clubbing rule.
const isWalletSpent = () => !!state.walletApplied || committedBurnPoints() > 0;

// CI3 has TWO distinct promo subtotals (ue_silver/js/checkout.js):
//   1. currentSubTotal (17622-17627) → modal header "Eligible Cart Value". Sum of each
//      promo-eligible item's OWN price; addons (nested subItems) are NOT counted. This is
//      what `promoEligibleSubtotal` returns below.
//   2. calculatePromoApplicableSubtotal(promo) (18478) → the actual min_order_value / discount
//      base, computed PER PROMO. It (a) filters by the promo's valid_cond sections too and
//      (b) adds addon subItems ONLY when promo.applicable_on_addons == 1. This is
//      `promoApplicableSubtotal` below.
// CI4 nests addons/variants under subItems[]; a line's OWN price is li.subTotal (base) — for
// dynamic combos the price lives in the components (Σ subItems.subTotal, server double-counts
// parent + components), and BOGO addons exclude the free variant (sp=0 / step). Variant/size
// prices are already baked into li.subTotal (see renderCartLineHTML:632-634), so they need no
// special handling here.
const isPromoEligibleRow = (x) => x?.promo_applicable_master == 1 || x?.promo_applicable_master == null;

// v4_cart lookup by id/parentId — only needed to detect BOGO free-variant subItems (sp=0/step).
function buildLocalById() {
    const localCart = (() => { try { return JSON.parse(localStorage.getItem('v4_cart') || '{}'); } catch { return {}; } })();
    const map = new Map();
    (localCart.items || []).forEach(it => map.set(String(it.id || it.parentId), it));
    return map;
}
function bogoVariantIds(li, localById) {
    const ids = new Set();
    if (Number(li.viewType) !== 3 || !localById) return ids;
    const localItem = localById.get(String(li.itemId));
    const localSubs = localItem && (Array.isArray(localItem.subItems) ? localItem.subItems : Object.values(localItem.subItems || {}));
    (localSubs || []).forEach(s => { if (s && (Number(s.sp) === 0 || s.step !== undefined)) ids.add(String(s.itemId)); });
    return ids;
}

// Per-line promo value. `withAddons` adds paid addon subItems (applicable_on_addons=1).
// Dynamic combos always use the component sum (the components ARE the price, not extras);
// BOGO free variants (sp=0/step) are always excluded.
function promoLineValue(li, localById, withAddons) {
    const base = Number(li.subTotal) || 0;
    const qty  = Number(li.qty) || 1;
    const subs = Array.isArray(li.subItems) ? li.subItems : Object.values(li.subItems || {});
    if (!subs.length) return base; // no subItems → li.subTotal is already the full line total
    if (String(li.viewType) === '2' && String(li.dynamic_combo) === '1') {
        const comp = subs.reduce((s, c) => { const v = Number(c && c.subTotal); return Number.isFinite(v) && v > 0 ? s + v : s; }, 0);
        return comp * qty;
    }
    if (!withAddons) return base * qty;
    const variantIds = bogoVariantIds(li, localById);
    const addons = subs.reduce((s, c) => {
        if (!c || !isPromoEligibleRow(c)) return s;        // CI3 filters child rows too
        if (variantIds.has(String(c.itemId))) return s;    // skip BOGO free variants
        const v = Number(c.subTotal);
        return Number.isFinite(v) && v > 0 ? s + v : s;
    }, 0);
    return (base + addons) * qty;
}

// (1) Header "Eligible Cart Value": eligible items' own price, addons excluded.
// (withAddons=false short-circuits before BOGO-variant detection, so no localById needed.)
function promoEligibleSubtotal(lines) {
    return (lines || []).reduce((sum, li) => isPromoEligibleRow(li) ? sum + promoLineValue(li, null, false) : sum, 0);
}

// (2) Per-promo subtotal for min_order_value + discount base. Filters by promo_applicable_master
// AND the promo's valid_cond sections, and includes addons only when applicable_on_addons == 1.
function promoApplicableSubtotal(lines, promo) {
    const arr = lines || [];
    const withAddons = parseInt(promo?.applicable_on_addons || 0, 10) === 1;
    const localById = (withAddons && arr.some(li => Number(li.viewType) === 3)) ? buildLocalById() : null;
    const norm = s => String(s || '').trim().toLowerCase();
    const validRaw  = (promo?.valid_cond || '').trim();
    const validSlugs = validRaw ? new Set(validRaw.split(',').map(norm).filter(Boolean)) : null;
    return arr.reduce((sum, li) => {
        if (!isPromoEligibleRow(li)) return sum;
        if (validSlugs && !validSlugs.has(effectiveSectionSlug(li, arr))) return sum;
        return sum + promoLineValue(li, localById, withAddons);
    }, 0);
}

// (3) Per-promo eligible ITEM COUNT for min_qty / buy-N-get-N promos (e.g. B2G1,
// discount_type 14). Mirrors promoApplicableSubtotal's row filter (promo_applicable_master
// + the promo's valid_cond sections) but sums qty instead of value. Zero-priced lines
// (BOGO free variants / freebies) are excluded — the server counts
// `sum(qty) WHERE isPromoApplicable=1 AND subTotal!=0`. CI3 ref: client_model min_qty check.
function promoApplicableQty(lines, promo) {
    const arr = lines || [];
    const norm = s => String(s || '').trim().toLowerCase();
    const validRaw  = (promo?.valid_cond || '').trim();
    const validSlugs = validRaw ? new Set(validRaw.split(',').map(norm).filter(Boolean)) : null;
    return arr.reduce((sum, li) => {
        if (!isPromoEligibleRow(li)) return sum;
        if (validSlugs && !validSlugs.has(effectiveSectionSlug(li, arr))) return sum;
        if (Number(li.subTotal) === 0) return sum;
        return sum + (Number(li.qty) || 1);
    }, 0);
}

// ─── Wallet rendering ─────────────────────────────────────────
// Mirrors CI3 ue_silver/check_out_new.php:507-549 + ue_silver/js/checkout.js:29501-29523.
// Gate: wallet=1 && wallet_as_payment_mode=0 && (any balance source > 0).
// Disable when every cart line has wallet_applicable_master === 0.
function renderWallet(order) {
    const wrap = el('walletDiv');
    if (!wrap) return; // outlet hides wallet entirely via $hideWallet — markup is omitted

    const walletOn    = String(order?.wallet ?? '') === '1';
    const payModeOnly = String(order?.wallet_as_payment_mode ?? '') === '1';
    const amount      = Number(order?.wallet_amount    || 0);
    const available   = Number(order?.wallet_available || 0);
    const total       = Number(order?.wallet_total     || 0);
    const hasBalance  = amount > 0 || available > 0 || total > 0;

    if (!walletOn || payModeOnly || !hasBalance) { hide('walletDiv'); return; }

    // Item-based brands don't use the flat order-level wallet — the two models
    // are mutually exclusive, and applying both to one order double-discounts
    // it. But an order that ALREADY carries a flat wallet still needs its
    // Remove control, or the customer is stuck with a discount they can't undo
    // (and, on an item-based brand, can't redeem points properly either until
    // it's cleared). So: hide the entry point, keep the exit.
    if (String(cfg.item_based_loyalty ?? '') === '1' && amount <= 0) { hide('walletDiv'); return; }

    const allBlocked = isWalletBlockedByCart();

    show('walletDiv');
    const span = el('walletspan');
    // CI3 parity (ue_silver/js/checkout.js renderWallet ~L29480): the wallet is NOT gated on
    // per-line OOS. An out-of-stock line is excluded from the bill total, so the wallet still
    // applies to the remaining valid items; the Pay CTA stays blocked separately (updatePayCta
    // → anyLineUnavailable) until the item is removed, after which the applied wallet persists.
    if (allBlocked && amount === 0) {
        wrap.classList.add('co-wallet--disabled');
        if (span) span.hidden = true;
        set('walletTotalAmount', 'Wallet not applicable on cart items');
        set('discount_amount', '');
        return;
    }
    wrap.classList.remove('co-wallet--disabled');
    if (span) span.hidden = false;

    const name = (order?.walletName && String(order.walletName).trim())
              || cfg.wallet_name || 'Wallet';
    const btn = el('applyWalletBtn');
    if (amount > 0) {
        set('walletTotalAmount', 'Wallet Applied');
        set('discount_amount', `Yay! You saved ₹${amount} using ${name}`);
        if (btn) btn.textContent = 'Remove';
        state.walletApplied = true;
        wrap.classList.add('co-wallet--applied');
    } else {
        set('walletTotalAmount', `Available ${name}: ${total || available}`);
        set('discount_amount', order?.wallet_rule || 'Use Wallet Balance');
        if (btn) btn.textContent = 'Apply';
        state.walletApplied = false;
        wrap.classList.remove('co-wallet--applied');
    }
}

// ─── Item-wise points ─────────────────────────────────────────
// Read-only for now: the cart shows what each line earns and what it would cost
// in points, but nothing here redeems. Redemption is a wallet deduction scoped to
// a line — the points ledger IS wallet.available — and it needs a per-line column
// on addo_order_items before it can be recorded.
//
// Gated on the brand flag the same way the menu is, with the same dev bypass:
// wallet_rules.item_based_loyalty reads 0 for every brand in the live DB while the
// programme is configured in UAT, so the flag can only gate the call when we're
// pointed at the same environment it describes.
async function loadBurnCatalog() {
    const sameEnv = String(getConfig().loyaltyBase || '') === String(getCrmBase() || '');
    if (sameEnv && String(cfg.item_based_loyalty ?? '') !== '1') return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('userdata') || 'null'); } catch { user = null; }
    const catalog = await fetchBurnCatalog({ parentId: cfg.parentId, businessId: cfg.businessId, user });
    if (!catalog || catalog.blockedReason) return;
    state.burnCatalog = catalog;
    // The balance strip depends only on the catalog (not on cart lines), so it
    // repaints as soon as this resolves regardless of whether the order has
    // landed yet. applyCartResp's own prebooking branch re-hides it if needed.
    renderPointsBalance();
    // Repaint whatever has already landed — the cart response usually beats this.
    if (state.order) {
        // Repaints #pointsStrip, the Savings Corner earn banner, AND the bill's
        // combined savings/earn line — all three read `computeEarn()` inside
        // this one call. Without this repaint they'd stay stuck at whatever
        // they computed before the catalog arrived (usually earn=0, hidden).
        renderPointsStrip(state.order);
        // renderSavingsCorner's OWN promo-state branches (empty/bare/suggested)
        // don't depend on the catalog, but re-running it here is cheap and
        // keeps it in sync with whatever renderPointsStrip just changed.
        renderSavingsCorner(state.order, state.promos);
    }
    if (state.lines.length) renderCartItems();
    if (state.suggs.length) renderRecommendations(state.suggs, state.lines);
}

// The catalog row for a server cart line, joined through the feed (the catalog is
// keyed by item_slug and cart lines carry none). Null whenever anything in that
// chain is missing — the figure is simply not shown, never guessed.
//
// A variant line is keyed by the DEEP variant id (the size), which the feed map
// doesn't hold — it carries section items and one level of variants. So walk
// outwards: the line's own id, then its parent's. "Country Side Pizza [Regular]"
// resolves on the parent, whose slug (country-side-pizza) is what the catalog knows.
function burnRowForLine(li, localItem) {
    if (!state.burnCatalog || !li) return null;
    const ids = [li.itemId, li.parentId, localItem && localItem.parentId, localItem && localItem.id];
    for (const id of ids) {
        if (id == null || id === '') continue;
        const slug = feedItemMap[String(id)]?.slug;
        const row  = slug ? burnRowFor(state.burnCatalog, slug) : null;
        if (row) return row;
    }
    return null;
}

// What this cart earns, client-side only — cart lines against the catalog's
// per-item rates. Deliberately does not touch the backend's aggregate
// wallet_balance/wallet_total (see renderPointsStrip's header comment for why
// that field can't be trusted). Shared by renderPointsStrip and
// renderSavingsCorner so the two never disagree on the same number.
function computeEarn() {
    if (!state.burnCatalog) return 0;
    // The row chip resolves its catalog row through the LOCAL v4_cart entry as well
    // as the server line (lineStripHTML → burnRowForLine(li, localItem)), and for a
    // variant line that local entry is the only thing that reaches the catalog: the
    // server keys such a line by the deep variant id, which the feed map doesn't
    // hold. Walking only the server ids here made the total silently drop every
    // variant line it was already showing a figure for on the row.
    const locals = new Map(), counts = new Map();
    (getV4Cart().items || []).forEach(it => {
        if (!it || it.id == null) return;
        const id = String(it.id);
        locals.set(id, it);
        counts.set(id, (counts.get(id) || 0) + 1);
    });
    // Same ambiguity guard as renderCartItems' localFor: one local entry per itemId
    // or nothing, since two entries mean two different customizations.
    const localFor = li => (counts.get(String(li.itemId)) === 1 ? locals.get(String(li.itemId)) : null) || null;

    return (state.lines || []).reduce((sum, li) => {
        // A redeemed line earns nothing: the customer paid for it in points, not
        // money, so there's no spend for it to earn back on — counting it would
        // promise points the order won't credit.
        if (Number(li.wallet_points_redeemed || 0) > 0) return sum;
        // Same reasoning for a promo-granted freebie: it costs ₹0. The row already
        // renders no points strip for one (renderCartLineHTML), so counting it here
        // put points in the total that nothing on the line accounts for.
        if (String(li.freeItems) === '1') return sum;
        const localItem = localFor(li);
        // Qty read the same way the row does, so a line the server returns without
        // one isn't counted as a single unit against a row showing N.
        const qty = Number(li.qty || (localItem && localItem.qty) || 1);
        return sum + earnPointsForLine(burnRowForLine(li, localItem), qty);
    }, 0);
}

// "pickup" / "delivery" / "dine-in" — states explicitly (per the reference) so
// the customer isn't left assuming points land immediately, before the order
// is even fulfilled. Shared by both earn surfaces below, which word it
// slightly differently ("Credited after X" vs "X" alone).
function orderFulfilmentWord() {
    const ot = cfg.orderType || 'delivery';
    return ot === 'pickup' ? 'pickup' : ot === 'dine_in' ? 'dine-in' : ot === 'in_car' ? 'pickup' : 'delivery';
}
function creditedAfterLabel() {
    return `Credited after ${orderFulfilmentWord()}`;
}

function renderPointsStrip(order) {
    const earn = computeEarn();

    // Top-of-page instance, near the outlet/location row. Mobile-only — CSS
    // (checkout.css, min-width:768px) hides it on desktop, where the Savings
    // Corner instance below is the only one shown. JS just tracks earn>0 here;
    // the viewport gating is CSS's job so it stays correct across resizes.
    const stripEl = el('pointsStrip');
    if (stripEl) {
        if (earn > 0) {
            const textEl = el('pointsStripText'); if (textEl) textEl.textContent = `You'll earn +${ptsU(earn)} on this order`;
            set('pointsStripNote', creditedAfterLabel());
            stripEl.hidden = false;
        } else {
            stripEl.hidden = true;
        }
    }

    renderLoyaltyBand(earn);

    if (earn <= 0) return;   // nothing to add to the bill banner — renderBillFull's own stands as-is

    const savings = Number(state.grandSavingsAmount || 0);
    const banner  = el('savingsSection');
    const msgEl   = el('savingsMessage');
    if (!banner || !msgEl) return;
    msgEl.innerHTML = savings > 0
        ? `Savings <strong>${fmt(savings)}</strong> · Earning <strong>${ptsU(earn)}</strong>`
        : `Earning <strong>${ptsU(earn)}</strong>`;
    show('savingsSection');
}

// Rupees this order's redeemed lines take off the bill. Server-confirmed:
// walletAmtUsed is what /client/applyWallet wrote against the line, paired with
// the wallet_points_redeemed that bought it — never recomputed from the catalog,
// which can price an item differently after the fact.
function redeemedBillAmount() {
    return (state.lines || []).reduce((sum, li) =>
        Number(li.wallet_points_redeemed || 0) > 0 ? sum + Number(li.walletAmtUsed || 0) : sum, 0);
}

// The Savings Corner's points surface, in whichever of its two shapes applies.
//
// Nothing redeemed → the one-line green earn banner: a single figure and no
// action. Once the order has spent points, the two-up band takes over — it
// carries the second figure AND the Remove that undoes the whole redemption,
// neither of which fits the line. They're mutually exclusive, so exactly one is
// visible at a time (or neither, on an order with no points story at all).
function renderLoyaltyBand(earn) {
    const band = el('loyaltyBand');
    const redeemedPts = committedBurnPoints();
    const redeemedAmt = redeemedBillAmount();

    const earnOnlyEl = el('promoEarnBanner');
    if (earnOnlyEl) {
        if (earn > 0 && redeemedPts <= 0) {
            const textEl = el('promoEarnText'); if (textEl) textEl.innerHTML = `You will earn <strong>${ptsU(earn)}</strong> on this order`;
            set('promoEarnBannerNote', `after ${orderFulfilmentWord()}`);
            earnOnlyEl.hidden = false;
        } else {
            earnOnlyEl.hidden = true;
        }
    }

    if (!band) return;
    if (redeemedPts <= 0) { band.hidden = true; return; }

    set('loyaltyRedeemedPts', `−${ptsU(redeemedPts)}`);
    const saveEl = el('loyaltyRedeemedSave');
    if (saveEl) {
        saveEl.textContent = redeemedAmt > 0 ? `${fmt(redeemedAmt)} off this bill` : '';
        saveEl.hidden = redeemedAmt <= 0;
    }
    // Re-enable after a previous removal left it mid-flight (the band is
    // re-rendered from a fresh cart, so the old disabled state is stale).
    const removeBtn = el('loyaltyRemoveBtn');
    if (removeBtn) { removeBtn.disabled = false; removeBtn.textContent = 'Remove'; }
    const redeemedHalf = el('loyaltyRedeemedHalf');
    if (redeemedHalf) redeemedHalf.hidden = false;

    const earningHalf = el('loyaltyEarningHalf');
    if (earningHalf) {
        if (earn > 0) {
            set('loyaltyEarnPts', `+${ptsU(earn)}`);
            set('loyaltyEarnNote', creditedAfterLabel());
            earningHalf.hidden = false;
        } else {
            earningHalf.hidden = true;
        }
    }

    band.hidden = false;
}

// The band's Remove — one action for the whole order, so it clears every
// redeemed line rather than making the customer undo them one at a time.
// Sequential: each call mutates the same order. Server is the source of truth
// either way, so the cart AND the catalog are refetched regardless of outcome.
async function removeAllRedemptions() {
    const btn = el('loyaltyRemoveBtn');
    if (btn?.disabled) return;
    const ids = (state.lines || [])
        .filter(li => Number(li.wallet_points_redeemed || 0) > 0 && li.orderItemId)
        .map(li => String(li.orderItemId));
    if (!ids.length) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    // Same capture as the picker's undo path: after the refetch these points are no
    // longer anywhere in state, and the panel has to name what came back.
    const spentBefore = committedBurnPoints();
    const balBefore   = spendableBurnPoints();
    const errors = [];
    for (const oid of ids) {
        const resp = await removeItemRedemption(oid);
        if (Number(resp?.status) !== 1) errors.push(resp?.msg || 'Could not remove this redemption.');
    }
    await loadCartSummary();
    await loadBurnCatalog();
    if (errors.length) { errors.forEach(msg => showApplyToast('error', msg)); return; }
    // Succeeded silently before this — the band simply vanished, leaving the
    // customer to work out from the bill whether the points had come back.
    renderRedeemOutcome({ returned: true, points: spentBefore - committedBurnPoints(), balBefore });
}

// Balance strip — "what you have right now", separate from #pointsStrip's
// "what this order earns" promise above. Shown for any customer the catalog
// resolved in customer mode, even at a 0 balance (a day-N customer who has
// spent everything should still see their balance, not have the strip
// disappear) — guest mode never carries a balance (wallet_balance is null
// by design) so the strip stays hidden until the customer pair resolves it.
// Points this order has already committed. The CRM balance does NOT move when a
// line is redeemed — nothing reaches CRM until the order is actually placed — so
// the catalog keeps reporting the full figure while those points are, for every
// practical purpose, spent. Anything that treats walletBalance as "what's left to
// spend" has to net this out first, or the customer is offered points twice.
function committedBurnPoints() {
    return (state.lines || []).reduce(
        (sum, li) => sum + Math.floor(Number(li.wallet_points_redeemed || 0)), 0);
}

// What's genuinely spendable right now.
//
// The catalog balance is ALREADY net of this order's redemptions: /client/applyWallet
// debits CRM the moment a line is redeemed, and /client/removeWallet credits it back
// — verified against crm_api/loyalty/item_wise/earn_burn_catalog, 4780 → 4690 on
// apply and 4690 → 4780 on remove. Subtracting committedBurnPoints() here took the
// same points off a second time, so a 4780 balance with 90 redeemed displayed 4600
// instead of 4690, on both the strip and the picker.
//
// freedByRemoval is still added: a removal staged in the picker has NOT reached the
// server yet, so those points are spendable in this session while CRM still counts
// them as spent.
function spendableBurnPoints(freedByRemoval = 0) {
    const bal = Number(state.burnCatalog?.walletBalance || 0);
    return Math.max(0, bal) + freedByRemoval;
}

function renderPointsBalance() {
    const stripEl = el('pointsBalanceStrip');
    if (!stripEl) return;
    const catalog = state.burnCatalog;
    if (!catalog || catalog.mode !== 'customer' || catalog.walletBalance == null) {
        stripEl.hidden = true;
        return;
    }
    // Net of what this order already holds — showing the raw catalog figure reads
    // as "you still have 4000 to spend" right after 3250 of it went onto a line.
    const bal = spendableBurnPoints();
    // Figure only — the strip's own "Balance" label sits beside it in the markup.
    const textEl = el('pointsBalanceText');
    if (textEl) textEl.textContent = ptsU(bal);
    // A 0 balance alone isn't a reason to lock the picker: once points are spent
    // on cart lines the balance IS 0, and disabling the only way back in strands
    // the customer with redemptions they can't undo or move to a different item.
    // Closed only when there's genuinely nothing to do — no balance AND nothing
    // already redeemed to manage.
    const hasRedeemed = (state.lines || []).some(li => Number(li.wallet_points_redeemed || 0) > 0);
    const btn = el('pointsBalanceRedeemBtn');
    if (btn) {
        btn.disabled = bal <= 0 && !hasRedeemed;
        btn.textContent = (bal <= 0 && hasRedeemed) ? 'Manage' : 'Redeem';
    }
    stripEl.hidden = false;
}

// ─── Item-wise redemption apply/remove ─────────────────────────────────
// Reuses the SAME /client/applyWallet + /client/removeWallet endpoints the
// flat-wallet flow uses (toggleWallet, above) — item_based_loyalty=1 branches
// the backend into a per-line redemption instead of an order-level apply.
// See docs/Loyalty-Item-Wise-Frontend-Integration.md for the full contract.
async function applyItemRedemption(orderItemId, points) {
    const orderId = state.order?.orderId;
    if (!orderId) return { status: 0, msg: 'Add items to your cart first.' };
    const ud = userData();
    const p = new URLSearchParams({
        businessId:         cfg.businessId,
        contactMappingId:   ud.contactMappingId || '',
        token:              ud.token            || '',
        userId:             ud.contactId        || '',
        mobileNo:           ud.mobile           || ud.mobileNo || '',
        parentBusinessId:   cfg.parentId        || '',
        orderId,
        item_based_loyalty: '1',
        orderItemId,
        points,
    });
    try {
        const res = await fetch(`${getApiBase()}/client/applyWallet?${p}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        return await res.json();
    } catch {
        return { status: 0, msg: 'Could not redeem this item. Please try again.' };
    }
}
async function removeItemRedemption(orderItemId) {
    const orderId = state.order?.orderId;
    if (!orderId) return { status: 0, msg: 'Add items to your cart first.' };
    const ud = userData();
    const p = new URLSearchParams({
        businessId:         cfg.businessId,
        contactMappingId:   ud.contactMappingId || '',
        token:              ud.token            || '',
        userId:             ud.contactId        || '',
        mobileNo:           ud.mobile           || ud.mobileNo || '',
        parentBusinessId:   cfg.parentId        || '',
        orderId,
        item_based_loyalty: '1',
        orderItemId,
    });
    try {
        const res = await fetch(`${getApiBase()}/client/removeWallet?${p}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        return await res.json();
    } catch {
        return { status: 0, msg: 'Could not remove this redemption. Please try again.' };
    }
}

// ─── Redeem picker ──────────────────────────────────────────────
// "IN YOUR CART" — one row per redeemable cart LINE (not deduped by item):
// the backend redeems a specific orderItemId whole-line for one points cost,
// there's no partial quantity. wallet_points_redeemed > 0 on the server line
// (echoed by /client/cart) means it's already redeemed — that's the
// server-confirmed truth the row starts from, never something assumed
// client-side. "MORE ELIGIBLE ITEMS" is informational only: an item not yet
// in the cart has no orderItemId, so there's nothing to actually redeem
// against here — checkout has no add-item flow of its own (that's the menu
// page's eligible-items sheet, which DOES let you add).
//
// Checking/unchecking a cart line is staged locally (redeemSelection) until
// "Update cart" is clicked, which is when the real apply/remove call fires
// per line that changed from its server-confirmed state.
let redeemSelection = {};   // orderItemId (string) -> true if staged as redeemed

function slugImageMap() {
    const map = {};
    Object.values(feedItemMap).forEach(f => { if (f && f.slug && !map[f.slug]) map[f.slug] = f.image || ''; });
    return map;
}

function redeemItemImageURL(slug, imgMap) {
    const raw = imgMap[slug] || '';
    if (!raw) return '';
    return raw.startsWith('http') ? raw : `${getCdnBase()}/uploads/${cfg.parentId}/${raw}`;
}

function redeemCartRows() {
    const rows = [];
    (state.lines || []).forEach(li => {
        if (String(li.freeItems) === '1') return;   // already free — nothing to redeem
        if (!li.orderItemId) return;                 // no server line to reference
        const row = burnRowForLine(li);
        const perUnit = row ? redeemPointsForLine(row) : 0;
        const alreadyRedeemed = Number(li.wallet_points_redeemed || 0) > 0;
        if (perUnit <= 0 && !alreadyRedeemed) return;   // not redeemable and nothing to undo
        const qty   = Number(li.qty) || 1;
        // NO affordability filter here, deliberately — unlike the eligible list below.
        // A cart line the balance can't cover still belongs in this section, dimmed and
        // labelled "N short" (recomputeRedeemTotals), because the customer has an action
        // on it that the figure alone doesn't reveal: the row's own stepper. A ₹450 line
        // at 180 pts a unit costs 360 for two and is out of reach at 228 — but one unit
        // is not, and stepping down is how they get there. Hiding the row hides that
        // path and, when it is the only redeemable line, drops the whole sheet into the
        // "nothing to redeem" empty state under a balance that can plainly afford it.
        // The eligible list filters instead because those rows have no stepper and no
        // quantity to trade down — there is nothing to act on there.
        const price = Number(li.subTotal || (Number(li.sp || 0) * qty) || 0);
        // Whole-line points cost: the backend zeroes the entire line for one
        // charge, so the cost scales with how many units that frees, not a
        // flat per-unit figure. An already-redeemed line reports its actual
        // charged cost rather than recomputing from the (possibly since
        // changed) catalog rate.
        const pointsCost = alreadyRedeemed ? Number(li.wallet_points_redeemed || 0) : perUnit * qty;
        const parentName = String(li.parentName || '').trim();
        const itemName   = String(li.itemName   || '').trim();
        const name = (parentName && parentName !== 'null') ? `${parentName} (${itemName})` : itemName;
        rows.push({
            orderItemId: String(li.orderItemId),
            // The local v4_cart key, for the stepper: applyCartQtyMutation needs both ids
            // to hit the right line when several share an itemId (variants, BOGO).
            itemId: String(li.itemId || ''),
            slug: row ? String(row.item_slug || '') : '',
            // The other half of the row's choice, same as the menu's sheet states it:
            // redeeming this line forfeits what it would have earned.
            earn: row ? earnPointsForLine(row, qty) : 0,
            name, price, pointsCost, alreadyRedeemed, qty,
        });
    });
    return rows;
}

// The feed entry a "more eligible" row can actually be added by. The loyalty
// catalog is keyed by item_slug and carries no id, so the feed is what joins
// them — and a slug can resolve to more than one entry (a variant inherits its
// parent's slug when it has none of its own), hence the preference order.
//
// Null when the entry can't be added with a bare id: out of stock; priced at 0,
// which the cart API silently refuses; needs addon choices; or is a group rather
// than an orderable row — redeemGroupChildren handles that last case by offering
// the group's choices instead.
function feedAddTargetForSlug(slug) {
    if (!slug) return null;
    for (const [id, f] of Object.entries(feedItemMap)) {
        if (!f || String(f.slug) !== String(slug)) continue;
        if (f.oos || f.tmpl > 0 || f.variants > 0) continue;
        const sp = Number(f.sp) || 0;
        if (sp <= 0) continue;
        return { itemId: String(id), sp, veg: f.veg || '', name: f.name || '' };
    }
    return null;
}

// Deep link to an item on the outlet's menu, where its variants and add-ons can be
// chosen. Same shape the loyalty rail uses (railItemHref): ?item_slug opens that
// item's popup on arrival. cfg.slug is the outlet this checkout belongs to; without
// it the outlet picker is the honest destination.
function menuItemHref(slug) {
    const outlet = String(cfg.slug || '');
    const base = outlet ? `/order/${outlet}` : '/online-order';
    return slug ? `${base}?item_slug=${encodeURIComponent(slug)}` : base;
}

// The feed entry to DESCRIBE a slug with — name, price, image, diet marker.
//
// Deliberately separate from feedAddTargetForSlug above, which answers a much
// narrower question: "can this be added with a bare id". That one rejects an item
// with variants, with add-ons, out of stock, or priced 0 — and using it to decide
// what the eligible LIST may contain silently dropped most of the menu. A burger
// with add-ons is still a burger the points can claim; it just needs a tap through
// to the menu to choose them. Listing is not the same question as adding.
//
// Preference order: a priced, orderable leaf first (its figures are the ones the
// customer will pay), then any entry carrying the slug, so a group label or a
// variant parent still yields a name rather than nothing.
function feedEntryForSlug(slug) {
    if (!slug) return null;
    let fallback = null;
    for (const [id, f] of Object.entries(feedItemMap)) {
        if (!f || String(f.slug) !== String(slug) || !f.name) continue;
        const sp = Number(f.sp) || 0;
        if (!f.oos && f.tmpl === 0 && f.variants === 0 && sp > 0) {
            return { itemId: String(id), sp, veg: f.veg || '', name: f.name };
        }
        if (!fallback) fallback = { itemId: String(id), sp, veg: f.veg || '', name: f.name };
    }
    return fallback;
}

// The catalog prices some items by the GROUP they live in rather than by the
// orderable row: "Mutton Curry Cut Platinum Grade - 2kg" is a label holding
// three cuts, "Chicken Seekh Party Pack 2kg" holds six seekhs. The group itself
// has no price and can't be added, which is why those two rows alone came up
// without a checkbox while the other six eligible items had one.
//
// So offer the choices instead of the label. Every child in such a group carries
// the same price, and the redemption costs the group's points whichever one is
// picked — which is already how a cart line for one of these resolves its points
// (burnRowForLine walks out to the parent when the child has no catalog row of
// its own). A child priced differently from what the catalog quoted is left out:
// its real cost isn't knowable from here.
function redeemGroupChildren(slug, catalogPrice) {
    const groupIds = Object.entries(feedItemMap)
        .filter(([, f]) => f && String(f.slug) === String(slug) && f.variants > 0)
        .map(([id]) => String(id));
    if (!groupIds.length) return [];
    return Object.entries(feedItemMap)
        .filter(([, f]) => f && groupIds.includes(String(f.parentFeedId || ''))
                        && !f.oos && f.tmpl === 0 && f.variants === 0
                        && (Number(f.sp) || 0) > 0
                        && Number(f.sp) === Number(catalogPrice))
        .map(([id, f]) => ({ itemId: String(id), sp: Number(f.sp) || 0, veg: f.veg || '', name: f.name || '', slug: String(f.slug || '') }));
}

// ── Customisation, in place ───────────────────────────────────────────────
//
// Most "Choose" rows are not variant groups at all. On the one brand with
// item-wise loyalty live, all 17 of them are single priced items carrying ONE
// optional add-on group (minQty 0, maxQty 5) — a burger that could be added as it
// stands. feedAddTargetForSlug refuses them only because an item with templates
// can't be added by bare id, and the sheet then sent the customer to the menu to
// make choices they may not even want to make.
//
// So resolve the groups here and offer them in the sheet. A combo or a BOGO is
// excluded on purpose: those are step wizards (menu.js buildComboPopup /
// buildBogoPopup), not a list of extras, and reducing one to a set of checkboxes
// would build a line the kitchen can't read. Those keep the deep link.
function redeemAddonSpec(slug) {
    if (!slug) return null;
    for (const [id, f] of Object.entries(feedItemMap)) {
        if (!f || String(f.slug) !== String(slug)) continue;
        if (f.oos || f.variants > 0 || f.tmpl === 0) continue;
        if ((Number(f.sp) || 0) <= 0) continue;
        if (f.viewType === 2 || f.viewType === 3) continue;
        const groups = addonGroupsFor(f);
        if (!groups.length) continue;
        return { itemId: String(id), name: f.name || '', sp: Number(f.sp) || 0,
                 mrp: Number(f.mrp) || 0, image: f.image || '', desc: f.desc || '',
                 veg: f.veg || '', slug: String(slug), groups };
    }
    return null;
}

// The item's groups, hydrated from the pool. Mirrors menu.js loadTemplates():
// the comma-separated templateId string wins when present (it is the ordered
// list), otherwise the per-item entries; min/max always come from the per-item
// entry, since the same pool group carries different limits on different items.
function addonGroupsFor(f) {
    const perItem = Array.isArray(f.tmpls) ? f.tmpls : [];
    const ids = f.tmplIds
        ? String(f.tmplIds).split(',').map(s => s.trim()).filter(Boolean)
        : perItem.map(t => t && t.templateId).filter(Boolean).map(String);
    const groups = [];
    ids.forEach(tid => {
        const pool = feedTemplatePool[String(tid)];
        if (!pool) return;
        const meta  = perItem.find(t => String(t && t.templateId) === String(tid)) || {};
        // Out-of-stock rows are KEPT, dimmed and disabled — same as the menu's
        // popup. Dropping them silently shortens the list and leaves the customer
        // hunting for an add-on they know the brand sells.
        // Sorted by price ascending, which is the order the menu shows them in.
        const items = (pool.template || pool.items || [])
            .filter(x => x && x.id && !(+x.status === -1))
            .map(x => ({ id: String(x.id), name: x.itemName || '', sp: Number(x.sp) || 0,
                         veg: x.vegNonvegBoth || '', image: x.image || '',
                         oos: +x.out_of_stock === 1 }))
            .sort((a, b) => a.sp - b.sp);
        if (!items.length) return;
        groups.push({
            templateId: String(tid),
            name: meta.headerName || pool.headerName || items[0]?.sectionName || (pool.template || [])[0]?.sectionName || 'Add-ons',
            min: Math.max(0, Number(meta.minQty) || 0),
            // 0 means "no ceiling" in the feed, which is how CI3 reads it too.
            max: Math.max(0, Number(meta.maxQty) || 0),
            hint: choiceHintFor(Math.max(0, Number(meta.minQty) || 0), Math.max(0, Number(meta.maxQty) || 0)),
            items,
        });
    });
    return groups;
}

// Which slug the sheet is showing, and what's ticked in it. Keyed by
// `${templateId}:${itemId}` so the price footer and the Add payload read one map.
let choiceSlug = '';
let choiceSel  = {};

// Deliberately the MENU's markup, class for class: .popup-section / .popup-addon
// and the rest are styled in location_modal.css, which base.php loads on every
// page — so the same add-on list renders identically whether it was opened from
// an item card or from this sheet. Copying the classes and not the styles is the
// whole point: one set of rules, no second version to drift.
function openRedeemChoices(slug) {
    const spec = redeemAddonSpec(slug);
    const list = el('redeemChoicesList');
    if (!spec || !list) return;
    choiceSlug = String(slug);
    choiceSel  = {};

    // Left column: the item itself — picture, name, price, description. Without
    // it the sheet opens straight onto a list of extras with nothing to say what
    // is being customised.
    const hero = el('redeemChoicesHero');
    const img  = choiceImageURL(spec.image);
    if (hero) hero.innerHTML = img ? `<img src="${esc(img)}" alt="${esc(spec.name)}">` : '';
    const strike = spec.mrp > spec.sp && spec.sp > 0 ? `<s>${esc(fmt(spec.mrp))}</s>` : '';
    const meta = el('redeemChoicesMeta');
    if (meta) meta.innerHTML =
        `<h2 class="popup-name" id="redeemChoicesTitle">${choiceDotHTML(spec.veg)}<span>${esc(spec.name)}</span></h2>`
        + (spec.sp > 0 ? `<p class="co-choice-price">${strike}${esc(fmt(spec.sp))}</p>` : '')
        + (spec.desc ? `<p class="popup-desc">${esc(spec.desc)}</p>` : '');

    // The same strip the eligible row carried, so the points claim follows the
    // item into the sheet instead of disappearing at the tap that opened it.
    const strip = el('redeemChoicesStrip');
    if (strip) strip.innerHTML = recStripHTML(spec.slug);

    list.innerHTML = spec.groups.map(g => {
        const single = g.min === 1 && g.max === 1;
        // A single-pick group arrives with its first available option already
        // chosen, exactly as the menu's popup does — the choice is required, so
        // opening on an invalid state only makes the customer click to stand still.
        const firstAvail = single ? g.items.findIndex(x => !x.oos) : -1;
        return `<section class="popup-section" data-tid="${esc(g.templateId)}" data-min="${g.min}" data-max="${g.max}">
            <div class="popup-section-head">
                <h4 class="popup-section__title">${esc(g.name)} <span class="popup-section__badge popup-section__badge--${g.min > 0 ? 'required' : 'optional'}">${g.min > 0 ? 'REQUIRED' : 'OPTIONAL'}</span></h4>
                ${g.hint ? `<p class="popup-section__hint">${esc(g.hint)}</p>` : ''}
            </div>
            <div class="popup-section-error" hidden></div>
            <div class="popup-addons">${g.items.map((it, idx) => {
                const checked = single && idx === firstAvail;
                const thumb = choiceThumbHTML(it);
                const dot   = choiceDotHTML(it.veg);
                return `<label class="popup-addon${thumb ? ' popup-addon--media' : ''}${dot ? '' : ' popup-addon--nodot'}${it.oos ? ' off' : ''}${checked ? ' on' : ''}">
                    ${dot}
                    ${thumb}
                    <span class="popup-addon__body">
                        <span class="popup-addon__name">${esc(it.name)}</span>
                        <span class="popup-addon__price">${it.oos ? 'Out of stock' : `+${fmt(it.sp)}`}</span>
                    </span>
                    <input type="${single ? 'radio' : 'checkbox'}" name="addon-${esc(g.templateId)}" class="tc"
                           data-tmpl="${esc(g.templateId)}" data-id="${esc(it.id)}" data-nm="${esc(it.name)}"
                           data-pr="${it.sp}" data-veg="${esc(it.veg)}"${it.oos ? ' disabled' : ''}${checked ? ' checked' : ''}>
                </label>`;
            }).join('')}</div>
        </section>`;
    }).join('');
    // Seed the selection from the pre-checked radios, so the footer price and the
    // Add payload start out agreeing with what's on screen.
    list.querySelectorAll('input.tc:checked').forEach(readChoiceInput);
    enforceChoiceCaps();
    syncChoiceFooter();
    bindRedeemChoicesEvents();
    openModal('redeemChoicesOverlay');
}

// Item artwork lives under the PARENT business on the CDN, not the outlet —
// same path redeemItemImageURL builds for the rows in the sheet below.
function choiceImageURL(raw) {
    if (!raw) return '';
    return raw.startsWith('http') ? raw : `${getCdnBase()}/uploads/${cfg.parentId}/${raw}`;
}

function choiceThumbHTML(it) {
    const src = choiceImageURL(it.image);
    return src ? `<span class="popup-addon__thumb"><img src="${esc(src)}" alt="" loading="lazy"></span>` : '';
}

// The diet dot. The menu's own vegDotHTML emits .veg-mark, which lives in
// menu.css and isn't loaded here; .veg-marker is the design-system equivalent
// and is the same 14px the .popup-addon grid reserves for it.
function choiceDotHTML(veg) {
    const v = String(veg || '').toLowerCase();
    if (v === 'veg'     || v === '1') return '<span class="veg-marker" aria-hidden="true"></span>';
    if (v === 'non-veg' || v === '0') return '<span class="veg-marker veg-marker--nonveg" aria-hidden="true"></span>';
    if (v === 'egg'     || v === '2') return '<span class="veg-marker veg-marker--egg" aria-hidden="true"></span>';
    return '';
}

// Word for word the menu's qDesc (menu.js buildAddonsHtml) — the same rule must
// not be phrased two ways on two screens.
function choiceHintFor(min, max) {
    if (min && max && min === max) return `Please select any ${max} option${max > 1 ? 's' : ''}`;
    if (!min && max)               return `You can choose up to ${max} option${max > 1 ? 's' : ''}`;
    if (min && max)                return `Select a minimum of ${min} and a maximum of ${max}`;
    if (min && !max)               return `Select a minimum of ${min}`;
    return '';
}

// Closing leaves the redeem sheet exactly as it was — same scroll, same keyword,
// same ticks — because it was never touched: this is a second overlay above it,
// not a view swapped into it.
function closeRedeemChoices() {
    choiceSlug = '';
    choiceSel  = {};
    const list = el('redeemChoicesList');
    if (list) list.innerHTML = '';
    closeModal('redeemChoicesOverlay');
}

// Bound once, on the overlay itself: it lives outside #redeemSheetBody, so the
// redeem sheet's own delegation doesn't reach it.
function bindRedeemChoicesEvents() {
    const ov = el('redeemChoicesOverlay');
    if (!ov || ov.dataset.bound) return;
    ov.dataset.bound = '1';

    // Backdrop and ✕ both dismiss. Escape too, but only while this overlay is the
    // top one — otherwise one key press would close both sheets at once.
    ov.addEventListener('click', (e) => {
        if (e.target === ov || e.target.closest('#redeemChoicesClose')) closeRedeemChoices();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !ov.hidden) { e.stopPropagation(); closeRedeemChoices(); }
    }, true);

    ov.addEventListener('change', (e) => {
        const inp = e.target.closest('input.tc');
        if (!inp) return;
        // A radio group is single-pick: the browser unchecks its sibling without
        // firing an event for it, so rebuild the group's slice of the selection
        // from the DOM rather than trying to patch one key.
        if (inp.type === 'radio') {
            const sec = inp.closest('.popup-section');
            Object.keys(choiceSel).forEach(k => {
                if (k.startsWith(`${inp.dataset.tmpl}:`)) delete choiceSel[k];
            });
            sec?.querySelectorAll('input.tc:checked').forEach(readChoiceInput);
        } else if (inp.checked) {
            readChoiceInput(inp);
        } else {
            delete choiceSel[`${inp.dataset.tmpl}:${inp.dataset.id}`];
        }
        inp.closest('.popup-addon')?.classList.toggle('on', inp.checked);
        if (inp.type === 'radio') {
            inp.closest('.popup-section')?.querySelectorAll('.popup-addon').forEach(l => {
                l.classList.toggle('on', !!l.querySelector('input.tc')?.checked);
            });
        }
        // Clear the section's min error once they start selecting.
        const sec = inp.closest('.popup-section');
        const err = sec?.querySelector('.popup-section-error');
        if (err && sec.querySelectorAll('input.tc:checked').length > 0) err.hidden = true;
        enforceChoiceCaps();
        syncChoiceFooter();
    });

    // A locked option swallows its change event (the input is disabled), so the
    // reason is surfaced on the label's click — same two messages the menu uses.
    ov.addEventListener('click', (e) => {
        const oosLab = e.target.closest('.popup-addon.off');
        const maxLab = e.target.closest('.popup-addon.maxed');
        if (!oosLab && !maxLab) return;
        ov.querySelector('.popup-toast')?.remove();
        const t = document.createElement('div');
        t.className = 'popup-toast';
        t.textContent = oosLab ? 'This item is out of stock' : 'Cannot add more items in this section';
        ov.querySelector('.popup-sheet')?.appendChild(t);
        clearTimeout(ov._toast);
        ov._toast = setTimeout(() => t.remove(), 2000);
    });

    el('redeemChoicesAdd')?.addEventListener('click', async () => {
        const addBtn = el('redeemChoicesAdd');
        if (!addBtn || addBtn.disabled) return;
        const spec = choiceSpec();
        if (!spec) return;
        // Same validation the menu's Add to Cart runs: the CTA stays live and the
        // first section that isn't satisfied says so and is scrolled to. A disabled
        // button would leave the customer to work out which group is short.
        if (!validateChoiceSections()) return;
        const subItems = choiceSubItems();
        const label = addBtn.innerHTML;
        addBtn.disabled = true;
        addBtn.innerHTML = '<span class="popup-cta__label">Adding…</span>';
        try {
            const price = spec.sp + subItems.reduce((s, a) => s + a.sp, 0);
            await addItemToCart(spec.itemId, spec.name, price, spec.veg, subItems);
            closeRedeemChoices();
            renderCartItems();
            // The item is now a cart line, so it moves out of "More eligible items"
            // and into "In your cart", where it can be ticked for redemption.
            clearRedeemSearch();
            renderRedeemSheet({ keepSelection: true });
        } catch (err) {
            console.warn('[checkout] Failed to add customised item:', err);
            addBtn.disabled = false;
            addBtn.innerHTML = label;
        }
    });
}

// Word for word menu.js's own check, including the messages.
function validateChoiceSections() {
    let firstInvalid = null;
    document.querySelectorAll('#redeemChoicesList .popup-section').forEach(sec => {
        const min = Number(sec.dataset.min) || 0;
        const max = Number(sec.dataset.max) || 0;
        const cnt = sec.querySelectorAll('input.tc:checked').length;
        const err = sec.querySelector('.popup-section-error');
        let msg = '';
        if (min > 0 && cnt < min)      msg = `Please select at least ${min} option${min > 1 ? 's' : ''}`;
        else if (max > 0 && cnt > max) msg = `Please select up to ${max} option${max > 1 ? 's' : ''}`;
        if (msg) {
            if (err) { err.textContent = msg; err.hidden = false; }
            if (!firstInvalid) firstInvalid = sec;
        } else if (err) { err.hidden = true; }
    });
    if (firstInvalid) { firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; }
    return true;
}

function choiceSpec() { return choiceSlug ? redeemAddonSpec(choiceSlug) : null; }

function readChoiceInput(inp) {
    choiceSel[`${inp.dataset.tmpl}:${inp.dataset.id}`] = {
        id: inp.dataset.id, name: inp.dataset.nm || '',
        sp: Number(inp.dataset.pr) || 0, veg: inp.dataset.veg || '',
    };
}

// Mirror of menu.js enforceCaps: once a checkbox group is full, the remaining
// unchecked options are disabled and dimmed rather than silently refusing the
// tick. To swap a pick the customer unchecks one, which re-opens the slot.
function enforceChoiceCaps() {
    document.querySelectorAll('#redeemChoicesList .popup-section').forEach(sec => {
        const max = Number(sec.dataset.max) || 0;
        if (max <= 0) return;
        const boxes = sec.querySelectorAll('input.tc[type="checkbox"]');
        if (!boxes.length) return;   // radios are single-pick — no cap to apply
        const full = sec.querySelectorAll('input.tc:checked').length >= max;
        boxes.forEach(b => {
            const lab = b.closest('.popup-addon');
            if (lab && lab.classList.contains('off')) return;   // out of stock stays disabled
            const lock = full && !b.checked;
            b.disabled = lock;
            lab?.classList.toggle('maxed', lock);
        });
    });
}

function choiceSubItems() {
    return Object.values(choiceSel).map(a => ({
        itemId: String(a.id), itemName: a.name, sp: Number(a.sp) || 0,
        qty: 1, type: 2, veg: a.veg || '',
    }));
}

// The menu's CTA: running price on the left, action on the right.
function syncChoiceFooter() {
    const spec = choiceSpec();
    const btn  = el('redeemChoicesAdd');
    if (!spec || !btn) return;
    const total = spec.sp + choiceSubItems().reduce((s, a) => s + a.sp, 0);
    btn.innerHTML = `<span class="popup-cta__price">${esc(fmt(total))}</span>`
                  + '<span class="popup-cta__label">Add to Cart</span>';
}

// Items NOT in the cart that this balance can redeem right now.
//
// Deliberately not "everything the catalog lists": the catalog is every item the
// brand mapped to a loyalty class, which for a brand that maps its whole menu is
// the whole menu — and a bottom sheet that reprints the menu under the heading
// "you can redeem these" is simply wrong. The balance is the filter that makes
// the claim true, and it's net of what this order has already committed
// (spendableBurnPoints), since the CRM balance doesn't move until the order is placed.


// Both price states render up front; a pure-CSS :has() rule (theme.css)
// swaps which one shows based on the checkbox, so toggling never needs to
// touch this row's markup again.
// One selection map for the picker's rows, so the burn math, the shortfall
// gate and the confirm step all read the same rows. Rows are keyed by the
// server line they redeem.
function redeemRowKeyForCart(orderItemId) { return `oid:${orderItemId}`; }
function allRedeemRows() {
    return [...document.querySelectorAll('#redeemCartList .redeem-row[data-row-key]')];
}

// ── Redeem sheet search ───────────────────────────────────────────────────
//
// Filters BOTH lists by keyword. The two are filtered differently on purpose:
//
// Cart rows are hidden with a class, never removed. recomputeRedeemTotals()
// sums the burn from the rows in the DOM, so dropping a ticked row would quietly
// take its points out of "You burn" and out of the balance math — the customer
// would type a keyword and watch their total change.
//
// Eligible rows carry no selection and feed no total, so those are filtered for
// real and the pager runs over the matches.
let redeemSearch = '';

function redeemMatches(name) {
    if (!redeemSearch) return true;
    return String(name || '').toLowerCase().includes(redeemSearch);
}

// A keyword narrows the sheet to find ONE item. Once it's added, that job is done
// and the keyword is only hiding the rest of the cart — the customer is left
// looking at a sheet with a single row and no obvious cause. So clear it on a
// successful add, before the re-render, and let the sheet come back whole.
// Not cleared on a qty step: the customer is still working within that search.
function clearRedeemSearch() {
    redeemSearch = '';
    const box = el('redeemSearch');
    if (box) box.value = '';
    const clearBtn = el('redeemSearchClear');
    if (clearBtn) clearBtn.hidden = true;
}

function applyRedeemSearch() {
    // Cart half: hide, don't remove.
    let cartShown = 0;
    document.querySelectorAll('#redeemCartList .redeem-row').forEach(rowEl => {
        const name = rowEl.querySelector('.redeem-row__name')?.textContent || '';
        const hit = redeemMatches(name);
        rowEl.classList.toggle('is-filtered', !hit);
        if (hit) cartShown++;
    });
    const cartSection = el('redeemCartSection');
    // Only the search may hide a section that has rows; renderRedeemSheet owns the
    // "no redeemable lines at all" case and must not be overridden here.
    if (cartSection && !cartSection.dataset.empty) cartSection.hidden = cartShown === 0;

    // Eligible half: rebuild from the matches, back to page one.
    renderRedeemEligible();

    const note = el('redeemNoMatch');
    if (note) {
        const none = redeemSearch && cartShown === 0 && eligibleRows.length === 0;
        note.hidden = !none;
        if (none) note.textContent = `No items match “${redeemSearch}”.`;
    }
}

// ── Eligible items, the ones NOT in the cart ──────────────────────────────
//
// The catalog is every item the brand mapped to a loyalty class, which for a
// brand that maps its whole menu IS the whole menu. Building all of that into a
// bottom sheet costs a long first paint for rows nobody scrolls to, so the list
// is paged: ELIGIBLE_PAGE at a time, the next page when the sentinel below the
// list comes into view.
//
// Ordered by what the balance can actually claim first, then by cheapest — the
// sheet is opened against a live balance, so "what can I get right now" is the
// question it exists to answer.
const ELIGIBLE_PAGE = 5;
let eligibleRows = [];
let eligibleShown = 0;
let eligibleObserver = null;

function redeemEligibleRows() {
    if (!state.burnCatalog || !state.burnCatalog.items) return [];
    // Slugs already on a cart line — those belong in the section above, and
    // offering the same item twice in one sheet reads as two different offers.
    const inCart = new Set();
    (state.lines || []).forEach(li => {
        [li.itemId, li.parentId].forEach(id => {
            const slug = id == null ? '' : feedItemMap[String(id)]?.slug;
            if (slug) inCart.add(String(slug));
        });
    });

    const budget = spendableBurnPoints();
    const rows = [];
    state.burnCatalog.items.forEach((row, slug) => {
        if (!row || !row.is_redeemable || inCart.has(String(slug))) return;
        const points = redeemPointsForLine(row);
        if (points <= 0) return;
        // No feed entry at all means no name, no price and no image — a row that
        // could only render as a points figure against a blank.
        const entry = feedEntryForSlug(slug);
        if (!entry) return;
        // Out of reach is out of the list: the section offers what this balance can
        // claim, and a row the customer can't act on is noise under that heading.
        if (points > budget) return;
        if (!redeemMatches(entry.name)) return;
        // Addable in place, or does it need choices made on the menu first?
        const target = feedAddTargetForSlug(slug);
        // Choices it can make here (add-ons) vs choices only the menu can offer
        // (a variant group, a combo wizard). Only the second needs the trip out.
        const spec = target ? null : redeemAddonSpec(slug);
        rows.push({ slug: String(slug), points, name: entry.name, price: entry.sp,
                    veg: entry.veg, itemId: target ? target.itemId : '',
                    needsChoices: !target, canChooseHere: !!spec });
    });
    rows.sort((a, b) => a.points - b.points);
    return rows;
}

function redeemEligibleRowHTML(row, imgMap) {
    const img = redeemItemImageURL(row.slug, imgMap);
    const imgTag = img
        ? `<img class="redeem-row__img" src="${esc(img)}" alt="${esc(row.name)}" loading="lazy">`
        : '';
    // Three states, not two. Addable as it stands → Add. Add-ons to pick → Choose,
    // which opens them in the sheet. A variant group or a combo wizard → Choose as a
    // link, because those are the menu's own flows and can't be reduced to a list here.
    const action = row.canChooseHere
        ? `<button type="button" class="btn btn--secondary btn--sm redeem-elig__choose" data-choose-slug="${esc(row.slug)}">Choose</button>`
        : row.needsChoices
        ? `<a class="btn btn--secondary btn--sm redeem-elig__choose" href="${esc(menuItemHref(row.slug))}">Choose</a>`
        : `<button type="button" class="btn btn--secondary btn--sm redeem-elig__add" data-elig-id="${esc(row.itemId)}" data-elig-name="${esc(row.name)}" data-elig-price="${row.price}" data-elig-veg="${esc(row.veg)}">Add</button>`;
    return `<div class="redeem-row redeem-row--elig" data-elig-slug="${esc(row.slug)}">
        ${imgTag}
        <span class="redeem-row__body">
            <span class="redeem-row__name">${esc(row.name)}</span>
            <span class="redeem-row__price"><span class="redeem-row__price-normal">${fmt(row.price)}</span></span>
        </span>
        ${action}
        <span class="redeem-row__pts">${ptsU(row.points)}</span>
    </div>`;
}

// Append the next page. Called on open (reset) and by the sentinel observer.
function renderEligiblePage() {
    const list = el('redeemEligibleList');
    const sentinel = el('redeemEligibleSentinel');
    if (!list) return;
    const imgMap = slugImageMap();
    const next = eligibleRows.slice(eligibleShown, eligibleShown + ELIGIBLE_PAGE);
    if (next.length) {
        list.insertAdjacentHTML('beforeend', next.map(r => redeemEligibleRowHTML(r, imgMap)).join(''));
        eligibleShown += next.length;
    }
    // Hide the sentinel once the list is complete, so the observer stops firing
    // and the spinner doesn't sit under a finished list pretending there's more.
    if (sentinel) sentinel.hidden = eligibleShown >= eligibleRows.length;
    // An observer only reports a CHANGE in visibility. When the page just appended
    // still leaves the sentinel on screen — a short catalog, a search narrowed to a
    // handful of rows, a tall sheet on desktop — nothing changes, the callback never
    // runs again, and the spinner sits over rows that never load. Re-observing
    // re-delivers the initial entry, so paging continues while the sentinel is in
    // view and stops on its own once rows have pushed it out (or it's hidden, which
    // has no box and so never intersects).
    if (sentinel && !sentinel.hidden && eligibleObserver) {
        eligibleObserver.unobserve(sentinel);
        eligibleObserver.observe(sentinel);
    }
}

function renderRedeemEligible() {
    const section = el('redeemEligibleSection');
    const list = el('redeemEligibleList');
    if (!section || !list) return;
    eligibleRows = redeemEligibleRows();
    eligibleShown = 0;
    list.innerHTML = '';
    section.hidden = eligibleRows.length === 0;
    if (!eligibleRows.length) return;
    renderEligiblePage();

    // One observer for the sheet's lifetime, rooted on the scrolling body rather
    // than the viewport — the sheet scrolls inside itself, so a viewport-rooted
    // observer would fire once on open and never again.
    if (!eligibleObserver && 'IntersectionObserver' in window) {
        const rootEl = el('redeemSheetBody');
        eligibleObserver = new IntersectionObserver(entries => {
            if (entries.some(en => en.isIntersecting)) renderEligiblePage();
        }, { root: rootEl || null, rootMargin: '120px' });
        const sentinel = el('redeemEligibleSentinel');
        if (sentinel) eligibleObserver.observe(sentinel);
    }
}

function redeemCartRowHTML(item, imgMap) {
    const checked = !!redeemSelection[redeemRowKeyForCart(item.orderItemId)];
    const img = redeemItemImageURL(item.slug, imgMap);
    // No image → no cell, matching the menu's sheet: a reserved blank just leaves a
    // grey hole beside the illustrated rows (and a brand logo in a food row reads as
    // that item's photo).
    const imgTag = img
        ? `<img class="redeem-row__img" src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">`
        : '';
    const oid = esc(item.orderItemId);
    // Quantity lives on the row itself: a redemption frees the whole line, so the
    // points cost is per-unit × qty and changing the quantity here is the only way
    // to change what the redemption costs without leaving the sheet. Same two ids
    // and the same data-action names the cart's own stepper uses, so the click
    // reuses applyCartQtyMutation rather than a second mutation path.
    // Locked once the redemption is live server-side: /client/cart's recalculation
    // drops a redeemed line's walletAmtUsed on a qty change while leaving its points
    // spent, so the customer would pay full price for an item they'd already paid
    // points for. Untick it (which removes the redemption) and the stepper frees up.
    const lockQty  = item.alreadyRedeemed;
    const lockAttr = lockQty ? ' disabled title="Remove the redemption to change quantity"' : '';
    const stepper = `<span class="redeem-row__qty">
            <button type="button" data-action="decrease" data-order-item-id="${oid}" data-item-id="${esc(item.itemId)}" aria-label="Decrease quantity"${lockAttr}>−</button>
            <span class="redeem-row__qty-num">${item.qty}</span>
            <button type="button" data-action="increase" data-order-item-id="${oid}" data-item-id="${esc(item.itemId)}" aria-label="Increase quantity"${lockAttr}>+</button>
        </span>`;
    return `<label class="redeem-row" data-row-key="${esc(redeemRowKeyForCart(item.orderItemId))}" data-order-item-id="${oid}" data-item-id="${esc(item.itemId)}" data-points="${item.pointsCost}" data-qty="${item.qty}" data-price="${item.price}" data-already="${item.alreadyRedeemed ? '1' : '0'}">
        <input type="checkbox" class="redeem-row__check"${checked ? ' checked' : ''}>
        ${imgTag}
        <span class="redeem-row__body">
            <span class="redeem-row__name">${esc(item.name)}</span>
            <span class="redeem-row__price">
                <span class="redeem-row__price-normal">${fmt(item.price)}</span>
                <span class="redeem-row__price-free"><s>${fmt(item.price)}</s> ${fmt(0)}</span>
            </span>
        </span>
        ${stepper}
        <span class="redeem-row__pts">${ptsU(item.pointsCost)}</span>
    </label>`;
}


// Recomputes everything from the current DOM + redeemSelection state.
// pendingNewBurn (what "Update cart" will actually spend) excludes lines
// already redeemed server-side — that cost was already spent in an earlier
// action, re-counting it here would double it in the balance math.
function recomputeRedeemTotals() {
    const cartRows = allRedeemRows();

    // Unchecking an already-redeemed line stages a removal, which hands those
    // points back — so they're spendable again in this same session. Without
    // counting them, swapping a redemption from one item to another is
    // impossible in one pass: the balance reads 0 and every other row shows
    // "short", even though the customer just freed exactly enough.
    // selectedBurn is what the whole selection costs — that's what "You burn"
    // states, so reopening a sheet with 680 already redeemed reads 680 and not
    // 0. pendingNewBurn is the narrower figure the balance math and the CTA
    // need: only what THIS update would newly spend.
    let selectedBurn = 0, pendingNewBurn = 0, saveTotal = 0, freedByRemoval = 0;
    cartRows.forEach(rowEl => {
        const checked    = !!redeemSelection[rowEl.dataset.rowKey];
        const wasAlready = rowEl.dataset.already === '1';
        if (checked) {
            saveTotal    += Number(rowEl.dataset.price);
            selectedBurn += Number(rowEl.dataset.points);
            if (!wasAlready) pendingNewBurn += Number(rowEl.dataset.points);
        } else if (wasAlready) {
            freedByRemoval += Number(rowEl.dataset.points);
        }
    });
    // Already net of this order's committed points — the catalog balance alone
    // would re-offer whatever earlier lines are already holding.
    const spendable = spendableBurnPoints(freedByRemoval);

    set('redeemBurnTotal', pts(selectedBurn));
    // The struck figure is the customer's TOTAL — what the account holds — and the
    // bold one is what survives everything this order has taken: points already
    // committed to redeemed lines PLUS whatever this update would newly spend.
    // Using "spendable right now" as the before instead made a sheet whose
    // redemptions were all already applied read "70 → 70", stating a change that
    // wasn't happening and never showing the total at all.
    const balTotal = Math.floor(Number(state.burnCatalog?.walletBalance || 0));
    const balAfter = Math.max(0, spendable - pendingNewBurn);
    const beforeEl = el('redeemBalanceBefore'), sepEl = el('redeemBalanceSep'), unitEl = el('redeemBalanceUnit');
    set('redeemBalanceBefore', pts(balTotal));
    set('redeemBalanceAfter',  pts(balAfter));
    // Identical only when nothing is committed and nothing staged — then one figure
    // says it all and the arrow would be pointing at itself.
    const unchanged = balAfter === balTotal;
    if (beforeEl) beforeEl.hidden = unchanged;
    if (sepEl)    sepEl.hidden    = unchanged;
    if (unitEl)   unitEl.textContent = unchanged ? ptsUnit() : `${ptsUnit()} left`;
    const banner = el('redeemSavingsBanner');
    if (banner) {
        if (saveTotal > 0) { set('redeemSavingsAmt', fmt(saveTotal)); banner.hidden = false; }
        else banner.hidden = true;
    }

    // Shortfall label for a not-yet-redeemed, not-currently-checked line —
    // checking is gated at the point of checking (see the change listener);
    // this loop only paints the resulting state.
    const remaining = spendable - pendingNewBurn;
    let dirty = false;
    cartRows.forEach(rowEl => {
        const checked    = !!redeemSelection[rowEl.dataset.rowKey];
        const wasAlready = rowEl.dataset.already === '1';
        if (checked !== wasAlready) dirty = true;
        // A STAGED row's "+" is gated by what's left. The line's points are
        // per-unit × qty, so one more unit costs one more unit's worth — and
        // nothing else stopped it: the balance gate above fires on the CHECKBOX,
        // so a row checked while affordable could be stepped straight past the
        // balance, which then floored at "0 left" and still went to the server.
        // An already-redeemed row's stepper is disabled outright at render time.
        const incBtn = rowEl.querySelector('.redeem-row__qty button[data-action="increase"]');
        if (incBtn && !wasAlready) {
            const perUnit = Number(rowEl.dataset.points) / Math.max(1, Number(rowEl.dataset.qty) || 1);
            const blocked = checked && perUnit > remaining;
            incBtn.disabled = blocked;
            if (blocked) incBtn.title = `Not enough ${ptsUnit()} for another`;
            else incBtn.removeAttribute('title');
        }
        if (wasAlready || checked) return;   // nothing to flag on an already-redeemed or already-checked row
        const points = Number(rowEl.dataset.points);
        const ptsEl  = rowEl.querySelector('.redeem-row__pts');
        const short  = points > remaining;
        rowEl.classList.toggle('redeem-row--short', short);
        // No "for N" suffix: the row's own stepper states the quantity now, and
        // the two together read as a contradiction the moment one repaints first.
        if (ptsEl) ptsEl.innerHTML = short
            ? `${ptsU(points - remaining)} short`
            : ptsU(points);
    });

    // Only enabled once something actually differs from server-confirmed
    // state — otherwise there's nothing for the click handler to send.
    // The label names the price of the action: spending points says so, a
    // selection that only gives them back is just an update.
    const cta = el('redeemUpdateCartBtn');
    if (cta) {
        cta.disabled = !dirty;
        cta.textContent = pendingNewBurn > 0 ? `Get free for ${ptsU(pendingNewBurn)}` : 'Update cart';
    }
}


// One stepper press from the redeem sheet.
//
// The cart's own stepper increments with `action=update` (CI3's path). The MENU's
// sheet increments by re-adding the line — `action=add` with a wire line — which is
// also what checkout already does for the recs rail. The two are equivalent on an
// API that implements both, but an API build without `update` answers 200 and
// changes nothing, and the sheet just looks dead while the menu's works. So: take
// the cart's path first, and if the quantity didn't actually move, finish the job
// the menu's way.
//
// The retry is skipped for a line carrying customizations (combo/BOGO wire shapes
// are built from the local cart entry in menu.js and can't be reconstructed here) —
// sending a bare itemId for one of those would add the WRONG line.
async function stepRedeemRowQty(btn) {
    const oid    = String(btn.dataset.orderItemId || '');
    const qtyOf  = () => Number((state.lines || []).find(l => String(l.orderItemId) === oid)?.qty || 0);
    const before = qtyOf();

    await applyCartQtyMutation(btn);

    if (btn.dataset.action !== 'increase' || qtyOf() > before) return;

    const itemId = String(btn.dataset.itemId || '');
    const local  = (getV4Cart().items || []).find(i => String(i.itemId ?? i.id) === itemId);
    if (!itemId || (local && Array.isArray(local.subItems) && local.subItems.length)) return;

    const resp       = await callCartApi({ action: 'add', cart: JSON.stringify({ items: [{ itemId, qty: 1 }] }) });
    const localItems = getV4Cart().items || [];
    applyCartResp(parseCartResp(resp), localItems, localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
}

// keepSelection repaints the rows against fresh cart data WITHOUT resetting what
// the customer has ticked — the stepper path, where a qty change rewrites every
// row's points cost but must not silently drop a staged selection.
function renderRedeemSheet({ keepSelection = false } = {}) {
    // Undo a prior "Updating…"/error label — recomputeRedeemTotals below sets
    // the real one for the current selection.
    const cta = el('redeemUpdateCartBtn');
    if (cta) cta.textContent = 'Update cart';
    const imgMap = slugImageMap();
    const cartItems = redeemCartRows();

    // Selection starts at server-confirmed truth only — no auto-pre-selecting
    // anything the customer hasn't explicitly chosen. Checking a box now
    // leads to a real points deduction on confirm, not a preview, so nothing
    // gets pre-checked on the customer's behalf.
    if (!keepSelection) {
        redeemSelection = {};
        cartItems.forEach(item => {
            if (item.alreadyRedeemed) redeemSelection[redeemRowKeyForCart(item.orderItemId)] = true;
        });
    } else {
        // A line the server dropped (qty taken to 0) leaves a key behind that no
        // row can clear, which would keep counting toward the burn total.
        const live = new Set(cartItems.map(i => redeemRowKeyForCart(i.orderItemId)));
        Object.keys(redeemSelection).forEach(k => { if (!live.has(k)) delete redeemSelection[k]; });
    }

    const cartSection = el('redeemCartSection');
    const cartListEl  = el('redeemCartList');
    if (cartItems.length) {
        delete cartSection.dataset.empty;
        cartSection.hidden = false;
        cartListEl.innerHTML = cartItems.map(i => redeemCartRowHTML(i, imgMap)).join('');
    } else {
        cartSection.dataset.empty = '1';
        cartSection.hidden = true;
        cartListEl.innerHTML = '';
    }
    // Paints the eligible list AND applies any live keyword to both halves, so a
    // re-render mid-search (an Add, a qty change) doesn't drop back to the full list.
    applyRedeemSearch();
    // The empty state is about the CART having nothing to redeem. It still says so
    // even when the eligible list has something to offer — the two answer different
    // questions, and the list below is the constructive half of that answer.
    renderRedeemEmptyState(cartItems.length === 0);

    recomputeRedeemTotals();
}

// The sheet with nothing to offer. redeemCartRows() drops a line that carries no
// catalog rate and has nothing already redeemed to undo, so a cart of only those
// leaves the body blank — under a balance the customer can plainly see, which
// reads as a bug rather than an answer.
//
// Swaps the footer as well as filling the body: "You burn 0" is a running total
// of a selection that cannot exist, and Update cart can never leave `disabled`
// because recomputeRedeemTotals enables it only on a diff. Two dead controls
// stand in for one that works.
function renderRedeemEmptyState(isEmpty) {
    const box = el('redeemEmptyState');
    if (!box) return;
    box.hidden = !isEmpty;

    const burnRow  = el('redeemBurnRow');
    const updateBt = el('redeemUpdateCartBtn');
    const closeBt  = el('redeemEmptyCloseBtn');
    const footnote = el('redeemFootnote');
    if (burnRow)  burnRow.hidden  = isEmpty;
    if (updateBt) updateBt.hidden = isEmpty;
    if (closeBt)  closeBt.hidden  = !isEmpty;
    // "Points come back instantly if you undo" describes undoing a redemption
    // there isn't one of.
    if (footnote) footnote.hidden = isEmpty;
    if (!isEmpty) return;

    // Name what the order IS doing with points, so the visit isn't a flat no.
    // Guarded on earn > 0: a cart that neither earns nor redeems has no second
    // sentence to offer, and inventing one ("you'll earn 0 pts") is worse.
    const earn = computeEarn();
    set('redeemEmptyText', earn > 0
        ? `None of the items in your cart can be paid for with points. You'll still earn ${ptsU(earn)} on this order — ${creditedAfterLabel().toLowerCase()}.`
        : 'None of the items in your cart can be paid for with points.');
}


// Delegated so freshly-rendered rows (innerHTML swapped in on every open)
// need no per-row listener wiring.
function bindRedeemSheetEvents() {
    // The search box lives OUTSIDE the scrolling body, so it binds on its own.
    const box = el('redeemSearch');
    const clearBtn = el('redeemSearchClear');
    // The clear button only exists while there is something to clear.
    const syncClear = () => { if (clearBtn) clearBtn.hidden = !box.value; };
    if (clearBtn && !clearBtn.dataset.bound) {
        clearBtn.dataset.bound = '1';
        clearBtn.addEventListener('click', () => {
            box.value = '';
            redeemSearch = '';
            syncClear();
            applyRedeemSearch();
            box.focus();
        });
    }
    if (box && !box.dataset.bound) {
        box.dataset.bound = '1';
        let t = null;
        box.addEventListener('input', () => {
            syncClear();
            // Debounced: each keystroke re-renders the eligible list, and on a
            // brand whose catalog is its whole menu that is real work per character.
            clearTimeout(t);
            t = setTimeout(() => {
                redeemSearch = box.value.trim().toLowerCase();
                applyRedeemSearch();
            }, 140);
        });
        // Escape clears the keyword before the sheet's own handler closes the sheet —
        // otherwise the only way out of a bad search is to close and reopen.
        box.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !box.value) return;
            e.stopPropagation();
            box.value = '';
            redeemSearch = '';
            syncClear();
            applyRedeemSearch();
        });
    }

    const body = el('redeemSheetBody');
    if (!body || body.dataset.bound) return;
    body.dataset.bound = '1';

    // Add from the eligible list. Same two steps the "Craving More?" rail uses —
    // local cart first so the sheet repaints immediately, then the server add —
    // and then the sheet re-renders so the item moves up into "In your cart",
    // where it can actually be ticked for redemption.
    // "Choose" on a row that carries add-ons — opens its own sheet above this one.
    body.addEventListener('click', (e) => {
        const open = e.target.closest('[data-choose-slug]');
        if (open) openRedeemChoices(open.dataset.chooseSlug);
    });

    body.addEventListener('click', async (e) => {
        const btn = e.target.closest('.redeem-elig__add');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = '…';
        const itemId = btn.dataset.eligId;
        try {
            await addItemToCart(itemId, btn.dataset.eligName, Number(btn.dataset.eligPrice), btn.dataset.eligVeg);
            renderCartItems();
            clearRedeemSearch();
            renderRedeemSheet({ keepSelection: true });
        } catch (err) {
            console.warn('[checkout] Failed to add eligible item:', err);
            btn.disabled = false;
            btn.textContent = label;
        }
    });

    body.addEventListener('change', (e) => {
        const check = e.target.closest('.redeem-row__check');
        if (!check) return;
        const rowEl      = check.closest('.redeem-row');
        const key        = rowEl.dataset.rowKey;
        const wasAlready = rowEl.dataset.already === '1';
        if (check.checked) {
            // Gate at the moment of checking: a not-yet-redeemed row that
            // doesn't fit the remaining balance reverts immediately — its
            // points figure already explains why via the shortfall label.
            // Re-redeeming an already-redeemed line (toggled off then back
            // on in the same session) costs nothing new, so it's exempt.
            if (!wasAlready) {
                const points  = Number(rowEl.dataset.points);
                let pendingNewBurn = 0, freedByRemoval = 0;
                allRedeemRows().forEach(r => {
                    if (r === rowEl) return;
                    const already  = r.dataset.already === '1';
                    const isChecked = !!redeemSelection[r.dataset.rowKey];
                    // Same accounting as recomputeRedeemTotals: a staged removal
                    // hands its points back, so they're spendable here too.
                    if (!already && isChecked)      pendingNewBurn += Number(r.dataset.points);
                    else if (already && !isChecked) freedByRemoval += Number(r.dataset.points);
                });
                if (points > spendableBurnPoints(freedByRemoval) - pendingNewBurn) {
                    check.checked = false;
                    recomputeRedeemTotals();
                    return;
                }
            }
            redeemSelection[key] = true;
        } else {
            delete redeemSelection[key];
        }
        recomputeRedeemTotals();
    });

    // Row stepper. The row is a <label>, so a click inside it would otherwise
    // toggle the checkbox — changing the quantity must not also stage (or
    // un-stage) the redemption. Shares _qtyMutationInflight with the cart's own
    // stepper so the two can never interleave on the same line.
    body.addEventListener('click', async (e) => {
        const btn = e.target.closest('.redeem-row__qty button[data-action]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (_qtyMutationInflight || btn.disabled) return;
        _qtyMutationInflight = true;
        // Every button in the sheet goes down while the cart settles: the figures
        // on screen are stale until the response lands.
        const steppers = [...body.querySelectorAll('.redeem-row__qty button')];
        steppers.forEach(b => { b.disabled = true; });
        // Ticks are keyed by orderItemId, and a decrease can come back as a NEW
        // server line (the API deletes and re-adds rather than decrementing), which
        // orphans the key and silently drops the customer's selection. The item id
        // survives that, so the selection is carried across on it.
        const checkedItemIds = new Set(
            allRedeemRows()
                .filter(r => !!redeemSelection[r.dataset.rowKey])
                .map(r => String(r.dataset.itemId || ''))
                .filter(Boolean));
        try {
            await stepRedeemRowQty(btn);
            // Fresh state.lines → fresh points costs, with the ticks carried over.
            renderRedeemSheet({ keepSelection: true });
            if (checkedItemIds.size) {
                allRedeemRows().forEach(r => {
                    if (!checkedItemIds.has(String(r.dataset.itemId || ''))) return;
                    redeemSelection[r.dataset.rowKey] = true;
                    const cb = r.querySelector('.redeem-row__check');
                    if (cb) cb.checked = true;
                });
                recomputeRedeemTotals();
            }
        } catch (err) {
            console.warn('[checkout] Redeem sheet qty update failed:', err);
            // Repaint rather than re-enable every button: a blanket re-enable also
            // unlocks the two that must stay locked — an already-redeemed row's
            // stepper, and a staged row whose next unit doesn't fit the balance.
            // The cart didn't move, so this paints the same rows with their locks.
            renderRedeemSheet({ keepSelection: true });
        } finally {
            _qtyMutationInflight = false;
        }
    });
}

function openRedeemSheet() {
    if (!state.burnCatalog) return;
    // A keyword left over from last time would open the sheet already filtered,
    // with no visible cause once the field scrolls out of view.
    clearRedeemSearch();
    // Likewise a customisation left half-made: reopening lands on the lists.
    closeRedeemChoices();
    renderRedeemSheet();
    bindRedeemSheetEvents();
    openModal('redeemPointsOverlay');
}

async function confirmRedeemSelection() {
    const btn = el('redeemUpdateCartBtn');
    if (!btn || btn.disabled) return;
    // Mirror of the promo-apply guard: a redemption is a wallet spend, so it can't
    // ride alongside a promo unless the outlet allows combining. Blocked here rather
    // than letting the server take it and silently re-price the line afterwards.
    if (state.appliedPromo && !isWalletPromoCombinedAllowed()) {
        showApplyToast('error', 'Remove the applied promo to redeem points.');
        return;
    }
    const changes = allRedeemRows()
        .map(rowEl => ({
            orderItemId: rowEl.dataset.orderItemId || '',
            points:      Number(rowEl.dataset.points),
            wasAlready:  rowEl.dataset.already === '1',
            nowChecked:  !!redeemSelection[rowEl.dataset.rowKey],
        }))
        .filter(c => c.nowChecked !== c.wasAlready);
    if (!changes.length) return;

    btn.disabled = true;
    btn.textContent = 'Updating…';
    // Captured before the writes: once the cart is refetched these are gone, and an
    // undo needs both to say what came back and what the balance was.
    const spentBefore = committedBurnPoints();
    const balBefore   = spendableBurnPoints();
    const errors = [];
    for (const c of changes) {
        if (!c.nowChecked) {
            const resp = await removeItemRedemption(c.orderItemId);
            if (Number(resp?.status) !== 1) errors.push(resp?.msg || 'Could not update this item.');
            continue;
        }
        const resp = await applyItemRedemption(c.orderItemId, c.points);
        if (Number(resp?.status) !== 1) errors.push(resp?.msg || 'Could not update this item.');
    }

    await loadCartSummary();
    await loadBurnCatalog();

    if (errors.length) {
        errors.forEach(msg => showApplyToast('error', msg));
        openRedeemSheet();   // fresh data — shows exactly what did and didn't apply
        return;
    }
    closeModal('redeemPointsOverlay');
    // Celebrate only an update that actually SPENT points. A selection that only
    // handed points back is a correction, not an achievement — congratulating it
    // reads as mockery, so it gets the same panel in its undo register.
    if (changes.some(c => c.nowChecked)) renderRedeemOutcome();
    else renderRedeemOutcome({ returned: true, points: spentBefore - committedBurnPoints(), balBefore });
}

// Undoing a redemption is the same event told backwards, so it gets the same panel
// rather than silence: the customer needs the same four figures to see the points
// came back. Icons diverge — a taken offer is a tick, a returned one an undo arrow —
// the way the promo toast's apply/remove pair does.
const _ICON_DONE_CHECK  = '<polyline points="20 6 9 17 4 12"/>';
const _ICON_DONE_RETURN = '<polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>';

// The confirmation panel. Every figure is read AFTER the cart and catalog refetch,
// so it states server-confirmed truth rather than what the sheet predicted.
//
// `returned` flips it to the undo case: `points` is what came back (the caller
// captures it before the removal, since state no longer holds it afterwards) and
// `balBefore` is what was spendable at that moment, so the balance row reads
// 882 → 2,000 instead of pretending nothing moved.
function renderRedeemOutcome({ returned = false, points = null, balBefore = null } = {}) {
    const overlay = el('redeemSuccessOverlay');
    // A spend reads its figure off the refreshed cart; an undo can't (those points
    // are gone from state by now), so the caller hands it in.
    const figure = Math.floor(Number(points == null ? committedBurnPoints() : points)) || 0;
    // Nothing to state — fall back to the plain acknowledgement rather than an
    // empty celebration.
    if (!overlay || figure <= 0) { showApplyToast('success', 'Cart updated.'); return; }

    overlay.classList.toggle('co-redeem-done--returned', returned);
    const icon = overlay.querySelector('.co-redeem-done__tick svg');
    if (icon) icon.innerHTML = returned ? _ICON_DONE_RETURN : _ICON_DONE_CHECK;

    set('redeemDoneLabel', returned ? 'Points returned' : 'Points to redeem');
    set('redeemDonePts',   pts(figure));
    // "Redeemed at payment" is the answer to "when do these leave my account?" —
    // meaningless once they've come back, where the question is the opposite one.
    set('redeemDoneFootnote', returned ? 'Points are back on your balance' : 'Final redemption happens after payment');

    // Only a spend saves money. On an undo the bill goes back up, so the green
    // "saved" pill would be stating the opposite of what just happened.
    const saved = returned ? 0 : redeemedBillAmount();
    const savedWrap = el('redeemDoneSavedWrap');
    if (savedWrap) {
        if (saved > 0) { set('redeemDoneSaved', fmt(saved)); savedWrap.hidden = false; }
        else savedWrap.hidden = true;
    }

    // Before is the catalog's own figure on a spend: the CRM balance doesn't move
    // until the order is placed, so it still reads what the customer had walking
    // in — exactly the number the "→ after" is meaningful against.
    const before = balBefore == null ? Math.floor(Number(state.burnCatalog?.walletBalance || 0)) : balBefore;
    set('redeemDoneBalBefore', pts(before));
    set('redeemDoneBalAfter',  pts(spendableBurnPoints()));

    const earn = computeEarn();
    const earnRow = el('redeemDoneEarnRow');
    if (earnRow) {
        // "still" concedes a loss the customer just took; "now" reports a gain.
        set('redeemDoneEarnLabel', returned ? 'This order now earns' : 'This order still earns');
        if (earn > 0) { set('redeemDoneEarn', `+${ptsU(earn)}`); earnRow.hidden = false; }
        else earnRow.hidden = true;   // everything redeemed → nothing left to earn on
    }

    openModal('redeemSuccessOverlay');
    // No confetti on an undo — nothing was won.
    overlay.querySelector('.co-confetti')?.remove();
    if (!returned) {
        addToastConfetti(overlay);
        // The overlay is reused, so a second redemption in the same session would
        // stack a second set of falling pieces on top of the first.
        setTimeout(() => overlay.querySelector('.co-confetti')?.remove(), 3600);
    }
}

// The same strip the menu renders, on a "Craving More?" card. Not in the cart
// yet, so the earn figure is for a single unit.
function recStripHTML(slug) {
    const row = state.burnCatalog && slug ? burnRowFor(state.burnCatalog, slug) : null;
    return burnStripHTML(row, { qty: 1, balance: catalogBalance() });
}

// …and on a cart row, where the quantity is known. `plain`: this pill keeps the
// design it has always had — both figures, the gold coin, the green earn — because
// the row is the redeem decision itself and needs to show both sides of it. The
// claim highlight belongs to the browse surfaces.
function lineStripHTML(li, qty, localItem) {
    return burnStripHTML(burnRowForLine(li, localItem), { qty, plain: true, redeemLabel: 'Redeem' });
}

// The catalog's own balance figure, NOT spendableBurnPoints(): this decides how a
// strip is drawn, and a strip that changed style every time another line was
// ticked for redemption would flicker through the whole list mid-selection.
function catalogBalance() {
    return state.burnCatalog ? state.burnCatalog.walletBalance : null;
}

// Insert / remove a "cannot be clubbed" notice on a card section. Appended to the
// section (outside .card__body) so the wallet card's flex `between` body is untouched.
function toggleClubMsg(card, id, on, text) {
    if (!card) return;
    let msg = document.getElementById(id);
    if (on) {
        if (!msg) {
            msg = document.createElement('p');
            msg.id = id;
            msg.className = 'co-club-msg';
            card.appendChild(msg);
        }
        msg.textContent = text;
    } else if (msg) {
        msg.remove();
    }
}

// CI3 parity (ue_silver/js/checkout.js:865 / :18874): wallet and promo are mutually
// exclusive unless the outlet enables `wallet_promo_combined_allowed`. When one is
// applied, grey out and lock the OTHER section with an explanatory notice so the user
// understands why it's unavailable. Uses dedicated `--locked` classes so it never
// fights the `--disabled` toggling driven by cart eligibility / unavailable items.
function renderWalletPromoExclusivity() {
    const walletCard = el('walletDiv');
    const promoCard  = el('promo_list');
    const combined   = isWalletPromoCombinedAllowed();
    // Same test the apply-guard uses: a spend is a spend whether it came from the flat
    // wallet or from redeeming an item's points. Reading state.walletApplied alone left
    // the promo card looking fully available to a customer who had points redeemed —
    // they typed a code, hit Apply, and got refused by a guard the UI hadn't shown them.
    // Safe for lockWallet below too: that branch is gated on !combined, and with
    // combining off confirmRedeemSelection already refuses to redeem while a promo is
    // applied, so "promo on AND points redeemed" is unreachable there.
    const walletOn   = isWalletSpent();
    const promoOn    = !!state.appliedPromo;

    // Lock promo while wallet is applied — unless the promo card is already faded by
    // cart eligibility / unavailable items (avoid stacking two disabled messages).
    const promoAlreadyOff = !!promoCard?.classList.contains('co-promo--disabled');
    const lockPromo = !combined && walletOn && !promoOn && !promoAlreadyOff;
    promoCard?.classList.toggle('co-promo--locked', lockPromo);
    toggleClubMsg(promoCard, 'promoClubbedMsg', lockPromo,
        committedBurnPoints() > 0 && !state.walletApplied
            ? 'Not applicable with a points redemption. Remove it to use a promo code.'
            : 'Not applicable with Wallet. Remove the wallet to use a promo code.');

    // Lock wallet while a promo is applied — same guard against the wallet card already
    // being disabled (unavailable items / wallet-ineligible cart).
    const walletAlreadyOff = !!walletCard?.classList.contains('co-wallet--disabled');
    const lockWallet = !combined && promoOn && !walletOn && !walletAlreadyOff;
    walletCard?.classList.toggle('co-wallet--locked', lockWallet);
    toggleClubMsg(walletCard, 'walletClubbedMsg', lockWallet,
        'Not applicable with a promo. Remove the promo to use wallet credits.');
}

// ─── Promo applicability helpers ─────────────────────────────

// discount_type: 1,5,6,9,10 = percentage; 2,4 = flat; 3,8 = buy-N-get-N; 7 = free-item (lowest priority)
const PROMO_PCT  = new Set([1, 5, 6, 9, 10]);
const PROMO_FLAT = new Set([2, 4]);

// Reward coupons (addo_rewards) ride in on the promoCodes list with received_by_reward=1.
// Their `code` is an opaque hash (e.g. "4f9cdeb0"), so surface the merchant-controlled
// `title` instead. Regular promos keep showing their code. CI3 ref: ue_silver/js/checkout.js:3162, 31164.
const isReward   = (p) => String(p?.received_by_reward) === '1';
const promoLabel = (p) => (isReward(p) && p?.title) ? String(p.title) : String(p?.code || '');

// Tidy merchant-authored promo descriptions for display: fix the stray " ,"/double
// spaces (e.g. "Combos ,6 in 1 ,Magic Box & Beverages") into clean ", " separators.
const tidyPromoDesc = (s) => String(s || '').replace(/\s*,\s*/g, ', ').replace(/ {2,}/g, ' ').trim();

// Caption for an applied promo — shown in the Savings Corner banner AND the success toast.
// Reward coupons use their friendly title; freebie promos (a cart line with freeItems=1)
// name the granted item(s) instead of the misleading "saving ₹0".
// CI3 ref: ue_silver/js/checkout.js:18904-18919, 31201-31214.
function freebieItemNames() {
    return (state.lines || [])
        .filter(li => String(li.freeItems) === '1')
        .map(li => String(li.itemName || '').trim())
        .filter(Boolean);
}
function appliedPromoCaption(promoObj, order) {
    const label = promoObj ? promoLabel(promoObj) : state.appliedPromo;
    const freeNames = freebieItemNames();
    if (freeNames.length) {
        return `"${label}" applied — Enjoy your free ${freeNames.join(', ')} 🎁`;
    }
    const o = order ?? state.order;
    // Cashback promos (discount_type 5/6) grant a post-delivery wallet credit, not a bill
    // discount, so `discount` is 0 → "saving ₹0" reads wrong. Show the server's own
    // cashback message (orderDetails.cashbackMsg) verbatim instead.
    const cashbackMsg = String(o?.cashbackMsg || '').trim();
    if (cashbackMsg) {
        return `"${label}" applied — ${cashbackMsg}`;
    }
    return `"${label}" applied — saving ${fmt(o?.discount || 0)}`;
}

function calcPromoDiscount(promo, subTotal) {
    const type  = parseInt(promo.discount_type);
    const val   = parseFloat(promo.discount_value || 0);
    const maxD  = parseFloat(promo.max_discount_amount || 0);
    if (PROMO_PCT.has(type)) {
        const pct = (val / 100) * subTotal;
        return maxD > 0 ? Math.min(pct, maxD) : pct;
    }
    if (PROMO_FLAT.has(type)) return val;
    return 0;
}

// Buy-N-get-M-free discount types. These grant a free item rather than a rupee/percentage
// cut, so calcPromoDiscount scores them ₹0 — which wrongly sinks them below any flat promo
// in the savings-corner ranking. Confirmed from /client/cart: B2G1 = discount_type 14 with
// buy_qty=2, discounted_items_qty=1 (free item count). 3/8 kept as legacy buy-N-get-N ids.
const PROMO_BOGO = new Set([3, 8, 14]);

// Per-unit prices of the promo-eligible items (valid_cond + promo_applicable_master aware),
// one entry per unit (a qty-2 line yields two entries), cheapest first. Zero-priced /
// already-free lines are excluded. Used to value the "free item" a Buy-N-Get-M promo grants.
function eligibleUnitPrices(lines, promo) {
    const norm = s => String(s || '').trim().toLowerCase();
    const validRaw  = (promo?.valid_cond || '').trim();
    const validSlugs = validRaw ? new Set(validRaw.split(',').map(norm).filter(Boolean)) : null;
    const units = [];
    (lines || []).forEach(li => {
        if (!isPromoEligibleRow(li)) return;
        if (validSlugs && !validSlugs.has(effectiveSectionSlug(li, lines))) return;
        const qty   = Number(li.qty) || 1;
        const total = Number(li.subTotal);
        if (!(total > 0)) return;
        const unit = total / qty;
        for (let i = 0; i < qty; i++) units.push(unit);
    });
    return units.sort((a, b) => a - b);
}

// Rupee benefit of a promo on the current cart — ranks the savings-corner slots by "actual
// benefit" (app parity). FLAT/PERCENTAGE: the direct cut (calcPromoDiscount). Buy-N-Get-M:
// the price of the M cheapest eligible items (standard BOGO semantics). Everything else
// (incl. free-item reward type 7) scores ₹0 so it ranks last, matching CI3.
function promoBenefit(promo, subTotal, lines) {
    const type = parseInt(promo.discount_type);
    if (PROMO_PCT.has(type) || PROMO_FLAT.has(type)) return calcPromoDiscount(promo, subTotal);
    if (PROMO_BOGO.has(type)) {
        const freeCount = Math.max(1, parseInt(promo.discounted_items_qty || promo.free_qty || 1, 10));
        return eligibleUnitPrices(lines, promo).slice(0, freeCount).reduce((s, v) => s + v, 0);
    }
    return 0;
}

// CI3 parity (checkout.js:17342): an addon/child line may lack its own sectionsSlug — fall
// back to the parent's slug so its section still counts toward valid_cond matching.
function effectiveSectionSlug(li, allLines) {
    const norm = s => String(s || '').trim().toLowerCase();
    const direct = norm(li?.sectionsSlug);
    if (direct) return direct;
    const parentOrderItemId = li?.parentOrderItemId ?? li?.parent_order_item_id;
    if (parentOrderItemId && Array.isArray(allLines)) {
        const parent = allLines.find(x => String(x?.orderItemId) === String(parentOrderItemId));
        const fromParent = norm(parent?.sectionsSlug);
        if (fromParent) return fromParent;
    }
    const iParentId = li?.iParentId;
    if (iParentId && Array.isArray(allLines)) {
        const parent = allLines.find(x => String(x?.itemId) === String(iParentId));
        const fromParent = norm(parent?.sectionsSlug);
        if (fromParent) return fromParent;
    }
    return '';
}

// Returns true if valid_cond is satisfied by current cart (sectionsSlug + promo_applicable_master).
// Exact slug match: a line counts toward a promo only when its section slug is listed
// verbatim in valid_cond. A compound section (e.g. "desserts-and-beverages") is NOT a
// valid item for a promo that lists "desserts" — it must match exactly, so such a line
// does not satisfy the promo's min-qty / min-order.
function promoMatchesCart(promo, lines) {
    const norm     = s => String(s || '').trim().toLowerCase();
    const validRaw = (promo.valid_cond || '').trim();
    const eligible = lines.filter(li =>
        li.promo_applicable_master == 1 || li.promo_applicable_master == null
    );
    if (!eligible.length) return false;
    if (!validRaw)         return true; // no section restriction
    const validSlugs = [...new Set(validRaw.split(',').map(norm).filter(Boolean))];
    const cartSlugs  = [...new Set(eligible.map(li => effectiveSectionSlug(li, lines)).filter(Boolean))];
    return validSlugs.some(s => cartSlugs.includes(s));
}

function promoStatus(promo, lines) {
    const sectionOk  = promoMatchesCart(promo, lines);
    if (!sectionOk)  return { ok: false, msg: 'Not applicable on selected items', reason: 'section' };
    // Per-promo subtotal (applicable_on_addons + valid_cond aware) — CI3 validateMinOrder.
    const subTotal   = promoApplicableSubtotal(lines, promo);
    const minOrder   = parseFloat(promo.min_order_value || 0);
    // Buy-N-get-N / min-quantity promos (B2G1, discount_type 14) need a minimum count of
    // promo-VALID items (only lines whose section is listed in valid_cond count). This is
    // the primary gate for these promos, so it's checked BEFORE min-order: a short cart
    // shows "Add N more valid item(s) to apply" (the item count the user must add), not a
    // rupee shortfall. The server rejects the apply with "Min N items required" otherwise.
    const minQty = parseInt(promo.min_qty || 0, 10);
    if (minQty > 0) {
        const need = minQty - promoApplicableQty(lines, promo);
        if (need > 0) return { ok: false, msg: `Add ${need} more valid item${need === 1 ? '' : 's'} to apply`, reason: 'minqty' };
    }
    if (subTotal < minOrder) return { ok: false, msg: `Add ${fmt(minOrder - subTotal)} more to apply`, reason: 'minorder' };
    return { ok: true, msg: '', reason: '' };
}

// Returns { best, next } among non-applied promos in the provided list.
// best = highest-discount applicable promo; next = closest not-yet-met but section-valid promo.
// Callers pre-filter by is_membership_offer (savings corner uses 0, membership savings uses 1).
// CI3 parity (ue_silver/js/checkout.js:16863 getPromoTypePriority): free-item promos
// (discount_type 7 — usually a redeemed reward) ARE surfaced, just ranked last so any
// rupee-discount promo wins the single inline slot. Free delivery is independent of
// discount_type (driven by order.amount_add_for_free_del → freeDeliverySection), so we
// do NOT exclude any discount_type here — that wrongly hid free-item rewards.
function pickBestPromo(promos, lines) {
    const sorted = [...promos]
        .sort((a, b) => parseFloat(a.min_order_value || 0) - parseFloat(b.min_order_value || 0));

    let best = null, bestBenefit = -1;
    let next = null, nextGap = Infinity;

    for (const p of sorted) {
        if (p.code === state.appliedPromo) continue;
        const sectionOk  = promoMatchesCart(p, lines);
        if (!sectionOk) continue;
        // Per-promo subtotal (applicable_on_addons + valid_cond aware) drives both the
        // min_order check and the discount base — CI3 calculatePromoApplicableSubtotal.
        const subTotal   = promoApplicableSubtotal(lines, p);
        const minOrder   = parseFloat(p.min_order_value || 0);
        // min_qty (buy-N-get-N) gates applicability too. A promo whose MOV is met but
        // item count isn't (e.g. B2G1) must NOT be offered with an Apply button that
        // fails — it falls through to `next` and renders the "Add N more valid items" hint.
        const minQty     = parseInt(p.min_qty || 0, 10);
        const qtyOk      = minQty <= 0 || promoApplicableQty(lines, p) >= minQty;
        if (subTotal >= minOrder && qtyOk) {
            // App parity: rank the applicable slot by *actual rupee benefit* (freebie value
            // included via promoBenefit), so a Buy-N-Get-N free item can outrank a small flat
            // discount — not by discount_type priority. CI3 scored freebies at ₹0 (bug).
            const benefit = promoBenefit(p, subTotal, lines);
            if (benefit > bestBenefit) { best = p; bestBenefit = benefit; }
        } else {
            // Locked slot: unchanged from CI3/original — the promo the user is closest to
            // unlocking (smallest rupee gap). Only the applicable slot ranks by benefit.
            const gap = minOrder - subTotal;
            if (gap < nextGap) { next = p; nextGap = gap; }
        }
    }
    return { best, next };
}

// ─── Savings corner ───────────────────────────────────────────

// Toggle disabled state on the Savings Corner card when every cart line has
// promo_applicable_master === 0. CI3 ref: ue_silver/js/checkout.js ~L27994
// (null/undefined treated as enabled — only explicit '0' counts as blocked).
function renderPromoDisabled(lines) {
    const wrap = el('promo_list');
    const allBlocked = isAllBlocked(lines, 'promo_applicable_master');
    if (!wrap) return allBlocked;
    wrap.classList.toggle('co-promo--disabled', allBlocked);
    let msg = el('promoDisabledMsg');
    if (allBlocked) {
        if (!msg) {
            msg = document.createElement('p');
            msg.id        = 'promoDisabledMsg';
            msg.className = 'co-promo__disabled-msg';
            msg.textContent = 'Items in cart are not eligible for promo codes';
            // Insert below the "Savings Corner" heading (heading on top, validation below).
            const body  = wrap.querySelector('.card__body');
            const title = body?.querySelector('.co-section-title');
            if (title) title.after(msg);
            else body?.prepend(msg);
        }
    } else if (msg) {
        msg.remove();
    }
    return allBlocked;
}

function renderSavingsCorner(order, promos) {
    state.promos = promos || [];
    const delivery = Number(order?.deliveryCharges ?? 0);
    const lines    = state.lines || [];
    // CI3 parity: min_order_value / "Add X more" hints check a PER-PROMO subtotal
    // (promoApplicableSubtotal — applicable_on_addons + valid_cond aware), computed inside
    // promoStatus/pickBestPromo. Items with promo_applicable_master=0 are excluded.

    // CI3 parity (ue_silver/js/checkout.js ~L17521): the Savings Corner is NOT gated on
    // per-line OOS. An out-of-stock line is excluded from the bill total, so a promo can
    // still apply to the remaining valid items; the Pay CTA stays blocked separately until
    // the item is removed. Only an explicitly-ineligible cart (renderPromoDisabled, below)
    // fades the card.
    const card = el('promo_list');
    card?.classList.remove('co-promo--disabled');
    card?.classList.remove('co-promo--bare');
    hide('promoEmptyState');

    // The earn figure is painted by renderLoyaltyBand into #promoEarnBanner, not here.
    // A second copy used to be written to #promoEarnNote, an element no view defines,
    // so the branch never ran. Reviving it would have been worse than deleting it: it
    // gated only on earn > 0, while the band also requires redeemedPts <= 0, so a
    // customer who had just redeemed would have seen "you'll earn N pts" beside a band
    // saying the opposite.

    // Short-circuit when every line is promo-ineligible — fade the whole card,
    // hide the input / suggestion / View More Offers / free-delivery progress.
    if (renderPromoDisabled(lines)) {
        hide('applyPromoSection');
        hide('promoBlock');
        hide('viewMoreOffersSection');
        hide('freeDeliverySection');
        return;
    }

    // Free-delivery suggestion. CI3 ref: client.php:5880-5934 — server populates
    // `orderDetails.amount_add_for_free_del` = onlineOrdersMinValue − subTotal (or
    // effective subtotal). Rendered by ue_default/js/checkoutPage_20251023_2.js:8282.
    //   value === 0           → free delivery already unlocked
    //   value > 0 (≤ 2000)    → "Add items worth ₹X more to get free delivery"
    //   value === '' or null  → suggestion hidden (no MOV / gap too large)
    //
    // Known backend gap: for dynamic (distance-tiered) delivery rules, this gap is
    // computed from getMinOrderValue() (client.php:12589), which only reads the matched
    // rule's min_order_amt and never checks that same rule's delivery_charge. A tier can
    // have DC=0 (delivery already free regardless of subtotal) while still reporting a
    // positive gap — e.g. rule "0-5km: MOV 200, DC 0" → deliveryCharges: "0.00" but
    // amount_add_for_free_del still says ₹85. order.deliveryCharges is the live, DC-aware
    // number (see 9038-9053), so trust it over the gap: never show the "add ₹X more"
    // nudge when the current delivery charge already reads 0.
    const fdText = el('freeDeliveryText');
    const fdSec  = el('freeDeliverySection');
    if (fdSec && fdText) {
        const isDelivery = cfg.orderType === 'delivery';
        const raw  = order?.amount_add_for_free_del;
        const gap  = raw === '' || raw == null ? null : Number(raw);
        const rupeeBadge = `<span class="co-promo__free-del-icon" aria-hidden="true">₹</span>`;
        // "Yay! Free Delivery" is only truthful once an address is selected — delivery
        // charges are server-computed and address-dependent (see the bill-row guard at
        // ~L1363). Before an address exists, order.deliveryCharges is only a provisional
        // guess (server defaults distance to 0 for the tier match), so we don't assert
        // free delivery yet — but we also won't contradict it with a "spend more" nudge.
        if (isDelivery && state.selectedAddressId && delivery === 0) {
            fdText.innerHTML = `${rupeeBadge}<span class="co-promo__free-del-text">Yay! <strong>Free Delivery</strong> on this order</span>`;
            fdSec.hidden = false;
        } else if (isDelivery && gap !== null && gap > 0 && delivery !== 0) {
            fdText.innerHTML = `${rupeeBadge}<span class="co-promo__free-del-text">Add items worth <strong>${fmt(gap)}</strong> more to get free delivery</span>`;
            fdSec.hidden = false;
        } else {
            fdSec.hidden = true;
        }
    }

    const available = (promos || []).filter(p => Number(p.is_membership_offer ?? 0) === 0);

    // "View All Offers" count reflects only promos usable on the *current* cart.
    // The server returns every active promo (incl. ones that fail valid_cond / min-
    // order, e.g. a "New User Offer" tagged "Not applicable on selected items"), so
    // counting `available.length` overstates what the user can actually apply. CI3
    // showed no count (static "View More Offers"); we keep the badge but scope it to
    // applicable promos. The section still opens whenever any promo exists, so the
    // modal can still list the inapplicable ones (disabled) for discovery.
    const applicableCount = available.filter(p => promoStatus(p, lines).ok).length;
    if (available.length) {
        set('viewMoreOffersText', applicableCount > 0 ? `View All Offers (${applicableCount})` : 'View All Offers');
        show('viewMoreOffersSection');
    } else {
        hide('viewMoreOffersSection');
    }

    // Three applied-state cases:
    //   1. A regular (non-membership) promo is applied → show #promoAppliedBlock, hide suggestion+input
    //   2. A membership promo is applied → keep the suggestion visible but DIM the card (.co-promo--conflict)
    //      so the user can click Apply to trigger the switch-confirm popup.
    //   3. Nothing applied → standard suggestion/input flow.
    // Membership comes from the MEMBERSHIP list, not from absence in the regular one: the server
    // keeps a promo attached to the cart after getPromoCodes() stops offering it (valid_till /
    // valid_days / valid_hours), and reading that as membership hid #promoAppliedBlock — the only
    // thing carrying Remove. Unknown code ⇒ regular branch, as CI3 (ue_silver/checkout.js:31164).
    const memberPromos      = (promos || []).filter(p => Number(p.is_membership_offer ?? 0) === 1);
    const appliedIsMember   = !!state.appliedPromo && memberPromos.some(p => p.code === state.appliedPromo);
    const appliedIsRegular  = !!state.appliedPromo && !appliedIsMember;

    if (appliedIsRegular) {
        // Reward coupons show their friendly title (the code is an opaque hash, CI3 ref: 31164);
        // freebie promos name the granted item instead of "saving ₹0".
        const appliedObj = available.find(p => p.code === state.appliedPromo);
        // Not in today's offers ⇒ validity window passed: Pay will be refused, so point at
        // Remove rather than quoting a saving the order can't keep.
        set('promo_cashback', appliedObj
            ? appliedPromoCaption(appliedObj, order)
            : `"${state.appliedPromo}" is no longer valid — remove it to continue`);
        show('promoAppliedBlock');
        hide('applyPromoSection');
        hide('promoBlock');
        hide('nextApplicablePromo');
        card?.classList.remove('co-promo--conflict');
        return;
    }
    hide('promoAppliedBlock');
    card?.classList.toggle('co-promo--conflict', appliedIsMember);

    if (!available.length) {
        hide('promoBlock');
        hide('nextApplicablePromo');
        show('applyPromoSection');
        // With no offers and no free-delivery hint the input is the only row — drop its
        // trailing dashed separator so it doesn't read as a stray/duplicate border.
        card?.classList.toggle('co-promo--bare', !!el('freeDeliverySection')?.hidden);
        return;
    }

    // Promos available — hide the manual input, show the best applicable one
    hide('applyPromoSection');

    const { best, next } = pickBestPromo(available, lines);
    const promoToShow = best || next;

    if (!promoToShow) {
        // Offers exist but none auto-applies to this cart. Keep "View All Offers" as the
        // single entry point (its modal carries its own promo-code input) and hide the
        // inline manual input — the two must never show together. The bare inline input
        // appears only when there are zero offers (the !available.length branch above).
        // Replace the otherwise-empty card with a contextual empty state: if the cart is
        // below the minimum order value, nudge the shortfall ("Add ₹X more to unlock offers");
        // otherwise explain the items aren't eligible yet.
        hide('promoBlock');
        hide('nextApplicablePromo');
        hide('applyPromoSection');
        renderPromoEmptyState(order);
        return;
    }
    hide('promoEmptyState');

    const oneCoupon      = el('oneCoupon');
    const oneCouponApply = el('oneCouponApply');
    const isApplicable   = !!best; // best = fully applicable; next = hint only

    if (oneCoupon) {
        // CI3 uses the short title ("Get Flat 15% OFF on Your First Order — Up to Rs100!")
        // not the long marketing description. Fall back to description only if title is missing.
        const title = esc(promoToShow.title || promoToShow.description || promoToShow.code || '');
        const code  = esc(promoToShow.code || '');
        // Shortfall hint — rupee gap ("Add ₹X more") for min-order promos, item-count gap
        // ("Add N more valid items to apply") for buy-N-get-N / min_qty promos. Reuses
        // promoStatus so both units render identically to the modal + next-tier suggestion.
        const hint  = !isApplicable ? esc(promoStatus(promoToShow, lines).msg) : '';
        // Reward coupons carry an opaque hash code, so don't print "Promo Code 4f9cdeb0";
        // the title already shows above. Keep the min-order hint when present. CI3 ref: 3162.
        const codeLine = isReward(promoToShow)
            ? (hint || 'Reward unlocked')
            : `Promo Code <strong>${code}</strong>${hint ? ` — ${hint}` : ''}`;
        // Merchant-authored applicability note (e.g. "Not Applicable on Combos, 6 in 1,
        // Magic Box & Beverages") lives in `description`. Collapsed by default behind an
        // accordion chevron next to the title; expand to see what the promo excludes.
        const rawDesc  = String(promoToShow.description || '').trim();
        const hasDesc  = rawDesc && rawDesc !== String(promoToShow.title || '').trim();
        // This block re-renders on every bill recalc, so persist the open state (keyed by
        // code) or the accordion would snap shut on any qty/address change.
        const descOpen = hasDesc && state.promoDescOpenCode === (promoToShow.code || '');
        const chevron  = hasDesc
            ? `<button type="button" class="co-promo__sugg-toggle${descOpen ? ' is-open' : ''}" aria-expanded="${descOpen ? 'true' : 'false'}" aria-label="Show offer details"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>`
            : '';
        const noteLine = hasDesc
            ? `<p class="co-promo__sugg-note"${descOpen ? '' : ' hidden'}>${esc(tidyPromoDesc(rawDesc))}</p>` : '';
        oneCoupon.innerHTML = `
<div class="co-promo__sugg-inner">
  <span class="co-promo__sugg-badge" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><path d="M9 9h.01"/><path d="M15 15h.01"/></svg>
  </span>
  <div class="co-promo__sugg-text">
    <p class="co-promo__sugg-desc">${title}${chevron}</p>
    <p class="co-promo__sugg-code">${codeLine}</p>
    ${noteLine}
  </div>
</div>`;
        // Accordion toggle — reveal/hide the description note in place.
        oneCoupon.onclick = hasDesc ? (e) => {
            const btn = e.target.closest('.co-promo__sugg-toggle');
            if (!btn) return;
            const note = oneCoupon.querySelector('.co-promo__sugg-note');
            if (!note) return;
            const open = note.hidden;
            note.hidden = !open;
            btn.classList.toggle('is-open', open);
            btn.setAttribute('aria-expanded', String(open));
            state.promoDescOpenCode = open ? String(promoToShow.code || '') : '';
        } : null;
    }

    if (oneCouponApply) {
        if (isApplicable) {
            oneCouponApply.innerHTML = `<button type="button" class="btn btn--sm btn--primary co-promo__sugg-apply" data-code="${esc(promoToShow.code || '')}">Apply</button>`;
            oneCouponApply.onclick = (e) => {
                const btn = e.target.closest('[data-code]');
                if (!btn) return;
                const mainInp = el('promoInput');
                if (mainInp) mainInp.value = btn.dataset.code;
                applyPromo();
            };
        } else {
            oneCouponApply.innerHTML = '';
            oneCouponApply.onclick = null;
        }
    }
    show('promoBlock');

    // Next-tier suggestion — when an applicable promo is already highlighted above,
    // surface the next-bigger promo with an "Add ₹X more to unlock" hint so the user
    // sees multiple suggestions stacked (matches the CI3 savings-corner pattern).
    const nextMsgEl = el('nextApplicablePromoMsg');
    if (best && next && nextMsgEl) {
        // Shortfall in the promo's own unit: rupees (min-order) or item count (min_qty /
        // buy-N-get-N). A min_qty promo whose MOV is already met needs items, not spend.
        const minQtyNext = parseInt(next.min_qty || 0, 10);
        const qtyNeed    = minQtyNext > 0 ? minQtyNext - promoApplicableQty(lines, next) : 0;
        const orderGap   = parseFloat(next.min_order_value || 0) - promoApplicableSubtotal(lines, next);
        // Render the promo TITLE as the heading and the shortfall on its own line. Buy-N-get-N
        // promos surface the item-COUNT gap first ("Add N more valid item(s) to apply"), matching
        // promoStatus; otherwise the rupee gap ("Add items worth ₹X more to apply").
        let shortfall;
        if (qtyNeed > 0) {
            shortfall = `Add <strong>${qtyNeed}</strong> more valid item${qtyNeed === 1 ? '' : 's'} to apply`;
        } else {
            shortfall = `Add items worth <strong>${fmt(orderGap)}</strong> more to apply`;
        }
        const label = esc(next.title || next.description || next.code || '');
        nextMsgEl.innerHTML = `<span class="co-promo__next-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span><span class="co-promo__next-text"><strong class="co-promo__next-title">${label}</strong><span class="co-promo__next-sub">${shortfall}</span></span>`;
        show('nextApplicablePromo');
    } else {
        hide('nextApplicablePromo');
    }
}

// Friendly empty state for the Savings Corner when offers exist but none applies to
// the current cart. Below MOV → show the shortfall ("Add ₹X more to unlock offers");
// otherwise the items just aren't eligible. Keeps the card useful instead of a bare
// title + "View All Offers" link.
function renderPromoEmptyState(order) {
    const titleEl = el('promoEmptyTitle');
    const subEl   = el('promoEmptySub');
    if (!titleEl || !subEl) return;

    const minVal   = Number(order?.minOrderAmount ?? order?.min_order_value ?? 0);
    const subTotal = Number(order?.subTotal ?? 0);
    const shortfall = minVal > 0 ? minVal - subTotal : 0;

    if (shortfall > 0) {
        titleEl.innerHTML = `Add <strong>${fmt(shortfall)}</strong> more to unlock offers`;
        subEl.textContent = 'Reach the minimum order value to apply available coupons.';
    } else {
        titleEl.textContent = 'No offers for your current items';
        subEl.textContent   = 'Tap View All Offers to explore everything available.';
    }
    show('promoEmptyState');
}

// ─── Membership savings (above Savings Corner) ────────────────────────
// Renders the parallel "MEMBERSHIP SAVINGS" card when the API returns promos
// flagged is_membership_offer=1 (set server-side for active members).
// Markup lives in checkout.php:134 (#membership_promo_list, hidden by default).
// Suggestion-only: no manual input, no "view all" — the API curates the list.
function renderMembershipSavings(order, promos) {
    const card = el('membership_promo_list');
    if (!card) return;

    const memberPromos = (promos || []).filter(p => Number(p.is_membership_offer ?? 0) === 1);

    // ── Ambient membership benefits (item-level) — render even with no membership PROMO.
    // CART_MEMBERSHIP_PROMO_CARD.md §2/§6.2/§8: group cart lines by membership_benefit_id,
    // sum saving_total; surface free delivery; compute the aggregated "Total Member savings".
    const memBenefitMap = {};
    (state.lines || []).forEach(li => {
        const bid = li?.membership_benefit_id;
        if (!(Number.isFinite(Number(bid)) && Number(bid) > 0)) return;
        const id = String(bid);
        const sv = Number(li.saving_total);
        if (!memBenefitMap[id]) memBenefitMap[id] = { name: (li.benefit_name && String(li.benefit_name).trim()) || 'Membership Discount', savings: 0 };
        if (Number.isFinite(sv) && sv > 0) memBenefitMap[id].savings += sv;
    });
    const memItemBenefits = Object.values(memBenefitMap).filter(b => b.savings > 0);
    const memFreeDelivery = String(order?.free_delivery_from_membership) === '1';
    const memAppliedIsMember = !!state.appliedPromo && memberPromos.some(p => p.code === state.appliedPromo);

    // Total = item savings + delivery savings (pre-discount delivery charge) + applied
    // membership-promo rupee discount (exclude discount_type 7 free-item + cashback promos).
    let memDeliverySavings = 0;
    if (memFreeDelivery) {
        const slash = Number(order?.slash_delivery_charges);
        const dcFallback = Number(order?.onlineOrdersDeliveryCharges || 0) + Number(order?.dc_surge_applied || 0);
        memDeliverySavings = Number.isFinite(slash) && slash > 0 ? slash : (dcFallback > 0 ? dcFallback : 0);
    }
    let memPromoSavings = 0;
    if (memAppliedIsMember && String(order?.discount_type ?? '') !== '7' && !order?.cashbackMsg) {
        const d = Number(order?.discount);
        if (Number.isFinite(d) && d > 0) memPromoSavings = d;
    }
    const ambientSavingsTotal = memItemBenefits.reduce((s, b) => s + b.savings, 0) + memDeliverySavings + memPromoSavings;

    // Gate: show when there's a membership promo OR any item-level benefit OR free delivery.
    // (CI3 gated on promos alone; we widen it so item-level slash benefits surface too.)
    if (!memberPromos.length && !memItemBenefits.length && !memFreeDelivery) {
        card.hidden = true;
        card.classList.remove('co-promo--conflict', 'co-promo--disabled');
        const t = el('membershipAmbientTop'); if (t) t.innerHTML = '';
        const b = el('membershipAmbientTotal'); if (b) b.innerHTML = '';
        return;
    }

    // Render ambient rows (free delivery + one row per redeemed benefit) + the total footer.
    const MEM_CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    const MEM_RUPEE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10M7 8h10M7 13l8 8M7 13h3a5 5 0 0 0 0-10"/></svg>`;
    const ambTopEl = el('membershipAmbientTop');
    if (ambTopEl) {
        let h = '';
        if (memFreeDelivery) h += `<div class="co-mem-row"><span class="co-mem-row__ic co-mem-row__ic--ok">${MEM_CHECK}</span><span>Unlimited Free Delivery</span></div>`;
        memItemBenefits.forEach(b => {
            h += `<div class="co-mem-row"><span class="co-mem-row__ic">${MEM_RUPEE}</span><span>Membership benefit applied - ${esc(b.name)}</span></div>`;
        });
        ambTopEl.innerHTML = h;
    }
    const ambTotEl = el('membershipAmbientTotal');
    if (ambTotEl) ambTotEl.innerHTML = ambientSavingsTotal > 0
        ? `<div class="co-mem-total"><span class="co-mem-row__ic">${MEM_RUPEE}</span><span>Total Member savings of ${fmt(ambientSavingsTotal)}</span></div>`
        : '';
    // Gate disabled: subscription_type is null for many active members (plan lives in
    // orderDetails.memberships), which wrongly hid the whole card. Re-enable only if the
    // server starts populating subscription_type reliably for all members.
    // if (!String(order?.subscription_type ?? '').trim()) {
    //     card.hidden = true;
    //     card.classList.remove('co-promo--conflict', 'co-promo--disabled');
    //     return;
    // }
    card.hidden = false;

    // Disable (faded + disabled Apply) only when every cart line has promo_applicable_master=0.
    // CI3 parity: membership savings are NOT gated on per-line OOS — an out-of-stock line is
    // excluded from the bill total and the membership offer still applies to the valid items.
    const cartBlocked        = isPromoBlockedByCart();
    const membershipDisabled = cartBlocked;

    card.classList.toggle('co-promo--disabled', membershipDisabled);

    // Same three cases as renderSavingsCorner, mirrored for membership:
    //   1. A membership promo is applied → show #membershipPromoUnlock, hide suggestion
    //   2. A regular promo is applied → keep suggestion visible but DIM the card so the
    //      user can click Apply to trigger the switch-confirm popup.
    //   3. Nothing applied → standard suggestion flow.
    const appliedIsMember  = !!state.appliedPromo && memberPromos.some(p => p.code === state.appliedPromo);
    const appliedIsRegular = !!state.appliedPromo && !appliedIsMember;

    if (appliedIsMember) {
        set('membership_promo_cashback', `"${state.appliedPromo}" applied — saving ${fmt(order?.discount || 0)}`);
        show('membershipPromoUnlock');
        hide('membershipPromoBlock');
        card.classList.remove('co-promo--conflict');
        return;
    }
    hide('membershipPromoUnlock');
    card.classList.toggle('co-promo--conflict', appliedIsRegular);

    const lines    = state.lines || [];

    const block = el('membershipPromoBlock');
    if (!block) return;

    // Pick best (or next) to show as the single inline strip — same as Savings Corner.
    // When neither exists (every membership promo is section-mismatched or the cart's
    // only items block promos — e.g. member-priced rows with promo_applicable_master=0),
    // fall back to the first promo rendered DISABLED with a "not applicable" caption,
    // so the offer still surfaces (CART_MEMBERSHIP_PROMO_CARD.md §6.5 disabled anchor).
    const { best, next } = pickBestPromo(memberPromos, lines);
    const promoToShow = best || next || memberPromos.find(p => p.code !== state.appliedPromo) || null;
    const promoForced = !best && !next;   // showing the disabled fallback anchor

    if (!promoToShow) {
        hide('membershipPromoBlock');
        hide('viewMoreMembershipSection');
        return;
    }

    const svgBadge = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><path d="M9 9h.01"/><path d="M15 15h.01"/></svg>`;

    const buildStrip = (p, forceDisabled) => {
        const disabled = forceDisabled || membershipDisabled;
        const { ok, reason } = disabled ? { ok: false, reason: '' } : promoStatus(p, lines);
        const code  = esc(p.code || '');
        const title = esc(p.title || p.description || p.code || '');
        // Reward coupons carry an opaque hash code, so suppress the "Promo Code <hash>" caption
        // (the title is already shown above). CI3 ref: 3162.
        const codeTag = isReward(p) ? '' : `Promo Code <strong>${code}</strong>`;
        // Caption: applicable → promo code; section-valid but below MOV → "Add ₹X more";
        // section-mismatch / cart blocks promos → "Not Applicable on current cart items".
        let codeLine;
        if (ok) {
            codeLine = codeTag || 'Reward unlocked';
        } else if (!disabled && reason === 'minorder') {
            const more = esc(`Add ${fmt(parseFloat(p.min_order_value || 0) - promoApplicableSubtotal(lines, p))} more`);
            codeLine = codeTag ? `${codeTag} — ${more}` : more;
        } else {
            codeLine = 'Not Applicable on current cart items';
        }
        const btn = ok
            ? `<button type="button" class="btn btn--sm btn--primary co-promo__sugg-apply" data-apply-promo="${code}">Apply</button>`
            : `<button type="button" class="btn btn--sm btn--primary co-promo__sugg-apply" disabled>Apply</button>`;
        return `<div class="co-promo__suggestion co-promo__suggestion--member${ok ? '' : ' co-promo__suggestion--disabled'}">
  <div class="co-promo__sugg-inner">
    <span class="co-promo__sugg-badge" aria-hidden="true">${svgBadge}</span>
    <div>
      <p class="co-promo__sugg-desc">${title}</p>
      <p class="co-promo__sugg-code">${codeLine}</p>
    </div>
  </div>
  ${btn}
</div>`;
    };

    // Inline card: single best/next strip (or the disabled fallback anchor).
    block.innerHTML = buildStrip(promoToShow, promoForced);
    block.onclick = (e) => {
        const btn = e.target.closest('[data-apply-promo]');
        if (!btn) return;
        applyPromo(btn.dataset.applyPromo);
    };
    show('membershipPromoBlock');

    // "View All Membership Offers" — only when there are more promos beyond the one shown.
    if (memberPromos.length > 1) {
        set('viewMoreMembershipText', `View All Membership Offers (${memberPromos.length})`);
        show('viewMoreMembershipSection');
    } else {
        hide('viewMoreMembershipSection');
    }

    // Header cart-value lines — same as the Saving Corner "Apply Coupon" modal
    // (renderPromoList): eligible promo subtotal, plus the full cart total when they differ.
    const memEligible = promoEligibleSubtotal(lines);
    const memTotal    = Number(state.order?.subTotal ?? 0);
    const memAmtEl    = el('membershipPromoEligibleAmount');
    if (memAmtEl) memAmtEl.textContent = fmtDec(memEligible);
    const memTotalRow = el('membershipPromoTotalCartRow');
    const memTotalAmt = el('membershipPromoTotalAmount');
    if (memTotalRow && memTotalAmt) {
        if (Math.abs(memTotal - memEligible) > 0.5) {
            memTotalAmt.textContent = fmtDec(memTotal);
            memTotalRow.hidden = false;
        } else {
            memTotalRow.hidden = true;
        }
    }

    // Populate the modal with ALL membership promos (sorted: applicable first).
    const modalContainer = el('membershipPromoListContainer');
    if (modalContainer) {
        const sorted = [...memberPromos].sort((a, b) => {
            const aOk = !membershipDisabled && promoStatus(a, lines).ok;
            const bOk = !membershipDisabled && promoStatus(b, lines).ok;
            if (aOk !== bOk) return aOk ? -1 : 1;
            return parseFloat(a.min_order_value || 0) - parseFloat(b.min_order_value || 0);
        });
        // Modal uses co-promo-item card style — identical to the Saving Corner
        // "View All Offers" modal (renderPromoList) so members see one consistent design.
        modalContainer.innerHTML = sorted.map(p => {
            const { ok, msg, reason } = membershipDisabled
                ? { ok: false, msg: '', reason: '' }
                : promoStatus(p, lines);
            const code = esc(p.code || '');
            // Reward coupons show the merchant title in place of the opaque hash. CI3 ref: 3162.
            const heading = esc(promoLabel(p));
            const desc = isReward(p) ? esc(p.description || '') : esc(p.title || p.description || '');
            const rawDesc  = String(p.description || '').trim();
            const exclLine = (!isReward(p) && String(p.title || '').trim() && rawDesc && rawDesc !== String(p.title).trim())
                ? `<p class="co-promo-item__excl">${esc(tidyPromoDesc(rawDesc))}</p>` : '';
            // App parity: pre-application shortfalls (section / min-order / MOQ) read RED.
            const noteLine = msg
                ? `<p class="co-promo-item__note">${esc(msg)}</p>`
                : '';
            const btnHtml = ok
                ? `<button type="button" class="co-promo-item__apply" data-apply-promo="${code}">Apply</button>`
                : `<button type="button" class="co-promo-item__apply" disabled>Apply</button>`;
            return `<div class="co-promo-item${ok ? '' : ' co-promo-item--disabled'}">
  <div class="co-promo-item__body">
    <p class="co-promo-item__code">${heading}</p>
    ${desc ? `<p class="co-promo-item__desc">${desc}</p>` : ''}
    ${exclLine}
    ${noteLine}
  </div>
  <div class="co-promo-item__action">${btnHtml}</div>
</div>`;
        }).join('');
        modalContainer.onclick = (e) => {
            const btn = e.target.closest('[data-apply-promo]');
            if (!btn) return;
            closeModal('membershipPromoModal');
            applyPromo(btn.dataset.applyPromo);
        };
    }
}

function renderPromoList() {
    const container = el('promoListContainer');
    if (!container) return;

    const lines    = state.lines || [];
    // CI3 parity: header shows promo-eligible subtotal as "Eligible Cart Value", and
    // the full cart subtotal as a secondary "Total Cart Value" line when they differ.
    const subTotal     = promoEligibleSubtotal(lines);
    const totalSubtotal = Number(state.order?.subTotal ?? 0);

    const amtEl = el('promoEligibleAmount');
    if (amtEl) amtEl.textContent = fmtDec(subTotal);
    const totalRow = el('promoTotalCartRow');
    const totalAmt = el('promoTotalAmount');
    if (totalRow && totalAmt) {
        if (Math.abs(totalSubtotal - subTotal) > 0.5) {
            totalAmt.textContent = fmtDec(totalSubtotal);
            totalRow.hidden = false;
        } else {
            totalRow.hidden = true;
        }
    }

    const promos = state.promos.filter(p => Number(p.is_membership_offer ?? 0) === 0);
    if (!promos.length) {
        container.innerHTML = '<p class="body-sm muted co-promo__empty">No offers available right now.</p>';
        return;
    }

    // Sort: applicable promos first, then by min_order_value ascending
    const sorted = [...promos].sort((a, b) => {
        const aOk = promoStatus(a, lines).ok;
        const bOk = promoStatus(b, lines).ok;
        if (aOk !== bOk) return aOk ? -1 : 1;
        return parseFloat(a.min_order_value || 0) - parseFloat(b.min_order_value || 0);
    });

    container.innerHTML = sorted.map(p => {
        const { ok, msg, reason } = promoStatus(p, lines);
        const code = esc(p.code || '');
        // Reward coupons carry an opaque hash code, so the heading shows the merchant title
        // instead (CI3 ref: 3162). The button still applies the real code.
        const heading = esc(promoLabel(p));
        // Secondary line: the marketing blurb. For a reward the title is already the heading,
        // so fall back to its description; for a promo use title/description as before.
        const desc = isReward(p) ? esc(p.description || '') : esc(p.title || p.description || '');
        // When the title is used as the headline (above), the merchant's `description`
        // often carries the applicability note ("Not Applicable on Combos, Beverages…").
        // Show it as a muted exclusion line so the user knows what the promo excludes.
        const rawDesc  = String(p.description || '').trim();
        const exclLine = (!isReward(p) && String(p.title || '').trim() && rawDesc && rawDesc !== String(p.title).trim())
            ? `<p class="co-promo-item__excl">${esc(tidyPromoDesc(rawDesc))}</p>` : '';
        // App parity: every pre-application shortfall reads RED as a warning — section
        // mismatch ("Not applicable"), min-order ("Add ₹X more to apply") AND min-qty / MOQ
        // ("Add N more valid item(s) to apply"). Uses the default red `.co-promo-item__note`.
        const noteLine = msg
            ? `<p class="co-promo-item__note">${esc(msg)}</p>`
            : '';
        const btnHtml = ok
            ? `<button type="button" class="co-promo-item__apply" data-apply-promo="${code}">Apply</button>`
            : `<button type="button" class="co-promo-item__apply" disabled>Apply</button>`;
        return `<div class="co-promo-item${ok ? '' : ' co-promo-item--disabled'}">
  <div class="co-promo-item__body">
    <p class="co-promo-item__code">${heading}</p>
    ${desc ? `<p class="co-promo-item__desc">${desc}</p>` : ''}
    ${exclLine}
    ${noteLine}
  </div>
  <div class="co-promo-item__action">${btnHtml}</div>
</div>`;
    }).join('');

    container.onclick = (e) => {
        const btn = e.target.closest('[data-apply-promo]');
        if (!btn) return;
        const inp = el('promoInputModal');
        if (inp) inp.value = btn.dataset.applyPromo;
        applyPromo();
    };
}

// ─── Recommendations ──────────────────────────────────────────

// ─── Feed item map (real-time OOS + MRP) ─────────────────────

const feedItemMap = {};

// The feed's rows.templates pool, keyed by templateId. An item points into this
// with {templateId, minQty, maxQty}; the pool supplies the choices themselves.
const feedTemplatePool = {};

// Menu member-pricing (member slashed price / guest unlock), shared with the menu
// page via membershipPricing.js. Null until loadMemberPricing() resolves, or when
// the outlet doesn't offer membership. Drives the "Craving More?" rec treatment.
let memberPricing = null;

// Fetch menu member-pricing for the recommendations rail, mirroring menu.js's
// loadMemberPricing(). No-op when the outlet doesn't offer membership. Silent on
// failure — recs fall back to plain prices. Repaints the rail once it lands.
async function loadMemberPricing() {
    if (Number(cfg.membershipApplicable) !== 1) return;
    const pricing = await fetchMenuMemberPricing({
        businessId:       cfg.businessId,
        parentBusinessId: cfg.parentId,
        user:             userData(),
    });
    if (!pricing || !pricing.buckets.length) return;
    memberPricing = pricing;
    if (state.suggs.length) renderRecommendations(state.suggs, state.lines);
}

function getCloudBrandId() {
    if (!cfg.isCloud) return '';
    try { return sessionStorage.getItem('cloud_brand_id_' + cfg.businessId) || ''; }
    catch { return ''; }
}

function getFeedUrl() {
    const bId    = cfg.businessId;
    const base   = `${getMenuFeedBase()}/feed/v2`;
    const isDine = cfg.dineMenu == 1 && (cfg.orderType === 'dine_in' || cfg.orderType === 'pickup');
    if (isDine) return `${base}/feed_${bId}_dinein.json`;
    const brand = getCloudBrandId();
    if (brand) return `${base}/feed_${bId}_${brand}.json`;
    return `${base}/feed_${bId}.json`;
}

// Returns both halves of the feed the redeem sheet needs: the sections, and the
// customisation pool. rows.templates is the POOL of add-on sections and their
// items; an item's own `templates` array carries only {templateId, minQty, maxQty}
// pointing into it. Same split CI3 works from (main_temp = data.rows.templates),
// mirrored on the menu page by templateList + loadTemplates().
async function fetchFeedSections(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return { sections: [], templates: [] };
        const data = await res.json();
        return {
            sections:  data?.rows?.menu || data?.sections || [],
            templates: data?.rows?.templates || [],
        };
    } catch { return { sections: [], templates: [] }; }
}

async function loadFeedMap() {
    try {
        let { sections: secs, templates } = await fetchFeedSections(getFeedUrl());
        // Fall back to the base outlet feed if the brand-specific one was empty (e.g. cfg.parentId
        // doesn't match the menu page's brandId for non-cloud outlets).
        if (!secs.length) {
            const fallback = `${getMenuFeedBase()}/feed/v2/feed_${cfg.businessId}.json`;
            if (fallback !== getFeedUrl()) ({ sections: secs, templates } = await fetchFeedSections(fallback));
        }
        (templates || []).forEach(t => {
            const tid = String(t?.templateId || '');
            if (tid) feedTemplatePool[tid] = t;
        });
        secs.forEach(sec => {
            // sectionId lets the membership "sections" buckets match a rec item, the
            // same way the menu tags each item with its section (menu.js tagSec()).
            const sectionId = sec.sectionId ?? sec.id ?? '';
            (sec.items || []).forEach(r => {
                const id = String(r.id || '');
                if (id) {
                    const sp  = +r.sp  || 0;
                    const mrp = +r.mrp || 0;
                    const oos = (+r.status === -1) || (+r.out_of_stock === 1) || (+r.outOfStock === 1);
                    // slug: the loyalty catalog is keyed by item_slug and cart lines
                    // carry none, so the feed is what joins the two.
                    // tmpl/variants: an item that needs choices can't be added with a
                    // bare id — the redeem sheet uses these to decide whether it can
                    // offer an inline Add at all (see feedAddTargetForSlug).
                    feedItemMap[id] = { sp, mrp, oos, sectionId, image: r.image || '', veg: r.vegNonvegBoth || '', slug: r.itemSlug || r.slug || '',
                                        name: r.itemName || '', tmpl: (r.templates || []).length, variants: (r.variants || []).length,
                                        // The add-on groups themselves, so the sheet can offer the
                                        // choices in place instead of only linking out to the menu.
                                        tmpls: r.templates || [], tmplIds: r.templateId || '', viewType: +r.viewType || 0,
                                        // Hero copy for that sheet — the menu's popup shows the item
                                        // before its options, and a picker without them is a bare list.
                                        desc: r.description || '' };
                }
                // Variants — addToCart stores the variant's own id, so the feed map must
                // include them too. They nest more than one level: a size group can hold
                // its own choices ("XL Party Packs" → "Mutton Curry Cut 2kg" → "Raan Curry
                // Cut"), and the middle row is a LABEL, priced 0 and not orderable, while
                // the leaves carry the real price. Walking only the first level left those
                // leaves out of the map entirely and made the label look like the item.
                const walkVariants = (list, parent) => (list || []).forEach(v => {
                    const vid = String(v.id || '');
                    if (!vid) return;
                    const kids = v.variants || [];
                    const oos  = (+v.status === -1) || (+v.out_of_stock === 1) || (+v.outOfStock === 1);
                    // A variant often carries no slug of its own — inherit the parent's.
                    feedItemMap[vid] = {
                        sp: +v.sp || 0, mrp: +v.mrp || 0, oos, sectionId,
                        image: v.image || parent.image || '',
                        veg:   v.vegNonvegBoth || parent.vegNonvegBoth || '',
                        slug:  v.itemSlug || v.slug || parent.itemSlug || parent.slug || '',
                        name:  v.itemName || parent.itemName || '',
                        tmpl: (v.templates || []).length,
                        variants: kids.length,
                        tmpls: v.templates || [],
                        tmplIds: v.templateId || '',
                        desc: v.description || r.description || '',
                        // A variant inherits the parent's viewType: a combo's or a BOGO's
                        // options are a wizard, not an add-on list, and must not be
                        // offered as one (redeemAddonSpec refuses them).
                        viewType: +(v.viewType ?? r.viewType) || 0,
                        // Who this hangs off, so a group can be expanded into the
                        // choices it holds (see redeemGroupChildren).
                        parentFeedId: String(parent.id || ''),
                    };
                    walkVariants(kids, v);
                });
                walkVariants(r.variants, r);
            });
        });
    } catch { /* non-critical */ }
}

function renderRecommendations(suggestions, cartItems) {
    const container = el('complete-your-meal');
    if (!container) return;
    if (isPrebookingCheckout()) { container.hidden = true; return; }

    const cartIds = new Set((cartItems || []).map(i => String(i.itemId)));

    // Enrich with live feed data: skip OOS items and already-in-cart items.
    // Item images live under the PARENT business, not the outlet — CI3 ref:
    // ue_silver/js/checkout.js ~L29083 uses parentBusinessId for the CDN path.
    const pId  = cfg.parentId || window.AppConfig?.businessId;
    const recs = (suggestions || [])
        .filter(s => !cartIds.has(String(s.itemId || s.id)))
        .map(s => {
            const fid  = String(s.itemId || s.id);
            const feed = feedItemMap[fid];
            // Veg type from the live feed (authoritative — matches the menu page's
            // vegNonvegBoth); fall back to the suggestion's own field only when the feed
            // doesn't carry the item. The cart-API suggestion's veg field is unreliable.
            // _slug joins the item to the loyalty catalog, the same lookup the cart
            // rows use — a recommendation is a menu item like any other and should
            // carry the same points figures.
            return { ...s, _sp: feed?.sp || Number(s.sp || s.price || 0), _mrp: feed?.mrp || 0, _oos: feed?.oos ?? false, _sectionId: feed?.sectionId ?? s.sectionId ?? '', _img: feed?.image || '', _veg: feed?.veg || s.vegNonvegBoth || s.veg || '', _slug: feed?.slug || '' };
        })
        .filter(s => !s._oos);

    if (!recs.length) { container.hidden = true; return; }

    // Fallback when a suggestion has no image or the URL 404s — brand logo with
    // a grayscale tint. CI3 ref: ue_silver/js/checkout.js ~L29080.
    const brandLogo = state.order?.logo
        ? `${getCdnBase()}/brand_logo/${state.order.logo}`
        : '';

    container.hidden = false;
    container.innerHTML = `<div class="co-recs">
  <p class="co-recs__title">Craving More?</p>
  <div class="co-recs__grid">
    ${recs.slice(0, 10).map(item => {
        const rid    = item.itemId || item.id;
        const name   = item.displayItemName || item.name || '';
        const rawImg = item._img || item.image || item.imageUrl || item.image_url || '';
        const img    = rawImg ? (rawImg.startsWith('http') ? rawImg : `${getCdnBase()}/uploads/${pId}/${rawImg}`) : '';
        const sp     = item._sp;
        const mrp    = item._mrp;
        const disc   = mrp > sp && sp > 0 ? Math.round((mrp - sp) / mrp * 100) : 0;
        const showFallback = !img && brandLogo;
        const imgSrc = img || brandLogo;
        const imgTag = imgSrc
            ? `<img class="co-rec__img${showFallback ? ' co-rec__img--fallback' : ''}" src="${esc(imgSrc)}" alt="${esc(name)}" loading="lazy">`
            : `<div class="co-rec__img ph-image"></div>`;

        // Membership offer — mirrors the menu card (priceLineHTML / unlockStripHTML).
        // member → struck base price + slashed member price + "Saving … Member Benefit".
        // guest  → keep the normal price + an "Unlock with Membership" CTA below.
        const md = memberPricing
            ? getMembershipDiscountForItem({ id: rid, sectionId: item._sectionId, sp, mrp, isBogo: false }, memberPricing)
            : null;
        const isMember = md && md.mode === 'member';
        const isGuest  = md && md.mode === 'guest';
        // Member treatment replaces the "X% off" badge with the member savings caption.
        const discBadge = (disc > 0 && !isMember) ? `<span class="co-rec__disc">${disc}% off</span>` : '';
        const priceHTML = isMember
            ? `<p class="co-rec__price co-rec__price--member"><span class="co-rec__mrp">${fmt(md.mrp)}</span> ${fmt(Math.floor(md.memberPrice))}</p>`
            : `<p class="co-rec__price">${disc > 0 ? `<span class="co-rec__mrp">₹${mrp}</span> ` : ''}${fmt(sp)}</p>`;
        const planId    = (md && md.bucket && md.bucket.membership_plan_id != null) ? esc(String(md.bucket.membership_plan_id)) : '';
        const memberRow = isMember
            ? `<p class="co-rec__member-save">Saving <b>${fmt(md.mrp - Math.floor(md.memberPrice))}</b> - Member Benefit</p>`
            : (isGuest
                ? `<button type="button" class="co-rec__unlock" data-plan-id="${planId}">Unlock for ${fmt(Math.floor(md.memberPrice))} with Membership</button>`
                : '');

        return `<div class="co-rec">
      ${imgTag}
      ${discBadge}
      <div class="co-rec__body">
        ${vegMarkerHTML({ veg: item._veg, is_veg: item.is_veg })}
        <p class="co-rec__name">${esc(name)}</p>
        ${priceHTML}
        <button type="button" class="co-rec__add"
          data-rec-id="${esc(String(rid))}"
          data-rec-name="${esc(name)}"
          data-rec-price="${sp}"
          data-rec-veg="${esc(item._veg || '')}">ADD +</button>
        ${memberRow}
      </div>
      ${recStripHTML(item._slug)}
    </div>`;
    }).join('')}
  </div>
</div>`;

    // CI3 parity (ue_silver/js/checkout.js ~L29120): suggestion images fall back
    // on load error to the brand logo (grayscale). If even the logo fails, swap
    // to the empty .ph-image placeholder so we don't show a broken-image icon.
    container.querySelectorAll('img.co-rec__img').forEach(img => {
        img.addEventListener('error', () => {
            if (brandLogo && img.src !== brandLogo) {
                img.classList.add('co-rec__img--fallback');
                img.src = brandLogo;
                return;
            }
            const ph = document.createElement('div');
            ph.className = 'co-rec__img ph-image';
            img.replaceWith(ph);
        });
    });

    container.onclick = async (e) => {
        // Guest "Unlock with Membership" CTA → memberships page (menu parity).
        if (e.target.closest('button.co-rec__unlock')) { location.href = '/memberships'; return; }
        const btn = e.target.closest('button.co-rec__add');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '…';
        const recId = btn.dataset.recId;
        try {
            await addItemToCart(recId, btn.dataset.recName, Number(btn.dataset.recPrice), btn.dataset.recVeg);
        } catch (err) {
            console.warn('[checkout] Failed to add rec item:', err);
        }
        renderCartItems();
    };
}

// Add one unit of an item to the cart from the checkout page — the rec rail and
// the redeem sheet's eligible list both land here.
//
// Two steps, not one: the local v4_cart write is what every other surface reads,
// and the server add is explicit because loadCartSummary() sends an empty probe
// and would never sync a new item mid-session — it would stay local-only until
// the next full menu-page load. Mirrors the syncCart('add', […]) pattern in
// menu.js / grocery.js.
async function addItemToCart(itemId, name, price, veg, subItems) {
    const subs = Array.isArray(subItems) && subItems.length ? subItems : null;
    v4AddItem(itemId, name, price, veg, subs);
    const line = subs ? { itemId: String(itemId), qty: 1, subItems: subs }
                      : { itemId: String(itemId), qty: 1 };
    const payload = JSON.stringify({ items: [line] });
    let parsed;
    try {
        parsed = parseCartResp(await callCartApi({ action: 'add', cart: payload }));
    } catch (err) {
        // The local write is optimistic and every caller leaves its sheet open on a
        // failure, so the next tap on the same Add would merge into the line the
        // server never received — one add, qty 2, and a cart the server disagrees
        // with. Give the unit back before the caller hears about the failure.
        v4UndoAdd(itemId, subs);
        throw err;
    }
    const localItems = getV4Cart().items || [];
    const subtotal   = localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
    applyCartResp(parsed, localItems, subtotal);
}

// ─── Pay CTA state machine ────────────────────────────────────

const CTA_IDS = ['payBTN','fastPayFooter','requestBillBTN','pushBTN','selectAddressBtn',
    'selectSlotActionBtn','selectTableBtn','selectCarNumberBtn',
    'selectPickOptionBtn','selectPickSlotBtn','emptyCartBTN'];

// A flag is "blocked" only when it's an explicit 0/"0". null/undefined never counts —
// mirrors CI3's loose `== 0` (null == 0 is false), and avoids Number(null) === 0 === true.
function valBlocked(v) { return v !== null && v !== undefined && Number(v) === 0; }

// A cart line is unavailable (OOS / not in slot) when its own validateStatus is blocked,
// or any of its sub-items is. Same contract renderCartLineHTML uses to swap the qty stepper
// for a Remove button. Used to gate Pay Securely even when cart-level validation.status === 1.
function lineUnavailable(li) {
    if (valBlocked(li?.validateStatus)) return true;
    const subs = Array.isArray(li?.subItems) ? li.subItems : Object.values(li?.subItems || {});
    return subs.some(s => valBlocked(s?.validateStatus));
}
function anyLineUnavailable() { return (state.lines || []).some(lineUnavailable); }

function updatePayCta(order) {
    CTA_IDS.forEach(id => hide(id));

    // Empty cart — only when BOTH mirrors agree there's nothing left. The server (state.lines)
    // is authoritative for what actually renders; gating on the local v4_cart alone let an
    // optimistic local over-delete flip this to "Cart is Empty" while items were still on screen.
    if (!(getV4Cart().items || []).length && !(state.lines || []).length) { show('emptyCartBTN'); return; }

    // Outlet closed — banner at top of page conveys the message; suppress the bottom CTA
    if (!cfg.outlet_open) {
        return;
    }

    // Per-line availability gate. Checked BEFORE the order-type/address branches below: an
    // OOS / not-in-slot line (validateStatus=0 → "Item is Out of Stock. Kindly Remove") is
    // independent of address or slot selection, and its price is already excluded from the
    // bill total. The only valid next action is to remove it — so suppress the Select Address /
    // Pay CTA and surface the removal error instead, even when no address is selected yet.
    if (anyLineUnavailable()) {
        const notice = el('cartErrNotice');
        if (notice) {
            const titleEl  = el('cartErrTitle');
            const detailEl = el('cartErrDetail');
            if (titleEl)  titleEl.textContent  = 'Some items are out of stock';
            if (detailEl) { detailEl.textContent = 'Please remove the unavailable items to continue.'; detailEl.hidden = false; }
            notice.hidden = false;
        }
        return;
    }

    const ot = cfg.orderType || 'delivery';

    // Delivery with NO address selected: the only meaningful next action is to pick one, so
    // the Select Address CTA takes priority over every cart-level notice below. In particular
    // the server cart may still be computing delivery against a since-deleted address and
    // return validation.status=0 "Not delivering to this area" — misleading when the user has
    // no address at all. The not-deliverable notice is reserved for when an address IS
    // selected but falls outside the delivery radius (state.selectedAddressDeliverable===false).
    // Hide the notice explicitly — this returns before the L2215 reset, so a notice left
    // visible by a prior call (e.g. the stale "Not delivering" message) would otherwise persist.
    if (ot === 'delivery' && !state.selectedAddressId) {
        if (el('cartErrNotice')) el('cartErrNotice').hidden = true;
        show('selectAddressBtn');
        return;
    }

    // Server-side cart validation (CI3 rows.validation contract). status=0 means cart-level
    // failure — e.g. item not available in selected slot, item out of stock, MOV not met.
    // Mirrors CI3 checkout.js Render.cta P1 branch (~L31172): hide pay, show error notice.
    const notice = el('cartErrNotice');
    const v = state.validation;
    if (v && Number(v.status) === 0) {
        if (notice) {
            // CI3 parity: show the server's validation.msg verbatim — it already describes
            // the actual reason (slot unavailable, OOS, MOV, "Please Enable Location Services",
            // etc.). CI3 ref: order_new_1/checkout.php:581 → $('#errBTN').html(validation.msg).
            // Do NOT fabricate a headline (e.g. "Items not available in this slot") — that
            // mis-framed non-slot failures like the location error under a slot heading.
            const serverMsg = String(v.msg || v.message || '').trim();
            const titleEl  = el('cartErrTitle');
            const detailEl = el('cartErrDetail');
            if (titleEl)  titleEl.textContent  = serverMsg || 'Cannot place order';
            if (detailEl) { detailEl.textContent = ''; detailEl.hidden = true; }
            notice.hidden = false;
        }
        return;
    }

    if (notice) notice.hidden = true;

    // Minimum order value
    const minVal   = Number(order?.minOrderAmount ?? order?.min_order_value ?? 0);
    const subTotal = Number(order?.subTotal ?? 0);
    if (minVal > 0 && subTotal < minVal) {
        const btn = el('emptyCartBTN');
        if (btn) {
            btn.textContent = `Add ${fmt(minVal - subTotal)} more to order`;
            btn.hidden = false;
        }
        return;
    }

    if (ot === 'delivery') {
        // (no-address case handled above — at this point an address is always selected)
        if (state.selectedAddressDeliverable === false) {
            if (notice) {
                const titleEl = el('cartErrTitle');
                const detailEl = el('cartErrDetail');
                if (titleEl)  titleEl.textContent = 'Not delivering to this area';
                if (detailEl) detailEl.hidden = true;
                notice.hidden = false;
            }
            return;
        }
        if (slotsOfferedFor('delivery', order) && slotPickNeeded(order)) { show('selectSlotActionBtn'); return; }
    } else if (ot === 'pickup') {
        if (slotsOfferedFor('pickup', order) && slotPickNeeded(order))   { show('selectPickSlotBtn');   return; }
    } else if (ot === 'dine_in') {
        // Block only until user either enters a table or explicitly skips
        if (!cfg.tableId && state.selectedTableId === null && !state.tableSkipped) {
            show('selectTableBtn'); return;
        }
    } else if (ot === 'in_car') {
        if (!state.carNumber)                                    { show('selectCarNumberBtn');  return; }
    }

    // Fast checkout: all pay gates have passed here (doc §5.3). Only shown on mobile —
    // desktop always lands on the payment screen so the fast footer adds no value there.
    if (state.lastPaymentMethod && isMobileUA()) { showFastPayFooter(order); return; }
    show('payBTN');
}

// Populate + reveal the two-part fast-checkout footer (PAY USING … | Pay Securely).
function showFastPayFooter(order) {
    const lp = state.lastPaymentMethod;
    if (!lp) { show('payBTN'); return; }

    const iconEl = el('fastPayAppIcon');
    if (iconEl) {
        iconEl.src = lp.logo;
        iconEl.alt = lp.name;
        iconEl.onerror = () => { iconEl.style.display = 'none'; };
    }
    const nameEl = el('fastPayAppName');
    if (nameEl) nameEl.textContent = `${lp.name} UPI`;
    const amtEl = el('fastPayTotal');
    if (amtEl) amtEl.textContent = fmt(Number(order?.totalAmt ?? state.order?.totalAmt ?? 0));

    show('fastPayFooter');
}

// ─── Address ──────────────────────────────────────────────────

// Address type label (CI3: name field is numeric type or string)
// Display label must match the add-address form's own chips (Home / Office / Hotel / Other),
// so type-2 shows "Office" — NOT "Work" — consistently with the home modal (location_picker.js).
const ADDR_TYPE = { '1': 'Home', '2': 'Office', '3': 'Hotel', '4': 'Other',
                    'home': 'Home', 'office': 'Office', 'work': 'Office', 'hotel': 'Hotel', 'other': 'Other' };
function addrTypeLabel(name) {
    if (!name) return 'Home';
    return ADDR_TYPE[String(name).toLowerCase()] || String(name) || 'Home';
}

// Populates the "<Type> in <N> Mins" chip next to the Delivery Address label.
// CI3 parity: ue_silver/js/checkout.js showed the ETA inline with the address card.
// Pass an explicit addr name when known (click/select handlers); otherwise the
// helper falls back to 'Home'. Clears the chip on non-delivery order types.
function updateDeliveryETA(addrName) {
    const dtEl = document.getElementById('deliveryTime');
    const dtMobEl = document.getElementById('deliveryTimeMobile');
    const clear = () => { if (dtEl) dtEl.innerHTML = ''; if (dtMobEl) dtMobEl.innerHTML = ''; };
    if (!dtEl && !dtMobEl) return;
    // Without a selected address on a delivery order there's nothing to label.
    if ((cfg.orderType || 'delivery') !== 'delivery' || !state.selectedAddressId) {
        clear();
        return;
    }
    const pin =
        '<svg class="co-detail-row__eta-pin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>'
        + '<circle cx="12" cy="10" r="3"/>'
        + '</svg>';
    // No 30-min fallback here: an unusable value means there's no per-order ETA to promise,
    // and the `mins > 0` branch below then shows the address type without a time.
    const mins = etaMins(state.order?.onlineDeliveryTime, cfg.onlineDeliveryTime);
    // A scheduled (later) slot overrides the now-ETA: onlineDeliveryTime is the outlet's
    // deliver-now promise, so pairing it with "Tomorrow, 7:30 AM - 9:00 AM" reads as a
    // contradiction ("Home in 45 mins" for a next-day slot). selectedSlot 0 = deliver-now,
    // null = nothing picked yet — only a truthy non-zero id means a scheduled window.
    const laterSlot = state.selectedSlot !== null && Number(state.selectedSlot) !== 0;
    // Decouple the address TYPE from the ETA: the type label (Home/Office/…) always shows
    // beside the address. The "<Type> in <ETA>" form only applies when a real per-order ETA
    // exists AND the address is deliverable — slot-based / pincode brands have no such ETA
    // (mins <= 0), but the type must still appear. Duration formatter matches the slot text.
    let html;
    if (mins > 0 && !laterSlot && state.selectedAddressDeliverable !== false) {
        html = pin
            + `<div class="co-detail-row__eta-type">${addrTypeLabel(addrName)} in</div>`
            + `<div class="co-detail-row__eta-time">${formatDuration(mins)}</div>`;
    } else {
        html = pin + `<div class="co-detail-row__eta-type">${addrTypeLabel(addrName)}</div>`;
    }
    if (dtEl) dtEl.innerHTML = html;
    if (dtMobEl) dtMobEl.innerHTML = html;
}
// Drop empty strings AND "0"/"0.0" placeholders — legacy rows (and pins with no
// reverse-geocoded state/pincode) come back from upstream with state/pincode = "0".
function addrNotZero(v) {
    if (v === null || v === undefined) return false;
    var s = String(v).trim();
    return s !== '' && s !== '0' && s !== '0.0';
}
function addrFullText(addr) {
    return [addr.addressLine1, addr.addressLine2, addr.locality, addr.city, addr.postalCode]
        .filter(addrNotZero).join(', ').replace(/,\s*,/g, ',').replace(/,\s*$/, '');
}

// forceRecompute: the add-new-address path (onSaved) must ALWAYS re-fetch the cart so
// the bill reflects the new address's delivery charges. The coord-diff gate below
// (lat !== usedLat) skips the recompute when the server echoes back the same coords the
// map pin just sent — leaving DC = 0. CI3 recomputes unconditionally after a save, so
// callers committing a brand-new selection pass forceRecompute=true to match that.
async function loadAddresses(forceRecompute = false) {
    const container = el('savedAddressList');
    if (!container) return;
    container.innerHTML = '<p class="body-sm muted co-addr-loading">Loading addresses…</p>';

    try {
        const ud  = userData();
        const url = `${getApiBase()}/client/getDeliveryAddress/${cfg.businessId}/${ud.contactMappingId || ''}/${ud.token || ''}`;
        const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`Address API ${res.status}`);
        const resp = await res.json();

        const addresses = resp?.rows || [];

        if (!addresses.length) {
            container.innerHTML =
                '<div class="co-addr-empty">' +
                  '<svg class="co-addr-empty__icon" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
                  '<p class="co-addr-empty__title">No saved addresses yet</p>' +
                  '<p class="co-addr-empty__sub">Add a delivery address to check availability and see your delivery time.</p>' +
                '</div>';
            // Empty list invalidates any stale selection restored from localStorage —
            // otherwise the bill panel keeps showing a ghost address and Pay Securely
            // tries to checkout against an ID the server doesn't know.
            if (state.selectedAddressId) {
                state.selectedAddressId          = null;
                state.selectedAddressText        = '';
                state.selectedAddressName        = '';
                state.selectedAddressDeliverable = true;
                const key = addrStorageKey();
                if (key) { try { localStorage.removeItem(key); } catch {} }
                const dispEl = el('selectedAddressDisplay');
                if (dispEl) {
                    dispEl.textContent = 'No address selected';
                    dispEl.classList.remove('co-addr-display--warn');
                }
                const mobEl = el('selectedAddressMobile');
                if (mobEl) mobEl.textContent = 'No address selected';
                updateDeliveryETA();
                updatePayCta(state.order);
                loadCartSummary();
            }
            return;
        }

        // Collect whether ANY branch below changed the address state, and fire a SINGLE
        // cart recompute at the end. The stale-address branch and the auto-select branch can
        // both run in one pass (clear deleted → pick next), so calling loadCartSummary() in
        // each raced two un-awaited /client/cart fetches; the later response could render the
        // bill against the wrong address. One call against the final state avoids that.
        let recompute = false;

        // Validate the restored selection against the server's saved-address list.
        if (state.selectedAddressId) {
            const current = addresses.find(a => String(a.deliveryAddressId) === state.selectedAddressId);
            if (!current) {
                // Address no longer exists on the account — it would be rejected as
                // "Invalid delivery address" on submit. Clear it and fall back to the
                // neutral "No address selected" prompt (Pay → "Select Address" CTA).
                state.selectedAddressId          = null;
                state.selectedAddressText        = '';
                state.selectedAddressName        = '';
                state.selectedAddressLat         = '';
                state.selectedAddressLng         = '';
                state.selectedAddressDeliverable = true;
                const key = addrStorageKey();
                if (key) { try { localStorage.removeItem(key); } catch {} }
                const dispEl = el('selectedAddressDisplay');
                if (dispEl) {
                    dispEl.textContent = 'No address selected';
                    dispEl.classList.remove('co-addr-display--warn');
                }
                updateDeliveryETA();
                updatePayCta(state.order);
                recompute = true; // recompute without the deleted address
            } else {
                // Address exists. Track whether it's deliverable so updatePayCta can
                // block Pay Securely when the server says deliveryAvailable==0.
                state.selectedAddressDeliverable = current.deliveryAvailable != 0;
                // Refresh the cached display text/name from the server row. The address may
                // have been EDITED elsewhere (Manage Addresses) since this selection was cached
                // in localStorage, so the summary div must show the current server value, not
                // the stale restored text. Uses the same addrFullText() the list cards render.
                const freshText = addrFullText(current);
                state.selectedAddressName = String(current.name ?? state.selectedAddressName ?? '');
                if (freshText && freshText !== state.selectedAddressText) {
                    state.selectedAddressText = freshText;
                    set('selectedAddressDisplay', freshText); // updates desktop + mobile mirror
                }
                el('selectedAddressDisplay')?.classList.remove('co-addr-display--warn');
                updatePayCta(state.order); // re-evaluate now that deliverability is known
                const lat = current.latitude  ? String(current.latitude)  : '';
                const lng = current.longitude ? String(current.longitude) : '';
                if (lat && lng) {
                    // Compare against the coords the cart was ACTUALLY loaded with (the
                    // restored selection, falling back to the home pick) — not the home pick
                    // alone. Now that selection coords are persisted/restored, a matching
                    // address skips the reload; only genuinely stale coords trigger one.
                    const usedLat = state.selectedAddressLat || localStorage.getItem('userLat') || localStorage.getItem('lat') || '';
                    const usedLng = state.selectedAddressLng || localStorage.getItem('userLng') || localStorage.getItem('lng') || '';
                    state.selectedAddressLat = lat;
                    state.selectedAddressLng = lng;
                    // Persist coords + fresh deliverability so the next page load is exact.
                    saveAddressSelection(state.selectedAddressId, state.selectedAddressText, state.selectedAddressName, lat, lng, state.selectedAddressDeliverable);
                    if (lat !== usedLat || lng !== usedLng) recompute = true;
                }
            }
        }

        const selectedId = state.selectedAddressId || '';
        container.innerHTML = `<div class="co-addr-grid">${addresses.map(addr => {
            const id        = String(addr.deliveryAddressId);
            const label     = addrTypeLabel(addr.name);
            const fullText  = addrFullText(addr);
            const dist      = addr.distance ? `${addr.distance} km away` : '';
            const isSelected = selectedId === id;
            const unavail   = addr.deliveryAvailable == 0;
            return `<div class="co-addr-card${isSelected ? ' co-addr-card--selected' : ''}${unavail ? ' co-addr-card--unavail' : ''}"
                    data-addr-id="${id}"
                    data-addr-text="${esc(fullText)}"
                    data-addr-name="${esc(String(addr.name || ''))}"
                    data-addr-lat="${esc(String(addr.latitude || ''))}"
                    data-addr-lng="${esc(String(addr.longitude || ''))}"
                    ${unavail ? 'aria-disabled="true"' : 'role="button" tabindex="0"'}>
  <div class="co-addr-card__top">
    <span class="co-addr-card__tag">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      ${esc(label)}
    </span>
    ${dist ? `<span class="co-addr-card__dist">${esc(dist)}</span>` : ''}
    ${isSelected ? '<span class="co-addr-card__badge">Selected</span>' : ''}
  </div>
  <p class="co-addr-card__text">${esc(fullText)}</p>
  ${unavail ? '<p class="co-addr-card__unavail">Not deliverable to this outlet</p>' : ''}
</div>`;
        }).join('')}</div>`;

        // Auto-select first deliverable address only — never pick a non-deliverable one
        if (!state.selectedAddressId) {
            const first = addresses.find(a => a.deliveryAvailable != 0);
            if (first) {
                state.selectedAddressId           = String(first.deliveryAddressId);
                state.selectedAddressText         = addrFullText(first);
                state.selectedAddressName         = first.name || '';
                state.selectedAddressLat          = first.latitude  ? String(first.latitude)  : '';
                state.selectedAddressLng          = first.longitude ? String(first.longitude) : '';
                state.selectedAddressDeliverable  = true; // auto-select only picks deliverable addresses
                set('selectedAddressDisplay', state.selectedAddressText);
                el('selectedAddressDisplay')?.classList.remove('co-addr-display--warn');
                saveAddressSelection(state.selectedAddressId, state.selectedAddressText, state.selectedAddressName, state.selectedAddressLat, state.selectedAddressLng);
                updateDeliveryETA(state.selectedAddressName);
                // Recompute against the auto-picked address's coords (the first cart load
                // ran before any address was known and used the home-pick fallback).
                recompute = true;
            }
        }

        // Bind the card-click handler ONCE. loadAddresses() runs on every modal open
        // (selectAddressCta/Btn/MobileCta) and after saving an address (no longer on init —
        // CI3 parity), but `container` (#savedAddressList) is a persistent element — only its innerHTML
        // is replaced. Re-adding the listener each call stacked handlers, so a single
        // pick fired loadCartSummary() once per prior modal-open → multiple /client/cart
        // requests. CI3 avoids this with one global onclick handler (selectAddress →
        // refreshCart once). Delegation via closest() keeps working across re-renders.
        if (!container.dataset.clickBound) {
        container.dataset.clickBound = '1';
        container.addEventListener('click', async (e) => {
            const card = e.target.closest('.co-addr-card:not(.co-addr-card--unavail)');
            if (!card) return;
            const id      = card.dataset.addrId;
            const text    = card.dataset.addrText;
            const name    = card.dataset.addrName || '';
            state.selectedAddressId           = id;
            state.selectedAddressText         = text;
            state.selectedAddressName         = name;
            state.selectedAddressLat          = card.dataset.addrLat || '';
            state.selectedAddressLng          = card.dataset.addrLng || '';
            state.selectedAddressDeliverable  = true; // click handler only allows non-unavail cards
            set('selectedAddressDisplay', text);
            el('selectedAddressDisplay')?.classList.remove('co-addr-display--warn');
            saveAddressSelection(id, text, name, state.selectedAddressLat, state.selectedAddressLng);
            updateDeliveryETA(name);
            trackAddShippingInfo({
                value: analyticsTotal(), items: analyticsItems(),
                address: { name, line1: text, city: name },
                selectionType: 'Existing',
            });
            // Update selected state visually
            container.querySelectorAll('.co-addr-card').forEach(c => {
                c.classList.toggle('co-addr-card--selected', c.dataset.addrId === id);
                c.querySelector('.co-addr-card__badge')?.remove();
                if (c.dataset.addrId === id) {
                    const top = c.querySelector('.co-addr-card__top');
                    if (top) top.insertAdjacentHTML('beforeend', '<span class="co-addr-card__badge">Selected</span>');
                }
            });
            closeModal('selectAddressModal');
            // Commit the selection server-side first (CI3 parity), then recompute the bill.
            await commitDeliveryAddress(id);
            loadCartSummary();
        });
        }

        // Single cart recompute for whatever the validate/auto-select branches resolved to
        // (deleted-address cleared, coords refreshed, or a new default picked). At most one
        // /client/cart fires per loadAddresses() pass — no racing responses.
        if (recompute || forceRecompute) {
            // Commit the resolved selection server-side before recomputing — covers
            // add-new (forceRecompute), auto-select, and stale-coord refresh. CI3 parity.
            if (state.selectedAddressId) await commitDeliveryAddress(state.selectedAddressId);
            loadCartSummary();
        }
    } catch (err) {
        console.warn('[checkout] Address load failed:', err);
        container.innerHTML = '<p class="body-sm muted">Could not load addresses. Please try again.</p>';
    }
}


// ─── Delivery slot ────────────────────────────────────────────

// Minutes → human duration: "30 mins", "1 hrs", "1 hrs 30 mins" (CI3 parity).
function formatDuration(mins) {
    const total = Math.max(0, Math.round(Number(mins) || 0));
    const h = Math.floor(total / 60), m = total % 60;
    if (h > 0 && m > 0) return `${h} hrs ${m} mins`;
    if (h > 0)          return `${h} hrs`;
    return `${m} mins`;
}

// Deliver-now ETA parse, tolerant of the shapes the cart API actually sends: a number,
// a numeric string, or a unit-suffixed one ("30 Mins"). Number() turns that last shape
// into NaN, and formatDuration rendered NaN as "0 mins" — so the summary row said
// "Deliver Now (0 mins)" while the slot modal, which falls back differently, said
// "Within 30 mins". Returns the first usable positive value, else 0 (= no ETA to show).
function etaMins(...candidates) {
    for (const v of candidates) {
        const n = parseFloat(String(v ?? '').trim());
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
}

// True only when the brand EXPLICITLY reports no deliver-now window (0), as opposed to
// omitting the field — that's the signal to suppress the deliver-now option entirely.
// Same tolerant parse, so "0" and "0 mins" are both recognised as an explicit zero.
function etaIsZero(v) {
    if (v == null || String(v).trim() === '') return false;
    const n = parseFloat(String(v).trim());
    return Number.isFinite(n) && n <= 0;
}

// Label for the immediate option — "Deliver Now (45 mins)", but a bare "Pick up Now".
// Pickup carries NO time: onlineDeliveryTime is a delivery promise that bundles rider
// travel the customer never waits for, and the cart contract has no pickup equivalent,
// so quoting it read as a 45-min wait on food ready far sooner. Same call the menu strip
// makes — it hides the ETA for every non-delivery type (menu.js updateOtsStrip). CI3
// printed the delivery ETA for both (ue_silver/js/checkout.js:8353 +
// updateSlotButtonText); this is a deliberate parity break.
function nowOptionLabel(order) {
    if ((cfg.orderType || 'delivery') === 'pickup') return 'Pick up Now';
    const mins = etaMins(order?.onlineDeliveryTime, cfg.onlineDeliveryTime, 30);
    return `Deliver Now (${formatDuration(mins)})`;
}

// How many dates stay visible as chips in the slot picker; the rest go in a dropdown.
const SLOT_DATE_CHIPS = 3;

function formatSlotDate(dateStr) {
    const d = new Date(dateStr);
    const today    = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1); tomorrow.setHours(0,0,0,0);
    d.setHours(0,0,0,0);
    if (+d === +today)    return 'Today';
    if (+d === +tomorrow) return 'Tomorrow';
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Build the ISO datetime the cart/validation API expects for `selected_slot`.
// CI3 parity (ue_silver/js/checkout.js): selected_slot is convertToISO(date + ' ' + time),
// NOT the slot ID. The server compares item prepTime against this timestamp, so a slot ID
// is unparseable and makes every prep-time item fail with "Needs N hours to prepare".
// Mirror menu.js slotAvailable()'s local-date construction from slotDate + startHours.
function slotSelectedIso() {
    if (!state.selectedSlot || !state.selectedSlotDate) return '';
    const parts = state.selectedSlotDate.split('-').map(Number);
    const [yr, mo, dy] = parts;
    if (!yr || !mo || !dy) return '';
    const sh = parseFloat(state.selectedSlotStartH) || 0;
    const h = Math.floor(sh), m = Math.round((sh - h) * 60);
    const d = new Date(yr, mo - 1, dy, h, m, 0);
    return isNaN(d.getTime()) ? '' : d.toISOString();
}

// CI3 parity: bucket a slot into a time-of-day period by its start hour.
// Morning 1–11, Afternoon 12–15, Evening everything else (mirrors groupSlotsByTime).
function slotPeriod(startHours) {
    const h = parseInt(startHours, 10) || 0;
    if (h >= 1 && h < 12)  return 'Morning';
    if (h >= 12 && h < 16) return 'Afternoon';
    return 'Evening';
}

function renderSlotTimes(slots) {
    const container = el('slotTimesContainer');
    if (!container) return;
    const valid = (slots || []).filter(s => s && Object.keys(s).length > 0);
    if (!valid.length) {
        container.innerHTML = '<p class="body-sm muted co-slot__empty">No slots available for this date.</p>';
        return;
    }
    // Group slots under time-of-day headings (Morning / Afternoon / Evening),
    // preserving the order each period is first seen — CI3 behaviour.
    const order = [];
    const groups = {};
    valid.forEach(slot => {
        const period = slotPeriod(slot.startHours);
        if (!groups[period]) { groups[period] = []; order.push(period); }
        groups[period].push(slot);
    });

    container.innerHTML = order.map(period => {
        const pills = groups[period].map(slot => {
            const active = String(state.selectedSlot) === String(slot.id);
            const startH = slot.startHours || 0;
            const endH   = (parseFloat(slot.endHours) || 0) + (parseFloat(slot.endMin) || 0) / 60;
            const label  = `${slot.startDisplayName} - ${slot.endDisplayName}`;
            // Highlight follows the checked radio via `.co-slot__time:has(input:checked)`
            // (checkout.css). Don't also stamp a static `--active` class here: it never
            // clears when the user picks a different slot, so the default 1:30–3:30 slot
            // stays highlighted alongside the new pick (feedback #238).
            return `<label class="co-slot__time">
                <input type="radio" name="slotTime" value="${esc(String(slot.id))}" data-start-hours="${esc(String(startH))}" data-end-hours="${esc(String(endH))}" data-label="${esc(label)}"${active ? ' checked' : ''}>
                ${esc(slot.startDisplayName)} – ${esc(slot.endDisplayName)}
            </label>`;
        }).join('');
        return `<div class="co-slot__group">
            <p class="co-slot__group-label">${esc(period)}</p>
            <div class="co-slot__times">${pills}</div>
        </div>`;
    }).join('');
}

function loadSlots(containerId = 'slotOptionsList') {
    const container = el(containerId);
    if (!container) return;
    // Drop any stale inline validation message from a previous attempt.
    slotError(containerId === 'pickupSlotList' ? 'pickupSlotModal' : 'slotModal', '');

    const order = state.order;
    if (!order) {
        container.innerHTML = '<p class="body-sm muted co-slot__empty">Please add items to cart first.</p>';
        return;
    }

    const slotsDetails = order.slotsDetails || [];
    // "Deliver Now" is server-gated via order.deliver_now_option. Some brands enable the
    // 60-min instant option; others (esp. slot-based brands like thedeepcrustco) don't.
    // Default to HIDE when the field is missing so slot-based brands don't see it by accident.
    // Also suppress when the brand reports onlineDeliveryTime=0: a "Deliver Now within 0 mins"
    // card is not a real, orderable option (e.g. blossomfood bId 13839 sends deliver_now_option=1
    // with onlineDeliveryTime=0). A missing/empty field keeps the legacy 30-min default and still
    // shows, so genuine deliver-now brands — including slot-based ones that offer both — are unaffected.
    // deliverNowAllowed adds the wall-clock re-check of the kitchen's prep-adjusted window,
    // so the card also disappears when the cutoff passes with the modal/tab already open.
    const dtRaw        = order.onlineDeliveryTime;
    const deliverNow   = deliverNowAllowed(order);
    const deliveryTime = etaMins(dtRaw, cfg.onlineDeliveryTime, 30);
    const hasSlots     = slotsDetails.some(d => (d.slots || []).some(s => Object.keys(s).length > 0));

    if (!deliverNow && !hasSlots) {
        container.innerHTML = '<p class="body-sm muted co-slot__empty">No delivery slots available.</p>';
        return;
    }

    const isLater = state.selectedSlot !== null && state.selectedSlot !== 0;

    // CI3 parity: pickup orders (orderType 2) relabel "Deliver" → "Pick up" in the slot cards.
    const isPickup  = (cfg.orderType || 'delivery') === 'pickup';
    const nowLabel  = isPickup ? 'Pick up Now'   : 'Deliver Now';
    const laterLabel = isPickup ? 'Pick up Later' : 'Deliver Later';

    let html = '<div class="co-slot__list">';

    if (deliverNow) {
        const sel = !isLater;
        html += `<label class="co-slot-card${sel ? ' co-slot-card--selected' : ''}" data-slot-mode="now">
            <div class="co-slot-card__icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="co-slot-card__info">
                <strong>${nowLabel}</strong>
                ${isPickup ? '' : `<span class="co-slot-card__sub">Within ${formatDuration(deliveryTime)}</span>`}
            </div>
            <input type="radio" name="slotMode" value="now"${sel ? ' checked' : ''} class="co-slot-card__radio">
        </label>`;
    }

    if (hasSlots) {
        // Pre-select "Deliver Later" (and open the picker) when deliver-now isn't offered —
        // otherwise nothing is selected and confirmSlotGeneric would default to the now branch.
        const sel = isLater || !deliverNow;
        html += `<label class="co-slot-card${sel ? ' co-slot-card--selected' : ''}" data-slot-mode="later">
            <div class="co-slot-card__icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <div class="co-slot-card__info">
                <strong>${laterLabel}</strong>
                ${sel && state.selectedSlotText ? `<span class="co-slot-card__sub">${esc(state.selectedSlotText)}</span>` : ''}
            </div>
            <input type="radio" name="slotMode" value="later"${sel ? ' checked' : ''} class="co-slot-card__radio">
        </label>`;

        // Date + time picker. Prep-time brands publish a month of dates, so rendering
        // every one as a chip pushed the actual time slots off-screen. Show the first
        // few as chips and park the rest in a native dropdown beside them.
        const dateList = slotsDetails
            .map((dateObj, k) => ({ date: dateObj.date, idx: k, slots: dateObj.slots || [] }))
            .filter(d => d.slots.some(s => Object.keys(s).length > 0));
        const activeDate = dateList.some(d => d.date === state.selectedSlotDate)
            ? state.selectedSlotDate
            : (dateList[0]?.date || '');
        const chipDates = dateList.slice(0, SLOT_DATE_CHIPS);
        const moreDates = dateList.slice(SLOT_DATE_CHIPS);
        const moreActive = moreDates.some(d => d.date === activeDate);

        html += `<div class="co-slot__picker" id="slotPicker"${sel ? '' : ' hidden'}>`;
        html += `<div class="co-slot__dates" id="slotDateTabs" data-active-date="${esc(activeDate)}">`;
        chipDates.forEach(d => {
            const active = d.date === activeDate;
            html += `<button type="button" class="co-slot__date-tab${active ? ' co-slot__date-tab--active' : ''}" data-slot-date="${esc(d.date)}" data-slot-idx="${d.idx}">${esc(formatSlotDate(d.date))}</button>`;
        });
        if (moreDates.length) {
            // Placeholder is disabled so it can't be re-picked back to "nothing selected"
            // — once a later date is chosen the select itself becomes the active chip.
            html += `<select class="co-slot__date-more${moreActive ? ' co-slot__date-more--active' : ''}" id="slotDateMore" aria-label="More dates">
                <option value="" disabled${moreActive ? '' : ' selected'}>More dates</option>
                ${moreDates.map(d => `<option value="${esc(d.date)}" data-slot-idx="${d.idx}"${d.date === activeDate ? ' selected' : ''}>${esc(formatSlotDate(d.date))}</option>`).join('')}
            </select>`;
        }
        html += '</div>';
        html += '<div class="co-slot__groups" id="slotTimesContainer"></div>';
        html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    // Clear the inline validation message as soon as the user picks a time slot
    // (radio change bubbles up here). onchange (not addEventListener) avoids
    // stacking a listener each time loadSlots re-renders into the same container.
    const _modalId = containerId === 'pickupSlotList' ? 'pickupSlotModal' : 'slotModal';
    container.onchange = () => slotError(_modalId, '');

    // Populate times for the date the picker actually opened on (chip or dropdown).
    // Read it back off the container so it can't drift from what's rendered — the first
    // renderable date isn't necessarily slotsDetails[0] (a leading date can be slot-less).
    const tabs    = container.querySelector('.co-slot__dates');
    const initIdx = tabs ? slotsDetails.findIndex(d => d.date === tabs.dataset.activeDate) : -1;
    renderSlotTimes(slotsDetails[Math.max(initIdx, 0)]?.slots || []);

    // Toggle mode
    container.querySelectorAll('.co-slot-card').forEach(card => {
        card.addEventListener('click', () => {
            container.querySelectorAll('.co-slot-card').forEach(c => c.classList.remove('co-slot-card--selected'));
            card.classList.add('co-slot-card--selected');
            card.querySelector('.co-slot-card__radio').checked = true;
            const picker = el('slotPicker');
            if (picker) picker.hidden = card.dataset.slotMode !== 'later';
        });
    });

    // Date switch — chips and the "More dates" dropdown are one control: whichever is
    // picked becomes the active date on the container, and the other clears its highlight.
    const moreSel = container.querySelector('.co-slot__date-more');
    const selectDate = (date, idx) => {
        if (tabs) tabs.dataset.activeDate = date;
        slotError(_modalId, '');   // date chosen — drop any stale inline message
        renderSlotTimes(slotsDetails[Number(idx)]?.slots || []);
    };
    container.querySelectorAll('.co-slot__date-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.co-slot__date-tab').forEach(b => b.classList.remove('co-slot__date-tab--active'));
            btn.classList.add('co-slot__date-tab--active');
            if (moreSel) {
                moreSel.classList.remove('co-slot__date-more--active');
                moreSel.selectedIndex = 0;   // back to the "More dates" placeholder
            }
            selectDate(btn.dataset.slotDate, btn.dataset.slotIdx);
        });
    });
    moreSel?.addEventListener('change', () => {
        const opt = moreSel.selectedOptions[0];
        if (!opt?.value) return;
        container.querySelectorAll('.co-slot__date-tab').forEach(b => b.classList.remove('co-slot__date-tab--active'));
        moreSel.classList.add('co-slot__date-more--active');
        selectDate(opt.value, opt.dataset.slotIdx);
    });
}

// Persist the chosen slot server-side. CI3 parity (ue_silver updateSlot): EVERY slot change —
// including "Deliver Now" (slotTime=0 + today's date) — hits /client/setSlot so the server's
// stored slot matches the UI. Skipping it for deliver-now leaves the previous later-slot stored
// server-side, and the cart re-validates prep-time items against that stale slot.
async function setSlotApi(slotDate, slotTime) {
    const ud    = userData();
    const ordId = state.order?.orderId || '';
    const url   = `${getApiBase()}/client/setSlot?contactId=${encodeURIComponent(ud.contactId || '')}&contactMappingId=${encodeURIComponent(ud.contactMappingId || '')}&businessId=${cfg.businessId}&token=${encodeURIComponent(ud.token || '')}&orderId=${encodeURIComponent(ordId)}&slotDate=${encodeURIComponent(slotDate)}&slotTime=${encodeURIComponent(slotTime)}`;
    const res   = await fetch(url, { method: 'GET' });
    const resp  = await res.json();
    return (resp?.status ?? resp?.result?.status) == 1;
}

// Inline slot-modal validation — no native alert(). Shows the message in the
// modal footer (.co-slot__error) so it reads like the rest of the checkout flow.
function slotError(modalId, msg) {
    const box = document.querySelector(`#${modalId} .co-slot__error`);
    if (!box) return;
    if (msg) { box.textContent = msg; box.hidden = false; }
    else     { box.textContent = ''; box.hidden = true; }
}

async function confirmSlotGeneric(modalId, displayId) {
    slotError(modalId, '');   // clear any prior inline message on each attempt
    const modeRadio = document.querySelector('input[name="slotMode"]:checked');
    // Only default to "now" when the deliver-now card actually exists. Slot-based brands that
    // don't offer deliver-now would otherwise bypass slot selection (no radio checked → 'now'),
    // letting the user confirm with no slot picked. Fall back to "later" so the time-slot guard fires.
    const nowAvailable = !!document.querySelector('.co-slot-card[data-slot-mode="now"]');
    const mode = modeRadio?.value || (nowAvailable ? 'now' : 'later');

    // The kitchen's prep cutoff can pass while the modal sits open — the card rendered
    // by loadSlots is then stale. Re-check before committing rather than let it through.
    if (mode === 'now' && !deliverNowAllowed(state.order)) {
        // Repaint first — loadSlots clears the inline error box on entry, so the message
        // has to be written after it, not before.
        loadSlots(modalId === 'pickupSlotModal' ? 'pickupSlotList' : 'slotOptionsList');
        slotError(modalId, nowClosedMsg());
        return;
    }

    if (mode === 'now') {
        // Reset the server-stored slot to "now" (slotTime=0, today) before recalculating —
        // otherwise a previously selected later-slot stays valid on the server and prep-time
        // items wrongly remain valid after switching back to Deliver Now.
        try {
            const now   = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            await setSlotApi(today, 0);
        } catch (err) {
            console.warn('[checkout] reset slot to deliver-now failed:', err);
        }
        state.selectedSlot       = 0;
        state.selectedSlotDate   = '';
        state.selectedSlotStartH = 0;
        state.selectedSlotEndH   = 0;
        state.slotExpired        = false;   // user resolved the slot explicitly
        // Same label builder as the reload auto-select (applyCartResp) — otherwise
        // "Deliver Now" shows without its time until the page is refreshed.
        state.selectedSlotText   = nowOptionLabel(state.order);
        set(displayId, state.selectedSlotText);
        // Bring the now-ETA back on the address chip immediately — don't wait for the
        // cart recalc round-trip (applyCartResp re-renders it too, harmlessly).
        updateDeliveryETA(state.selectedAddressName);
        // Clear menu/checkout shared slot keys so reload uses the deliver-now auto-select branch
        // (applyCartResp) instead of restoring the previously stored later-slot.
        ['slot_id','slot_date','slot_label','slot_startH','slot_endH'].forEach(k => localStorage.removeItem(k));
        window.Analytics?.trackSlotSelected?.({ mode: 'now', label: state.selectedSlotText });
        closeModal(modalId);
        loadCartSummary();
        return;
    }

    // The active date lives on the tabs container, not on a chip — it can also have come
    // from the "More dates" dropdown. Scope to this modal so the delivery and pickup
    // pickers can't read each other's selection.
    const slotDate  = document.querySelector(`#${modalId} .co-slot__dates`)?.dataset.activeDate || '';
    const timeRadio = document.querySelector(`#${modalId} input[name="slotTime"]:checked`);
    if (!slotDate)  { slotError(modalId, 'Please select a date.');      return; }
    if (!timeRadio) { slotError(modalId, 'Please select a time slot.'); return; }

    const slotId      = timeRadio.value;
    const rangeLabel  = timeRadio.dataset.label || timeRadio.closest('label')?.textContent?.trim() || '';
    const startHours  = parseFloat(timeRadio.dataset.startHours || '0');
    const endHours    = parseFloat(timeRadio.dataset.endHours || '0');

    try {
        if (await setSlotApi(slotDate, slotId)) {
            state.selectedSlot       = slotId;
            state.selectedSlotDate   = slotDate;
            state.selectedSlotStartH = startHours;
            state.selectedSlotEndH   = endHours;
            state.slotExpired        = false;   // user resolved the slot explicitly
            state.selectedSlotText   = `${formatSlotDate(slotDate)}, ${rangeLabel}`;
            set(displayId, state.selectedSlotText);
            // Drop the now-ETA from the address chip right away: a scheduled window and
            // "in 45 mins" can't both be true.
            updateDeliveryETA(state.selectedAddressName);
            // Persist for reload + cross-page (menu) consistency. Use menu.js key names + label
            // format ("Day | startTime - endTime") so both pages restore the same selection.
            // slot_endH lets a returning session detect a fully-elapsed window (slotWindowPast).
            localStorage.setItem('slot_id',     String(slotId));
            localStorage.setItem('slot_date',   slotDate);
            localStorage.setItem('slot_label',  `${formatSlotDate(slotDate)} | ${rangeLabel}`);
            localStorage.setItem('slot_startH', String(startHours));
            localStorage.setItem('slot_endH',   String(endHours));
            window.Analytics?.trackSlotSelected?.({ mode: 'later', slotDate, label: state.selectedSlotText });
            closeModal(modalId);
            loadCartSummary();
        } else {
            slotError(modalId, 'Could not confirm slot. Please try again.');
        }
    } catch (err) {
        console.warn('[checkout] confirmSlot failed:', err);
        slotError(modalId, 'Could not confirm slot. Please try again.');
    }
}

async function confirmSlot()       { await confirmSlotGeneric('slotModal',       'deliverySlot'); }
async function confirmPickupSlot() { await confirmSlotGeneric('pickupSlotModal', 'pickupSlot');  }
function loadPickupSlots() { loadSlots('pickupSlotList'); }

// ─── Car number ───────────────────────────────────────────────

// ─── Car number persistence (localStorage — survives refresh) ─
// Scoped per business + user so switching accounts doesn't bleed.

function carStorageKey() {
    const ud = userData();
    return ud.contactId
        ? `co_car_${cfg.businessId}_${ud.contactId}`
        : `co_car_${cfg.businessId}`;
}

function saveCarSelection(carNumber) {
    try { localStorage.setItem(carStorageKey(), carNumber || ''); } catch {}
}

function restoreCarSelection() {
    if ((cfg.orderType || 'delivery') !== 'in_car') return;
    try {
        const saved = localStorage.getItem(carStorageKey());
        if (saved) {
            state.carNumber = saved;
            set('selectedCarNumberDisplay', saved);
        }
    } catch {}
}

// CI3 parity — ue_silver/js/checkout.js LocationManager runs on every checkout load
// regardless of order type, but it NEVER force-pops the permission dialog. It captures
// location only when nothing is already known, and even then only fetches silently if
// the user had ALREADY granted permission on a prior visit (CI3 monitorLocationPermission:
// permission==='granted' → checkCurrentLocationStatus() silent fetch; permission==='prompt'
// → "waiting for user to explicitly request location", i.e. via Select Address / car flow).
//
// Why this matters here: delivery sources coords from the picked address, so its explicit
// action is the Select Address modal (which itself calls requestGeolocation). This fills the
// gap for the already-granted case without ever forcing a dialog.
//
// in_car does NOT come through here — it needs a live fix rather than any stored value, and
// it is the one order type that is unusable without one, so it gets to prompt. See
// ensureInCarLocation().
async function ensureCheckoutLocation() {
    if ((cfg.orderType || 'delivery') === 'in_car') return;
    // Already have coords — from the home location flow / store locator (userLat/userLng),
    // a legacy write (lat/lng), or a restored saved-address selection. Use them, never ask.
    if (localStorage.getItem('userLat') || localStorage.getItem('lat') || state.selectedAddressLat) return;

    // No stored location. Mirror CI3: only fetch when permission is ALREADY granted (silent,
    // no popup). If it's still "prompt"/"denied" — or the Permissions API is unavailable
    // (e.g. older Safari) — wait for the user's explicit action rather than forcing a dialog.
    let granted = false;
    try {
        const status = await navigator.permissions?.query({ name: 'geolocation' });
        granted = status?.state === 'granted';
    } catch { /* Permissions API unavailable — treat as not-granted, don't force a prompt */ }
    if (!granted) return;

    const geo = await requestGeolocation();
    if (!geo.ok) return;
    try {
        localStorage.setItem('userLat', String(geo.lat));
        localStorage.setItem('userLng', String(geo.lng));
    } catch {}
    // Only delivery sends these to the cart (see callCartApi), so only it needs a recompute;
    // pickup/dine-in ignore coords and in_car never reaches here. Delivery with a picked
    // address already uses the address coords, but we only get here when none existed at all.
    if ((cfg.orderType || 'delivery') === 'delivery') loadCartSummary();
}

// ─── In-car location ──────────────────────────────────────────
// The live GPS fix in-car orders are validated against. Unlike ensureCheckoutLocation this
// DOES prompt: the server refuses an in-car cart outright without coords inside the outlet's
// inCarRadius, so there is no degraded mode to fall back to. CI3 prompts here too
// (ue_silver/js/checkout.js LocationManager).
//
// On failure carLat/carLng stay empty and the server's own refusal surfaces through the
// normal cart-error path.
async function ensureInCarLocation() {
    if ((cfg.orderType || 'delivery') !== 'in_car') return;
    if (!navigator.geolocation) return;

    const geo = await requestGeolocation();
    if (!geo.ok) { state.carLat = ''; state.carLng = ''; return; }

    state.carLat = String(geo.lat);
    state.carLng = String(geo.lng);
    // Deliberately NOT written to userLat/userLng. Those are the customer's delivery
    // location and feed the header bar and the delivery cart; overwriting them with a
    // forecourt fix would silently move the address the next delivery order bills against.
}

function showCarError(msg) {
    const errEl = el('carInputError');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
}

function carApiParams(extra = {}) {
    const ud = userData();
    return new URLSearchParams({
        businessId:       cfg.businessId,
        parentBusinessId: cfg.parentId || '',
        contactMappingId: ud.contactMappingId || '',
        token:            ud.token            || '',
        contactId:        ud.contactId        || '',
        orderId:          state.order?.orderId || '',
        ...extra,
    });
}

async function loadSavedCars() {
    const container = el('savedCarsList');
    if (!container) return;
    container.innerHTML = '<p class="body-sm muted co-car__loading">Loading…</p>';
    try {
        const res  = await fetch(`${getApiBase()}/client/getUserCarNo?${carApiParams()}`, {
            method: 'GET', headers: { 'Accept': 'application/json' },
        });
        const resp = await res.json();
        const cars = resp?.carDetails || resp?.result?.rows?.carDetails || [];
        if (!cars.length) {
            container.innerHTML = '';
            return;
        }
        const selectedNum = state.carNumber;
        container.innerHTML = `
<p class="co-car__saved-title">Saved Car Numbers</p>
<div class="co-car__list">
${cars.map(c => {
    const num      = c.carNumber || c.car_number || '';
    const isActive = num === selectedNum;
    return `<div class="co-car-item${isActive ? ' co-car-item--active' : ''}">
  <svg class="co-car-item__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 10h14l1 5v5H4v-5l1-5Z"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/></svg>
  <span class="co-car-item__num">${esc(num)}</span>
  <div class="co-car-item__actions">
    ${isActive
        ? '<span class="co-car-item__selected">Selected</span>'
        : `<button type="button" class="btn btn--sm btn--primary co-car-item__select" data-car="${esc(num)}">Select</button>`}
  </div>
</div>`;
}).join('')}
</div>`;
    } catch (err) {
        console.warn('[checkout] loadSavedCars failed:', err);
        container.innerHTML = '<p class="body-sm muted">Could not load saved cars.</p>';
    }
}

// Internal: update state + persist + close modal + refresh bill (single API call).
// Items are already reconciled at this point — no need for the full loadCartSummary loop.
async function applySelectedCar(carNumber) {
    state.carNumber = carNumber;
    saveCarSelection(carNumber);
    set('selectedCarNumberDisplay', carNumber);
    closeModal('addCarNoModal');
    try {
        const resp      = await callCartApi({ action: 'add', cart: '{"items":[]}' });
        const parsed    = parseCartResp(resp);
        const localItems = getV4Cart().items || [];
        const subtotal  = localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
        applyCartResp(parsed, localItems, subtotal);
    } catch (err) {
        console.warn('[checkout] applySelectedCar bill refresh failed:', err);
        updatePayCta(state.order);
    }
}

// Called when user picks a saved car — must call setCarNumberDelivery so the
// server registers the selection before the cart API proximity check runs.
async function selectCarNo(carNumber) {
    try {
        await fetch(`${getApiBase()}/client/setCarNumberDelivery?${carApiParams({ carNumber })}`, {
            method: 'GET', headers: { 'Accept': 'application/json' },
        });
    } catch (err) {
        console.warn('[checkout] setCarNumberDelivery (select) failed:', err);
    }
    await applySelectedCar(carNumber);
}

async function addCarNo() {
    const num = el('carNumberInput')?.value?.trim().toUpperCase() || '';
    if (!num) { showCarError('Please enter a car number.'); return; }
    const errEl = el('carInputError');
    if (errEl) errEl.hidden = true;

    const btn = el('addCarNoBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

    try {
        const res  = await fetch(`${getApiBase()}/client/setCarNumberDelivery?${carApiParams({ carNumber: num })}`, {
            method: 'GET', headers: { 'Accept': 'application/json' },
        });
        const resp = await res.json();
        if (Number(resp?.status ?? 1) === 0) {
            showCarError(resp?.msg || resp?.message || 'Could not add car number.');
            return;
        }
        const inp = el('carNumberInput');
        if (inp) inp.value = '';
        // setCarNumberDelivery already called above — go straight to apply
        await applySelectedCar(num);
    } catch (err) {
        console.warn('[checkout] addCarNo failed:', err);
        showCarError('Could not add car number. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Add No'; }
    }
}

async function openCarModal() {
    openModal('addCarNoModal');
    await loadSavedCars();
}

// ─── Table / gift / promo / wallet ────────────────────────────

function showTableError(msg) {
    const errEl = el('tableInputError');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
}

async function saveTableNumber() {
    const num = el('tableNumberInput')?.value?.trim() || '';
    if (!num) { showTableError('Please enter a table number.'); return; }

    // Clear any prior error
    const errEl = el('tableInputError');
    if (errEl) errEl.hidden = true;

    const btn = el('saveTableBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Validating…'; }

    try {
        const p = new URLSearchParams({
            parentBusinessId: cfg.parentId  || '',
            businessId:       cfg.businessId,
            tableName:        num,
        });
        const res  = await fetch(`${getApiBase()}/client/verifyTableList?${p}`, {
            method: 'GET', headers: { 'Accept': 'application/json' },
        });
        const resp = await res.json();

        // API returns status 0 for invalid table
        if (Number(resp?.status ?? resp?.result?.status ?? 1) === 0) {
            showTableError(resp?.msg || resp?.message || 'Invalid table number.');
            return;
        }

        // Valid — persist and close
        const tableId   = resp?.result?.rows?.tableId || resp?.tableId || '';
        const tableName = resp?.result?.rows?.tableName || resp?.tableName || num;
        state.selectedTableId   = tableId || num;
        state.selectedTableName = tableName;
        state.tableSkipped      = false;
        saveTableSelection(tableName, tableId);
        set('tableNoDisplay', tableName);
        closeModal('dineinmodal');
        // Refresh bill now that table is confirmed
        await loadCartSummary();
    } catch (err) {
        console.warn('[checkout] Table validation failed:', err);
        showTableError('Could not validate table. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
    }
}

function skipTableNumber() {
    state.tableSkipped      = true;
    state.selectedTableId   = null;
    state.selectedTableName = '';
    // Persist the skip so Pay Securely stays visible after a page refresh
    try { sessionStorage.setItem(tableStorageKey(), JSON.stringify({ skipped: true })); } catch {}
    closeModal('dineinmodal');
    updatePayCta(state.order);
}

// ─── Dine-in QR scan (mobile only) ────────────────────────────
// CI3 ref: ue_silver/js/checkout.js setupMobileQROption / startQRScanner /
// verifyTableFromQR (~L5234, 6641, 6860). Mobile users get a "Scan QR" option
// in the dine-in modal that decodes the table's QR sticker → /client/verifyTableList
// confirms ownership and returns tableId/tableName.

const isMobileUA = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let _qrScanner = null;        // Html5QrcodeScanner instance
let _qrLibLoading = null;     // de-dupe concurrent script-tag loads

function setupDineInMobileOptions() {
    if (isMobileUA()) {
        show('dineMobileOptions');
        hide('dineManualEntry');
    } else {
        hide('dineMobileOptions');
        show('dineManualEntry');
    }
}

function loadQrLibrary() {
    if (typeof window.Html5QrcodeScanner !== 'undefined') return Promise.resolve();
    if (_qrLibLoading) return _qrLibLoading;
    _qrLibLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/assets/wla_new/js/html5-qrcode.js';
        s.onload  = () => resolve();
        s.onerror = () => { _qrLibLoading = null; reject(new Error('QR library failed to load')); };
        document.head.appendChild(s);
    });
    return _qrLibLoading;
}

async function openQrScanner() {
    // Request geolocation first — verifyTableList accepts lat/lng for validation
    // (CI3 sends them to confirm the user is physically at the outlet).
    const coords = await new Promise(resolve => {
        if (!navigator.geolocation) return resolve({ lat: '', lng: '' });
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            ()  => resolve({ lat: '', lng: '' }),
            { timeout: 5000, maximumAge: 60000 }
        );
    });

    try { await loadQrLibrary(); }
    catch (err) {
        const e = el('qrScanError');
        if (e) { e.textContent = 'Could not load scanner. Please try again.'; e.hidden = false; }
        return;
    }

    closeModal('dineinmodal');
    openModal('scanQrVideoModal');

    // Init the scanner. CI3 used the same library + config.
    try {
        _qrScanner = new window.Html5QrcodeScanner('qrReader', { qrbox: 250, fps: 10, rememberLastUsedCamera: true }, /* verbose= */ false);
        _qrScanner.render(
            (decodedText) => {
                stopQrScanner();
                verifyTableFromQR(decodedText, coords.lat, coords.lng);
            },
            /* onScanFailure= */ () => { /* silent — fires per frame */ }
        );
    } catch (err) {
        const e = el('qrScanError');
        if (e) { e.textContent = 'Could not start the camera. Please grant camera access and try again.'; e.hidden = false; }
    }
}

function stopQrScanner() {
    if (!_qrScanner) return;
    try { _qrScanner.clear(); } catch {}
    _qrScanner = null;
}

async function verifyTableFromQR(decodedText, lat, lng) {
    // QR encodes a URL ending with .../{tableId}. CI3 parity:
    //   const segments = decodedText.split('/'); tableId = segments[segments.length - 1];
    const tableIdFromQR = String(decodedText || '').trim().split('/').filter(Boolean).pop() || '';
    if (!tableIdFromQR) {
        showQrError('Invalid QR code. Please try again.');
        return;
    }

    try {
        const p = new URLSearchParams({
            parentBusinessId: cfg.parentId  || '',
            businessId:       cfg.businessId,
            tableId:          tableIdFromQR,
            lat:              String(lat || ''),
            lng:              String(lng || ''),
        });
        const res  = await fetch(`${getApiBase()}/client/verifyTableList?${p}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const resp = await res.json();

        // CI3 response shape: { status:1, details:[{ id, tableName }] }
        const details = resp?.details || resp?.result?.details || [];
        if (Number(resp?.status ?? resp?.result?.status ?? 0) !== 1 || !details.length) {
            showQrError(resp?.message || resp?.msg || 'Invalid QR code. Please try again.');
            return;
        }

        const tableName = details[0].tableName || tableIdFromQR;
        const tableId   = details[0].id        || tableIdFromQR;
        state.selectedTableId   = tableId;
        state.selectedTableName = tableName;
        state.tableSkipped      = false;
        saveTableSelection(tableName, tableId);
        set('tableNoDisplay', tableName);
        closeModal('scanQrVideoModal');
        await loadCartSummary();
    } catch (err) {
        console.warn('[checkout] QR table verification failed:', err);
        showQrError('Could not verify table. Please try again.');
    }
}

function showQrError(msg) {
    const e = el('qrScanError');
    if (e) { e.textContent = msg; e.hidden = false; }
    // Bring the user back to the dine-in modal so they can retry or enter manually.
    setTimeout(() => {
        stopQrScanner();
        closeModal('scanQrVideoModal');
        openModal('dineinmodal');
        setupDineInMobileOptions();
    }, 2000);
}

// Opens the gift modal — mirrors CI3: shows the current delivery address, and
// pre-fills the sender name from the logged-in user when not already set.
function openGiftModal() {
    set('giftAddressText', state.selectedAddressText || 'No address selected');
    const senderEl = el('giftSender');
    if (senderEl && !senderEl.value.trim()) senderEl.value = userData().name || '';
    openModal('sendAsGiftModal');
}

// POST gift details to /client/updateGiftDetails.
// gift_status = 1 adds, 0 removes.
async function callSaveGiftingApi(details, enable) {
    const ud      = userData();
    const orderId = state.order?.orderId || '';
    if (!orderId) throw new Error('No active order — load cart first');
    const body = new URLSearchParams({
        contactMappingId: ud.contactMappingId || '',
        businessId:       cfg.businessId,
        orderId,
        token:            ud.token || '',
        gift_status:      String(enable),
        gift_to:          details.name,
        contact_number:   details.mobile,
        gift_from:        details.sender,
        gift_message:     details.message,
    });
    const res  = await fetch(`${getApiBase()}/client/updateGiftDetails`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'token': ud.token || '',
        },
        body,
    });
    return res.json();
}

// Restore saved gift details from the server cart on cold load so they survive a
// page refresh (gift state is otherwise in-memory only). CI3 ref: ue_silver/js/
// checkout.js:7314 — orderDetails.gift_order==1 → currentGiftDetails. Only populates
// (never clears) so it can't clobber a just-saved local state before the next fetch.
function hydrateGiftFromServer(order) {
    if (!order || state.giftDetails) return;
    if (Number(order.gift_order ?? order.gift_status) !== 1) return;
    const details = {
        name:    order.gift_to        || '',
        mobile:  order.gift_to_number || order.contact_number || '',
        sender:  order.gift_from      || '',
        message: order.gift_message   || '',
    };
    if (!details.name) return;
    state.giftDetails = details;
    set('giftCardText', `Gift to: ${details.name}`);
    hide('showGiftModalBtn');
    show('removeGiftDetailsBtn');
    const setVal = (id, v) => { const f = el(id); if (f) f.value = v; };
    setVal('giftName',    details.name);
    setVal('giftMobile',  details.mobile);
    setVal('giftSender',  details.sender);
    setVal('giftMessage', details.message);
}

async function saveGiftDetails() {
    const details = {
        name:    el('giftName')?.value?.trim()    || '',
        mobile:  el('giftMobile')?.value?.trim()  || '',
        sender:  el('giftSender')?.value?.trim()  || '',
        message: el('giftMessage')?.value?.trim() || '',
    };
    if (!details.name)               { showApplyToast('error', 'Please enter recipient name.');          return; }
    if (details.mobile.length !== 10) { showApplyToast('error', 'Recipient mobile number should be 10 digits.'); return; }
    if (!details.sender)             { showApplyToast('error', 'Please enter sender name.');             return; }

    const btn = el('saveGiftDetailsBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const result = await callSaveGiftingApi(details, 1);
        if (Number(result?.status) !== 1) { showApplyToast('error', result?.msg || result?.message || 'Failed to save gift details.'); return; }
        state.giftDetails = details;
        set('giftCardText', `Gift to: ${details.name}`);
        hide('showGiftModalBtn');
        show('removeGiftDetailsBtn');
        closeModal('sendAsGiftModal');
        showApplyToast('success', 'Gift details saved!', { variant: 'saved' });
    } catch (e) {
        showApplyToast('error', 'Failed to save gift details. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Details'; }
    }
}

async function removeGiftDetails() {
    const details = state.giftDetails || { name: '', mobile: '', sender: '', message: '' };
    try {
        const result = await callSaveGiftingApi(details, 0);
        if (Number(result?.status) !== 1) { showApplyToast('error', result?.msg || result?.message || 'Failed to remove gift details.'); return; }
    } catch (e) {
        showApplyToast('error', 'Failed to remove gift details. Please try again.');
        return;
    }
    state.giftDetails = null;
    ['giftName', 'giftMobile', 'giftSender', 'giftMessage'].forEach(id => { const f = el(id); if (f) f.value = ''; });
    set('giftCardText', 'Want to send this as a gift?');
    show('showGiftModalBtn');
    hide('removeGiftDetailsBtn');
    closeModal('sendAsGiftModal');
    // Removal uses the red-cross (error-styled) toast per design — a destructive-action cue.
    showApplyToast('error', 'Gift details removed.');
}

// Calls CI3 /client/applyPromo endpoint (action=1 apply, action=0 remove).
async function callApplyPromoApi(code, action) {
    const ud      = userData();
    const orderId = state.order?.orderId || '';
    if (!orderId) throw new Error('No active order — load cart first');
    const p = new URLSearchParams({
        businessId:      cfg.businessId,
        contactMappingId: ud.contactMappingId || '',
        token:            ud.token            || '',
        contactId:        ud.contactId        || '',
        orderId,
        promoCode:        code,
        action,
    });
    const res = await fetch(`${getApiBase()}/client/applyPromo?${p}`, {
        method: 'GET', headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`ApplyPromo API ${res.status}`);
    return res.json();
}

// Show the switch-confirmation popup when the user tries to apply a different
// promo than the one already applied. Resolves to true if they confirm.
function confirmPromoSwitch(currentCode, newCode) {
    return new Promise((resolve) => {
        const modal   = el('promoSwitchModal');
        const desc    = el('promoSwitchDesc');
        const okBtn   = el('promoSwitchConfirm');
        const cancel  = el('promoSwitchCancel');
        if (!modal || !okBtn || !cancel) { resolve(true); return; } // fail-open

        if (desc) desc.innerHTML = `Your current promo <strong>${esc(currentCode)}</strong> will be replaced with <strong>${esc(newCode)}</strong>. Continue?`;

        const cleanup = () => {
            okBtn.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            modal.querySelector('.popup-close')?.removeEventListener('click', onCancel);
            closeModal('promoSwitchModal');
        };
        const onOk     = () => { cleanup(); resolve(true);  };
        const onCancel = () => { cleanup(); resolve(false); };
        okBtn.addEventListener('click', onOk,     { once: true });
        cancel.addEventListener('click', onCancel, { once: true });
        modal.querySelector('.popup-close')?.addEventListener('click', onCancel, { once: true });
        openModal('promoSwitchModal');
    });
}

async function applyPromo(codeOverride) {
    // Code source priority: explicit arg (from a suggestion-tile click) > modal input > main input.
    const mainInp  = el('promoInput');
    const modalInp = el('promoInputModal');
    const memInp   = el('membershipPromoInputModal');
    const code = (typeof codeOverride === 'string' && codeOverride)
        ? codeOverride.trim()
        : (memInp?.value?.trim() || modalInp?.value?.trim() || mainInp?.value?.trim() || '');
    if (!code) { showPromoError('Please enter a promo code.'); return; }

    // CI3 parity (ue_silver/js/checkout.js:18129) — block when cart is fully ineligible
    // (e.g. BOGO-only cart). Mirrors the `cartDisabled` short-circuit.
    if (isPromoBlockedByCart()) {
        const msg = 'Items in cart are not eligible for promo codes';
        showApplyToast('error', msg);
        showPromoError(msg);
        return;
    }

    // CI3 parity (ue_silver/js/checkout.js:18874 — "Promo Codes Usage Cannot be clubbed
    // with Wallet"). Wallet and promo are mutually exclusive unless the outlet enables
    // combining. Block client-side with an actionable message rather than firing the
    // request and surfacing the server's raw "not applicable on Discount Type" error.
    if (isWalletSpent() && !isWalletPromoCombinedAllowed()) {
        // Name the thing the customer actually did, so the instruction is followable:
        // "remove the wallet" means nothing to someone who redeemed an item's points.
        const msg = committedBurnPoints() > 0 && !state.walletApplied
            ? 'Remove the points redemption to apply a promo code.'
            : 'Remove the wallet to apply a promo code.';
        showApplyToast('error', msg);
        showPromoError(msg);
        return;
    }

    // Switch-confirmation: when a different promo is already applied, ask before swapping.
    // Server only supports one applied promo; we remove the current one first, then apply.
    if (state.appliedPromo && state.appliedPromo !== code) {
        const confirmed = await confirmPromoSwitch(state.appliedPromo, code);
        if (!confirmed) return;
        try { await callApplyPromoApi(state.appliedPromo, 0); } catch {}
        state.appliedPromo = '';
        hide('promoAppliedBlock');
        hide('membershipPromoUnlock');
    }

    // Disable apply buttons during request
    [el('applyPromoBtn'), el('applyPromoBtnModal'), el('applyMembershipPromoBtnModal')].forEach(b => { if (b) b.disabled = true; });

    try {
        const resp = await callApplyPromoApi(code, 1);
        if (resp?.status === 1) {
            state.appliedPromo = code;
            if (mainInp)  mainInp.value  = '';
            if (modalInp) modalInp.value = '';
            if (memInp)   memInp.value   = '';
            closeModal('promo');
            closeModal('membershipPromoModal');
            // Refresh bill to show updated discount
            const billResp = await callCartApi({ action: 'add', cart: '{"items":[]}' });
            const parsed   = parseCartResp(billResp);
            const localItems = getV4Cart().items || [];
            applyCartResp(parsed, localItems, localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
            // Show applied state in the right slot based on whether this is a membership promo.
            // applyCartResp already re-runs renderSavingsCorner + renderMembershipSavings, which
            // toggle the applied/unlock blocks; the direct DOM nudges below match the existing
            // optimistic-update pattern in case the server response omits the discount value.
            const appliedPromo = (state.promos || []).find(p => p.code === code);
            const isMembership = Number(appliedPromo?.is_membership_offer ?? 0) === 1;
            // Reward coupons show their title (the code is an opaque hash); freebie promos
            // read "Enjoy your free <item> 🎁" instead of "saving ₹0". CI3 ref: 18904-18919.
            const savingMsg = appliedPromoCaption(appliedPromo, state.order);
            if (isMembership) {
                set('membership_promo_cashback', savingMsg);
                show('membershipPromoUnlock');
                hide('membershipPromoBlock');
            } else {
                set('promo_cashback', savingMsg);
                show('promoAppliedBlock');
                hide('applyPromoSection');
                hide('promoBlock');
                // NOTE: do NOT hide('viewMoreOffersSection') here. renderSavingsCorner
                // (run via applyCartResp above) is the single source of truth for that
                // CTA — it shows it whenever offers exist, independent of applied state.
                // Hiding it optimistically made the CTA vanish on apply but reappear on
                // reload (renderSavingsCorner re-shows it), the inconsistency reported.
            }
            // For a freebie the server's display_msg won't name the item, so prefer our
            // caption; otherwise honour the server message.
            // Always celebrate: a successful apply is a win regardless of how the server
            // phrases it. Relying on amount auto-detection meant cashback messages that
            // name a bare number ("cashback of 250") got the quiet checkmark, making the
            // REMOVE toast look more festive than the apply.
            // promoLabel, not the raw code: reward coupons carry an opaque hash, so the
            // header would otherwise read "4f9cdeb0 applied!".
            showApplyToast('success',
                freebieItemNames().length ? savingMsg : (resp.display_msg || savingMsg),
                { variant: 'celebrate', code: promoLabel(appliedPromo) || code });
            trackCouponStatus({ status: 'Applied', code, discount: state.order?.discount || 0 });
        } else {
            showApplyToast('error', resp?.msg || 'Promo code is not applicable.');
            showPromoError(resp?.msg || 'Promo code is not applicable.');
            trackCouponStatus({ status: 'Failed', code, discount: 0 });
            // Membership promo rejected by server — disable the card so the user
            // can't click Apply again until the next cart sync brings fresh promo data.
            const failedPromo = (state.promos || []).find(p => p.code === code);
            if (failedPromo && Number(failedPromo.is_membership_offer ?? 0) === 1) {
                const card = el('membership_promo_list');
                if (card) {
                    card.classList.add('co-promo--disabled');
                    const applySlot = el('oneMembershipCouponApply');
                    if (applySlot) { applySlot.innerHTML = ''; applySlot.onclick = null; }
                }
            }
        }
    } catch {
        showApplyToast('error', 'Could not apply promo. Please try again.');
        showPromoError('Could not apply promo. Please try again.');
    } finally {
        [el('applyPromoBtn'), el('applyPromoBtnModal'), el('applyMembershipPromoBtnModal')].forEach(b => { if (b) b.disabled = false; });
    }
}

async function removePromo() {
    const code = state.appliedPromo;
    // Reward coupons carry an opaque hash code; show the merchant title in the toast instead.
    const label = promoLabel((state.promos || []).find(p => p.code === code)) || code;
    state.appliedPromo = '';
    const mainInp  = el('promoInput');
    const modalInp = el('promoInputModal');
    if (mainInp)  mainInp.value  = '';
    if (modalInp) modalInp.value = '';
    hide('promoAppliedBlock');
    hide('membershipPromoUnlock');

    if (code) {
        try { await callApplyPromoApi(code, 0); } catch {}
    }
    // Refresh bill (renderSavingsCorner + renderMembershipSavings re-run from applyCartResp)
    const billResp = await callCartApi({ action: 'add', cart: '{"items":[]}' });
    const parsed   = parseCartResp(billResp);
    const localItems = getV4Cart().items || [];
    applyCartResp(parsed, localItems, localItems.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
    // Removed confirmation — muted disc + sinking icon + contracting ring. Deliberately
    // the inverse of the apply celebration: a benefit was given up, so nothing here should
    // read as a win.
    // With a label the code moves to the header line, so the body states the LOSS rather
    // than repeating "<code> has been removed" underneath "<code> removed".
    if (label) showApplyToast('success', "You're no longer getting this offer", { variant: 'removed', code: label });
    else       showApplyToast('success', 'Coupon has been removed', { variant: 'removed' });
}

// Apply/remove wallet against the legacy endpoints. CI3 ref:
//   /client/applyWallet  – on Apply  (assets/themes/ue_default/js/checkoutPage_20251023_2.js:9373-9459)
//   /client/removeWallet – on Remove
// Both mutate addo_orders.wallet_amount; we then refetch the cart so renderWallet()
// can flip the label/state from the server's wallet_amount.
async function toggleWallet() {
    const btn = el('applyWalletBtn');
    const orderId = state.order?.orderId;
    if (!orderId) { showError('Add items to your cart first.'); return; }

    const ud   = userData();
    const remove = state.walletApplied;          // currently applied → user is removing

    // CI3 parity — block apply when every cart line is wallet-ineligible.
    // Removing is always allowed so users can recover after a cart change.
    if (!remove && isWalletBlockedByCart()) {
        showApplyToast('error', 'Wallet is not applicable on items in your cart');
        return;
    }

    // CI3 parity (ue_silver/js/checkout.js:865 — "Remove the applied promo to use wallet
    // credits."). Mirror of the promo-apply guard: wallet and promo can't be clubbed
    // unless the outlet opts in. Removing wallet is always allowed.
    if (!remove && state.appliedPromo && !isWalletPromoCombinedAllowed()) {
        showApplyToast('error', 'Remove the applied promo to use wallet credits.');
        return;
    }
    const path = remove ? '/client/removeWallet' : '/client/applyWallet';
    const p    = new URLSearchParams({
        businessId:        cfg.businessId,
        contactMappingId:  ud.contactMappingId || '',
        token:             ud.token            || '',
        userId:            ud.contactId        || '',
        mobileNo:          ud.mobile           || ud.mobileNo || '',
        parentBusinessId:  cfg.parentId        || '',
        orderId,
    });

    // Optimistic label flip so the click feels responsive; renderWallet() will
    // overwrite based on the truthy server response.
    if (btn) { btn.disabled = true; btn.textContent = remove ? 'Removing…' : 'Applying…'; }

    try {
        const res  = await fetch(`${getApiBase()}${path}?${p}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const resp = await res.json();
        if (Number(resp?.status) === 1) {
            // CI3 distinguishes "applied with display_msg" (success toast) vs
            // "applied but blocked by rules" (failure toast with rule message).
            if (!remove && resp.display_msg) {
                showApplyToast('success', resp.display_msg);
            } else if (remove) {
                showApplyToast('success', 'Wallet has been removed successfully.', { variant: 'removed' });
            } else if (resp.msg) {
                showApplyToast('error', resp.msg);
            }
        } else {
            showApplyToast('error', resp?.msg || 'Could not update wallet. Please try again.');
        }
    } catch {
        showApplyToast('error', 'Could not update wallet. Please try again.');
    } finally {
        if (btn) btn.disabled = false;
        // Refresh cart regardless — server is the source of truth for wallet_amount.
        await loadCartSummary();
    }
}

function showError(msg) {
    const alertEl = el('dangerAlertPay');
    const textEl  = el('errorMessagePay');
    if (textEl) textEl.textContent = msg;
    if (alertEl) {
        alertEl.hidden = false;
        setTimeout(() => { alertEl.hidden = true; }, 4000);
    }
}

function showPromoError(msg) {
    // Show error inside whichever promo modal is open (regular or membership),
    // otherwise near the savings corner input.
    const memModal   = el('membershipPromoModal');
    const promoModal = el('promo');
    const errId = (memModal && !memModal.hidden)   ? 'membershipPromoErrorTextModal'
                : (promoModal && !promoModal.hidden) ? 'promoErrorTextModal'
                : 'promoErrorText';
    const promoErr   = el(errId);
    if (promoErr) {
        promoErr.textContent = msg;
        promoErr.hidden = false;
        setTimeout(() => { promoErr.hidden = true; }, 4000);
    } else {
        showError(msg);
    }
}

// ─── Order type modal ─────────────────────────────────────────

const OT_ICONS = {
    delivery: `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 17 17" fill="none">
<path fill-rule="evenodd" clip-rule="evenodd" d="M2.25 5.44848C2.25 2.40198 4.8911 0 8.0625 0C11.2339 0 13.875 2.40198 13.875 5.44848C13.875 8.30683 9.24359 12.8844 9.24359 12.8844H6.88141C4.02217 11.6625 2.25 8.30683 2.25 5.44848ZM8.0625 1.125C5.43491 1.125 3.375 3.09807 3.375 5.44848C3.375 7.94473 4.95407 10.8374 7.32349 11.8499C7.79175 12.05 8.33325 12.05 8.80151 11.8499C11.1709 10.8374 12.75 7.94473 12.75 5.44848C12.75 3.09807 10.6901 1.125 8.0625 1.125ZM8.0625 4.875C7.54473 4.875 7.125 5.29473 7.125 5.8125C7.125 6.33027 7.54473 6.75 8.0625 6.75C8.58027 6.75 9 6.33027 9 5.8125C9 5.29473 8.58027 4.875 8.0625 4.875ZM6 5.8125C6 4.67341 6.92341 3.75 8.0625 3.75C9.20159 3.75 10.125 4.67341 10.125 5.8125C10.125 6.95159 9.20159 7.875 8.0625 7.875C6.92341 7.875 6 6.95159 6 5.8125ZM1.75906 10.3099C1.96758 10.5402 1.94994 10.8959 1.71966 11.1045C1.29389 11.49 1.125 11.859 1.125 12.1875C1.125 12.7603 1.66801 13.4661 2.99003 14.061C4.25925 14.6322 6.05214 15 8.0625 15C10.0729 15 11.8657 14.6322 13.135 14.061C14.457 13.4661 15 12.7603 15 12.1875C15 11.8591 14.8311 11.49 14.4053 11.1045C14.1751 10.8959 14.1574 10.5402 14.3659 10.3099C14.5745 10.0797 14.9302 10.062 15.1605 10.2705C15.7327 10.7887 16.125 11.4383 16.125 12.1875C16.125 13.4787 14.9891 14.4603 13.5966 15.0869C12.1514 15.7373 10.1943 16.125 8.0625 16.125C5.93073 16.125 3.97361 15.7373 2.52837 15.0869C1.13592 14.4603 0 13.4787 0 12.1875C0 11.4383 0.392286 10.7887 0.96454 10.2705C1.19482 10.062 1.55054 10.0797 1.75906 10.3099Z" fill="#212121"/>
</svg>`,
    pickup:   `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none">
<path fill-rule="evenodd" clip-rule="evenodd" d="M8.99968 2.0625C8.0677 2.0625 7.31218 2.81802 7.31218 3.75V3.94086C7.62531 3.93749 7.96333 3.9375 8.32861 3.9375H9.67075C10.036 3.9375 10.3741 3.93749 10.6872 3.94086V3.75C10.6872 2.81802 9.93166 2.0625 8.99968 2.0625ZM11.8122 3.9802V3.75C11.8122 2.1967 10.553 0.9375 8.99968 0.9375C7.44638 0.9375 6.18718 2.1967 6.18718 3.75V3.9802C6.08593 3.98759 5.98823 3.99626 5.89391 4.00642C5.23515 4.07742 4.68424 4.22616 4.19502 4.56148C4.02676 4.67681 3.86871 4.80637 3.72263 4.94875C3.29788 5.36271 3.04399 5.87374 2.84517 6.50579C2.65214 7.11944 2.49613 7.8995 2.3001 8.87969L2.2858 8.95123C2.00332 10.3636 1.78072 11.4765 1.71679 12.363C1.65146 13.2687 1.74275 14.0306 2.17178 14.691C2.31492 14.9113 2.482 15.1151 2.66996 15.2987C3.23331 15.8488 3.96257 16.0878 4.86352 16.2014C5.74528 16.3125 6.88027 16.3125 8.32058 16.3125H9.67878C11.1191 16.3125 12.2541 16.3125 13.1358 16.2014C14.0368 16.0878 14.7661 15.8488 15.3294 15.2987C15.5174 15.1151 15.6844 14.9113 15.8276 14.691C16.2566 14.0306 16.3479 13.2687 16.2826 12.363C16.2186 11.4765 15.9961 10.3636 15.7136 8.95129L15.6993 8.87972C15.5032 7.89951 15.3472 7.11944 15.1542 6.50579C14.9554 5.87374 14.7015 5.36271 14.2767 4.94875C14.1307 4.80637 13.9726 4.6768 13.8043 4.56148C13.3151 4.22616 12.7642 4.07742 12.1055 4.00642C12.0111 3.99626 11.9134 3.98759 11.8122 3.9802ZM6.01447 5.12494C5.45444 5.1853 5.10846 5.29929 4.83104 5.48943C4.71592 5.56834 4.60778 5.65699 4.50783 5.75441C4.26697 5.98914 4.08735 6.30605 3.91833 6.84337C3.7456 7.39246 3.60073 8.11294 3.39689 9.13216C3.10473 10.5929 2.89711 11.6365 2.83887 12.4439C2.78143 13.2403 2.87842 13.7137 3.11514 14.078C3.21308 14.2288 3.3274 14.3682 3.456 14.4938C3.76683 14.7974 4.21198 14.9853 5.00422 15.0852C5.80739 15.1864 6.87136 15.1875 8.36108 15.1875H9.63828C11.128 15.1875 12.192 15.1864 12.9951 15.0852C13.7874 14.9853 14.2325 14.7974 14.5434 14.4938C14.672 14.3682 14.7863 14.2288 14.8842 14.078C15.1209 13.7137 15.2179 13.2403 15.1605 12.4439C15.1023 11.6365 14.8946 10.5929 14.6025 9.13216C14.3986 8.11294 14.2538 7.39246 14.081 6.84337C13.912 6.30605 13.7324 5.98914 13.4915 5.75441C13.3916 5.65699 13.2834 5.56834 13.1683 5.48943C12.8909 5.29929 12.5449 5.1853 11.9849 5.12494C11.4126 5.06326 10.6777 5.0625 9.63828 5.0625H8.36108C7.32167 5.0625 6.58677 5.06326 6.01447 5.12494ZM6.6904 10.7197C6.98331 10.6161 7.30468 10.7696 7.4082 11.0625C7.64013 11.7187 8.26596 12.1875 8.99983 12.1875C9.7337 12.1875 10.3595 11.7187 10.5914 11.0625C10.695 10.7696 11.0163 10.6161 11.3092 10.7197C11.6021 10.8232 11.7557 11.1445 11.6521 11.4375C11.2663 12.5291 10.2253 13.3125 8.99983 13.3125C7.77437 13.3125 6.73334 12.5291 6.34751 11.4375C6.24398 11.1445 6.3975 10.8232 6.6904 10.7197Z" fill="#212121"/>
</svg>`,
    dine_in:  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="15" viewBox="0 0 12 15" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.79379 1.8169e-07H5.84748C6.52566 -6.74735e-06 7.07262 -1.22907e-05 7.51384 0.0399769C7.9686 0.0811932 8.36595 0.168416 8.72689 0.376804C9.15444 0.623652 9.50948 0.978697 9.75633 1.40625C9.96472 1.76719 10.0519 2.16454 10.0932 2.6193C10.1331 3.06052 10.1331 3.60748 10.1331 4.28567V6.84079C10.5036 6.91902 10.8389 7.0721 11.1095 7.38143C11.4437 7.76334 11.5527 8.2399 11.5978 8.76493C11.5988 8.77687 11.5999 8.78879 11.6009 8.80069C11.6273 9.10759 11.6524 9.39832 11.6361 9.64125C11.6175 9.91966 11.5419 10.2038 11.316 10.4499C11.0827 10.7042 10.7897 10.7989 10.5091 10.839C10.3948 10.8553 10.2685 10.8642 10.1331 10.8691V14.0625C10.1331 14.3732 9.8813 14.625 9.57063 14.625C9.25998 14.625 9.00813 14.3732 9.00813 14.0625V10.875H2.63314V14.0625C2.63314 14.3732 2.3813 14.625 2.07064 14.625C1.75998 14.625 1.50814 14.3732 1.50814 14.0625V10.8691C1.37275 10.8642 1.24646 10.8553 1.13218 10.839C0.851558 10.7989 0.558564 10.7042 0.325236 10.4499C0.0993244 10.2038 0.0237989 9.91966 0.00516125 9.64125C-0.0111023 9.39832 0.0139407 9.10758 0.0403765 8.80067C0.0414007 8.78878 0.0424271 8.77687 0.0434532 8.76493C0.088582 8.2399 0.197563 7.76334 0.531734 7.38143C0.802399 7.0721 1.13762 6.91902 1.50814 6.84079L1.50814 4.28565C1.50813 3.60747 1.50812 3.06052 1.54811 2.6193C1.58933 2.16454 1.67655 1.76719 1.88494 1.40625C2.13179 0.978696 2.48683 0.623652 2.91439 0.376804C3.27532 0.168416 3.67267 0.0811932 4.12743 0.0399769C4.56865 -1.22907e-05 5.11561 -6.74735e-06 5.79379 1.8169e-07ZM3.15334 6.75C3.12587 6.75 3.09857 6.75 3.07146 6.75H2.63314V4.3125C2.63314 3.60119 2.63367 3.10531 2.66852 2.72084C2.70266 2.34411 2.76616 2.12993 2.85922 1.96875C3.00733 1.71222 3.22035 1.49919 3.47689 1.35108C3.63806 1.25803 3.85225 1.19453 4.22898 1.16038C4.61344 1.12554 5.10932 1.125 5.82064 1.125C6.53195 1.125 7.02783 1.12554 7.41229 1.16038C7.78902 1.19453 8.00321 1.25803 8.16439 1.35108C8.42092 1.49919 8.63394 1.71222 8.78205 1.96875C8.87511 2.12993 8.93861 2.34411 8.97275 2.72084C9.0076 3.10531 9.00813 3.60119 9.00813 4.3125V6.75H8.56981C8.5427 6.75 8.5154 6.75 8.48793 6.75H3.15334ZM3.19564 7.875C2.55882 7.875 2.14574 7.87655 1.84089 7.92339C1.56076 7.96644 1.45323 8.03671 1.37838 8.12225C1.28373 8.23043 1.20306 8.41055 1.16432 8.86127C1.13375 9.21698 1.11786 9.41986 1.12765 9.56611C1.132 9.6311 1.14058 9.66178 1.14502 9.674C1.14789 9.6819 1.14945 9.68422 1.15409 9.68928L1.15498 9.69021C1.15496 9.69019 1.15499 9.69021 1.15498 9.69021L1.15729 9.69171C1.15862 9.69246 1.16097 9.69369 1.1646 9.69529C1.18026 9.70219 1.21662 9.71463 1.29127 9.72529C1.4548 9.74865 1.68431 9.75 2.07064 9.75H9.57063C9.95696 9.75 10.1865 9.74865 10.35 9.72529C10.4246 9.71463 10.461 9.70219 10.4767 9.69529C10.4803 9.69369 10.4826 9.69246 10.484 9.69171L10.486 9.6905C10.486 9.69048 10.486 9.69045 10.486 9.6905L10.4872 9.68928C10.4918 9.68422 10.4934 9.6819 10.4963 9.674C10.5007 9.66178 10.5093 9.6311 10.5136 9.56611C10.5234 9.41986 10.5075 9.21698 10.477 8.86127C10.4382 8.41055 10.3575 8.23043 10.2629 8.12225C10.188 8.03671 10.0805 7.96644 9.80038 7.92339C9.49553 7.87655 9.08245 7.875 8.44564 7.875H3.19564Z" fill="#212121"/></svg>`,
    in_car: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M9 2.0625C5.16852 2.0625 2.0625 5.16852 2.0625 9C2.0625 12.8315 5.16852 15.9375 9 15.9375C12.8315 15.9375 15.9375 12.8315 15.9375 9C15.9375 5.16852 12.8315 2.0625 9 2.0625ZM0.9375 9C0.9375 4.5472 4.5472 0.9375 9 0.9375C13.4528 0.9375 17.0625 4.5472 17.0625 9C17.0625 13.4528 13.4528 17.0625 9 17.0625C4.5472 17.0625 0.9375 13.4528 0.9375 9ZM5.10238 8.4375H7.01514C7.10949 8.10389 7.28569 7.80464 7.52067 7.56282L6.56419 5.90613C5.7888 6.51744 5.24878 7.41398 5.10238 8.4375ZM7.53801 5.34285L8.49468 6.99985C8.65638 6.95913 8.82566 6.9375 9 6.9375C9.17432 6.9375 9.34359 6.95913 9.50527 6.99984L10.4619 5.34283C10.0099 5.16198 9.51659 5.0625 9 5.0625C8.4834 5.0625 7.99003 5.16199 7.53801 5.34285ZM11.4358 5.90611L10.4793 7.56278C10.7143 7.80461 10.8905 8.10387 10.9849 8.4375H12.8976C12.7512 7.41396 12.2112 6.51741 11.4358 5.90611ZM12.8976 9.5625H10.9849C10.8905 9.89614 10.7143 10.1954 10.4793 10.4373L11.4357 12.0939C12.2112 11.4826 12.7512 10.5861 12.8976 9.5625ZM10.4619 12.6572L9.50522 11.0002C9.34355 11.0409 9.1743 11.0625 9 11.0625C8.82568 11.0625 8.65641 11.0409 8.49473 11.0002L7.53805 12.6572C7.99006 12.838 8.48341 12.9375 9 12.9375C9.51657 12.9375 10.0099 12.838 10.4619 12.6572ZM6.56422 12.0939L7.5207 10.4372C7.28571 10.1954 7.1095 9.89613 7.01514 9.5625H5.10238C5.24878 10.586 5.78882 11.4826 6.56422 12.0939ZM8.53945 9.81677C8.53673 9.81514 8.53399 9.81352 8.53123 9.81193C8.52861 9.81042 8.52598 9.80892 8.52335 9.80746C8.24749 9.64426 8.0625 9.34374 8.0625 9C8.0625 8.65751 8.24615 8.35792 8.52035 8.19433C8.52399 8.19233 8.52763 8.19028 8.53125 8.18819C8.53507 8.18598 8.53886 8.18374 8.54261 8.18145C8.67791 8.10569 8.83391 8.0625 9 8.0625C9.16531 8.0625 9.32063 8.10529 9.45549 8.18039C9.45984 8.18306 9.46423 8.18568 9.46867 8.18824C9.47291 8.19069 9.47718 8.19308 9.48146 8.19541C9.75466 8.35924 9.9375 8.65827 9.9375 9C9.9375 9.34462 9.75155 9.64582 9.47451 9.80872C9.47259 9.8098 9.47067 9.81089 9.46875 9.812C9.46665 9.81321 9.46456 9.81444 9.46249 9.81567C9.32602 9.89322 9.16818 9.9375 9 9.9375C8.83262 9.9375 8.67548 9.89363 8.53945 9.81677ZM3.9375 9C3.9375 6.20406 6.20406 3.9375 9 3.9375C11.7959 3.9375 14.0625 6.20406 14.0625 9C14.0625 11.7959 11.7959 14.0625 9 14.0625C6.20406 14.0625 3.9375 11.7959 3.9375 9Z" fill="#212121"/></svg>`,
};
const OT_SUBS = {
    delivery: 'Home delivery',
    pickup:   'Self pickup',
    dine_in:  'Eat at the outlet',
    in_car:   'Curbside pickup',
};

function closeOtsDropdowns() {
    document.querySelectorAll('.co-ots.open').forEach(w => {
        w.classList.remove('open');
        w.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
    });
}

function toggleOtsDropdown(wrapperId) {
    const wrapper = el(wrapperId);
    if (!wrapper) return;
    const isOpen = wrapper.classList.contains('open');
    closeOtsDropdowns();
    if (!isOpen) {
        wrapper.classList.add('open');
        wrapper.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'true');
    }
}

function buildOtsMenus() {
    const current = cfg.orderType || 'delivery';
    // CI3 parity (mirrors order_menu_new.php + checkout.php $showDel): delivery
    // requires BOTH the master switch (onlineDeliveryOn) AND the delivery flag;
    // other types are gated only by their own flag. Checking only
    // onlineOrdersDelivery here made the checkout dropdown show Delivery for
    // outlets where the menu page (correctly) hides it.
    const delEnabled = Number(cfg.onlineDeliveryOn ?? 1) === 1
                    && Number(cfg.onlineOrdersDelivery ?? 1) === 1;
    const types = [
        { id: '1', key: 'delivery', label: 'Delivery',  enabled: delEnabled ? 1 : 0 },
        { id: '2', key: 'pickup',   label: 'Pickup',    enabled: cfg.onlineOrdersSelfPickup ?? 0 },
        { id: '3', key: 'dine_in',  label: 'Dine-In',   enabled: cfg.dineInOrders           ?? 0 },
        { id: '4', key: 'in_car',   label: 'In-Car',    enabled: cfg.inCarOrders            ?? 0 },
    ].filter(t => Number(t.enabled) === 1);

    const TICK = `<span class="co-ot-option__tick"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>`;

    const html = types.map(t => `
        <button type="button" class="co-ot-option${t.key === current ? ' co-ot-option--active' : ''}" data-ot="${t.id}">
            <span class="co-ot-option__ic">${OT_ICONS[t.key] || ''}</span>
            <span class="co-ot-option__body">
                <b>${esc(t.label)}</b>
                <span>${esc(OT_SUBS[t.key] || '')}</span>
            </span>
            ${t.key === current ? TICK : '<span></span>'}
        </button>`).join('');

    ['coOtsMenuMobile', 'coOtsMenuDesktop'].forEach(id => {
        const container = el(id);
        if (!container) return;
        // Backstop for checkout.php's own $hasOrderTypes check, if the two ever disagree.
        if (!types.length) { container.closest('.co-ots')?.remove(); return; }
        container.innerHTML = html;
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ot]');
            if (!btn) return;
            const otNum   = btn.dataset.ot;
            const numToOt = { '1': 'delivery', '2': 'pickup', '3': 'dine_in', '4': 'in_car' };
            const newOt   = numToOt[otNum];
            closeOtsDropdowns();
            if (!newOt || newOt === current) return;
            showOrderTypeConfirm(otNum, newOt);
        });
    });
}

function navigateToOt(otNum) {
    const tid = cfg.tableId || 0;
    const numToOt = { '1': 'delivery', '2': 'pickup', '3': 'dine_in', '4': 'in_car' };
    const otKey = numToOt[String(otNum)] || 'delivery';
    // The committed order-type switch (setupOrderType() also runs on every page load, so
    // it's the wrong place for a "user selected" event). Fires synchronously because the
    // navigation below tears the page down immediately.
    window.Analytics?.trackDeliveryTypeSelected?.({ deliveryType: otKey, source: 'checkout' });
    // Mirror menu.js click handler so the menu page sees this OT too if user goes back.
    try {
        localStorage.setItem('orderType', String(otNum));
        const cookieKey = otKey === 'pickup' ? 'pick_up' : otKey;
        document.cookie = `order_type=${cookieKey};path=/;max-age=2592000`;
    } catch {}
    location.href = (otKey === 'dine_in' && tid > 0)
        ? `/checkout/${cfg.businessId}/${otNum}/${tid}`
        : `/checkout/${cfg.businessId}/${otNum}`;
}

function showOrderTypeConfirm(otNum, otKey) {
    const store = [cfg.locality, cfg.city].filter(Boolean).join(', ') || cfg.bName || '';

    // Black-and-white line-art illustrations matching the design spec.
    const ink = '#111';
    // Illustrations live at /assets/icons/order-type/*.svg (shared with menu.js).
    const icons = {
        delivery: '/assets/icons/order-type/delivery.svg',
        pickup:   '/assets/icons/order-type/pickup.svg',
        dine_in:  '/assets/icons/order-type/dine_in.svg',
        in_car:   '/assets/icons/order-type/in_car.svg',
    };

    const meta = {
        delivery: {
            title:  'Delivery Order',
            desc:   'Your order will be delivered to your respective address',
            note:   '',
            cancel: 'Cancel',
            ok:     'Confirm Delivery',
        },
        pickup: {
            title:  'Pickup Order',
            desc:   `You have to collect the order from ${store}`,
            note:   'Delivery partners are not assigned for pickup orders.',
            cancel: 'Keep Delivery',
            ok:     'Yes, Switch to Pickup',
        },
        dine_in: {
            title:  'Dine-In Order',
            desc:   'You will be dining at our outlet',
            note:   '',
            cancel: 'Cancel',
            ok:     'Confirm Dine-In',
        },
        in_car: {
            title:  'In-Car Order',
            desc:   'Your order will be delivered to your car',
            note:   '',
            cancel: 'Cancel',
            ok:     'Confirm In-Car',
        },
    };

    const m = meta[otKey];
    if (!m) { navigateToOt(otNum); return; }

    set('otConfirmTitle', m.title);
    const iconEl = el('otConfirmIcon');
    if (iconEl) iconEl.innerHTML = icons[otKey] ? `<img src="${icons[otKey]}" alt="" width="144" />` : '';

    set('otConfirmDesc', m.desc);

    const noteEl = el('otConfirmNote');
    if (noteEl) {
        noteEl.textContent = m.note;
        noteEl.hidden = !m.note;
    }

    const cancelBtn = el('otConfirmCancel');
    const okBtn     = el('otConfirmOk');
    if (cancelBtn) {
        cancelBtn.textContent = m.cancel;
        cancelBtn.onclick = () => closeModal('otConfirmModal');
    }
    if (okBtn) {
        okBtn.textContent = m.ok;
        okBtn.onclick = () => { closeModal('otConfirmModal'); navigateToOt(otNum); };
    }

    openModal('otConfirmModal');
}

// ─── GSTIN saved-state helpers ────────────────────────────────
// localStorage key — namespaced by businessId so different brands don't share state.
function _gstStorageKey() { return 'gstSaved_' + (cfg.businessId || 0); }

function persistGstSaved(g) {
    try { localStorage.setItem(_gstStorageKey(), JSON.stringify(g)); } catch (e) {}
}
function loadGstSaved() {
    try { return JSON.parse(localStorage.getItem(_gstStorageKey()) || 'null'); } catch (e) { return null; }
}
function dropGstSaved() {
    try { localStorage.removeItem(_gstStorageKey()); } catch (e) {}
}

function renderGstinSavedState(g) {
    const row     = document.querySelector('.co-gstin-card__row');
    const input   = document.getElementById('gstNumber');
    const btn     = document.getElementById('gstConfirmBtn');
    const savedEl = document.getElementById('gstSavedBox');
    const nameEl  = document.getElementById('gstSavedName');
    if (!row || !input || !btn) return;
    input.value    = g.gstin;
    input.readOnly = true;                       // editable only after Update / X
    row.classList.add('is-saved');
    btn.textContent = 'Update';
    btn.disabled    = false;
    if (nameEl)  nameEl.textContent = g.legal_name || '';
    if (savedEl) savedEl.hidden = !(g.legal_name);
    window._gstSaved = g;
}

// Generic success flash inside the GST popup. Opens overlay if closed, hides existing
// content, appends a green-check success block, then auto-closes after `duration` ms
// and restores the body for the next open. Used by both Save and Remove flows.
function flashGstPopup(title, subtitle, duration) {
    const overlay = document.getElementById('gstPopup');
    const sheet   = document.querySelector('#gstPopup .co-gst-sheet');
    if (!overlay || !sheet) return;
    sheet.querySelectorAll(':scope > *').forEach((el) => { el.hidden = true; });
    document.getElementById('gstPopupSuccess')?.remove();
    const success = document.createElement('div');
    success.id = 'gstPopupSuccess';
    success.className = 'co-gst-sheet__success';
    const subHtml = subtitle ? `<p class="co-gst-sheet__success-text">${String(subtitle).replace(/</g, '&lt;')}</p>` : '';
    success.innerHTML = `
        <div class="co-gst-sheet__success-icon" aria-hidden="true">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        <h3 class="co-gst-sheet__success-title">${String(title).replace(/</g, '&lt;')}</h3>
        ${subHtml}
    `;
    sheet.appendChild(success);
    overlay.hidden = false;
    setTimeout(() => {
        overlay.hidden = true;
        sheet.querySelectorAll(':scope > *').forEach((el) => { el.hidden = false; });
        document.getElementById('gstPopupSuccess')?.remove();
        const btn = document.getElementById('saveGstBtn');
        const msg = document.getElementById('gstPopupMsg');
        if (btn) { btn.disabled = false; btn.textContent = 'Save GST Details'; }
        if (msg) { msg.hidden = true; msg.textContent = ''; msg.className = 'co-gst-sheet__msg'; }
    }, duration || 1800);
}

function showGstSavedSuccess(g) {
    flashGstPopup('GST Details Saved', g.legal_name || g.gstin, 2200);
}

function clearGstinSavedState() {
    const row     = document.querySelector('.co-gstin-card__row');
    const input   = document.getElementById('gstNumber');
    const btn     = document.getElementById('gstConfirmBtn');
    const savedEl = document.getElementById('gstSavedBox');
    if (input) { input.value = ''; input.readOnly = false; input.focus(); }
    if (row)   row.classList.remove('is-saved');
    if (btn)   { btn.textContent = 'Confirm'; btn.disabled = true; }
    if (savedEl) savedEl.hidden = true;
    window._gstSaved = null;
    window._gstDetails = null;
    dropGstSaved();
}

// ─── GSTIN validate + save ─────────────────────────────────────
// CI3 parity. Endpoints live on api.uengage.in:
//   GET  /client/getValidateGstDetails?businessId&contactMappingId&token&gstin
//   POST /client/gstDetailSaved  (form: contactMappingId, token, orderId, legalName, tradeName, gstno)

async function validateGstin(gstin) {
    if (!gstin || gstin.length !== 15) return;
    const ud  = userData();
    const msg = document.getElementById('gstPopupMsg');
    if (msg) { msg.hidden = true; msg.className = 'co-gst-sheet__msg'; }

    if (!ud.token || !ud.contactMappingId) {
        return showApplyToast('error', 'Please log in to validate GSTIN.');
    }

    // Endpoint only reads params from POST body (form-encoded). Query-string params
    // are silently ignored — verified against api.uengage.in.
    const form = new URLSearchParams();
    form.set('businessId',       String(cfg.businessId || ''));
    form.set('contactMappingId', ud.contactMappingId);
    form.set('token',            ud.token);
    form.set('gstin',            gstin);

    try {
        const r = await fetch(`${getApiBase()}/client/getValidateGstDetails`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body:    form.toString(),
        });
        const d = await r.json();
        if (Number(d.status) !== 1) {
            return showApplyToast('error', d.msg || 'Invalid GSTIN. Please check the number and try again.');
        }
        const g = d.gst || d.data || {};
        window._gstDetails = {
            gstin:      g.gstin || gstin,
            legal_name: g.legal_name || g.legalName || '',
            trade_name: g.trade_name || g.tradeName || '',
        };
        const numEl   = document.getElementById('gstPopupNumber');
        const legalEl = document.getElementById('gstPopupLegalName');
        if (numEl)   numEl.textContent   = window._gstDetails.gstin;
        if (legalEl) legalEl.textContent = window._gstDetails.legal_name;
        document.getElementById('gstPopup').hidden = false;
    } catch (e) {
        showApplyToast('error', 'Network error while validating GSTIN. Please try again.');
    }
}

async function saveGstDetails() {
    const g  = window._gstDetails;
    const ud = userData();
    if (!g || !ud.token || !ud.contactMappingId) return;

    const orderId = state.order?.orderId
        || state.order?.orderDetails?.orderId
        || (() => { try { return JSON.parse(localStorage.getItem('cartData') || '{}')?.rows?.orderDetails?.orderId || ''; } catch { return ''; } })();

    const btn = document.getElementById('saveGstBtn');
    const msg = document.getElementById('gstPopupMsg');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const form = new URLSearchParams();
    form.set('businessId',       String(cfg.businessId || ''));
    form.set('contactMappingId', ud.contactMappingId);
    form.set('token',            ud.token);
    form.set('orderId',          orderId);
    form.set('legalName',        g.legal_name);
    form.set('tradeName',        g.trade_name || g.legal_name);
    form.set('gstno',            g.gstin);

    try {
        const r = await fetch(`${getApiBase()}/client/gstDetailSaved`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body:    form.toString(),
        });
        const d = await r.json();
        if (Number(d.status) !== 1) {
            if (msg) { msg.textContent = d.msg || 'Could not save GST details.'; msg.classList.add('is-error'); msg.hidden = false; }
            if (btn) { btn.disabled = false; btn.textContent = 'Save GST Details'; }
            return;
        }
        // Render the saved state on the GSTIN card BEFORE the popup auto-closes so users
        // see the green input/legal-name pill take effect during the flash.
        renderGstinSavedState(g);
        persistGstSaved(g);
        // Flash the success block (auto-closes after 2.2s and restores popup body).
        showGstSavedSuccess(g);
    } catch (e) {
        if (msg) { msg.textContent = 'Network error. Please try again.'; msg.classList.add('is-error'); msg.hidden = false; }
        if (btn) { btn.disabled = false; btn.textContent = 'Save GST Details'; }
    }
}

// ─── Special instructions ─────────────────────────────────────
// Per-brand localStorage-backed remarks. Mirrors CI3 SpecialInstructionsManager
// (assets/themes/ue_silver/js/checkout.js:260-372): same storage-key shape so
// returning users on a brand keep their saved note. Save visible only when
// focused + changed; Remove visible only when blurred + something saved.

function siStorageKey() { return 'special_instructions_' + (cfg.businessId || 0); }

function siUpdateButtons(focused) {
    const input    = el('remarks');
    const saveBtn  = el('saveInstructionsBtn');
    const removeBtn = el('removeInstructionsBtn');
    if (!input || !saveBtn || !removeBtn) return;

    const current = input.value.trim();
    const saved   = localStorage.getItem(siStorageKey()) || '';
    const changed = current !== saved;

    saveBtn.hidden   = !(focused && current.length > 0 && changed);
    removeBtn.hidden = !(!focused && saved.length > 0);
}

function bindSpecialInstructions() {
    const input     = el('remarks');
    const section   = el('remarksSection');
    const toggleBtn = el('addInstructionsBtn');
    const saveBtn   = el('saveInstructionsBtn');
    const removeBtn = el('removeInstructionsBtn');
    if (!input || !section) return;

    // Hide Save/Remove by default — visibility is driven by focus + state.
    if (saveBtn)   saveBtn.hidden   = true;
    if (removeBtn) removeBtn.hidden = true;

    // Auto-load saved value and open the section so the user sees it.
    try {
        const saved = localStorage.getItem(siStorageKey());
        if (saved) {
            input.value = saved;
            section.hidden = false;
        }
    } catch {}

    toggleBtn?.addEventListener('click', () => {
        section.hidden = !section.hidden;
        if (!section.hidden) setTimeout(() => input.focus(), 100);
    });

    let isFocused = false;
    input.addEventListener('focus', () => { isFocused = true;  siUpdateButtons(true);  });
    input.addEventListener('blur',  () => { isFocused = false; setTimeout(() => siUpdateButtons(false), 150); });
    input.addEventListener('input', () => siUpdateButtons(isFocused));

    saveBtn?.addEventListener('mousedown', (e) => e.preventDefault());
    saveBtn?.addEventListener('click', () => {
        const val = input.value.trim();
        if (!val) { showApplyToast('error', 'Please enter some instructions before saving.'); return; }
        try {
            localStorage.setItem(siStorageKey(), val);
            showApplyToast('success', 'Special instructions saved!');
            input.blur();
            siUpdateButtons(false);
        } catch {
            showApplyToast('error', 'Error saving instructions.');
        }
    });

    removeBtn?.addEventListener('mousedown', (e) => e.preventDefault());
    removeBtn?.addEventListener('click', () => {
        try { localStorage.removeItem(siStorageKey()); } catch {}
        input.value = '';
        showApplyToast('success', 'Instructions removed!');
        siUpdateButtons(false);
    });

    siUpdateButtons(false);
}

// ─── Events ───────────────────────────────────────────────────

function bindEvents() {
    // Cart qty buttons (persistent — survives renderCartItems re-renders)
    document.addEventListener('click', handleCartQtyClick);
    document.addEventListener('click', handleCustomizationsToggle);
    // "Remove all" on the grouped out-of-stock card (lives outside #cartItemsContainer).
    document.addEventListener('click', handleRemoveInvalidClick);

    // GSTIN — enable Confirm/Update when input has 15 chars (CI3 parity).
    const gstInput = document.getElementById('gstNumber');
    const gstBtn   = document.getElementById('gstConfirmBtn');
    if (gstInput && gstBtn) {
        gstInput.addEventListener('input', () => {
            gstBtn.disabled = gstInput.value.trim().length !== 15;
        });
        gstBtn.addEventListener('click', () => {
            // Saved GST → input is read-only and the button reads "Update". The first
            // click unlocks the field for editing (it doesn't re-validate the unchanged
            // value); the saved row/pill is restored on refresh from localStorage.
            if (gstInput.readOnly) {
                gstInput.readOnly = false;
                document.querySelector('.co-gstin-card__row')?.classList.remove('is-saved');
                const savedEl = document.getElementById('gstSavedBox');
                if (savedEl) savedEl.hidden = true;
                gstBtn.textContent = 'Confirm';
                gstInput.focus();
                gstInput.select();
                return;
            }
            validateGstin(gstInput.value.trim());
        });
    }
    // Restore cached saved-state on page load so a refresh doesn't lose the saved GST.
    const cachedGst = loadGstSaved();
    if (cachedGst && cachedGst.gstin) renderGstinSavedState(cachedGst);

    // Popup close (Change) — keep the input value so the user can edit / re-validate.
    document.getElementById('cancelGstBtn')?.addEventListener('click', () => {
        const pop = document.getElementById('gstPopup');
        if (pop) pop.hidden = true;
        // Restore the popup's default state for the next open.
        const btn = document.getElementById('saveGstBtn');
        const msg = document.getElementById('gstPopupMsg');
        if (btn) { btn.disabled = false; btn.textContent = 'Save GST Details'; }
        if (msg) { msg.hidden = true; msg.textContent = ''; msg.className = 'co-gst-sheet__msg'; }
        // Reveal hidden details/buttons if a prior success swapped them out.
        document.querySelectorAll('.co-gst-sheet > *').forEach((el) => { el.hidden = false; });
        document.getElementById('gstPopupSuccess')?.remove();
    });

    // Save GST details
    document.getElementById('saveGstBtn')?.addEventListener('click', saveGstDetails);

    // X-clear on the saved-state pill — wipes the GST then flashes a "GST Removed" success.
    document.getElementById('gstClearBtn')?.addEventListener('click', () => {
        clearGstinSavedState();
        flashGstPopup('GST Removed', '', 1500);
    });

    // Top-right X on the popup — same effect as Change (close popup, preserve input).
    document.getElementById('gstPopupCloseBtn')?.addEventListener('click', () => {
        document.getElementById('cancelGstBtn')?.click();
    });

    // Redemption-confirmed panel: its CTA is an ordinary block button, not the ✕
    // glyph, so it closes by id rather than riding the .popup-close delegation.
    el('redeemDoneBtn')?.addEventListener('click', () => closeModal('redeemSuccessOverlay'));

    // Close modals + dropdowns
    document.addEventListener('click', (e) => {
        if (e.target.closest('.popup-close'))              { closeAllModals(); return; }
        if (e.target.classList.contains('popup-overlay'))  { closeAllModals(); return; }
        if (!e.target.closest('.co-ots'))                  closeOtsDropdowns();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });

    // Pay
    el('payBTN')?.addEventListener('click', handlePlaceOrder);
    // Fast checkout: both buttons open the Order Summary confirmation modal first
    // (app parity). Pay Securely → "Proceed to Payment" → auto UPI; Change →
    // "Continue to Payment Options" → full picker. Confirm runs the pending action.
    el('fastPaySecureBtn')?.addEventListener('click', () => openConfirmOrderModal('fast'));
    el('fastPayChangeBtn')?.addEventListener('click', () => openConfirmOrderModal('change'));
    el('confirmOrderProceedBtn')?.addEventListener('click', onConfirmOrderProceed);
    el('confirmOrderCancelBtn')?.addEventListener('click', onConfirmOrderCancel);

    // Welcome-form name gate: once the user saves their name in the forced prompt, resume
    // the order automatically so they don't have to tap Pay a second time.
    window.addEventListener('profile:completed', () => {
        if (state.pendingPlaceOrder) {
            state.pendingPlaceOrder = false;
            handlePlaceOrder();
        }
    });

    // Points balance — Redeem opens the item picker sheet. Disabled at a 0
    // balance (renderPointsBalance sets that), so this only ever fires with
    // something to redeem.
    el('pointsBalanceRedeemBtn')?.addEventListener('click', openRedeemSheet);
    el('loyaltyRemoveBtn')?.addEventListener('click', removeAllRedemptions);
    el('redeemUpdateCartBtn')?.addEventListener('click', confirmRedeemSelection);
    // Wired explicitly rather than riding the .popup-close delegation: that class
    // is the ✕ glyph's styling too (position:absolute, 40px, font-size:33px), so
    // wearing it for the behaviour threw this full-width button into the sheet's
    // top-right corner at glyph size.
    el('redeemEmptyCloseBtn')?.addEventListener('click', () => closeModal('redeemPointsOverlay'));

    // Address
    el('selectAddressCta')?.addEventListener('click', () => { openModal('selectAddressModal'); loadAddresses(); });
    el('selectAddressBtn')?.addEventListener('click', () => { openModal('selectAddressModal'); loadAddresses(); });
    el('selectAddressMobileCta')?.addEventListener('click', () => { openModal('selectAddressModal'); loadAddresses(); });
    // Add-new-address opens the shared address-form modal (map + reverse-geocode + save).
    // The form controller (addressForm.js) owns the save / locate / confirm / back / chip
    // wiring internally; checkout supplies the current outlet (for serviceability + the map
    // fallback center) and an onSaved hook to select the new address + recompute the bill.
    const addrForm = createAddressForm({
        businessId: cfg.businessId,
        outlet: { lat: cfg.latitude, lng: cfg.longitude, slug: cfg.slug },
        serviceability: true,
        // Pincode/ecomm journey gate — OUTLET-level localityMapping (from CheckoutConfig) wins
        // over brand-level, so pincode mode activates only for the Pan-India / B2B outlets.
        localityMapping: cfg.localityMapping,
        ecomm: cfg.ecomm,
        onSaved: async (saved) => {
            if (saved.id) {
                state.selectedAddressId          = String(saved.id);
                state.selectedAddressText        = [saved.addressLine1, saved.addressLine2, saved.locality, saved.city].filter(Boolean).join(', ');
                state.selectedAddressName        = saved.label;
                state.selectedAddressLat         = saved.lat ? String(saved.lat) : '';
                state.selectedAddressLng         = saved.lng ? String(saved.lng) : '';
                state.selectedAddressDeliverable = true;
                set('selectedAddressDisplay', state.selectedAddressText);
                el('selectedAddressDisplay')?.classList.remove('co-addr-display--warn');
                saveAddressSelection(state.selectedAddressId, state.selectedAddressText, state.selectedAddressName, state.selectedAddressLat, state.selectedAddressLng);
            }
            // Address is already saved AND selected — return to checkout rather than re-opening
            // the list. loadAddresses(true) refreshes the (hidden) list state + FORCES a bill
            // recompute so the new address's delivery charges land — the coord-diff gate inside
            // loadAddresses would otherwise skip it when the server echoes the map-pin coords.
            closeModal('selectAddressModal');
            // Shipping info previously fired ONLY when picking an already-saved address
            // (loadAddresses, selectionType 'Existing'), so first-time buyers — who add an
            // address rather than pick one — were missing from the step entirely.
            trackAddShippingInfo({
                value: analyticsTotal(), items: analyticsItems(),
                address: {
                    name:  saved.label,
                    line1: [saved.addressLine1, saved.addressLine2].filter(Boolean).join(', '),
                    city:  saved.city || saved.locality || '',
                },
                selectionType: saved.isEdit ? 'Edited' : 'New',
            });
            // address_added is the NEW-address subset of add_shipping_info (which also fires
            // when picking an existing address). Doc counts reflect that: 3,167 of 6,026.
            if (!saved.isEdit) window.Analytics?.trackAddressAdded?.({ selectionType: 'New' });
            await loadAddresses(true);
            updatePayCta(state.order);
            showApplyToast('success', 'Address saved successfully!', { variant: 'saved' });
        },
    });
    el('addNewAddressBtn')?.addEventListener('click', () => { closeModal('selectAddressModal'); addrForm.openAdd(); });
    el('addNewAddressBtnMobile')?.addEventListener('click', () => { closeModal('selectAddressModal'); addrForm.openAdd(); });

    // Slot
    const openSlotModal = () => { openModal('slotModal'); loadSlots(); };
    el('selectSlotBtn')?.addEventListener('click',       openSlotModal);
    el('selectSlotActionBtn')?.addEventListener('click', openSlotModal);
    el('confirmSlotBtn')?.addEventListener('click', confirmSlot);

    // Pickup slot
    const openPickupSlotModal = () => { openModal('pickupSlotModal'); loadPickupSlots(); };
    el('selectPickupSlotBtn')?.addEventListener('click',    openPickupSlotModal);
    el('selectPickSlotBtn')?.addEventListener('click',      openPickupSlotModal);
    el('confirmPickupSlotBtn')?.addEventListener('click',   confirmPickupSlot);

    // Car
    el('addCarDetailsBtn')?.addEventListener('click',  openCarModal);
    el('selectCarNumberBtn')?.addEventListener('click', openCarModal);
    el('selectCarMobileCta')?.addEventListener('click', openCarModal);
    el('addCarNoBtn')?.addEventListener('click', addCarNo);
    el('carNumberInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCarNo(); });
    el('carNumberInput')?.addEventListener('input', () => { const e = el('carInputError'); if (e) e.hidden = true; });
    el('savedCarsList')?.addEventListener('click', async (e) => {
        const sel = e.target.closest('.co-car-item__select');
        if (sel) await selectCarNo(sel.dataset.car);
    });

    // Dine-in table
    const openDineInModal = () => { openModal('dineinmodal'); setupDineInMobileOptions(); };
    el('changTableBtn')?.addEventListener('click',  openDineInModal);
    el('selectTableBtn')?.addEventListener('click', openDineInModal);
    el('selectTableMobileCta')?.addEventListener('click', openDineInModal);
    el('saveTableBtn')?.addEventListener('click', saveTableNumber);
    el('skipTableBtn')?.addEventListener('click', skipTableNumber);
    el('tableNumberInput')?.addEventListener('input', () => { const e = el('tableInputError'); if (e) e.hidden = true; });
    el('tableNumberInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveTableNumber(); });

    // Mobile-only QR scan flow for dine-in. CI3 ref: ue_silver/js/checkout.js
    // setupMobileQROption + startQRScanner + verifyTableFromQR (~L5234, 6641, 6860).
    el('dineScanQrBtn')?.addEventListener('click', openQrScanner);
    el('dineEnterManualBtn')?.addEventListener('click', () => {
        hide('dineMobileOptions');
        show('dineManualEntry');
        el('tableNumberInput')?.focus();
    });
    // Release the camera when the scanner modal closes (✕ or backdrop click).
    el('scanQrVideoModal')?.addEventListener('click', (e) => {
        if (e.target.closest('.popup-close') || e.target.classList.contains('popup-overlay')) {
            stopQrScanner();
        }
    });

    // Gift
    el('showGiftModalBtn')?.addEventListener('click',   openGiftModal);
    el('saveGiftDetailsBtn')?.addEventListener('click', saveGiftDetails);
    el('removeGiftDetailsBtn')?.addEventListener('click', removeGiftDetails);
    el('removeGiftModalBtn')?.addEventListener('click',  removeGiftDetails);
    el('giftChangeAddressBtn')?.addEventListener('click', () => { closeModal('sendAsGiftModal'); openModal('selectAddressModal'); loadAddresses(); });

    // Promo
    el('applyPromoBtn')?.addEventListener('click', applyPromo);
    el('applyPromoBtnModal')?.addEventListener('click', applyPromo);
    el('removePromoBtn')?.addEventListener('click', removePromo);
    el('viewMoreOffersBtn')?.addEventListener('click', () => { renderPromoList(); openModal('promo'); });
    el('viewMoreMembershipBtn')?.addEventListener('click', () => openModal('membershipPromoModal'));
    el('promoInput')?.addEventListener('keydown',      (e) => { if (e.key === 'Enter') applyPromo(); });
    el('promoInputModal')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPromo(); });
    el('applyMembershipPromoBtnModal')?.addEventListener('click', applyPromo);
    el('membershipPromoInputModal')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPromo(); });

    // Membership promo (parallel section above Savings Corner) — suggestion-only.
    el('removeMembershipPromoBtn')?.addEventListener('click', removePromo);

    // Wallet
    el('applyWalletBtn')?.addEventListener('click', toggleWallet);

    // Special instructions — per-brand localStorage, focus-driven Save/Remove visibility.
    // Matches CI3 SpecialInstructionsManager (checkout.js:260-372).
    bindSpecialInstructions();

    // GST tooltip — desktop shows on hover via #gstTr:hover CSS; this click handler
    // only kicks in for touch devices where :hover isn't reliable. Toggling a class
    // (not the `hidden` attribute) so CSS hover still works after a tap dismisses it.
    el('gstInfoBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        el('gstTip')?.classList.toggle('co-bill__gst-tip--open');
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#gstTr')) el('gstTip')?.classList.remove('co-bill__gst-tip--open');
    });

    // Order type toggle buttons → inline dropdown
    el('orderTypeToggleBtn')?.addEventListener('click',        (e) => { e.stopPropagation(); toggleOtsDropdown('coOtsMobile'); });
    el('orderTypeToggleBtnDesktop')?.addEventListener('click', (e) => { e.stopPropagation(); toggleOtsDropdown('coOtsDesktop'); });

    // Cart updates from other modules
    window.addEventListener('cart:updated', () => {
        renderCartItems();
        loadCartSummary();
    });
}

// ─── Place order ──────────────────────────────────────────────

// Standard "Pay Securely" — initiate + let the user pick any method on the payment screen.
function handlePlaceOrder() { return runCheckout({ btn: el('payBTN') }); }

// Fast checkout "Pay Securely" — initiate then auto-charge the saved last UPI method
// (VPA collect) on the payment screen, skipping the picker. Falls back to the standard
// flow if the last method is somehow gone by click time.
function handleFastCheckout() {
    const lp = state.lastPaymentMethod;
    if (!lp) return handlePlaceOrder();
    return runCheckout({ btn: el('fastPaySecureBtn'), fastUpi: lp });
}

// Fast-checkout confirmation (app's Order Summary sheet). Both footer buttons open it.
// A progress bar fills the primary button over CONFIRM_REDIRECT_MS (mirrors the location
// modal's Zomato-style auto-redirect: doing nothing proceeds along the button's own path).
// Behaviour (per product spec):
//   • Fast mode ("Pay Securely") → button "Pay with {app}"; tap OR auto → Google Pay
//     (last UPI method, VPA collect).
//   • Change mode                → button "Continue to Payment Options"; tap OR auto →
//     full payment screen (method picker).
//   • Cancel (text link)         → stop the timer, close, stay on cart.
// The button label matches BOTH the tap and the auto outcome, so it can't mislead.
const CONFIRM_REDIRECT_MS = 3000;
let _confirmMode  = null;    // 'fast' | 'change'
let _confirmTimer = null;

function openConfirmOrderModal(mode) {
    _confirmMode = mode;
    const order = state.order || {};
    const ot    = cfg.orderType || 'delivery';
    const otLabel = { delivery: 'Delivery', pickup: 'Pickup', dine_in: 'Dine-in', in_car: 'In-car' }[ot] || 'Delivery';
    set('confirmOrderType', otLabel);

    // Location row: delivery → the selected address; otherwise the outlet.
    const addrRow = el('confirmAddrRow');
    if (ot === 'delivery') {
        set('confirmAddrLabel', 'Delivery Address');
        set('confirmAddrValue', state.selectedAddressText || state.selectedAddressName || '—');
    } else {
        set('confirmAddrLabel', ot === 'pickup' ? 'Pickup from' : otLabel === 'Dine-in' ? 'Dine-in at' : otLabel);
        set('confirmAddrValue', (cfg.bName || '') + (cfg.locality ? ', ' + cfg.locality : ''));
    }
    if (addrRow) addrRow.hidden = false;

    set('confirmTotal', fmt(Number(order.totalAmt ?? 0)));
    // Label matches the outcome (tap AND auto): fast → pay with the saved app; change → picker.
    set('confirmOrderProceedLabel',
        mode === 'fast' ? `Pay with ${state.lastPaymentMethod?.name || 'UPI'}` : 'Continue to Payment Options');
    openModal('confirmOrderModal');
    startConfirmCountdown();
}

// Animate the fill 0→100% over CONFIRM_REDIRECT_MS; on completion, auto-proceed along the
// current mode's path (fast → Google Pay, change → picker) — the "do nothing" default.
// Guarded so a modal closed by ✕ / overlay / Escape (which route through closeAllModals)
// cancels the pending navigation.
function startConfirmCountdown() {
    stopConfirmCountdown();
    const fill = el('confirmOrderFill');
    if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth;                 // reflow so the next change animates
        fill.style.transition = `width ${CONFIRM_REDIRECT_MS}ms linear`;
        fill.style.width = '100%';
    }
    _confirmTimer = setTimeout(() => {
        _confirmTimer = null;
        if (el('confirmOrderModal')?.hidden) return;   // closed meanwhile → abort
        proceedFromConfirm();
    }, CONFIRM_REDIRECT_MS);
}

function stopConfirmCountdown() {
    if (_confirmTimer) { clearTimeout(_confirmTimer); _confirmTimer = null; }
    const fill = el('confirmOrderFill');
    if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
}

// Route by mode only — tap and auto lead to the same place (matching the button label).
function proceedFromConfirm() {
    stopConfirmCountdown();
    closeModal('confirmOrderModal');
    if (_confirmMode === 'fast') handleFastCheckout();   // → Google Pay (VPA collect)
    else                         handlePlaceOrder();     // → full payment screen
}

function onConfirmOrderProceed() { proceedFromConfirm(); }
function onConfirmOrderCancel()  { stopConfirmCountdown(); closeModal('confirmOrderModal'); }

// Shared initiate pipeline. `fastUpi` (a { vpa, name } descriptor) routes to the
// payment screen with an auto-run VPA-collect flag instead of showing the picker.
async function runCheckout({ btn, fastUpi = null }) {
    if (!btn || btn.disabled) return;

    // Belt-and-suspenders: updatePayCta already hides Pay when a line is OOS/invalid,
    // but never let an order through if an unavailable line is still in the cart.
    if ((state.validation && Number(state.validation.status) === 0) || anyLineUnavailable()) {
        showError('Some items are out of stock. Please remove them to continue.');
        updatePayCta(state.order);
        return;
    }

    // Name mandatory on the cart screen (CI3 validateUserProfile parity). A logged-in
    // user must have a name on record before placing the order. When it's still missing,
    // force the welcome form (bypassing its post-login one-shot, which stops it reopening
    // after a refresh) and abort this tap — the user re-taps Pay once the name is saved.
    const nameUd = userData();
    if (nameUd.token && nameMissing(nameUd.name)) {
        // The welcome form itself carries the "add your name to place your order" copy
        // (firstLoginProfile.js force-open), so no separate pay-alert toast is needed.
        // Flag the order as pending so the 'profile:completed' listener resumes it
        // automatically once the name is saved — no second Pay tap needed.
        state.pendingPlaceOrder = true;
        if (typeof window.openProfilePrompt === 'function') window.openProfilePrompt(true);
        return;
    }

    // A later-slot whose window elapsed while the tab sat open (restoreSlotSelection only
    // runs on load) must not reach payment. Clear it and re-render the CTA so the "Select
    // slot" gate re-fires — the user picks a fresh, still-valid window.
    const laterSlot = state.selectedSlot !== null && Number(state.selectedSlot) !== 0;
    if (laterSlot && slotWindowPast(state.selectedSlotDate, state.selectedSlotStartH, state.selectedSlotEndH)) {
        showError('Your selected slot has passed. Please choose a new delivery time.');
        state.selectedSlot = null;
        state.selectedSlotText = '';
        state.slotExpired = true;   // don't let a recalc silently default to Deliver Now
        ['slot_id','slot_date','slot_label','slot_startH','slot_endH'].forEach(k => localStorage.removeItem(k));
        updatePayCta(state.order);
        return;
    }

    // Same story for "Deliver Now" (slot 0): the outlet's actual closing time minus the
    // 30-minute prep buffer can pass while the tab sits open, and neither cfg.outlet_open
    // (online-ordering window, usually 00:00–23:59) nor a stale deliver_now_option catches
    // it. Last gate before payment so an immediate order never reaches a closed kitchen.
    if (isStaleNowSlot(state.order)) {
        showError(nowClosedMsg());
        clearStaleNowSlot();
        updatePayCta(state.order);
        return;
    }

    const origHtml = btn.innerHTML;
    btn.disabled   = true;
    btn.textContent = 'Processing…';

    const reEnable = () => { btn.disabled = false; btn.innerHTML = origHtml; };

    try {
        const ud  = userData();
        const ot  = cfg.orderType || 'delivery';
        const otn = OT_NUM[ot] || 1;

        // CI3 /pay/initiate contract. /client/cart returns the order with
        // `o.id AS orderId` and `b.id AS businessId` — use those directly so
        // the validateOrder query (businessId + orderId + contactMappingId)
        // can find the row. Form-encoded because CI3 reads via input->get_post().
        const orderId  = state.order?.orderId    ?? '';
        const orderBiz = state.order?.businessId ?? cfg.businessId;
        if (!orderId) {
            showError('Cart not ready yet — please wait a moment and try again.');
            reEnable();
            return;
        }

        trackAddPaymentInfo({ value: analyticsTotal(), items: analyticsItems(), deliveryType: ot });

        const body = {
            businessId:          orderBiz,
            userId:              ud.contactId       || '',
            token:               ud.token           || '',
            mode:                'native',
            contactMappingId:    ud.contactMappingId || '',
            orderId,
            orderType:           otn,
            deliveryAddressId:   ot === 'delivery' ? (state.selectedAddressId || '') : '',
            // Server-resolved name first — same reasoning as runningTabNo().
            tableNo:             ot === 'dine_in'  ? (cfg.tableName || state.selectedTableName || '') : '',
            tableId:             ot === 'dine_in'  ? (cfg.tableId   || state.selectedTableId   || 0) : 0,
            comments:            el('remarks')?.value?.trim() || '',
            marketing_consent:   el('subscribeNewsletter')?.checked ? 1 : 0,
            promoCode:           state.appliedPromo || '',
            applyWallet:         state.walletApplied ? 1 : 0,
        };

        if (ot === 'delivery' && state.selectedSlot) {
            const iso = slotSelectedIso();
            if (iso) body.selected_slot = iso;
        }
        if (ot === 'in_car')                          body.carNumber     = state.carNumber;
        if (state.giftDetails) {
            body.giftName    = state.giftDetails.name;
            body.giftMobile  = state.giftDetails.mobile;
            body.giftSender  = state.giftDetails.sender;
            body.giftMessage = state.giftDetails.message;
        }

        // /pay/initiate/json — GET with all params in the query string. The API
        // wants the field order from its reference URL, including `mode=native`
        // (payment type) at the start and `mode=json` (response format) at the end.
        const qs = new URLSearchParams();
        qs.append('userId',            String(body.userId));
        qs.append('businessId',        String(body.businessId));
        qs.append('token',             String(body.token));
        qs.append('mode',              'native');
        qs.append('contactMappingId',  String(body.contactMappingId));
        qs.append('orderId',           String(body.orderId));
        qs.append('deliveryAddressId', body.deliveryAddressId === '' ? 'null' : String(body.deliveryAddressId));
        qs.append('comments',          String(body.comments));
        qs.append('orderType',         String(body.orderType));
        // Optional extras (only sent when present)
        if (body.tableNo)             qs.append('tableNo',           String(body.tableNo));
        if (body.tableId)             qs.append('tableId',           String(body.tableId));
        if (body.selected_slot)       qs.append('selected_slot',     String(body.selected_slot));
        if (body.carNumber)           qs.append('carNumber',         String(body.carNumber));
        if (body.promoCode)           qs.append('promoCode',         String(body.promoCode));
        if (body.applyWallet)         qs.append('applyWallet',       String(body.applyWallet));
        if (body.marketing_consent)   qs.append('marketing_consent', String(body.marketing_consent));
        if (body.giftName)            qs.append('giftName',          String(body.giftName));
        if (body.giftMobile)          qs.append('giftMobile',        String(body.giftMobile));
        if (body.giftSender)          qs.append('giftSender',        String(body.giftSender));
        if (body.giftMessage)         qs.append('giftMessage',       String(body.giftMessage));
        // Web-origin context for the payment gateway (callback theming + source tracking)
        qs.append('origin',            'web');
        qs.append('origin_url',        window.location.origin);
        qs.append('brand_color',       String(window.AppConfig?.brandColor || ''));
        // Tags the order as WhatsApp-originated (os=waba) so whatsapp_ordering's
        // post-payment confirmation/track-link fires — same signal header.php/
        // footer.php already use to detect a WhatsApp-nonce-authenticated session.
        if (cfg.entryChannel === 'whatsapp') qs.append('os', 'waba');
        qs.append('mode',              'json');

        // 2.0 endpoint (matches the mobile app). The legacy /pay/initiate/json re-prices the
        // order and re-applies the combo double-count; /pay/initiate/2.0/json is combo-aware,
        // so the payment total matches the (correct) stored cart subtotal.
        const url = `${getApiBase()}/pay/initiate/2.0/json?${qs}`;
        const res = await fetch(url, {
            method:  'GET',
            headers: { 'Accept': 'application/json' },
        });

        const data = await res.json().catch(() => null);
        if (!data) {
            showError('Payment service returned an invalid response.');
            reEnable();
            return;
        }
        if (data.status !== 1) {
            showError(data.msg || 'Payment initiation failed');
            // Bridge, not the import — trackPaymentFailed is a new export and this module's
            // `import './analytics.js'` is unversioned against a 30-day CDN cache. See analytics.js.
            window.Analytics?.trackPaymentFailed?.({
                value: analyticsTotal(),
                reason: 'initiation_failed',
                orderId: state.order?.orderId,
            });
            reEnable();
            return;
        }

        // Persist the outlet businessId for the post-payment polling page BEFORE we
        // hand off to any gateway. getOrderStatus matches on the order's OUTLET
        // businessId, which order_polling.js reads from paymentContext. The Razorpay
        // Standard Checkout (payment_gateway_direct) and hosted-redirect paths below
        // both `return` before the screen-path stash, so without this the polling page
        // would send an empty businessId, never detect status=1, and time out into a
        // false "We couldn't place your order!" — even though the order succeeded.
        // sessionStorage survives the gateway redirect (same tab/origin); the screen
        // path re-writes this with the full context a few lines down.
        sessionStorage.setItem('paymentContext', JSON.stringify({ orderId, businessId: orderBiz }));

        // Loyalty figures for the confirmation page's celebration, handed over here
        // because only this page can know them. The order carries no item-wise earn —
        // addo_orders.cashbackvalue belongs to the flat cashback programme and reads 0
        // for every item-wise brand — and no balance at all, so the confirmation page
        // has nothing server-side to state. computeEarn() and the catalog balance are
        // already on screen at this moment; stashing them costs one write and spares
        // the receipt a CRM round-trip.
        //
        // Its OWN key, not paymentContext: that object is cleared on some paths and
        // rewritten on others, and this must outlive both. Keyed by orderId so a second
        // order in the same tab cannot read the first one's figures.
        //
        // sessionStorage, so it dies with the tab — the modal fires once, in this tab,
        // moments from now. A later visit from order history finds nothing and falls
        // back to what the server can prove (see order_confirmation.php).
        try {
            sessionStorage.setItem('oc_pts_' + orderId, JSON.stringify({
                earn:    computeEarn(),
                balance: catalogBalance(),
                unit:    ptsUnit(),
            }));
        } catch { /* private window — the page degrades to the server-known figures */ }

        // Freeze UTM attribution at order creation — BEFORE any gateway redirect, while the
        // first-party utm_data cookie is fresh + same-origin. The server stashes it keyed by
        // orderId (order_utm_pending) and promotes it to order_utm_source_mapping_sess only once
        // the order is paid. This keeps attribution correct even when payment completes later from
        // a direct session, and survives gateway round-trips that would otherwise drop the cookie.
        try { navigator.sendBeacon(`/attribution/stage?orderId=${encodeURIComponent(orderId)}`); } catch (_) { /* best-effort */ }

        // Fast checkout ALWAYS routes to the payment screen (never the Standard Checkout
        // overlay): VPA collect needs the custom createPayment flow, which the screen
        // drives via the auto-run flag below. Skip the payment_gateway_direct/redirect
        // early-returns that the standard flow uses.
        if (!fastUpi) {
            if (data.payment_gateway_direct === 1) {
                await openRazorpayCheckout(data, reEnable);
                return;  // Razorpay's redirect:true takes over from here
            }
            if (data.redirect) {
                window.location.href = data.redirect;
                return;
            }
        }

        // Screen path: stash the API context so the payment page can hydrate
        // without re-fetching, then navigate to the CI4 payment screen.
        sessionStorage.setItem('paymentContext', JSON.stringify({
            ...data,
            orderId,
            businessId: orderBiz,
            orderType:  otn,
            // Carried through to payment_screen.js's processPayment() so its /pay/process
            // call (the actual COD/charge completion — see os=waba there) can tell
            // whatsapp_ordering this order's customer arrived via WhatsApp. cfg.entryChannel
            // comes from CheckoutController.php's entry_channel cookie passthrough.
            entryChannel: cfg.entryChannel || null,
            // Fulfilment timing shown on the payment screen next to the address —
            // the exact text from the slot selector: a "Later" window
            // ("Today, 3:00 PM - 4:30 PM") or the immediate ETA
            // ("Deliver Now (1 hrs 30 mins)", or a bare "Pick up Now" — pickup quotes
            // no ETA, see nowOptionLabel). Only delivery & pickup carry a slot;
            // dine-in / in-car leave it empty.
            slotLabel: (ot === 'delivery' || ot === 'pickup')
                ? (state.selectedSlotText || '')
                : '',
            // Fast checkout: the payment screen auto-charges this VPA (category 5).
            // On mobile, autoUpiIntentApp triggers UPI-intent (opens the app directly);
            // on desktop it falls back to VPA collect (sends a collect to the VPA).
            ...(fastUpi ? {
                autoUpiVpa:       fastUpi.vpa,
                autoUpiApp:       fastUpi.name,
                autoUpiIntentApp: VPA_INTENT_MAP[String(fastUpi.vpa || '').split('@')[1]?.toLowerCase() || ''] || null,
            } : {}),
        }));
        window.location.href = `/payments-page?orderId=${orderId}`;
    } catch (err) {
        console.error('[checkout] Place order failed:', err);
        showError('Something went wrong. Please try again.');
        reEnable();
    }
}

// Auto-init
if (document.querySelector('[data-page="checkout"]')) {
    init();
}

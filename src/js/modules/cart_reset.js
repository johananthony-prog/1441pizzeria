/**
 * cart_reset.js — clear the local cart + chosen-slot keys once an order is placed.
 *
 * Lives in its own module rather than config.js on purpose. base.php cache-busts only the
 * ENTRY module (`payment_screen.js?v=<filemtime>`); nested imports are bare specifiers, and
 * nginx serves /src/js with `Cache-Control: max-age=2592000` (30 days). So a deploy that adds
 * a new export to config.js pairs a freshly-fetched entry module with a month-old cached
 * config.js for every returning visitor — the import then throws
 * "does not provide an export named 'clearOrderedCart'" and kills the whole payment screen.
 * A new file is a new URL that cannot be in anyone's cache, so it is safe on first deploy.
 * Keep this module's exports stable; adding one later reintroduces the same hazard.
 */

// The chosen-later-slot localStorage keys, in one place. menu.js clearStoredSlot() and the
// inline copies in checkout.js / location_picker.js remove the same set — import this to avoid
// a new key (e.g. slot_timezone) being added in one spot and silently missed in the others.
export const SLOT_KEYS = ['slot_id', 'slot_date', 'slot_label', 'slot_startH', 'slot_endH'];

/**
 * Reset the local food-ordering cart once an order is confirmed placed.
 *
 * CI3's cart is server-authoritative — placing an order flips it to status=1, so the
 * next visit naturally starts a fresh cart and there was no local cart to clear. CI4
 * keeps a persistent localStorage cart (`v4_cart`, written by menu.js) plus the chosen
 * later-slot keys. If these survive a placed order, the NEXT checkout reuses the stale
 * items AND restoreSlotSelection() re-adopts the previous order's slot client-side
 * WITHOUT re-persisting it via /client/setSlot. That silently bypasses the
 * mandatory-slot Pay gate, so the second order is placed against a server cart that
 * never had a slot — and on deliver_now_option=0 brands the backend then null-outs
 * slotId/slotDate/slotTimig. Clearing at every "order placed" moment fixes both the
 * "cart not resetting" and "2nd order loses its slot" symptoms.
 *
 * Called on payment success (order_polling.js) and on COD/wallet completion
 * (payment_screen.js). Safe to call for pack/uMoney flows — they don't use these keys.
 */
export function clearOrderedCart() {
    try {
        localStorage.removeItem('v4_cart');
        SLOT_KEYS.forEach(k => localStorage.removeItem(k));
    } catch { /* storage unavailable — nothing to clear */ }
}

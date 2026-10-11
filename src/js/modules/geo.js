/**
 * Browser geolocation, wrapped once.
 *
 * getCurrentPosition's callback API makes every call site hand-roll the same
 * Promise, and the option triple that decides fix quality then lives in as many
 * places as there are callers. This is that triple's home.
 *
 * Resolves `{ ok: true, lat, lng }` or `{ ok: false }` — never rejects. Callers
 * decide what a missing fix means; the Geolocation API cannot distinguish a
 * denial from a timeout or an unavailable position in any useful way, so there
 * is nothing worth surfacing beyond "no fix".
 *
 * Defaults (CI3 parity — ue_silver/js/checkout.js LocationManager ~L12587):
 *   enableHighAccuracy  a street-level fix, not a cell-tower guess: callers use
 *                       this to answer "is the customer AT this address / outlet".
 *   timeout 10000       past ~10s a customer assumes the page is broken.
 *   maximumAge 0        never a cached fix. A stored position may predate a
 *                       drive, and a position the customer has moved away from
 *                       is worse than none.
 *
 * Pass `options` only with a reason to differ (e.g. a coarse "sort outlets by
 * distance" fix, where a cached position is fine and speed matters more).
 */
export function requestGeolocation(options) {
    const opts = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0, ...(options || {}) };
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve({ ok: false }); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude }),
            ()    => resolve({ ok: false }),
            opts,
        );
    });
}

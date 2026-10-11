/**
 * auth-storage.js — shared login/logout storage writes, used across several
 * independent modules that each end or begin an authenticated session
 * (wa_login_return.js, wa_order_login_return.js, userProfile.js, membership.js,
 * activeOrders.js). Previously duplicated identically in each — one file
 * getting a key added or removed without the others keeping in sync.
 */

/**
 * Persist a userdata payload as an authenticated session, exactly like a normal
 * OTP login would. `justLoggedIn` is read by firstLoginProfile.js (the welcome /
 * name-capture form); `pending_login_method` is read by base.php's deferred
 * analytics block (trackLogin/trackRegistration/identifyUser).
 * @param {object} rows - userdata object; must have a `token`.
 */
export function commitAuthToStorage(rows) {
    localStorage.setItem('userdata', JSON.stringify(rows));
    localStorage.setItem('token', rows.token);
    try { localStorage.setItem('justLoggedIn', '1'); } catch { /* ignore */ }
    try { localStorage.setItem('pending_login_method', 'whatsapp'); } catch { /* ignore */ }
}

/**
 * Clear the entry_channel cookie (set by WhatsappOrderAuthFilter on a
 * successful `wo` nonce redeem — see wa_entry_channel() in wla_helper.php for
 * why it's a plain cookie, not session data). Call this everywhere a session
 * ends — a real logout or an automatic force-logout on a dead token — so a
 * WhatsApp-entry session never leaks into whatever happens next in that
 * browser (nav-hiding, os=waba order tagging, the confirm/order/status call).
 */
export function clearEntryChannel() {
    document.cookie = 'entry_channel=; Max-Age=0; path=/';
}

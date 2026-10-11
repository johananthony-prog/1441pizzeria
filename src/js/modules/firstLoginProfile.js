'use strict';

import { getApiBase, getBusinessId } from './config.js';
import { trackProfileUpdated, identifyUser } from './analytics.js?v=20260829';

// First-time-login profile prompt (welcome form). Mirrors CI3's #updateProfileModal_new.
//
// Behaviour (feedback #239):
//  - Appears immediately after login (any method) when the user's first name is still
//    missing (empty / null / placeholder "user").
//  - MANDATORY: non-skippable and non-cancellable. The skip button is hidden, and
//    backdrop clicks / Escape are swallowed (capture-phase guards) so no page-level
//    handler can dismiss it. The only way out is to submit a valid name.
//  - Exposed as window.openProfilePrompt() so _completeLogin can open it inline on
//    pages that don't reload after login. The form is wired once on load.
//  - Save reuses the legacy contract (api.uengage.in/client/updateProfile).
(function () {
    var FLAG_LOGIN = 'justLoggedIn';    // set by _completeLogin (all login methods)
    var FLAG_OTP   = 'otpJustLoggedIn'; // legacy OTP one-shot — read for back-compat, then cleared
    var FLAG_SHOWN = 'userProfile';     // CI3 parity: persistent one-shot — set on open, never re-show

    var overlay = document.getElementById('profilePromptModal');
    if (!overlay) return; // markup only present in the base layout

    function currentUser() {
        try { return JSON.parse(localStorage.getItem('userdata') || '{}') || {}; }
        catch (e) { return {}; }
    }
    function nameMissing(u) {
        var n = String((u || {}).name || '').trim().toLowerCase();
        return n === '' || n === 'user';
    }
    function close() {
        overlay.setAttribute('hidden', '');
        overlay.setAttribute('aria-hidden', 'true');
    }
    function setCopy(copy) {
        var title = document.getElementById('fpTitle');
        var sub   = document.getElementById('fpSubtitle');
        var pill  = document.getElementById('fpPill');
        if (title) title.textContent = copy.title;
        if (sub)   sub.textContent   = copy.subtitle;
        // Pill only shows in the mandatory checkout context ("Last step").
        if (pill) {
            if (copy.pill) { pill.textContent = copy.pill; pill.hidden = false; }
            else           { pill.hidden = true; }
        }
    }
    // Update the submit label without wiping the trailing arrow SVG.
    function setSubmitLabel(text) {
        var lbl = document.getElementById('fpSubmitLabel');
        if (lbl) lbl.textContent = text;
    }

    // Open the welcome form (always mandatory — see the non-cancellable guards below).
    // Pass force=true to bypass the post-login one-shot below: the checkout name gate
    // uses this to re-prompt after a refresh, since the name is mandatory to place an order.
    function open(force) {
        var u = currentUser();
        if (!u || !u.token) return;   // logged-in users only
        if (!nameMissing(u)) return;  // already has a name — nothing to ask
        // CI3 one-shot (localStorage.userProfile): shown once, don't nag again on refresh.
        // A forced caller (checkout) skips this so a name-less user can't slip past pay.
        if (!force) {
            try { if (localStorage.getItem(FLAG_SHOWN) === 'true') return; } catch (e) {}
        }

        // Context-aware copy: the post-login prompt is a friendly "Welcome"; when forced
        // from the cart screen it reads as a required last step so the ask feels purposeful.
        setCopy(force
            ? { title: 'Almost there', subtitle: "Tell us who's ordering so we can personalise it.", pill: 'Last step' }
            : { title: 'Welcome',      subtitle: 'Help us know you better!' });

        // Prefill email if the backend already had one (CI3 prefilled #uEmail).
        if (u.email) {
            var preEmail = document.getElementById('fpEmail');
            if (preEmail && !preEmail.value) preEmail.value = u.email;
        }
        wireDates();
        // Referral reveal: new users only (CI3: undefined newUser still shows).
        setupReferral(Number(u.newUser) !== 0);

        overlay.removeAttribute('hidden');
        overlay.setAttribute('aria-hidden', 'false'); // modal-lock.js handles scroll-lock
        try { localStorage.setItem(FLAG_SHOWN, 'true'); } catch (e) {} // CI3 one-shot: mark as shown
    }
    window.openProfilePrompt = open;

    // Non-cancellable (feedback #239): there is no skip. Hide the close/skip button
    // and bind no dismiss handler.
    overlay.querySelectorAll('.js-fp-close').forEach(function (b) {
        b.hidden = true;
        b.style.display = 'none';
    });

    // Swallow backdrop clicks and Escape while the form is open, so no page-level
    // handler (e.g. checkout's closeAllModals on backdrop/Escape) can dismiss it.
    // Capture phase = we intercept before those delegated document listeners run.
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { e.stopPropagation(); e.preventDefault(); } // backdrop tap
    }, true);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);

    // Prefill the referral code from ?refer= (referral-link arrivals) and reveal
    // the field when allowed. Mirrors ue_silver's .referCodeInput show/hide + prefill.
    function setupReferral(show) {
        var input = document.getElementById('fpReferral');
        if (!input) return;
        try {
            var ref = new URLSearchParams(location.search).get('refer');
            if (ref) input.value = ref;
        } catch (e) {}
        if (show) {
            var wrap = document.getElementById('fpReferralWrap');
            if (wrap) wrap.removeAttribute('hidden');
        }
    }

    // Restrict DOB/Anniversary to today-or-earlier and make the calendar icon (and
    // the field itself) open the native picker. Mirrors userProfile.js.
    function wireDates() {
        var today = new Date().toISOString().split('T')[0];
        document.querySelectorAll('#profilePromptModal .pf-pi-date-wrap').forEach(function (wrap) {
            var input = wrap.querySelector('input[type="date"]');
            var icon  = wrap.querySelector('.pf-pi-date-icon');
            if (!input) return;
            input.max = today;
            var openPicker = function () { try { input.showPicker(); } catch (e) { input.focus(); } };
            input.addEventListener('click', openPicker); // clicking the field opens the picker
            if (icon) {
                icon.style.pointerEvents = 'auto';
                icon.style.cursor = 'pointer';
                icon.addEventListener('click', openPicker);
            }
        });
    }

    // ── Submit (wired once) ──────────────────────────────────
    var form = document.getElementById('fpForm');
    if (form) {
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var u         = currentUser();
            var errEl     = document.getElementById('fpError');
            var submitBtn = document.getElementById('fpSubmit');
            var name = document.getElementById('fpName').value.trim();

            var email  = document.getElementById('fpEmail').value.trim();
            var gender = (document.querySelector('input[name="fpGender"]:checked') || {}).value || '';
            var dob    = (document.getElementById('fpDob')         || {}).value || '';
            var ann    = (document.getElementById('fpAnniversary') || {}).value || '';
            var refer  = (document.getElementById('fpReferral')    || {}).value || '';

            // CI3 validation parity (uProfileUpdate): name required, email format if provided.
            errEl.hidden = true;
            if (!name) {
                errEl.textContent = 'Please enter your full name.';
                errEl.hidden = false;
                return;
            }
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errEl.textContent = 'Please enter a valid email address.';
                errEl.hidden = false;
                return;
            }

            submitBtn.disabled = true;
            setSubmitLabel('Saving…');

            // Same legacy contract as userProfile.js: auth params in the query string,
            // profile fields form-encoded. Endpoint: api.uengage.in/client/updateProfile.
            var qs = new URLSearchParams({
                contactId:        String(u.contactId        || ''),
                contactMappingId: String(u.contactMappingId || ''),
                businessId:       String(getBusinessId() ?? ''),
                token:            String(u.token            || ''),
            }).toString();

            var body = new URLSearchParams();
            body.set('name',        name);
            body.set('email',       email);
            body.set('gender',      gender);
            body.set('dob',         dob);
            body.set('anniversary', ann);
            body.set('married',     ann ? '1' : '');
            // ue_silver parity: only send referralcode when the user actually entered one.
            if (refer.trim() !== '') body.set('referralcode', refer.trim());

            fetch(getApiBase() + '/client/updateProfile?' + qs, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    body.toString(),
            })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.status === 1 || d.status === '1') {
                    u.name  = name;
                    u.email = email;
                    if (gender) u.gender      = gender;
                    if (dob)    u.dob          = dob;
                    if (ann)    u.anniversary  = ann;
                    try { localStorage.setItem('userdata', JSON.stringify(u)); } catch (e) {}

                    trackProfileUpdated({
                        mobile: u.mobile || u.mobileNo || '', email: email,
                        name: name, dob: dob, anniversary: ann,
                    });
                    identifyUser({
                        mobile: u.mobile || u.mobileNo || '', email: email, name: name,
                        dob: dob, gender: gender, anniversary: ann,
                    });

                    document.querySelectorAll('.user-name-display').forEach(function (el) {
                        el.textContent = 'Profile';
                    });

                    close(); // name captured — release the (otherwise non-cancellable) form

                    // Let waiting flows resume (e.g. checkout's place-order gate continues
                    // to payment automatically — no second "Proceed to Pay" tap needed).
                    try {
                        window.dispatchEvent(new CustomEvent('profile:completed', { detail: { name: name } }));
                    } catch (e) {}
                } else {
                    errEl.textContent = d.msg || 'Update failed. Please try again.';
                    errEl.hidden      = false;
                }
            })
            .catch(function () {
                errEl.textContent = 'Network error. Please try again.';
                errEl.hidden      = false;
            })
            .finally(function () {
                submitBtn.disabled = false;
                setSubmitLabel('Save & Continue');
            });
        });
    }

    // ── Auto-open immediately after login (CI3 parity) ───────
    // CI3 (wla_*.js) opens #updateProfileModal_new only in the login-success callback,
    // never on plain page loads. Mirror that: only attempt to open when a just-logged-in
    // flag is present. The persistent FLAG_SHOWN one-shot guard inside open() then makes
    // it show once and not reappear on refresh.
    var justLoggedIn = false;
    try {
        justLoggedIn = localStorage.getItem(FLAG_LOGIN) === '1'
                    || localStorage.getItem(FLAG_OTP)   === '1';
    } catch (e) {}
    try { localStorage.removeItem(FLAG_LOGIN); } catch (e) {}
    try { localStorage.removeItem(FLAG_OTP);   } catch (e) {}
    if (justLoggedIn) open();
})();

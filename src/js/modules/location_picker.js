'use strict';

/**
 * Location picker — 7-step modal mirrored from CI3 wla_home_20260507.js.
 * All API calls go to AppConfig.apiBase (https://api.uengage.in).
 * Loaded on every page from base.php; auto-opens when AppConfig.autoOpenLocationModal=1
 * AND localStorage has no userLat/userLng. Header pill is wired site-wide.
 *
 * Globals exposed (matching CI3 names referenced from modal markup):
 *   closeLocationFlow, CurrentAddress, showLocationStep,
 *   enterAddressSearchLocality, homeSearchLocality,
 *   openHomeAddressForm, homeAddrGoToCurrentLocation,
 *   confirmLocationAndShowForm, saveHomeAddress,
 *   selectOrderTypeAndRedirect, openLoginOrSavedAddresses, changeUserLocation
 */
(function () {
    var AppConfig = window.AppConfig || {};
    var API_BASE  = (AppConfig.apiBase || '').replace(/\/$/, '');
    var API_KEY   = AppConfig.staticApiKey || '';
    var pId       = Number(AppConfig.businessId || 0);
    var mapsKey   = AppConfig.mapsKey || '';
    var mapsFlow  = Number(AppConfig.mapsFlow || 0);
    var useGoogle = Boolean(mapsKey) && mapsFlow === 1;

    function apiHeaders(extra) {
        var h = { 'api-key': API_KEY };
        if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
        return h;
    }

    // ─── Reset & expiry ─────────────────────────────────────
    // Every localStorage key the location flow writes — used by logout cleanup and TTL expiry.
    var _LP_LOCATION_KEYS = [
        'userLat', 'userLng', 'userAddress', 'userAddressLabel', 'userLocSource',
        'slug', 'business', 'locality', 'city', 'orderType',
        'deliveryAddressId', 'selectedDeliveryAddressId', 'selectedAddressId',
        'formatted_Address', 'locationSelectedAt',
        // Pre-booking: outlet name cache + chosen slot — clear on logout/TTL too.
        'pbkOutletName', 'pbkOutletId',
        'slot_id', 'slot_date', 'slot_label', 'slot_startH', 'slot_endH'
    ];
    var _LP_TTL_MS = 60 * 60 * 1000; // 60 minutes — re-prompt for location after this

    // Public reset hook — logout handlers (profile_sidebar.js, userProfile.js) call this.
    window.resetLocationJourney = function () {
        _LP_LOCATION_KEYS.forEach(function (k) { localStorage.removeItem(k); });
        // Also clear per-user cart/order/address caches that must not survive logout:
        // packs (pkgCartMeta/pkgOrderId), subscriptions (subCartMeta/subOrderId), and the
        // checkout-address cache co_addr_{pId}_{contactId} (dynamic key → prefix scan).
        ['pkgCartMeta', 'pkgOrderId', 'subCartMeta', 'subOrderId'].forEach(function (k) { localStorage.removeItem(k); });
        try {
            Object.keys(localStorage).forEach(function (k) { if (k.indexOf('co_addr_') === 0) localStorage.removeItem(k); });
        } catch (e) { /* ignore */ }
        // Clear the view_business cookie too — it gates which outlet's menu/cart loads.
        document.cookie = 'view_business=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    };

    // TTL: if the user confirmed an outlet more than 60 mins ago, wipe the journey so the
    // modal re-prompts on the next page. Runs once per page load before maybeAutoOpen().
    (function _checkLocationTtl() {
        var ts = parseInt(localStorage.getItem('locationSelectedAt') || '0', 10);
        if (ts && (Date.now() - ts) > _LP_TTL_MS) window.resetLocationJourney();
    })();

    // ─── Location flow disabled (location_popup_config = 0) ──────────────────
    // Replaces CI3 wla_home_20260608.js isSingleOutlet block.
    // Single outlet → seed slug + navigate directly to /order/{slug}.
    // Multi outlet  → send to /online-order (store locator) to pick first.
    if (!Number(AppConfig.locationPopupConfig)) {
        var isSingle = Number(AppConfig.storesCount) === 1;

        if (isSingle) {
            // Seed the outlet from home page storesDetails into localStorage.
            // OVERWRITE unconditionally: with one outlet there is nothing for the
            // user to choose, so a previously stored slug is a stale cache, not a
            // selection to preserve. Leaving it in place strands the visitor —
            // /order/{unknown-slug} 302s back to home, which reads as "the category
            // click just reloads the page". Renamed outlets and slugs carried over
            // from an earlier config both land here. city/locality are evicted
            // before the conditional writes so an outlet whose city/locality is
            // blank clears the stale values rather than leaving them sitting next
            // to a freshly written slug.
            var _singleOutletSlug = (function _seedDisabledOutlet() {
                var d = window.storesDetails;
                if (!d || !d.length) return '';
                var store = d[0];
                var slug  = store.web_slug || store.slug || '';
                if (!slug) return '';
                localStorage.setItem('slug', slug);
                localStorage.removeItem('city');
                localStorage.removeItem('locality');
                if (store.city)     localStorage.setItem('city',     store.city);
                if (store.locality) localStorage.setItem('locality', store.locality);
                return slug;
            })();

            // Server-rendered slug wins over localStorage for the same reason.
            // Both handlers take the outlet slug as their last argument so neither
            // depends on window.storesDetails being present on the page.
            window.silverCatClick = function (sectionSlug, outletSlug) {
                var slug = outletSlug || _singleOutletSlug || localStorage.getItem('slug') || '';
                if (!slug || slug === 'null') return;
                var url = '/order/' + slug;
                if (sectionSlug) url += '?section_slug=' + encodeURIComponent(sectionSlug);
                window.location.href = url;
            };
            window.silverItemClick = function (sectionSlug, itemSlug, storeCount, outletSlug) {
                var slug = outletSlug || _singleOutletSlug || localStorage.getItem('slug') || '';
                if (!slug || slug === 'null') return;
                var url  = '/order/' + slug;
                var qs   = [];
                if (sectionSlug) qs.push('section_slug=' + encodeURIComponent(sectionSlug));
                if (itemSlug)    qs.push('item_slug='    + encodeURIComponent(itemSlug));
                if (qs.length)   url += '?' + qs.join('&');
                window.location.href = url;
            };
            // The header's "Deliver to" chip calls changeUserLocation(), which is
            // only assigned near the bottom of this module — past the return
            // below. A single-outlet brand therefore had an undefined global and
            // the chip did nothing at all when clicked. There is no journey to
            // open here (no #locationFlowModal is rendered either), and the
            // established behaviour for one outlet is to go straight to its menu,
            // which is exactly what silverCatClick does above.
            window.changeUserLocation = function () {
                var slug = _singleOutletSlug || localStorage.getItem('slug') || '';
                if (!slug || slug === 'null') return;
                window.location.href = '/order/' + slug;
            };

            // The chip reads localStorage on its own (deferred) script run, which
            // can happen before the seeding above. Nudge it so it shows the outlet
            // rather than sitting on "Set location" for a brand where a location
            // cannot be set. No-op when the v2 header is not the one rendered.
            if (typeof window.hdr2RefreshHeader === 'function') window.hdr2RefreshHeader();
        } else {
            // Multi-outlet with flow disabled: send to store locator to pick an outlet.
            window.silverCatClick  = function () { window.location.href = '/online-order'; };
            window.silverItemClick = function () { window.location.href = '/online-order'; };
            window.changeUserLocation = function () { window.location.href = '/online-order'; };
        }
        return; // no modal, no info bar — nothing else to initialise
    }

    var modalEl = document.getElementById('locationFlowModal');
    if (!modalEl) return;

    var state = {
        lat: null, lng: null,
        address: '', locality: '', city: '', stateName: '', pinCode: '',
        nearest: [], currentStep: 'location', pendingAddr: null,
        // Promise for an in-flight add/update-address POST. selectOrderTypeAndRedirect awaits
        // it (bounded) so the freshly-created deliveryAddressId is committed before redirect.
        savePromise: null
    };
    window._lpPrevStep = 'location';

    function userData() {
        try { return JSON.parse(localStorage.getItem('userdata') || '{}') || {}; } catch (e) { return {}; }
    }

    // Write the canonical delivery-address selection the checkout page reads
    // (checkout.js: co_addr_{parentId}_{contactId} → {id,text,name}). pId here is
    // the parent id, the same brand scope checkout uses, so the address chosen in
    // this flow is restored on checkout without asking the user to pick again.
    function persistCheckoutAddress(id, text, name) {
        var ud = userData();
        if (!ud.contactId || !id || String(id) === '0') return;
        try {
            localStorage.setItem('co_addr_' + pId + '_' + ud.contactId,
                JSON.stringify({ id: String(id), text: text || '', name: name || '' }));
        } catch (e) {}
    }

    // ─── Deferred-address buffer ────────────────────────────
    // While the user is mid-flow — they've picked/added/searched an address but have NOT
    // yet been redirected to a real outlet WITH an order type — the selection is held in
    // memory only. Nothing touches the keys checkout reads (co_addr_*, deliveryAddressId,
    // userAddress). flushPendingAddr() commits it from selectOrderTypeAndRedirect; an
    // abandoned flow ("not serviceable" → Explore Menu, or just closing the modal) leaves
    // no stray address on the checkout page.
    function setPendingAddr(a)   { state.pendingAddr = a; }
    function clearPendingAddr()  { state.pendingAddr = null; }
    function flushPendingAddr() {
        var a = state.pendingAddr;
        if (!a) return;
        if (a.text)     localStorage.setItem('userAddress', a.text);
        // An EXPLICIT empty label clears the key instead of being skipped. These guards
        // can only ever set a value, never clear one, so a caller that deliberately has
        // no address type — the GPS path passes label: '' and says so in a comment —
        // silently inherited the previous selection's label. `undefined` still means
        // "this caller isn't touching the label"; '' means "there is no label".
        if (a.label)                  localStorage.setItem('userAddressLabel', a.label);
        else if (a.label === '')      localStorage.removeItem('userAddressLabel');
        if (a.locality) localStorage.setItem('locality', a.locality);
        if (a.city)     localStorage.setItem('city', a.city);
        if (a.id && String(a.id) !== '0') {
            localStorage.setItem('deliveryAddressId', String(a.id));
            localStorage.setItem('selectedDeliveryAddressId', String(a.id));
            persistCheckoutAddress(a.id, a.text || '', a.label || 'Home');
        } else {
            // A new location was chosen but no saved-address id resolved (add-address upstream
            // returned no id, or the user picked a raw locality). The previously stored
            // deliveryAddressId points at a DIFFERENT, older address — clear it so checkout
            // can't silently reuse the wrong one for this freshly chosen location.
            var ud = userData();
            localStorage.removeItem('deliveryAddressId');
            localStorage.removeItem('selectedDeliveryAddressId');
            if (ud.contactId) localStorage.removeItem('co_addr_' + pId + '_' + ud.contactId);
        }
        state.pendingAddr = null;
    }
    function $(sel) { return modalEl.querySelector(sel); }
    function $$(sel) { return modalEl.querySelectorAll(sel); }

    // ─── Modal show/hide via Bootstrap ──────────────────────
    var bsModal = null;
    function getModal() {
        if (bsModal) return bsModal;
        if (window.bootstrap && bootstrap.Modal) {
            bsModal = bootstrap.Modal.getOrCreateInstance(modalEl, { backdrop: 'static', keyboard: true });
        }
        return bsModal;
    }
    function showOverlay() {
        // Forced mode (window._lpForceSelect): the caller (e.g. pre-booking detail)
        // requires a location before proceeding — hide the close buttons so the modal
        // can't be dismissed. Escape/backdrop are blocked via the hide.bs.modal guard
        // below + the existing static backdrop. Default off → normal dismissible modal.
        var force = !!window._lpForceSelect;
        modalEl.querySelectorAll('.lp-brandhead__close').forEach(function (b) { b.style.display = force ? 'none' : ''; });
        var m = getModal(); if (m) m.show(); else modalEl.classList.add('show');
        // Top of the location funnel — fires once per modal open so we can measure the
        // picker drop-off rate (opened ÷ location_selected). page_path splits by surface:
        // content pages (/collections/*), homepage (/), ordering page (/online-order), etc.
        window.Analytics?.trackLocationPickerOpened?.({ pagePath: window.location.pathname });
    }
    function hideOverlay() { var m = getModal(); if (m) m.hide(); else modalEl.classList.remove('show'); }
    // Block every close attempt (Escape, programmatic hide) while a selection is forced.
    modalEl.addEventListener('hide.bs.modal', function (e) { if (window._lpForceSelect) e.preventDefault(); });

    // ─── Step state machine ─────────────────────────────────
    function showLocationStep(name) {
        if (state.currentStep && state.currentStep !== name) window._lpPrevStep = state.currentStep;
        $$('.location-flow-step').forEach(function (s) {
            if (s.dataset.step === name) s.classList.add('active');
            else                          s.classList.remove('active');
        });
        state.currentStep = name;
        // Track when a user hits the "not serviceable" dead-end — this is our coverage gap
        // signal. lat/lng come from state.coords (set by GPS or locality selection).
        if (name === 'notServiceable') {
            window.Analytics?.trackLocationNotServiceable?.({
                locality: state.locality || '',
                lat:      state.lat  || undefined,
                lng:      state.lng  || undefined,
            });
        }

        // Expand the dialog only for the two-panel address form.
        var dlg = modalEl.querySelector('.modal-dialog');
        if (dlg) dlg.classList.toggle('modal-dialog--wide', name === 'addressForm');

        // Hide the "Already have a Saved Address? Login" CTA on the entry step when the
        // user is already authenticated — they have direct access to saved addresses.
        if (name === 'location') {
            var loginRow = modalEl.querySelector('.alreadyhaveanaccount__cta');
            if (loginRow) {
                var u = userData();
                loginRow.style.display = (u.token && u.contactMappingId) ? 'none' : '';
            }
        }

        // Step-specific init
        if (name === 'savedAddresses') loadSavedAddresses();
        if (name === 'enterAddress')   initEnterAddressAutocomplete();
        if (name === 'addressForm') {
            // Reset right form to hidden + confirm button to disabled on every
            // entry; user must re-pick the pin and re-confirm.
            var rightPanel = $('#addressFormRight');
            if (rightPanel) rightPanel.style.display = '';
            var confirmCta = modalEl.querySelector('#confirmLocationBtn .btn');
            if (confirmCta) confirmCta.disabled = true;
            initAddressMap();
            initHomeLocalityAutocomplete();
        }
        if (name === 'orderType')      loadOrderTypes();
        if (name === 'redirect')       startRedirectCountdown();
        if (name === 'location') {
            var err = $('#error-msg-show'); if (err) err.classList.add('d-none');
        }
    }

    function closeLocationFlow() { if (window._lpForceSelect) return; hideOverlay(); }

    // ─── GPS / current location ─────────────────────────────
    function CurrentAddress() {
        var err = $('#error-msg-show');
        if (err) err.classList.add('d-none');

        if (!navigator.geolocation) {
            if (err) { err.textContent = 'Geolocation not supported by this browser.'; err.classList.remove('d-none'); }
            return;
        }
        if (!window.isSecureContext) {
            if (err) { err.textContent = 'Location requires a secure (HTTPS) connection.'; err.classList.remove('d-none'); }
            return;
        }

        window.Analytics?.trackLocationSearchAttempted?.({ method: 'gps' });
        navigator.geolocation.getCurrentPosition(function (pos) {
            var lat = pos.coords.latitude, lng = pos.coords.longitude;
            persistCoords(lat, lng, 'gps');
            // CI3 wla_home_20260507.js:935-956 — wipe the prior outlet/address tuple so the
            // auto-open guard correctly treats this as "in progress" until orderType is picked.
            localStorage.removeItem('deliveryAddressId');
            localStorage.removeItem('selectedDeliveryAddressId');
            localStorage.removeItem('selectedAddressId');
            localStorage.removeItem('business');
            localStorage.removeItem('slug');
            localStorage.removeItem('formatted_Address');
            // …and the LABEL of that address. A GPS point has no address type, so leaving
            // it behind labelled the detected location with the previous saved address's
            // type — pick "Home", then Use current location, and the chip still read
            // "Home" over a completely different place. Every other address-wipe block in
            // this file (resetLocation, the stale-location sweep) already clears this key
            // next to `userAddress`; this one omitted it.
            localStorage.removeItem('userAddressLabel');
            // CI3 wla_home_20260507.js:995-1008 — geocode failure stays on location step with
            // a retry message; never silently advance to orderType without an address.
            reverseGeocode(lat, lng).then(function (info) {
                if (!info) {
                    if (err) { err.textContent = 'Unable to fetch your location. Please try again or enter manually.'; err.classList.remove('d-none'); }
                    return;
                }
                applyGeocode(info);
                // Buffer the detected address in memory (applyGeocode no longer persists it).
                // Nothing touches the outlet's locality/city until the user confirms an
                // order type (commitAndRedirect).
                // 'Other' like the locality/pincode paths below: a GPS point has no saved
                // address type, and leaving it blank made the header inherit the previous
                // address's label. What matters is that it is always WRITTEN, never inherited.
                setPendingAddr({ id: '', text: state.address, label: 'Other', locality: state.locality, city: state.city });
                showLocationStep('orderType');
            }).catch(function () {
                if (err) { err.textContent = 'Unable to fetch your location. Please try again or enter manually.'; err.classList.remove('d-none'); }
            });
        }, function (e) {
            var msg = e.code === 1 ? 'Location permission denied. Please enter manually.' : 'Could not get your location. Try entering manually.';
            if (err) { err.textContent = msg; err.classList.remove('d-none'); }
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }

    function applyGeocode(info) {
        if (!info) return;
        // CI3 wla_home_20260507.js:987-992 — read locality/city (with resp.data.* fallback),
        // build address as "locality, city" (or whichever single value is present).
        var loc  = info.locality || (info.data && info.data.locality) || '';
        var city = info.city     || (info.data && info.data.city)     || '';
        var addr = (loc && city) ? (loc + ', ' + city) : (loc || city || '');
        if (addr) state.address = addr;
        if (loc)  state.locality = loc;
        if (city) state.city = city;
        if (info.state)   state.stateName = info.state;
        if (info.pincode) state.pinCode  = info.pincode;
        // In-memory ONLY. Do NOT write userAddress/locality/city to localStorage here — those
        // keys drive the header's "Selected Outlet" pill (locality+city) and "Your Location"
        // pill (userAddress). Persisting the user's detected location here overwrote the
        // still-selected outlet's locality/city on the address form / entry GPS paths (business/
        // slug stayed pointing at the old outlet), so the outlet pill showed the user's location.
        // The picked location is buffered via setPendingAddr and committed only on redirect
        // (flushPendingAddr), after which commitAndRedirect sets locality/city = the OUTLET's.
    }

    function persistCoords(lat, lng, source) {
        state.lat = lat; state.lng = lng;
        localStorage.setItem('userLat', String(lat));
        localStorage.setItem('userLng', String(lng));
        localStorage.setItem('userLocSource', source);
    }

    // ─── Upstream API calls (all hit api.uengage.in with api-key) ────────
    // Mirrors CI3 wla_home_20260507.js:962-1009 — dual auth: token+contactMappingId for
    // logged-in, sha256(businessId+salt) hashKey for guests. Server: maps_mongodb.php:294-348.
    // Note: CI3 sent Token in a request header (same-origin, no preflight). CI4 is cross-origin
    // (wlp-uat → edge-uat), so a custom Token header triggers a CORS preflight the API rejects.
    // The server accepts `token` as a query param too (maps_mongodb.php:298 reads it before the
    // header fallback at :306-310), so we keep auth in the URL and avoid preflight on Token.
    function reverseGeocode(lat, lng) {
        var ud = userData();
        var qs = '?lat=' + lat + '&lng=' + lng + '&businessId=' + pId;
        if (ud.token && ud.contactMappingId) {
            qs += '&contactMappingId=' + encodeURIComponent(ud.contactMappingId)
                + '&token=' + encodeURIComponent(ud.token);
        } else {
            var hk = (window.AppConfig && window.AppConfig.geocodeHashKey) || '';
            qs += '&hashKey=' + encodeURIComponent(hk);
        }
        var url = API_BASE + '/maps/getGeocodeAddress' + qs;
        return fetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' })
            .then(function (r) { return r.json(); })
            .then(function (d) { return (d && (d.status === 1 || d.status === '1')) ? d : null; });
    }

    // Loading row shown in the hybrid results dropdown from the moment a valid (≥3 char)
    // query is typed until fetchLocality resolves — so the debounce + network wait reads as
    // "searching", not "no matches". renderLocalityResults overwrites it with the real list.
    function renderLocalityLoading(el) {
        if (!el) return;
        el.innerHTML = '<li class="lp-search-loading">'
            + '<span class="lp-inline-spinner" aria-hidden="true"></span>Searching\u2026</li>';
        el.style.display = 'block';
    }

    var searchTimer = null;
    function enterAddressSearchLocality(keyword) {
        // Google flow: places.Autocomplete renders its own .pac-container dropdown when the
        // SDK is loaded — suppress the AJAX hybrid UI. Falls through if Google auth failed.
        if (useGoogle && !window._gmapsAuthFailed) return;
        clearTimeout(searchTimer);
        var resultsEl = $('#enterAddressLocalityResults');
        if (!keyword || keyword.length < 3) {
            if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }
            return;
        }
        renderLocalityLoading(resultsEl);
        searchTimer = setTimeout(function () {
            window.Analytics?.trackLocationSearchAttempted?.({ method: 'text', query: keyword });
            fetchLocality(keyword).then(function (items) { renderLocalityResults(resultsEl, items, 'enterAddress'); });
        }, 300);
    }

    var homeSearchTimer = null;
    function homeSearchLocality(keyword) {
        if (useGoogle && !window._gmapsAuthFailed) return;
        clearTimeout(homeSearchTimer);
        var resultsEl = $('#homeLocalityResults');
        if (!keyword || keyword.length < 3) {
            if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }
            return;
        }
        renderLocalityLoading(resultsEl);
        homeSearchTimer = setTimeout(function () {
            window.Analytics?.trackLocationSearchAttempted?.({ method: 'text', query: keyword });
            fetchLocality(keyword).then(function (items) { renderLocalityResults(resultsEl, items, 'addressForm'); });
        }, 300);
    }

    // ─── Google Places Autocomplete on entry-step inputs ────
    // Mirrors CI3 footer.php:2155-2210 initEnterAddressAutocomplete. For Google-flow brands
    // (mapsKey + mapsFlow=1), the entry-step search uses Google Places directly instead of
    // /client/searchLocality. On place_changed → persist coords/address → orderType step.
    var _enterAddrAc = null, _homeLocAc = null;
    function initGoogleAutocomplete(inputId, acRef) {
        if (!useGoogle || window._gmapsAuthFailed) return;
        var input = document.getElementById(inputId);
        if (!input) return;
        if (acRef.ac) return; // already bound
        loadGoogleMaps().then(function () {
            if (!window.google || !google.maps || !google.maps.places) return;
            acRef.ac = new google.maps.places.Autocomplete(input, {
                componentRestrictions: { country: 'IN' },
                fields: ['address_components', 'geometry.location', 'formatted_address', 'name']
            });
            acRef.ac.addListener('place_changed', function () {
                var p = acRef.ac.getPlace();
                if (!p || !p.geometry || !p.geometry.location) return;
                var lat = p.geometry.location.lat();
                var lng = p.geometry.location.lng();
                persistCoords(lat, lng, 'locality');
                state.address = p.formatted_address || p.name || '';
                localStorage.setItem('searchLocalityInput', JSON.stringify([lat, lng]));
                // CI3 wla_home_20260507.js:939-955 — locality pick = fresh coords; drop stale tuple.
                localStorage.removeItem('deliveryAddressId');
                localStorage.removeItem('selectedDeliveryAddressId');
                localStorage.removeItem('selectedAddressId');
                localStorage.removeItem('business');
                localStorage.removeItem('slug');
                localStorage.removeItem('userAddress');
                localStorage.removeItem('userAddressLabel');
                // Buffer the picked locality; committed on redirect (flushPendingAddr).
                // 'Other' — same product decision as the GPS path above; see that comment.
                setPendingAddr({ id: '', text: state.address, label: 'Other', locality: '', city: '' });
                showLocationStep('orderType');
            });
        });
    }
    function initEnterAddressAutocomplete() { initGoogleAutocomplete('search_locality_new',     { get ac() { return _enterAddrAc; }, set ac(v) { _enterAddrAc = v; } }); }
    function initHomeLocalityAutocomplete() { initGoogleAutocomplete('homeLocalitySearchInput', { get ac() { return _homeLocAc; },   set ac(v) { _homeLocAc = v; } }); }

    // CI3 footer.php:2212-2228 — if Google Maps key is restricted/rejected for the domain,
    // drop back to the hybrid AJAX path so the user can still search.
    window.gm_authFailure = function () {
        window._gmapsAuthFailed = true;
        _enterAddrAc = null;
        _homeLocAc = null;
    };

    // Hybrid (non-Google) flow: general locality geo-search. Mirrors CI3
    // ue_silver/home.php:268 → maps_mongodb.php:603 getLocalityByName — a guest,
    // token-less prefix match over the global maps_places collection that returns
    // ANY locality + coords. This is NOT /client/searchLocality (which only returns
    // the brand's own outlets, so typing a real area name gave "No matches").
    // Server enforces a 3-char minimum and IP rate limiting.
    function fetchLocality(keyword) {
        keyword = (keyword || '').trim();
        if (keyword.length < 3) return Promise.resolve([]);
        var url = API_BASE + '/maps/getLocalityByName'
                + '?localityName=' + encodeURIComponent(keyword);
        return fetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || d.status != 1) return [];
                var items = d.search_results || d.localities || d.data || [];
                if (!Array.isArray(items)) items = [];
                return items.map(function (it) {
                    return {
                        localityName: it.localityName || it.locality || it.name || '',
                        cityName:     it.cityName || it.city || '',
                        latitude:     it.latitude || it.lat || 0,
                        longitude:    it.longitude || it.lng || it.long || 0,
                        localityId:   it.localityId || it.id || ''
                    };
                }).slice(0, 20);
            })
            .catch(function () { return []; });
    }

    // Location pin for result rows (stroke=currentColor so CSS colours it).
    var PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';

    function renderLocalityResults(el, items, ctx) {
        if (!el) return;
        if (!items.length) {
            el.innerHTML = '<li class="lp-result-empty">No matches</li>';
            el.style.display = 'block';
            // The search query lives on the input that triggered this render.
            var inputEl = el.previousElementSibling || el.closest('.lp-search-wrap')?.querySelector('input');
            var query = inputEl ? (inputEl.value || '').trim() : '';
            window.Analytics?.trackLocationNoResults?.({ query: query });
            return;
        }
        el.innerHTML = items.map(function (it) {
            var lat = it.latitude || it.lat || 0;
            var lng = it.longitude || it.lng || 0;
            return '<li class="lp-result-row" '
                 + 'data-lat="' + lat + '" data-lng="' + lng + '" '
                 + 'data-locality="' + (it.localityName || '').replace(/"/g, '&quot;') + '" '
                 + 'data-city="' + (it.cityName || '').replace(/"/g, '&quot;') + '">'
                 + '<span class="lp-result-row__pin">' + PIN_ICON + '</span>'
                 + '<span class="lp-result-row__body">'
                 +   '<span class="lp-result-row__title">' + (it.localityName || '') + '</span>'
                 +   (it.cityName ? '<span class="lp-result-row__sub">' + it.cityName + '</span>' : '')
                 + '</span>'
                 + '</li>';
        }).join('');
        el.style.display = 'block';
        Array.prototype.forEach.call(el.querySelectorAll('.lp-result-row'), function (li) {
            li.addEventListener('click', function () { selectLocality(li, ctx); });
        });
    }

    function selectLocality(li, ctx) {
        var lat = parseFloat(li.dataset.lat);
        var lng = parseFloat(li.dataset.lng);
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
        persistCoords(lat, lng, 'address');
        state.locality = li.dataset.locality || '';
        state.city     = li.dataset.city || '';
        // In-memory ONLY — do NOT persist locality/city here. They drive the header's
        // "Selected Outlet" pill, which must keep showing the already-selected outlet until
        // the user confirms a new one. addressForm ctx reflects state via applyGeocodeToForm;
        // entry ctx buffers via setPendingAddr below. commitAndRedirect writes the outlet's
        // locality/city at confirmation.

        if (ctx === 'addressForm') {
            applyMapCenter(lat, lng);
            state.lat = lat; state.lng = lng;
            // The picked locality is the reference label shown in the right-panel info box.
            state.address = state.locality + (state.city ? ', ' + state.city : '');
            // Funnel through the shared hydrator — same path as a pin-drop / Google
            // place_changed — so the floating right-side info box (#homeAddrFormInfo) AND the
            // visible/hidden Locality/City/Lat/Lng fields update and Save unlocks. The hybrid
            // branch previously hand-set only a subset of inputs and never touched the info box,
            // so the displayed address didn't change on select.
            applyGeocodeToForm(lat, lng);
            var rl = $('#homeLocalityResults'); if (rl) { rl.style.display = 'none'; rl.innerHTML = ''; }
            // Show the SELECTED locality in the search box (state.address is exactly
            // that label, built just above). It used to be cleared, leaving nothing on
            // screen to tell a wrong pick from a right one; the typed fragment is not
            // the useful reference either, the chosen place is.
            var si = $('#homeLocalitySearchInput'); if (si && state.address) si.value = state.address;
        } else {
            // Entry-step locality pick — mirror CI3 selectHybridLocality (ue_silver/home.php
            // → showOrderTypeSelector) and the Google-flow place_changed handler: a picked
            // locality resolves coords and advances straight to the order-type selector
            // (find nearest outlet), NOT the add-address form. The full delivery address is
            // collected later. Previously this opened addressForm, diverging from both flows.
            state.address = state.locality + (state.city ? ', ' + state.city : '');
            localStorage.setItem('searchLocalityInput', JSON.stringify([lat, lng]));
            localStorage.removeItem('deliveryAddressId');
            localStorage.removeItem('selectedDeliveryAddressId');
            localStorage.removeItem('selectedAddressId');
            localStorage.removeItem('business');
            localStorage.removeItem('slug');
            localStorage.removeItem('userAddress');
            localStorage.removeItem('userAddressLabel');
            // 'Other' — same product decision as the GPS path; see that comment.
            setPendingAddr({ id: '', text: state.address, label: 'Other', locality: state.locality, city: state.city });
            showLocationStep('orderType');
        }
    }

    // ─── Address form / map ─────────────────────────────────
    // Tracks an in-progress edit from the Manage Addresses page. When set, the
    // upstream POST carries deliveryAddressId (turning add → update) and the
    // post-save flow dispatches `lp:address-saved` instead of redirecting.
    var editingAddressId = 0;
    var manageMode       = false;

    // `manage` = opened standalone from the Manage Addresses page (not the home/product
    // find-outlet flow). In that mode the form closes fully and save dispatches
    // `lp:address-saved` instead of advancing to the order-type step.
    function openHomeAddressForm(manage) {
        editingAddressId = 0;
        manageMode = !!manage;
        // Wipe ALL carried-over state + form fields BEFORE the map inits. `state` is
        // module-level and the hidden lat/lng + street/email inputs are never cleared by
        // the browser between opens, so a prior add/edit (or saved-address pick) left its
        // coords and text in place — and saveHomeAddress read them verbatim, saving the
        // PREVIOUS location for a brand-new address. Resetting state.lat/lng here also makes
        // initAddressMap fall back to localStorage (last-known area) instead of re-hydrating
        // the stale in-memory coords. CI3 normal-flow default copy.
        state.lat = null; state.lng = null;
        state.address = ''; state.locality = ''; state.city = '';
        state.stateName = ''; state.pinCode = '';
        state.savePromise = null;
        ['#homeAddrLine1', '#homeAddrLine2', '#homeAddrPhone', '#homeAddrEmail',
         '#homeAddrLat', '#homeAddrLng',
         '#homeAddrLocality', '#homeAddrCity', '#homeAddrState', '#homeAddrPincode',
         '#homeAddressSearch'].forEach(function (sel) {
            var elx = $(sel); if (elx) elx.value = '';
        });
        // Hide the resolved-address info boxes so a prior address isn't shown until the new
        // geocode resolves, and default the type radio back to Home (an edit may have moved it).
        ['#homeAddrMapInfo', '#homeAddrFormInfo'].forEach(function (sel) {
            var box = $(sel); if (box) box.style.display = 'none';
        });
        var homeRadio = $('#homeRadio1'); if (homeRadio) homeRadio.checked = true;
        showLocationStep('addressForm');
        showOverlay();
        prefillPhoneFromUserdata();
        homeSetSaveButtonState(false, 'Select location on map to continue');
        // CI3 wla_home_20260507.js:1636-1653 — auto-fetch GPS only when we don't already
        // have stored coords. Silently no-ops on permission denial; user can still search
        // or click "Go to current location" manually.
        var hasStored = localStorage.getItem('userLat') && localStorage.getItem('userLng');
        if (!hasStored) homeAddrGoToCurrentLocation();
    }

    // CI3 wla_home_20260507.js:1447-1459 — strip optional +91/91, prefill only on a 10-digit
    // number. Skip if the user already typed something so we don't clobber manual input.
    function prefillPhoneFromUserdata() {
        var phoneEl = $('#homeAddrPhone');
        if (!phoneEl || phoneEl.value) return;
        var ud = userData();
        var raw = String(ud.mobile || ud.mobileNo || '').replace(/^\+?91/, '');
        if (/^\d{10}$/.test(raw)) phoneEl.value = raw;
    }

    // Wait for the address-form map to finish initializing (Google Maps loads async).
    // Polls for ~6s so a GPS resolution that beats the map can still center it.
    function whenMapReady(cb) {
        if (mapInstance.map) { cb(); return; }
        var tries = 0;
        var iv = setInterval(function () {
            if (mapInstance.map) { clearInterval(iv); cb(); }
            else if (++tries > 30) { clearInterval(iv); }
        }, 200);
    }

    // CI3 wla_home_20260507.js:1678-1690 — gate the Save Address CTA on the map-pin
    // lifecycle. Same state machine as the checkout add-address modal:
    //   • "Select location on map to continue"  — initial / pin not yet placed
    //   • "Save Address"  (enabled)             — pin placed + locality/city resolved
    //   • "Location not serviceable"            — geocode returned status != 1
    function homeSetSaveButtonState(enabled, message) {
        var btn = $('#homeAddrSaveBtn');
        var err = $('#homeAddrError');
        if (btn) {
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? '1' : '0.5';
        }
        if (err) {
            if (enabled || !message) { err.classList.add('d-none'); err.classList.remove('is-loading'); err.textContent = ''; }
            else                     { err.classList.remove('d-none', 'is-loading'); err.style.color = ''; err.textContent = message; }
        }
    }

    // Show a neutral "Locating your address…" loader in the address-form footer while the
    // pin's coords are reverse-geocoded (Google client Geocoder OR hybrid getGeocodeAddress).
    // Save stays disabled meanwhile; applyGeocodeToForm (success) or the not-serviceable
    // message (failure) replaces this, so callers must clear it on every resolution path.
    function homeSetGeocoding() {
        var btn = $('#homeAddrSaveBtn');
        var cta = $('#confirmLocationBtn .btn');
        var err = $('#homeAddrError');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
        if (cta) cta.disabled = true;
        if (err) {
            err.classList.remove('d-none');
            err.classList.add('is-loading');
            err.style.color = '';
            err.innerHTML = '<span class="lp-inline-spinner" aria-hidden="true"></span>Locating your address\u2026';
        }
    }

    // Re-render the map after a container resize WITHOUT the resize's own moveend/idle
    // re-geocoding. invalidateSize preserves the centre, but getCenter() jitters ~1e-5 after a
    // resize — past the dedupe — so the move handler would fire a second, redundant geocode of
    // the same point (the "2 calls / fluctuating between 2 addresses" bug). The flag makes the
    // move handlers skip that one programmatic move.
    function resizeHomeMap() {
        if (!mapInstance.map) return;
        mapInstance.suppressGeo = true;
        if (mapInstance.kind === 'leaflet' && mapInstance.map.invalidateSize) mapInstance.map.invalidateSize(); // default pan:true PRESERVES centre
        else if (mapInstance.kind === 'google' && window.google && window.google.maps && window.google.maps.event) window.google.maps.event.trigger(mapInstance.map, 'resize');
        setTimeout(function () { mapInstance.suppressGeo = false; }, 300);
    }

    // Shared form-field hydration after a geocode resolves. Used by both onPinChanged
    // (map drag) and homeAddrGoToCurrentLocation (button click + auto-GPS on open) so
    // locality/city/state/pincode land in the hidden inputs and the confirm CTA activates.
    // (Locality/City have no visible field — they show in the green card — but their hidden
    // inputs #homeAddrLocality / #homeAddrCity below still feed the save payload.)
    function applyGeocodeToForm(lat, lng) {
        $('#homeAddrLat') && ($('#homeAddrLat').value = lat);
        $('#homeAddrLng') && ($('#homeAddrLng').value = lng);
        $('#homeAddrCity') && ($('#homeAddrCity').value = state.city || '');
        $('#homeAddrState') && ($('#homeAddrState').value = state.stateName || '');
        $('#homeAddrPincode') && ($('#homeAddrPincode').value = state.pinCode || '');
        $('#homeAddrLocality') && ($('#homeAddrLocality').value = state.locality || '');
        // Reference shows on both screens: the map step (#homeAddrMapInfo, above
        // Confirm Location) and the form step (#homeAddrFormInfo, under the header).
        var loc = state.locality || '';
        var addr = state.address || '';
        // Green card + map card show "locality, city" — but only append city when the locality
        // doesn't already contain it (avoids "Kolkata, Kolkata" / "Panchkula, Panchkula").
        var cityName = state.city || '';
        var locWithCity = (cityName && loc.toLowerCase().indexOf(cityName.toLowerCase()) === -1)
            ? (loc ? (loc + ', ' + cityName) : cityName) : loc;
        var info1 = $('#homeAddrMapLocality');     if (info1) info1.textContent = locWithCity;
        var info2 = $('#homeAddrMapFullAddress');  if (info2) info2.textContent = addr;
        var info3 = $('#homeAddrFormLocality');    if (info3) info3.textContent = locWithCity;
        var info4 = $('#homeAddrFormFullAddress'); if (info4) info4.textContent = addr;
        var box  = $('#homeAddrMapInfo');  if (box)  box.style.display = 'block';
        var box2 = $('#homeAddrFormInfo'); if (box2) box2.style.display = 'block';
        // Showing the below-map card shrinks the map (flex-fill layout) — re-render so it
        // doesn't show gray tiles, WITHOUT the resize's moveend re-geocoding the same point.
        setTimeout(resizeHomeMap, 80);
        var cta = $('#confirmLocationBtn .btn'); if (cta) cta.disabled = false;
        if (state.locality && state.city) homeSetSaveButtonState(true,  'Save Address');
        else                              homeSetSaveButtonState(false, 'Select location on map to continue');
    }

    // CI3 wla_home_20260507.js:1714-1724 — parse a Google Places/Geocoder
    // address_components array into state. City = the 'locality' type; Locality =
    // 'sublocality' (falls back to city); plus admin_area_1 → state, postal_code → pincode.
    function applyAddressComponents(components) {
        if (!components || !components.length) return;
        var city = '', stateName = '', pincode = '', locality = '';
        components.forEach(function (c) {
            var t = c.types || [];
            if (t.indexOf('locality') > -1)                    city     = c.long_name;
            if (t.indexOf('administrative_area_level_1') > -1) stateName = c.long_name;
            if (t.indexOf('postal_code') > -1)                 pincode  = c.long_name;
            if (t.indexOf('sublocality_level_1') > -1 || t.indexOf('sublocality') > -1) locality = c.long_name;
        });
        state.city     = city;
        state.locality = locality || city;
        if (stateName) state.stateName = stateName;
        if (pincode)   state.pinCode   = pincode;
    }

    // CI3 wla_home_20260507.js:1703-1738 (updateHomeAddressFromLatLng) — the single
    // reverse-geocode entry point for the address form, shared by search, pin drag, and
    // the GPS button. Google-flow brands use the client-side Geocoder and add the address
    // UNCONDITIONALLY (no serviceability call); serviceability is decided later at checkout
    // when the nearest open outlet is resolved. Non-Google (Leaflet) brands have no client
    // geocoder, so they fall back to the AJAX getGeocodeAddress — their only option.
    function hydrateFormFromLatLng(lat, lng) {
        state.lat = lat; state.lng = lng;
        homeSetGeocoding();
        if (useGoogle && !window._gmapsAuthFailed && window.google && google.maps && google.maps.Geocoder) {
            var geocoder = new google.maps.Geocoder();
            geocoder.geocode({ location: { lat: lat, lng: lng } }, function (results, status) {
                if (status !== 'OK' || !results[0]) { homeSetSaveButtonState(false, 'Location not serviceable'); return; }
                applyAddressComponents(results[0].address_components);
                state.address = results[0].formatted_address || state.address;
                if (state.address) localStorage.setItem('userAddress', state.address);
                // The search box is LEFT ALONE. It used to be cleared here so it would
                // not sit prefilled with a resolved address — but this runs on every
                // geocode, including the one fired when the form opens, so anyone who
                // started typing while the map was still loading had their text wiped
                // out from under them. It is the user's input, not a label: only they
                // clear it.
                applyGeocodeToForm(lat, lng);
            });
            return;
        }
        reverseGeocode(lat, lng).then(function (info) {
            if (!info) { homeSetSaveButtonState(false, 'Location not serviceable'); return; }
            applyGeocode(info);
            applyGeocodeToForm(lat, lng);
        });
    }

    function openEditAddressForm(addr) {
        if (!addr || typeof addr !== 'object') return;
        editingAddressId = parseInt(addr.id || addr.deliveryAddressId || 0, 10) || 0;
        manageMode = true;

        // Open the modal first so the form fields exist in the DOM
        showLocationStep('addressForm');
        showOverlay();

        // Pre-fill — fields populated by initAddressMap may overwrite some of these,
        // so apply on the next tick to win over the initial centering.
        setTimeout(function () {
            var setVal = function (sel, v) { var el = $(sel); if (el) el.value = (v == null ? '' : v); };
            setVal('#homeAddrLine1', addr.addressLine1 || addr.line1 || '');
            setVal('#homeAddrLine2', addr.addressLine2 || addr.line2 || '');
            setVal('#homeAddrPhone', addr.mobile       || addr.phone || '');
            setVal('#homeAddrEmail', addr.email        || '');
            // Seed in-memory state from the saved address so the shared hydrator below
            // can fill the form from it. state.address is the reference label shown in the
            // under-map / under-header info boxes.
            state.locality  = addr.locality || '';
            state.city      = addr.city || '';
            state.stateName = addr.state || addr.stateName || '';
            state.pinCode   = addr.pinCode || addr.pincode || '';
            // Info box shows locality (bold) + this sub-line. Keep it to city only — not the
            // full street address.
            state.address   = addr.city || '';
            var lat = parseFloat(addr.latitude  || addr.lat || 0);
            var lng = parseFloat(addr.longitude || addr.lng || 0);
            if (lat && lng) { state.lat = lat; state.lng = lng; applyMapCenter(lat, lng); }
            // Reuse the shared hydrator instead of hand-filling fields. It populates the
            // right-panel inputs (visible + hidden Locality/City/State/Pincode/Lat/Lng) AND
            // the under-map / under-header info boxes (#homeAddrMapInfo / #homeAddrFormInfo)
            // — which openEditAddressForm previously never touched, so the locality + full
            // address stayed hidden below the map on edit — and unlocks Save.
            applyGeocodeToForm(state.lat || lat || 0, state.lng || lng || 0);
            // Address type radio (Home/Office/Hotel/Other) — resolve the same way the list does
            // (handles numeric addressType/name + custom addressValue labels), then fall back to
            // 'Other' if the resolved label isn't one of the four standard radios.
            var typeName = resolveAddressLabel(addr);
            if (['Home', 'Office', 'Hotel', 'Other'].indexOf(typeName) === -1) typeName = 'Other';
            var typeRadio = modalEl.querySelector('input[name="homeAddrType"][value="' + typeName + '"]');
            if (typeRadio) typeRadio.checked = true;
        }, 0);
    }

    // Geolocation failures show on the MAP step (#homeLocateError), not the form banner —
    // on mobile the "Use my location" button lives on the map step, so the message must too.
    function homeShowError(msg) {
        var box = $('#homeLocateError');
        if (!box) return;
        box.hidden = false;
        box.textContent = msg;
    }

    // showError: true when triggered by the manual "Use my location" button — surfaces a
    // reason on failure (denied permission / insecure-context block) inline instead of
    // silently no-op'ing. The auto-call on form open (openHomeAddressForm) passes nothing → quiet.
    function homeAddrGoToCurrentLocation(showError) {
        var lerr = $('#homeLocateError'); if (lerr) lerr.hidden = true; // clear any prior failure
        if (!navigator.geolocation) {
            if (showError) homeShowError('Location services are not available in this browser.');
            return;
        }
        navigator.geolocation.getCurrentPosition(function (pos) {
            var lat = pos.coords.latitude, lng = pos.coords.longitude;
            persistCoords(lat, lng, 'gps');
            // When called from openHomeAddressForm the map is still loading, so defer the
            // center + reverse-geocode until it's ready. For a manual click the map is
            // already up and whenMapReady invokes the callback synchronously.
            // CI3 wla_home_20260507.js:1639-1650 — auto-GPS on the address form hydrates via
            // the same path as search/drag (Google client geocoder, no add-time gate).
            whenMapReady(function () {
                applyMapCenter(lat, lng);
                hydrateFormFromLatLng(lat, lng);
            });
        }, function () {
            if (showError) homeShowError('Unable to get your location. Please allow location access — this needs a secure (HTTPS) page.');
        }, { enableHighAccuracy: true, timeout: 10000 });
    }

    function confirmLocationAndShowForm() {
        // Mobile two-step flow: hide map, reveal the form panel. Desktop ignores
        // the class (panels are side-by-side via CSS).
        var container = modalEl.querySelector('.homeAddressFormModal .addadress-starting');
        if (container) container.classList.add('is-form-visible');
    }

    function backToLocationMap() {
        var container = modalEl.querySelector('.homeAddressFormModal .addadress-starting');
        if (container) container.classList.remove('is-form-visible');
    }

    // Green card's "Change on map" — mirrors checkout's addressForm.js: on mobile swap
    // back to the map screen, then focus + flash the map search field so the user can re-pick.
    function homeChangeOnMap() {
        backToLocationMap();
        var input = $('#homeAddressSearch') || $('#homeLocalitySearchInput');
        var wrap  = input && input.closest('.map-search');
        setTimeout(function () {
            if (input) input.focus();
            if (!wrap) return;
            wrap.classList.add('map-search--flash');
            setTimeout(function () { wrap.classList.remove('map-search--flash'); }, 1200);
        }, 60);
    }

    // Close (X) handler for the address-form step. On the Manage Addresses page the form is
    // opened standalone (manageMode), so closing fully dismisses the modal — it must NOT fall
    // back into the saved-addresses / find-outlet flow, which is restricted to home + product
    // pages. In the home/product flow the form is reached from savedAddresses, so it returns there.
    function closeAddressForm() {
        if (manageMode) closeLocationFlow();
        else            showLocationStep('savedAddresses');
    }

    function saveHomeAddress() {
        var ud = userData();
        var errEl = $('#homeAddrError');
        if (errEl) errEl.classList.add('d-none');

        var line1 = ($('#homeAddrLine1') || {}).value || '';
        var line2 = ($('#homeAddrLine2') || {}).value || '';
        var phone = ($('#homeAddrPhone') || {}).value || '';
        var email = ($('#homeAddrEmail') || {}).value || '';
        var typeEl = modalEl.querySelector('input[name="homeAddrType"]:checked');
        var typeVal = typeEl ? typeEl.value : 'Home';
        var lat = parseFloat(($('#homeAddrLat') || {}).value || '') || state.lat || 0;
        var lng = parseFloat(($('#homeAddrLng') || {}).value || '') || state.lng || 0;

        line1 = line1.trim();
        phone = phone.trim();
        if (line1.length < 3) {
            if (errEl) { errEl.textContent = 'Please enter a valid house / flat / block.'; errEl.classList.remove('d-none', 'is-loading'); }
            return;
        }
        if (!/^[0-9]{10}$/.test(phone)) {
            if (errEl) { errEl.textContent = 'Please enter a valid 10-digit phone number.'; errEl.classList.remove('d-none', 'is-loading'); }
            return;
        }
        if (!lat || !lng) {
            if (errEl) { errEl.textContent = 'Please pick a location on the map.'; errEl.classList.remove('d-none', 'is-loading'); }
            return;
        }

        var locality = state.locality || (($('#homeAddrLocality') || {}).value || '');
        var city     = state.city || (($('#homeAddrCity') || {}).value || '');
        if (!locality.trim() || !city.trim()) {
            if (errEl) { errEl.textContent = 'Please pick a serviceable location on the map.'; errEl.classList.remove('d-none', 'is-loading'); }
            return;
        }
        var fullAddr = [line1, line2, locality, city].filter(Boolean).join(', ');
        // Explicit user confirmation — persist coords now (needed for the nearest-outlet
        // lookup). The address identity is held in memory until redirect (flushPendingAddr),
        // so adding an address that turns out non-serviceable never leaks onto checkout.
        persistCoords(lat, lng, 'address');
        if (!manageMode) {
            setPendingAddr({ id: editingAddressId || '', text: fullAddr, label: typeVal, locality: locality, city: city });
        }

        // Save to upstream only for logged-in users (CI3 contract).
        // CI3 reuses /client/addDeliveryAddress for BOTH add and update — passing
        // deliveryAddressId in the body switches it to update mode.
        if (ud.token && ud.contactMappingId) {
            var url = API_BASE + '/client/addDeliveryAddress/' + pId + '/' + encodeURIComponent(ud.contactMappingId) + '/' + encodeURIComponent(ud.token);
            var form = new URLSearchParams();
            form.set('addressLine1', line1);
            form.set('addressLine2', line2);
            form.set('locality', locality);
            form.set('city', city);
            form.set('state', state.stateName || '');
            form.set('pinCode', state.pinCode || '');
            form.set('mobile', phone);
            form.set('email', email);
            form.set('name', typeVal);
            form.set('type', typeVal);
            form.set('latitude', String(lat));
            form.set('longitude', String(lng));
            if (ud.contactId) form.set('contactId', String(ud.contactId));
            if (editingAddressId) form.set('deliveryAddressId', String(editingAddressId));
            var wasManage  = manageMode;
            // Snapshot the edit-id: this callback is async and editingAddressId is reset
            // synchronously below, so read the captured value, not the live module var.
            var wasEditId  = editingAddressId;
            state.savePromise = fetch(url, {
                method: 'POST',
                headers: apiHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
                body: form.toString(),
                credentials: 'omit'
            }).then(function (r) { return r.json(); })
              .then(function (d) {
                  // Upstream id shape varies by path — accept rows.deliveryAddressId / rows.id /
                  // top-level deliveryAddressId / data.deliveryAddressId. Falls back to the edited
                  // id on an update.
                  var id = (d && ((d.rows && (d.rows.deliveryAddressId || d.rows.id))
                                  || d.deliveryAddressId
                                  || (d.data && d.data.deliveryAddressId))) || wasEditId;
                  // Attach the saved id to the buffered selection — still NOT written to the
                  // checkout keys; that happens on redirect via flushPendingAddr.
                  if (id && !wasManage && state.pendingAddr) state.pendingAddr.id = id;
                  if (wasManage) {
                      window.dispatchEvent(new CustomEvent('lp:address-saved'));
                  }
              }).catch(function () {});
        }

        // Reset the edit-id after every save (not just the manage branch) so a subsequent
        // "Add new address" can't inherit the id of the address just edited.
        editingAddressId = 0;
        if (manageMode) {
            // Manage Addresses flow — close the modal, don't redirect to order type.
            manageMode = false;
            hideOverlay();
        } else {
            showLocationStep('orderType');
        }
    }

    // ─── Saved addresses ────────────────────────────────────
    function openLoginOrSavedAddresses() {
        var ud = userData();
        if (!ud.token || !ud.contactMappingId) {
            // Close the location modal first so the login modal isn't stacked on top of it.
            // Hook _onLoginSuccess so we re-open at savedAddresses once auth completes.
            hideOverlay();
            window._onLoginSuccess = function () {
                window._onLoginSuccess = null;
                showLocationStep('savedAddresses');
                showOverlay();
            };
            if (typeof window.showLogin === 'function') {
                // Small delay so Bootstrap can finish hiding the location modal before showing the next.
                setTimeout(function () { window.showLogin(); }, 200);
            }
            return;
        }
        showLocationStep('savedAddresses');
    }

    // Numeric type-id → label. Mirrors checkout.js:2009 ADDR_TYPE so both screens agree.
    var TYPE_LABELS = { 1: 'Home', 2: 'Office', 3: 'Hotel', 4: 'Other' };
    // String type-name → canonical label (case-insensitive). 'work' is checkout's alias for office.
    var TYPE_NAMES  = { home: 'Home', office: 'Office', work: 'Office', hotel: 'Hotel', other: 'Other', others: 'Other' };
    var TYPE_ICONS = {
        Home:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z"/></svg>',
        Office: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M3 13h18"/></svg>',
        Hotel:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18v-6h14a4 4 0 014 4v2"/><path d="M2 18h20"/><path d="M2 18v3"/><path d="M22 18v3"/><circle cx="7" cy="11" r="2.2"/></svg>',
        Other:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>'
    };
    var CHEV_RIGHT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18l6-6-6-6"/></svg>';

    function resolveAddressLabel(a) {
        // The address type lives in `name` — a numeric id ("1".."4"), a string label ("Office"),
        // or null. checkout.js:2106 reads the SAME field via addrTypeLabel(addr.name); this list
        // ignored `name`, so every row fell through to 'Home'. `addressType`/`addressValue` are
        // noisy in production (zero-padded "00000000000", literal "0"), so they're a last resort.
        var candidates = [a.name, a.addressType, a.addressValue, a.type];
        for (var i = 0; i < candidates.length; i++) {
            var v = String(candidates[i] == null ? '' : candidates[i]).trim();
            if (!v) continue;
            if (/^\d+$/.test(v)) {                 // numeric id (incl. zero-padded) — 0 = unset
                var n = parseInt(v, 10);
                if (n !== 0 && TYPE_LABELS[n]) return TYPE_LABELS[n];
                continue;
            }
            return TYPE_NAMES[v.toLowerCase()] || v; // known label, else a genuine custom label
        }
        return 'Home';
    }

    function iconFor(label) {
        return TYPE_ICONS[label] || TYPE_ICONS.Other;
    }

    function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function cleanFieldList(arr) {
        // Drop empty strings, "0" placeholders, and any numeric-zero stand-ins from the joined address.
        return arr.filter(function (v) {
            if (v === null || v === undefined) return false;
            var s = String(v).trim();
            if (!s) return false;
            if (s === '0' || s === '0.0') return false;
            return true;
        });
    }

    // Saved-address pagination: show the first 3, then reveal 4 more per
    // "View More" click (CI3 home-flow chunking behaviour).
    var SAVED_ADDR_INITIAL = 3;
    var SAVED_ADDR_CHUNK   = 4;

    function savedAddrRowHtml(a) {
        var label = resolveAddressLabel(a);
        var full  = cleanFieldList([a.addressLine1, a.addressLine2, a.locality, a.city, a.pinCode]).join(', ');
        // getDeliveryAddress returns coords as latitude/longitude OR lat/lng depending on the
        // upstream path — accept both (manageAddresses.js normalizes the same way). Without the
        // lat/lng fallback, coords-bearing rows render empty → onPickSavedAddress diverts to the
        // address step and getNearestOpenOutlet never fires.
        var aLat = a.latitude  || a.lat || '';
        var aLng = a.longitude || a.lng || '';
        return '<div class="saved-addr-row" '
            + 'data-id="'       + escAttr(a.deliveryAddressId || a.id || '') + '" '
            + 'data-lat="'      + escAttr(aLat) + '" '
            + 'data-lng="'      + escAttr(aLng) + '" '
            + 'data-locality="' + escAttr(a.locality || '') + '" '
            + 'data-city="'     + escAttr(a.city || '') + '" '
            + 'data-address="'  + escAttr(full) + '" '
            + 'data-label="'    + escAttr(label) + '">'
            + '<span class="saved-addr-row__icon">' + iconFor(label) + '</span>'
            + '<div class="saved-addr-row__main">'
            +   '<span class="saved-addr-row__label">' + escHtml(label) + '</span>'
            +   '<span class="saved-addr-row__text" title="' + escAttr(full) + '">' + escHtml(full) + '</span>'
            + '</div>'
            + '<span class="saved-addr-row__chev">' + CHEV_RIGHT + '</span>'
            + '</div>';
    }

    // Bind the click handler to any saved-addr rows that aren't wired up yet.
    function bindSavedAddrRows(listEl) {
        Array.prototype.forEach.call(listEl.querySelectorAll('.saved-addr-row'), function (row) {
            if (row.dataset.bound === '1') return;
            row.dataset.bound = '1';
            row.addEventListener('click', function () { onPickSavedAddress(row); });
        });
    }

    // Render `shown` of `rows` plus a toggle link: "View More" reveals the
    // next chunk, "View Less" (once all are shown) collapses back to the
    // initial count.
    function renderSavedAddresses(listEl, rows, shown) {
        listEl.innerHTML = rows.slice(0, shown).map(savedAddrRowHtml).join('');
        bindSavedAddrRows(listEl);
        if (rows.length <= SAVED_ADDR_INITIAL) return;

        var toggle = document.createElement('div');
        toggle.className = 'saved-addr-more';
        toggle.id = 'savedAddrViewMore';
        var allShown = shown >= rows.length;
        toggle.textContent = allShown ? 'View Less' : 'View More';
        toggle.addEventListener('click', function () {
            var next = allShown
                ? SAVED_ADDR_INITIAL
                : Math.min(shown + SAVED_ADDR_CHUNK, rows.length);
            renderSavedAddresses(listEl, rows, next);
        });
        listEl.appendChild(toggle);
    }

    function loadSavedAddresses() {
        var ud = userData();
        // Personalise the "Welcome Back" greeting with the user's first name (client-side
        // data, so it can't be rendered by PHP). Falls back to a plain "Welcome Back".
        var nameEl = $('#lpWelcomeName');
        if (nameEl) {
            var first = String(ud.name || '').trim().split(/\s+/)[0] || '';
            // Suppress empty/null and the generic "user" placeholder — greet by name only
            // when it's a real given name.
            if (first.toLowerCase() === 'user') first = '';
            nameEl.textContent = first ? (', ' + first) : '';
        }
        var listEl = $('#savedaddress_list');
        if (!listEl) return;
        if (!ud.token || !ud.contactMappingId) {
            listEl.innerHTML = '<div class="saved-addr-empty">Please log in to see saved addresses.</div>';
            return;
        }
        listEl.innerHTML = '<div class="saved-addr-empty">Loading...</div>';
        var url = API_BASE + '/client/getDeliveryAddress/' + pId + '/' + encodeURIComponent(ud.contactMappingId) + '/' + encodeURIComponent(ud.token);
        fetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = (d && (d.data || d.rows)) || [];
                rows = rows.filter(function (a) {
                    return cleanFieldList([a.addressLine1, a.addressLine2, a.locality, a.city, a.pinCode]).length > 0;
                });
                if (!rows.length) {
                    listEl.innerHTML = '<div class="saved-addr-empty">No saved addresses found</div>';
                    return;
                }
                // Show the first SAVED_ADDR_INITIAL rows, then reveal
                // SAVED_ADDR_CHUNK more per "View More" click. Once everything
                // is visible a "View Less" link collapses back (CI3 chunking).
                renderSavedAddresses(listEl, rows, Math.min(SAVED_ADDR_INITIAL, rows.length));
            })
            .catch(function () {
                listEl.innerHTML = '<div class="saved-addr-empty">Could not load addresses.</div>';
            });
    }

    function onPickSavedAddress(row) {
        var lat = parseFloat(row.dataset.lat);
        var lng = parseFloat(row.dataset.lng);
        var id  = row.dataset.id;
        // Hold the selection in memory only — committed on redirect (flushPendingAddr).
        setPendingAddr({
            id:       id,
            text:     row.dataset.address || '',
            label:    row.dataset.label || 'Home',
            locality: row.dataset.locality || '',
            city:     row.dataset.city || ''
        });

        if (isFinite(lat) && isFinite(lng) && lat !== 0 && lng !== 0) {
            persistCoords(lat, lng, 'address');
            state.locality = row.dataset.locality || '';
            state.city     = row.dataset.city || '';
            showLocationStep('orderType');
        } else {
            showLocationStep('enterAddress');
        }
    }

    // ─── Order type / nearest store ─────────────────────────
    function loadOrderTypes() {
        var lat = state.lat || parseFloat(localStorage.getItem('userLat') || '0');
        var lng = state.lng || parseFloat(localStorage.getItem('userLng') || '0');
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
            // No coords — but we may already know WHICH outlet this is, from the
            // menu page the visitor is coming off (_seedCurrentOutlet). The
            // coordinate lookup below exists to answer "which outlet serves you";
            // that question is already answered, so ask the one that is actually
            // open instead: how do you want it. This is the menu page's own
            // switcher behaviour, reached from every other page.
            var card = storedOutletCard();
            if (card) {
                window._lpSelectedStore = card;
                var cAddrEl = $('#orderTypeModal_address');
                if (cAddrEl) cAddrEl.textContent = [card.locality, card.city].filter(Boolean).join(', ');
                renderOrderTypes(card);
                return;
            }
            // Nothing known at all (e.g. an outlet picked on the store-locator
            // before this record existed). Send logged-in users to their saved
            // addresses so they can re-anchor a location with coords; only
            // anonymous users go to step 1.
            var ud = userData();
            showLocationStep(ud.token && ud.contactMappingId ? 'savedAddresses' : 'location');
            return;
        }

        var addrEl = $('#orderTypeModal_address');
        if (addrEl) {
            // Fall back to stored locality/city (in-memory state is empty after a reload for a
            // store-locator pick, which has no userAddress) so this never shows a bare ", ".
            var loc  = state.locality || localStorage.getItem('locality') || '';
            var cty  = state.city     || localStorage.getItem('city')     || '';
            // Prefer the in-memory buffer (not yet committed to localStorage) for display.
            var pend = state.pendingAddr && state.pendingAddr.text;
            addrEl.textContent = pend || localStorage.getItem('userAddress') || [loc, cty].filter(Boolean).join(', ');
        }

        // api.uengage.in/client/getNearestOpenOutlet returns a single { address: {...} },
        // so wrap into an array for the downstream picker logic.
        var url = API_BASE + '/client/getNearestOpenOutlet'
                + '?parentBusinessId=' + pId
                + '&latitude=' + lat
                + '&longitude=' + lng
                + (window._lpPrebooking ? '&prebooking=1' : '');
        fetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = [];
                if (d && Number(d.status) === 1 && d.address) {
                    rows = Array.isArray(d.address) ? d.address : [d.address];
                } else if (d && (d.data || d.rows)) {
                    rows = d.data || d.rows;
                }
                if (!rows.length) {
                    showLocationStep('notServiceable');
                    return;
                }
                state.nearest = rows;
                var store = pickNearestOpen(rows);
                window._lpSelectedStore = store;

                // Order type already chosen (e.g. home-page Action Center card) — skip the
                // visual orderType step and go straight to the redirect, same as if the user
                // had tapped that type's button here. Falls through to the normal picker if
                // the nearest outlet doesn't actually support the pre-chosen type.
                var pendingType = window._lpPendingOrderType;
                window._lpPendingOrderType = null;
                if (pendingType) {
                    var flagKey = FLAG_BY_TYPE[pendingType];
                    var supported = flagKey ? Number(store[flagKey]) === 1 : false;
                    if (Number(pendingType) === 1) {
                        supported = supported && Number(store.onlineDeliveryOn !== undefined ? store.onlineDeliveryOn : 1) === 1;
                    }
                    if (supported) {
                        selectOrderTypeAndRedirect(pendingType);
                        return;
                    }
                }
                renderOrderTypes(store);
            })
            .catch(function () { showLocationStep('notServiceable'); });
    }

    function pickNearestOpen(stores) {
        for (var i = 0; i < stores.length; i++) {
            if (stores[i].isOpen === true || Number(stores[i].isOpen) === 1) return stores[i];
        }
        return stores[0];
    }

    // The outlet the visitor is currently browsing, recorded by _seedCurrentOutlet
    // below. Read back only while it still describes the stored outlet: `business`
    // is the authority, and a journey pick overwrites that without touching this.
    var OUTLET_CARD_KEY = 'v4_current_outlet';
    function storedOutletCard() {
        var business = localStorage.getItem('business');
        if (!business || business === 'null') return null;
        try {
            var card = JSON.parse(localStorage.getItem(OUTLET_CARD_KEY) || 'null');
            return (card && card.id && String(card.id) === String(business)) ? card : null;
        } catch (e) { return null; }
    }

    var FLAG_BY_TYPE = {
        1: 'onlineOrdersDelivery',
        2: 'onlineOrdersSelfPickup',
        3: 'dineInOrders',
        4: 'inCarOrders',
        5: 'reservationAllowed',
        6: 'uengage_pay'
    };

    function renderOrderTypes(store) {
        var enabledIds = [];
        Object.keys(FLAG_BY_TYPE).forEach(function (id) {
            var on = Number(store[FLAG_BY_TYPE[id]]) === 1;
            if (Number(id) === 1) on = on && Number(store.onlineDeliveryOn !== undefined ? store.onlineDeliveryOn : 1) === 1;
            if (on) enabledIds.push(id);
            var btn = document.getElementById('orderTypeBtn_' + id);
            if (btn) btn.style.display = on ? '' : 'none';
        });
        var grid = document.getElementById('orderTypeButtonsContainer');
        var single = enabledIds.length === 1;
        if (grid) grid.classList.toggle('order-type-grid--single', single);

        // No order type at all (every flag off): all cards are hidden, so the grid would
        // sit empty under a "how would you like your order?" prompt. Swap in a message
        // instead — the "Change" control above it is the way out.
        var none = enabledIds.length === 0;
        var empty = document.getElementById('orderTypeEmpty');
        if (empty) empty.hidden = !none;
        if (grid) grid.hidden = none;

        // With a single order type there is no choice to make, so the "Select an order
        // type…" framing reads oddly. Reframe the heading as a continue prompt; the lone
        // card is styled as a full-width primary CTA (see .order-type-grid--single CSS).
        var heading = document.getElementById('orderTypeHeading');
        if (heading) {
            // With no order type the highlighted band below states the situation, so the
            // prompt is dropped rather than repeated. style.display, not [hidden] — the
            // heading's own rule carries !important and would win over the attribute.
            heading.style.display = none ? 'none' : '';
            if (!none) {
                heading.textContent = single
                    ? "Great, you're covered! Continue to place your order"
                    : "Great, you're covered! How would you like your order?";
            }
        }

        // Heal a stale stored orderType (e.g. delivery='1' left over from a previous
        // session on a brand where delivery is now disabled). The header info bar renders
        // this value verbatim — without correcting it, it shows "Delivery" for a pickup-only
        // outlet. Reset to the first enabled type and refresh the bar so the label matches
        // what the outlet actually offers.
        var stored = localStorage.getItem('orderType');
        if (enabledIds.length && enabledIds.indexOf(String(stored)) === -1) {
            localStorage.setItem('orderType', enabledIds[0]);
            updateHeaderInfoBar();
        }
    }

    function selectOrderTypeAndRedirect(typeId) {
        var store = window._lpSelectedStore;
        if (!store && state.nearest.length) store = state.nearest[0];
        if (!store) return;

        // Delivery is the one type that needs the CUSTOMER's address: it decides
        // serviceability and it is where the order goes. The step can now be
        // opened on a known outlet alone (changeOrderType above), so this is the
        // point where that path collects one instead of committing a delivery
        // order with nowhere to deliver it. A pending address counts — it is
        // committed by flushPendingAddr() moments later.
        // No-op for every pre-existing route here, which only ever arrive with an
        // address already in hand.
        if (Number(typeId) === 1) {
            var addr    = localStorage.getItem('userAddress');
            var pending = state.pendingAddr && state.pendingAddr.text;
            if (!pending && (!addr || addr === 'null' || addr === '')) {
                var udd = userData();
                showLocationStep(udd.token && udd.contactMappingId ? 'savedAddresses' : 'location');
                return;
            }
        }
        // Real outlet + order type confirmed. Wait for any in-flight add-address save so the
        // freshly-created deliveryAddressId is committed (not the previously selected one).
        // Bound the wait so a slow/failed save can't block the redirect — flushPendingAddr then
        // clears the stale id instead of reusing it.
        if (state.savePromise) {
            var done = false;
            var once = function () { if (done) return; done = true; commitAndRedirect(typeId, store); };
            state.savePromise.then(once, once);
            setTimeout(once, 2500);
        } else {
            commitAndRedirect(typeId, store);
        }
    }

    function commitAndRedirect(typeId, store) {
        // Commit the held address — this is the only place it reaches the checkout keys.
        flushPendingAddr();
        state.savePromise = null;
        var slug = store.web_slug || store.slug || '';
        localStorage.setItem('orderType', String(typeId));
        localStorage.setItem('business', String(store.id || ''));
        if (slug) localStorage.setItem('slug', slug);
        // TTL stamp — 60-min expiry checked at next page load (top of this module).
        localStorage.setItem('locationSelectedAt', String(Date.now()));
        // CI3 wla_home_20260507.js:2347-2353 — overwrite locality/city with the selected
        // outlet's values so the header info bar shows the outlet (not the user's address).
        localStorage.setItem('city', store.city || '');
        localStorage.setItem('locality', store.locality || '');
        document.cookie = 'view_business=' + (store.id || '') + '; path=/; max-age=2592000';

        // A serviceable outlet has been committed — every entry path (saved address, new
        // address, locality search, GPS) funnels through here, so this is the one place
        // that means "user picked where they're ordering from". Bridge, not an import:
        // this module's './analytics.js' import is unversioned against a 30-day CDN cache.
        try {
            window.Analytics?.trackLocationSelected?.({
                businessId: store.id || '', locality: store.locality || '',
                city: store.city || '', deliveryType: String(typeId),
            });
        } catch (e) { /* never block the redirect */ }

        // Resolve-only mode (opt-in via window._lpResolveOnly): the caller wants the
        // outlet resolved + committed but WITHOUT navigating away (e.g. the pre-booking
        // detail page, which must stay on the event). Commit is already done above;
        // close the modal and notify via an event, then bail before the redirect.
        // Default (flag unset) behavior is unchanged for every other page.
        if (window._lpResolveOnly) {
            window._lpResolveOnly = false;
            window._lpForceSelect = false;   // selection made → allow the modal to close
            state.savePromise = null;
            closeLocationFlow();
            document.dispatchEvent(new CustomEvent('lp:outlet-resolved', {
                detail: {
                    businessId: String(store.id || ''),
                    name:       store.name || store.businessName || store.brandName || '',
                    slug:       slug,
                    orderType:  typeId,
                    city:       store.city || '',
                    locality:   store.locality || '',
                    lat:        localStorage.getItem('userLat') || '',
                    lng:        localStorage.getItem('userLng') || '',
                },
            }));
            return;
        }

        // Populate redirect view
        var addrEl   = $('#redirectModal_address');     if (addrEl) addrEl.textContent = localStorage.getItem('userAddress') || '';
        var typeEl   = $('#redirectModal_orderType');   if (typeEl) typeEl.textContent = orderTypeLabel(typeId);
        var outletEl = $('#redirectModal_outlet');      if (outletEl) outletEl.textContent = (store.locality || '') + ', ' + (store.city || '');

        // If a widget-click queued a destination, honor it (CI3 parity). The /online-order
        // shortcut becomes the outlet's menu now that we know the slug.
        // Reservation (5) → /reservation/{city}/{slug}; Direct Pay (6) → /direct-pay/{slug}
        var target = typeId === 5 ? '/reservation/' + encodeURIComponent(store.city || '') + '/' + slug
                   : typeId === 6 ? '/direct-pay/' + slug
                   : '/order/' + slug;
        if (window._lpPendingNav) {
            target = window._lpPendingNav;
            window._lpPendingNav = null;
            if (/^\/online-order(\/|$|\?)/.test(target)) target = '/order/' + slug;
        }
        // Silver-widget deep link: append section_slug so the menu jumps to the category.
        if (window._lpPendingSection) {
            target += (target.indexOf('?') > -1 ? '&' : '?') +
                      'section_slug=' + encodeURIComponent(window._lpPendingSection);
            window._lpPendingSection = null;
        }
        // Product-page deep link: append item_slug so the menu opens the item popup.
        if (window._lpPendingItemSlug) {
            target += (target.indexOf('?') > -1 ? '&' : '?') +
                      'item_slug=' + encodeURIComponent(window._lpPendingItemSlug);
            window._lpPendingItemSlug = null;
        }
        window._lpRedirectTarget = target;
        showLocationStep('redirect');
    }

    function orderTypeLabel(id) {
        // Same canonical set as ORDER_TYPE_LABELS below — this file carried two
        // maps that disagreed with each other ("Dine In" here, "Dine In" there,
        // "Pickup" vs "Pick Up") as well as with the menu page.
        return ({ 1: 'Delivery', 2: 'Pickup', 3: 'Dine-in', 4: 'In-car', 5: 'Reservation', 6: 'Direct Pay' })[id] || '';
    }

    // Zomato-style auto-redirect: a progress bar fills over REDIRECT_MS, then navigates.
    // The cancel button (cancelRedirect) halts it; the "Change" link still works as before.
    var REDIRECT_MS = 3000;
    function startRedirectCountdown() {
        clearInterval(window._lpCountdownIv);
        clearTimeout(window._lpRedirectTimeout);
        var loader = $('#redirectLoader');
        if (loader) loader.classList.remove('redirect-loader--cancelled');
        var bar = $('#redirectProgressBar');
        if (bar) {
            bar.style.transition = 'none';
            bar.style.width = '0%';
            void bar.offsetWidth;               // force reflow so the next change animates
            bar.style.transition = 'width ' + REDIRECT_MS + 'ms linear';
            bar.style.width = '100%';
        }
        // Live 3 → 2 → 1 countdown in the progress text (matches the filling bar).
        var textEl = $('#redirectProgressText');
        var secs = Math.round(REDIRECT_MS / 1000);
        var setText = function (n) { if (textEl) textEl.textContent = 'Taking you to the menu in ' + n + '...'; };
        setText(secs);
        window._lpCountdownIv = setInterval(function () {
            secs -= 1;
            if (secs <= 0) { clearInterval(window._lpCountdownIv); return; }
            setText(secs);
        }, 1000);
        window._lpRedirectTimeout = setTimeout(function () {
            clearInterval(window._lpCountdownIv);
            if (window._lpRedirectTarget) window.location.href = window._lpRedirectTarget;
        }, REDIRECT_MS);
    }

    // Cross beside the progress bar: cancel the auto-redirect and return to the
    // order-type step (the previous step) so the user can re-choose.
    function cancelRedirect() {
        clearTimeout(window._lpRedirectTimeout);
        clearInterval(window._lpCountdownIv);
        showLocationStep('orderType');
    }

    function changeUserLocation() {
        clearInterval(window._lpCountdownIv);
        clearTimeout(window._lpRedirectTimeout);
        state.nearest = [];
        // CI3 wla_home_20260507.js:1326 — "DON'T clear localStorage here — data is only
        // overwritten when user makes a new selection." Wiping business/slug/deliveryAddressId
        // here erased the outlet that drives the header info bar, so opening "Change" and
        // closing without picking left the bar with nothing to show (it vanished). Keep the
        // prior selection; a new pick overwrites it, a cancel preserves it.
        var ud = userData();
        // Logged-in users came from the saved-addresses list; send them back there
        // instead of the initial entry step so they can pick a different address.
        showLocationStep(ud.token && ud.contactMappingId ? 'savedAddresses' : 'location');
        showOverlay();
    }

    // ─── "Explore Menu" (notServiceable step) ───────────────
    // The user's location has no serviceable (in-radius, open) outlet, so getNearestOpenOutlet
    // returned nothing and the dead-end "notServiceable" modal is showing. Instead of re-hitting
    // that same radius-bound endpoint (which would return null again), fall back to the radius-free
    // getNearestOutlet — it returns the closest outlet regardless of radius/open-hours — and send
    // the user to its menu so they can still browse.
    // Browse-only: we do NOT flush the held address (the location isn't serviceable, so no
    // delivery address is committed to checkout) — only the buffer is cleared.
    // Last resort: if even getNearestOutlet has nothing (or the call fails), route to the
    // store-locator so the button is never a dead end.
    function exploreNearestOutlet() {
        clearPendingAddr();
        var lat = state.lat || parseFloat(localStorage.getItem('userLat') || '0');
        var lng = state.lng || parseFloat(localStorage.getItem('userLng') || '0');

        var EXPLORE_OUTLET_URL = API_BASE + '/client/getNearestOutlet'
                + '?parentBusinessId=' + pId
                + '&latitude=' + lat
                + '&longitude=' + lng
                + (window._lpPrebooking ? '&prebooking=1' : '');

        fetch(EXPLORE_OUTLET_URL, { method: 'GET', headers: apiHeaders(), credentials: 'omit' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var store = null;
                if (d && Number(d.status) === 1 && d.address) {
                    store = Array.isArray(d.address) ? d.address[0] : d.address;
                } else if (d && (d.data || d.rows)) {
                    var arr = d.data || d.rows;
                    store = Array.isArray(arr) ? arr[0] : arr;
                }
                var slug = store && (store.web_slug || store.slug || '');
                if (slug) {
                    // Outlet IS selected (the user is browsing this menu), even though no
                    // serviceable DELIVERY location was set. Persist the outlet tuple so
                    // home/product don't re-prompt — mirrors the store-locator .sl-cta--primary
                    // handler below (outlet picked ≠ user location set): store business/slug/
                    // city/locality, clear the stale (non-serviceable) user-location keys so
                    // "Your Location" reads "No location selected" and changeOrderType() routes
                    // to the address step. No address is flushed and no order type is set, so
                    // checkout still asks for a real deliverable address.
                    localStorage.setItem('slug', slug);
                    localStorage.setItem('business', String(store.id || ''));
                    if (store.city)     localStorage.setItem('city',     store.city);
                    if (store.locality) localStorage.setItem('locality', store.locality);
                    localStorage.removeItem('userLat');
                    localStorage.removeItem('userLng');
                    localStorage.removeItem('userLocSource');
                    localStorage.removeItem('userAddress');
                    localStorage.removeItem('userAddressLabel');
                    localStorage.removeItem('deliveryAddressId');
                    localStorage.removeItem('selectedDeliveryAddressId');
                    localStorage.setItem('locationSelectedAt', String(Date.now()));
                    if (store.id) document.cookie = 'view_business=' + store.id + '; path=/; max-age=2592000';
                }
                window.location.href = slug ? '/order/' + slug : '/store-locator';
            })
            .catch(function () { window.location.href = '/store-locator'; });
    }

    // ─── Map adapters (Google / Leaflet) ────────────────────
    function loadLeaflet() {
        if (window.L && window.L.map) return Promise.resolve();
        return new Promise(function (resolve) {
            var link = document.createElement('link');
            link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);
            var s = document.createElement('script');
            s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            s.onload = resolve; document.head.appendChild(s);
        });
    }

    function loadGoogleMaps() {
        if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve();
        if (window._gmapsPromise) return window._gmapsPromise;
        window._gmapsPromise = new Promise(function (resolve) {
            window._gmapsReady = resolve;
            var s = document.createElement('script');
            s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(mapsKey) + '&libraries=places&loading=async&callback=_gmapsReady';
            document.head.appendChild(s);
        });
        return window._gmapsPromise;
    }

    var mapInstance = { kind: null, map: null, marker: null };

    // Teardrop pin shared by both map engines (no dependency on Leaflet's default icon
    // images). Fixed green for now per design; swap to var(--brand) to theme per brand.
    function brandPinSvg() {
        var c = '#22c55e';
        return '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">'
             + '<path d="M17 0C7.6 0 0 7.6 0 17c0 11.9 15.3 25.6 16 26.2.6.5 1.4.5 2 0C18.7 42.6 34 28.9 34 17 34 7.6 26.4 0 17 0z" fill="' + c + '"/>'
             + '<circle cx="17" cy="17" r="6" fill="#fff"/></svg>';
    }

    function initAddressMap() {
        // CI3 wla_home_20260507.js:1577-1583 — seed the map center from stored coords so the
        // form opens on the user's last-known location, not the Delhi fallback.
        var sLat = parseFloat(localStorage.getItem('userLat') || '');
        var sLng = parseFloat(localStorage.getItem('userLng') || '');
        var hasStored = isFinite(sLat) && isFinite(sLng) && !(sLat === 0 && sLng === 0);
        var lat = state.lat || (hasStored ? sLat : 28.6139);
        var lng = state.lng || (hasStored ? sLng : 77.2090);
        // CI3 wla_home_20260507.js:1634 — hydrate the form from the initial coords on open so
        // locality/city/address show immediately. Add flow only (edit pre-fills its own saved
        // address); when no coords exist the GPS auto-fetch in openHomeAddressForm handles it.
        var hydrateOnInit = !manageMode && (!!state.lat || hasStored);
        if (useGoogle) {
            var el = document.getElementById('homeAddressMap');
            if (!el) return;
            if (mapInstance.map && mapInstance.kind === 'google') {
                applyMapCenter(lat, lng);
                if (hydrateOnInit) hydrateFormFromLatLng(lat, lng);
                return;
            }
            loadGoogleMaps().then(function () {
                var map = new google.maps.Map(el, {
                    center: { lat: lat, lng: lng }, zoom: 16,
                    mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
                    // 'greedy' so one-finger drag pans the map on mobile (default 'auto' is
                    // cooperative — one finger scrolls the page, blocking the drag-the-map pin UX).
                    gestureHandling: 'greedy', clickableIcons: false
                });
                mapInstance.kind = 'google'; mapInstance.map = map;
                // Centre-pin UX: the pin is a static CSS element (.addr-map__pin) fixed at the map
                // centre, so the map moves under it (drag-the-map). Replaces the deprecated
                // google.maps.Marker. `idle` fires after the map settles; dedupe skips programmatic/
                // tile moves; onPinChanged debounces (400ms) so panning fires ONE geocode.
                map.addListener('idle', function () {
                    var ctr = map.getCenter(); if (!ctr) return;
                    var cl = ctr.lat(), cn = ctr.lng();
                    if (mapInstance.suppressGeo) return;        // programmatic resize → don't re-geocode
                    if (state.lat != null && Math.abs(cl - state.lat) < 1e-5 && Math.abs(cn - state.lng) < 1e-5) return;
                    onPinChanged(cl, cn);
                });
                map.addListener('click', function (e) { map.panTo(e.latLng); });
                wireGooglePlaces();
                if (hydrateOnInit) hydrateFormFromLatLng(lat, lng);
            });
        } else {
            var el2 = document.getElementById('homeLeafletMap');
            if (!el2) return;
            if (mapInstance.map && mapInstance.kind === 'leaflet') {
                applyMapCenter(lat, lng);
                if (hydrateOnInit) hydrateFormFromLatLng(lat, lng);
                return;
            }
            loadLeaflet().then(function () {
                el2.innerHTML = '';
                var map = L.map(el2, { zoomControl: true }).setView([lat, lng], 16);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
                mapInstance.kind = 'leaflet'; mapInstance.map = map;
                // Draggable marker (custom divIcon so we don't depend on Leaflet's default
                // marker images). Drag to drop, or tap the map to move the pin there.
                var pinIcon = L.divIcon({ className: 'lp-leaflet-pin', html: brandPinSvg(), iconSize: [34, 44], iconAnchor: [17, 44] });
                var marker = L.marker([lat, lng], { draggable: true, icon: pinIcon }).addTo(map);
                mapInstance.marker = marker;
                // Centre-pin UX (see Google branch above): any map movement snaps the pin to the
                // new centre and geocodes it, keeping pin + fixed coach-mark aligned. onPinChanged
                // debounces (400ms) so panning fires ONE geocode; dedupe skips no-op/resize moves.
                map.on('moveend', function () {
                    var c = map.getCenter();
                    marker.setLatLng(c);                        // always keep pin centred
                    if (mapInstance.suppressGeo) return;        // programmatic resize → don't re-geocode
                    if (state.lat != null && Math.abs(c.lat - state.lat) < 1e-5 && Math.abs(c.lng - state.lng) < 1e-5) return;
                    onPinChanged(c.lat, c.lng);
                });
                map.on('click', function (e) { map.panTo(e.latlng); });
                marker.on('dragend', function () { map.panTo(marker.getLatLng()); });
                setTimeout(resizeHomeMap, 200);
                if (hydrateOnInit) hydrateFormFromLatLng(lat, lng);
            });
        }
    }

    function applyMapCenter(lat, lng) {
        if (!mapInstance.map) return;
        if (mapInstance.kind === 'google') {
            mapInstance.map.setCenter({ lat: lat, lng: lng });
            if (mapInstance.marker) mapInstance.marker.setPosition({ lat: lat, lng: lng });
        } else {
            mapInstance.map.setView([lat, lng], 16);
            if (mapInstance.marker) mapInstance.marker.setLatLng([lat, lng]);
            setTimeout(resizeHomeMap, 100);
        }
    }

    function wireGooglePlaces() {
        var inp = document.getElementById('homeAddressSearch');
        if (!inp || !window.google || !google.maps || !google.maps.places) return;
        var ac = new google.maps.places.Autocomplete(inp, { fields: ['geometry', 'address_components', 'formatted_address'], componentRestrictions: { country: 'IN' } });
        ac.addListener('place_changed', function () {
            var p = ac.getPlace();
            if (!p || !p.geometry) return;
            var lat = p.geometry.location.lat();
            var lng = p.geometry.location.lng();
            persistCoords(lat, lng, 'address');
            applyMapCenter(lat, lng);
            state.address = p.formatted_address || state.address;
            if (state.address) localStorage.setItem('userAddress', state.address);
            // CI3 wla_home_20260507.js:1662-1671 — a search pick is equivalent to a pin
            // drop. The Place already carries address_components, so hydrate locality/city/
            // state/pincode straight from it (no extra geocode) and unlock Save. No add-time
            // serviceability gate — that's decided at checkout. Without this the picked place
            // recentred the map but Locality/City stayed empty and Save stayed disabled.
            state.lat = lat; state.lng = lng;
            applyAddressComponents(p.address_components);
            applyGeocodeToForm(lat, lng);
            // The picked place STAYS in the field. Clearing it left nothing on screen
            // saying what was searched for, so a wrong result could not be recognised
            // as wrong, let alone edited — the info box shows where the pin landed, not
            // what was asked for. Keeping the query is what makes the two comparable.
        });
    }

    var pinDebounce = null;
    function onPinChanged(lat, lng) {
        clearTimeout(pinDebounce);
        // In-memory only — do NOT call persistCoords here. localStorage writes happen on
        // explicit user confirmation (GPS pick, locality pick, saved address, Save Address).
        // CI3 wla_home_20260507.js:1604-1612 — drag/click funnel into the same form-hydrate
        // path as search; Google brands add unconditionally, serviceability waits for checkout.
        pinDebounce = setTimeout(function () { hydrateFormFromLatLng(lat, lng); }, 400);
    }

    // ─── Header location info bar (CI3-aligned) ─────────────
    // CANONICAL order-type labels — see the note in headerV2.js. This bar is the
    // mobile counterpart of the header's order-type chip, so a different
    // spelling here just moves the mismatch to a breakpoint. Kept as a literal
    // copy rather than a shared import on purpose (cached /src/js, unversioned
    // nested imports).
    var ORDER_TYPE_LABELS = { 1: 'Delivery', 2: 'Pickup', 3: 'Dine-in', 4: 'In-car', 5: 'Reservation', 6: 'Direct Pay' };
    // The types where the customer goes to the OUTLET rather than the order
    // coming to them — so the bar names the outlet, not their saved address.
    // Literal copy of headerV2.js's map for the same reason as the labels above.
    var AT_OUTLET_TYPES = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };

    function updateHeaderInfoBar() {
        var bar = document.getElementById('locationInfoBar');
        if (!bar) return;

        var addr      = localStorage.getItem('userAddress') || '';
        var addrLabel = localStorage.getItem('userAddressLabel') || '';
        // Defensive: the checkout hydration path (and older builds) could store a raw
        // numeric address-type id here ("1" = Home, "2" = Office, …). The bar renders
        // this verbatim, so map a bare number to its label — otherwise it shows "1".
        if (/^\d+$/.test(addrLabel)) {
            var lblNum = parseInt(addrLabel, 10);
            addrLabel = (lblNum !== 0 && TYPE_LABELS[lblNum]) ? TYPE_LABELS[lblNum] : '';
        }
        var locality  = localStorage.getItem('locality');
        var city      = localStorage.getItem('city');
        var business  = localStorage.getItem('business');
        var slug      = localStorage.getItem('slug');
        var orderType = localStorage.getItem('orderType');

        var has = function (v) { return v && v !== 'null' && v !== 'undefined'; };
        var hasLocation = (has(locality) && has(city) && (has(business) || has(slug))) || has(slug);

        // v2's bar is the ONLY location control below 992px — the header chip is
        // d-none d-lg-flex and a phone row has no space for it. Hiding the bar
        // outright when nothing is stored therefore left a FIRST-TIME mobile
        // visitor with no way to set a location at all, while desktop still got
        // the chip's "Set location". So v2's bar (marked d-lg-none by base.php)
        // stays up in a prompt state instead. v1 keeps hiding: its own entry
        // points cover that case and its bar is not breakpoint-scoped.
        var isV2Bar    = bar.classList.contains('d-lg-none');
        var outletSec  = bar.querySelector('.location-info-bar-divider');
        var typeSec    = bar.querySelector('.location-info-bar-section-fixed');

        if (!hasLocation) {
            if (!isV2Bar) { bar.style.display = 'none'; return; }
            var promptEl = bar.querySelector('#headerAddress');
            if (promptEl) promptEl.textContent = 'Select location';
            var promptLbl = bar.querySelector('#headerAddressLabel');
            if (promptLbl) promptLbl.style.display = 'none';
            // The ORDER TYPE is still reported here. It is stored independently of
            // the location — the menu page writes the outlet's default on load
            // (menu.js), and the journey auto-commits a sole enabled type — so
            // falling straight through left every other page showing "Set order
            // type" over a choice that had in fact been made, while the menu page
            // a click earlier showed "Pickup".
            Array.prototype.forEach.call(bar.querySelectorAll('.headerOrderType'), function (el) {
                el.textContent = ORDER_TYPE_LABELS[orderType] || 'Set order type';
            });
            // The outlet row says nothing before a location exists, and an empty
            // "Selected Outlet" row reads as a rendering fault. v1's fixed
            // order-type section goes with it: v1 is not being changed here, and
            // its bar has its own rows for this.
            if (outletSec) outletSec.style.display = 'none';
            if (typeSec)   typeSec.style.display   = 'none';
            bar.style.display = '';
            return;
        }
        // Restore whatever the prompt state hid above.
        if (outletSec) outletSec.style.display = '';
        if (typeSec)   typeSec.style.display   = '';

        var displayLocality = has(locality) ? locality : (slug || '');
        var displayCity     = has(city) ? city : '';
        var displayOutlet   = displayLocality + (displayCity ? ', ' + displayCity : '');

        var addrEl  = bar.querySelector('#headerAddress');
        var lblEl   = bar.querySelector('#headerAddressLabel');
        var outEl   = bar.querySelector('#headerOutlet');
        var typeEls = bar.querySelectorAll('.headerOrderType');

        // v1 has a separate "Selected Outlet" row to fall back on, so an empty
        // address there can read "No location selected". v2's bar is one line
        // with no such row, so it falls back the way the desktop chip does —
        // address, then locality/city, then the outlet slug — and only says
        // "Select location" when there is genuinely nothing.
        // v2 ONLY. v1 is deliberately left alone: it has a separate "Selected Outlet"
        // row, so its "Your Location" honestly reads "No location selected" here and
        // never mislabelled the outlet as the user's address — verified against the
        // same state. v2 collapsed both into one chip, which is what made the outlet
        // fallback wrong. Nothing to fix on v1, and ~2,500 brands run it.
        if (addrEl) {
            // WHICH place this names depends on the order type, exactly as the
            // header chip's does (headerV2.js refreshLocation): delivery comes to
            // the customer, so it names their address; pickup, dine-in, in-car and
            // reservation happen AT the outlet, so naming their home address there
            // is simply false. The bar showed the address for every type, so a
            // visitor who chose pickup on the home page read "Set location" — or
            // worse, their own street — under a heading that said "Pick up from",
            // while the menu page's band (the same chip, reflowed) named the
            // outlet. Same words, same source, both widths.
            addrEl.textContent = isV2Bar
                ? ((AT_OUTLET_TYPES[orderType] ? displayOutlet : addr) || 'Select location')
                : (addr || 'No location selected');
        }
        if (lblEl) {
            if (addr && addrLabel) { lblEl.textContent = addrLabel; lblEl.style.display = ''; }
            else                   { lblEl.style.display = 'none'; }
        }
        if (outEl) outEl.textContent = displayOutlet;
        // Same prompt as the desktop chip when no type is stored. v2 ONLY: v1's bar
        // keeps its 'Delivery' default, since v1 is not being changed here.
        Array.prototype.forEach.call(typeEls, function (el) {
            el.textContent = ORDER_TYPE_LABELS[orderType] || (isV2Bar ? 'Set order type' : 'Delivery');
        });
        bar.style.display = '';
    }

    function changeOrderType() {
        // CI3 wla_home_20260507.js:1402-1429. The order-type step is only correct once the user
        // has entered their OWN location (userAddress). An outlet picked from the store locator
        // sets business/slug but no userAddress, so there's nothing to anchor the nearest-outlet
        // lookup — collect the location first: logged-in users see their saved-address listing,
        // anonymous users the entry step (CI3 changeOrderType :1410-1413 → changeUserLocation
        // :1327-1331). Don't wipe the stored outlet (CI3 :1403-1404) — if the user opens "Change"
        // and closes without picking anything, their current selection survives.
        var ud         = userData();
        var business   = localStorage.getItem('business');
        var hasOutlet  = business && business !== 'null';
        var addr       = localStorage.getItem('userAddress');
        var hasAddress = addr && addr !== 'null' && addr !== '';

        // ...or when the outlet itself is known, even without an address: its own
        // flags say which types it offers, and for pickup/dine-in/in-car there is
        // no address to anchor anything to. Delivery still collects one — see the
        // guard in selectOrderTypeAndRedirect().
        if (hasOutlet && (hasAddress || storedOutletCard())) {
            showLocationStep('orderType');
        } else {
            showLocationStep(ud.token && ud.contactMappingId ? 'savedAddresses' : 'location');
        }
        showOverlay();
    }

    // ─── Public globals (referenced from modal markup) ──────
    window.closeLocationFlow            = closeLocationFlow;
    window.CurrentAddress               = CurrentAddress;
    window.showLocationStep             = showLocationStep;
    // showOverlay is needed alongside showLocationStep when external callers
    // (e.g. productPage.js "+ Add") want to actually display the modal — without
    // it the step is set but the modal stays hidden.
    window.showLocationOverlay          = showOverlay;
    window.enterAddressSearchLocality   = enterAddressSearchLocality;
    window.homeSearchLocality           = homeSearchLocality;
    window.openHomeAddressForm          = openHomeAddressForm;
    window.openEditAddressForm          = openEditAddressForm;
    window.homeAddrGoToCurrentLocation  = homeAddrGoToCurrentLocation;
    window.confirmLocationAndShowForm   = confirmLocationAndShowForm;
    window.homeChangeOnMap              = homeChangeOnMap;
    window.backToLocationMap            = backToLocationMap;
    window.closeAddressForm             = closeAddressForm;
    window.saveHomeAddress              = saveHomeAddress;
    window.selectOrderTypeAndRedirect   = selectOrderTypeAndRedirect;
    window.openLoginOrSavedAddresses    = openLoginOrSavedAddresses;
    window.changeUserLocation           = changeUserLocation;
    window.exploreNearestOutlet         = exploreNearestOutlet;
    window.cancelRedirect               = cancelRedirect;
    window.changeOrderType              = changeOrderType;

    // ─── Widget click gate ──────────────────────────────────
    // Intercept clicks on anchors targeting outlet-dependent paths. If the user has no outlet
    // (slug + business), open the modal and queue the destination for after order-type pick.
    // If the user has an outlet, /online-order shortcuts straight to /order/{slug} (CI3 parity,
    // wla_home_20260507.js:638-700). Other gated hrefs proceed normally.
    // Product pages (/products, /product-detail/...) are intentionally NOT gated —
    // users should browse the catalogue freely; the location modal is triggered by
    // productPage.js when they click "+ Add" on an item (the action that actually
    // needs an outlet).
    // `/online-order` is intentionally NOT gated — it's the store-locator page where
    // anonymous users browse outlets. Picking an outlet there sets localStorage via the
    // .sl-cta--primary handler below.
    // Single-outlet brands: seed the one outlet so the header has something to
    // show. Nothing else does it any more — the disabled-flow branch that used to
    // is no longer taken now that these brands run the journey, and arriving on
    // /order/{slug} directly writes no location at all. The visible symptom was a
    // visitor going straight to the menu, coming back to home, and finding the
    // chip on "Set location" for a brand with exactly one outlet.
    //
    // The two keys are seeded on different rules, because they answer to different
    // owners:
    //
    //   slug — always overwritten, as the config-0 branch above does and for the
    //     same reason: with one outlet the only correct slug is this one, so a
    //     value left over from a RENAMED outlet is a stale cache, not a choice.
    //     Leaving it strands the visitor on /order/{unknown-slug}, which 302s back
    //     to home and reads as "the category click just reloads the page". Safe to
    //     stamp even after a journey pick — that journey can only have resolved to
    //     this same single outlet.
    //
    //   city/locality — only when unset. These are the VISITOR's, written by the
    //     journey from the address they chose. Re-stamping the outlet's over the
    //     top on the next page load would quietly replace where they are
    //     delivering to with where the shop is.
    (function _seedSoleOutlet() {
        if (Number(AppConfig.storesCount) !== 1) return;

        var d = window.storesDetails;
        if (!d || !d.length) return;
        var store = d[0];
        var slug  = store.web_slug || store.slug || '';
        if (!slug) return;

        localStorage.setItem('slug', slug);

        var haveCity     = localStorage.getItem('city');
        var haveLocality = localStorage.getItem('locality');
        if (store.city     && (!haveCity     || haveCity     === 'null')) localStorage.setItem('city',     store.city);
        if (store.locality && (!haveLocality || haveLocality === 'null')) localStorage.setItem('locality', store.locality);

        if (typeof window.hdr2RefreshHeader === 'function') window.hdr2RefreshHeader();
    }());

    // ─── Adopt the outlet whose menu we are on ──────────────
    // A visitor who lands on /order/{slug} from a shared link, a search result or
    // a QR code never runs the location journey, so nothing is stored. The MENU
    // page still showed the outlet, because the header chip falls back to
    // window.OutletConfig (headerV2.js) — but every other page has no such
    // fallback, so the same header went from "Pick up from · DLF Midtown Plaza"
    // to "Set location" on the next click, as if the visit had been forgotten.
    //
    // The page is the server's own statement of which outlet this is, so record
    // it, exactly as checkout.js does from CheckoutConfig and as the single-outlet
    // seeder above does from storesDetails. Same two rules as that seeder:
    //
    // All four keys are stamped, not merged. commitAndRedirect() above already
    // overwrites city/locality with the committed OUTLET's values on every
    // journey (CI3 wla_home_20260507.js:2347-2353) precisely so the header names
    // the outlet — the visitor's own address lives in userAddress, which nothing
    // here touches. Merging instead would leave a visitor who committed outlet A
    // and then opened outlet B's menu reading "Pick up from <A's locality>" over
    // B's menu. Being on an outlet's page is the same assertion as picking it.
    (function _seedCurrentOutlet() {
        // v2 headers only. The seeding would be just as correct under v1, but v1
        // runs on every live brand and slug/business are state the cart and
        // checkout read — that is not a change to make on the whole fleet to fix
        // a mismatch reported in the v2 header. Drop this line to widen it.
        if (!document.querySelector('.site-header.hdr2')) return;

        var oc = window.OutletConfig;
        if (!oc || !oc.slug) return;

        localStorage.setItem('slug', String(oc.slug));
        if (oc.businessId) localStorage.setItem('business', String(oc.businessId));

        if (oc.city)     localStorage.setItem('city',     String(oc.city));
        if (oc.locality) localStorage.setItem('locality', String(oc.locality));

        // Also keep the outlet as a STORE RECORD, in the shape renderOrderTypes()
        // and commitAndRedirect() already take. Without it the order-type step is
        // unreachable off the menu page: it is built around "find the outlet
        // nearest these coordinates", and a visitor who arrived on /order/{slug}
        // from a link has no coordinates, so loadOrderTypes() bounced them to
        // address entry — while the menu page a click earlier switched order type
        // instantly. Same outlet, same choice, two different journeys.
        //
        // OutletConfig.orderTypes already carries the four flags, so this costs no
        // request and no view change. Keyed by business id and checked on read, so
        // a later journey pick (which writes a different `business`) retires it
        // rather than answering for the wrong outlet.
        var ot = oc.orderTypes || {};
        try {
            localStorage.setItem(OUTLET_CARD_KEY, JSON.stringify({
                id: String(oc.businessId || ''),
                slug: String(oc.slug || ''),
                city: String(oc.city || ''),
                locality: String(oc.locality || ''),
                onlineOrdersDelivery:   Number(ot.delivery) === 1 ? 1 : 0,
                onlineDeliveryOn:       Number(ot.delivery) === 1 ? 1 : 0,
                onlineOrdersSelfPickup: Number(ot.pickup)   === 1 ? 1 : 0,
                dineInOrders:           Number(ot.dine_in)  === 1 ? 1 : 0,
                inCarOrders:            Number(ot.in_car)   === 1 ? 1 : 0,
            }));
        } catch (e) { /* storage full or blocked — the step just falls back */ }

        updateHeaderInfoBar();
        if (typeof window.hdr2RefreshHeader === 'function') window.hdr2RefreshHeader();
    }());

    var GATED_HREF_RE = /^\/(order\/|cart|checkout)(\/|$|\?)/;

    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target.closest('a[href]');
        if (!a) return;
        if (a.target === '_blank') return;
        // Store-locator cards are the explicit outlet-pick surface — never gate them.
        if (a.closest('.sl-card')) return;
        var href = a.getAttribute('href') || '';
        if (!GATED_HREF_RE.test(href)) return;
        // One outlet → nothing for this gate to resolve. A /order/ link already
        // names the only outlet there is, so stopping it to ask "where?" gates a
        // choice the brand has already made. Those brands keep the journey on the
        // header controls; every other route in runs unimpeded. /cart and
        // /checkout follow the same reasoning — they act on a cart that can only
        // belong to that one outlet.
        //
        // This also preserves how those brands behaved before they were given the
        // journey: their config was forced to 0, so this module returned early and
        // the gate was never installed for them at all.
        if (Number(AppConfig.storesCount) === 1) return;

        var slug     = localStorage.getItem('slug');
        var business = localStorage.getItem('business');
        var hasOutletPick = slug && slug !== 'null' && business && business !== 'null';

        if (hasOutletPick) return; // gated paths proceed naturally when outlet is set

        e.preventDefault();
        window._lpPendingNav = href;
        var ud = userData();
        showLocationStep(ud.token && ud.contactMappingId ? 'savedAddresses' : 'location');
        showOverlay();
    }, true);

    // Store-locator outlet-pick — when user clicks the primary "Order Online" CTA
    // OR taps anywhere on the card (whole-card click in storeLocator.js fires a
    // synthetic click on the primary link, which bubbles here), persist the outlet
    // to localStorage so the home info bar shows the selection. Let the link
    // navigate normally afterwards (to /order/{slug}).
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('.sl-cta--primary');
        if (!btn) return;
        var card = btn.closest('.sl-card');
        if (!card) return;
        var d = card.dataset || {};
        var cardSlug     = d.slug || '';
        var cardBusiness = d.business || '';
        if (!cardSlug || !cardBusiness) return;
        // Display-friendly locality (with original casing) when available, lowercase fallback.
        var locality = d.localityDisplay || d.locality || '';
        var city     = d.city || '';
        localStorage.setItem('slug',      cardSlug);
        localStorage.setItem('business',  cardBusiness);
        if (locality) localStorage.setItem('locality', locality);
        if (city)     localStorage.setItem('city',     city);
        // Picking an outlet is NOT the user entering their own delivery location (CI3
        // wla_home_20260507.js:3111-3114 stores only business/slug/city/locality — no coords,
        // no userAddress). So clear any stale user address (and the saved-address id it came
        // from): "Your Location" must read "No location selected" (CI3 header.php:564), and
        // changeOrderType() must route to the address step — not the order-type step — until
        // the user actually sets their location.
        localStorage.removeItem('userLat');
        localStorage.removeItem('userLng');
        localStorage.removeItem('userLocSource');
        localStorage.removeItem('userAddress');
        localStorage.removeItem('userAddressLabel');
        localStorage.removeItem('deliveryAddressId');
        localStorage.removeItem('selectedDeliveryAddressId');
        localStorage.setItem('locationSelectedAt', String(Date.now()));
        document.cookie = 'view_business=' + cardBusiness + '; path=/; max-age=2592000';
        updateHeaderInfoBar();
    }, true);

    // Silver-theme widget handlers — `silverCatClick(section, outletSlug, noOfStores)` is
    // inlined by widget partials and already includes its own location gate, but it doesn't
    // queue a post-pick destination; `silverItemClick(section, itemSlug, bId)` is referenced
    // in markup but NOT defined inline (broken in the legacy template), so the +Add buttons
    // on home item cards silently fail. We override both with versions that:
    //   • If location set → navigate to /order/{userOutlet}?section_slug&item_slug
    //   • If no location → queue section + item, open the modal; redirect happens after
    //     order-type selection (selectOrderTypeAndRedirect consumes _lpPendingSection/Item).
    // One outlet → a tile has nothing to disambiguate, so it goes straight to that
    // outlet's menu instead of opening the journey. Those brands DO run the journey
    // now (base.php stopped forcing their config to 0), but it belongs to the header
    // controls alone: "where do I deliver to" and "which order type" are worth asking
    // on demand, while a category tile asking them first is a gate in front of a
    // choice that was already made by the brand having a single store.
    //
    // Slug sources in order: the one the widget passed, the home page's
    // storesDetails, then localStorage. Returns '' when none resolves, and the
    // callers fall through to the normal gate rather than navigating to /order/.
    function _soleOutletSlug(passed) {
        if (Number(AppConfig.storesCount) !== 1) return '';
        if (passed && passed !== 'null') return String(passed);
        var d = window.storesDetails;
        if (d && d.length) {
            var slug = d[0].web_slug || d[0].slug || '';
            if (slug) return String(slug);
        }
        var stored = localStorage.getItem('slug');
        return (stored && stored !== 'null') ? String(stored) : '';
    }

    function _gatedSilverCatClick(sectionSlug, outletSlug, noOfStores) {
        var sole = _soleOutletSlug(outletSlug);
        if (sole) {
            var soleUrl = '/order/' + sole;
            if (sectionSlug) soleUrl += '?section_slug=' + encodeURIComponent(sectionSlug);
            window.location.href = soleUrl;
            return;
        }
        var s  = localStorage.getItem('slug');
        var b  = localStorage.getItem('business');
        var ok = s && s !== 'null' && b && b !== 'null';
        if (!ok) {
            if (sectionSlug) window._lpPendingSection = sectionSlug;
            var u = userData();
            showLocationStep(u.token && u.contactMappingId ? 'savedAddresses' : 'location');
            showOverlay();
            return;
        }
        var target = (Number(noOfStores) === 1 && outletSlug && outletSlug !== 'null') ? outletSlug : s;
        var url = '/order/' + target;
        if (sectionSlug) url += '?section_slug=' + encodeURIComponent(sectionSlug);
        window.location.href = url;
    }

    function _gatedSilverItemClick(sectionSlug, itemSlug, businessId) {
        // Third arg is a businessId, not a slug, so nothing to pass through here —
        // _soleOutletSlug falls back to storesDetails (see home.php).
        var sole = _soleOutletSlug('');
        if (sole) {
            var soleQs = [];
            if (sectionSlug) soleQs.push('section_slug=' + encodeURIComponent(sectionSlug));
            if (itemSlug)    soleQs.push('item_slug=' + encodeURIComponent(itemSlug));
            window.location.href = '/order/' + sole + (soleQs.length ? '?' + soleQs.join('&') : '');
            return;
        }
        var s  = localStorage.getItem('slug');
        var b  = localStorage.getItem('business');
        var ok = s && s !== 'null' && b && b !== 'null';
        if (!ok) {
            if (sectionSlug) window._lpPendingSection  = sectionSlug;
            if (itemSlug)    window._lpPendingItemSlug = itemSlug;
            var u = userData();
            showLocationStep(u.token && u.contactMappingId ? 'savedAddresses' : 'location');
            showOverlay();
            return;
        }
        var url = '/order/' + s;
        var qs  = [];
        if (sectionSlug) qs.push('section_slug=' + encodeURIComponent(sectionSlug));
        if (itemSlug)    qs.push('item_slug=' + encodeURIComponent(itemSlug));
        if (qs.length) url += '?' + qs.join('&');
        window.location.href = url;
    }

    function _installSilverWidgetHandlers() {
        window.silverCatClick  = _gatedSilverCatClick;
        window.silverItemClick = _gatedSilverItemClick;
    }
    // Replace BEFORE DOMContentLoaded so inline definitions later in the page can't override
    // ours — and again after, in case they do (script load order varies). Both stages are
    // idempotent because we install the same reference.
    _installSilverWidgetHandlers();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _installSilverWidgetHandlers);
    }
    window.addEventListener('load', _installSilverWidgetHandlers);

    // Home widget menu-item / ADD-button gate — these cards render as <article> without
    // an href, so the URL gate above misses them. On the home page (only) intercept clicks
    // on .add-ctrl__btn / .wla-best__btn and .item / .wla-best__card card bodies so they
    // participate in the location flow (open modal if no outlet, else jump to /order/{slug}
    // with the item preselected — never /product-detail from the home rails).
    // On /products and /product-detail/* this is handled by productPage.js — skip there.
    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Active only on the home route; other pages have their own +Add wiring.
        var path = window.location.pathname || '/';
        if (path !== '/' && path !== '') return;

        // v2 widgets' "Shop the full menu" link — same gate, no item: outlet known
        // -> /order/{slug}; otherwise queue and open the journey. Handled here (not
        // in the widget) because this module owns location-gated routing.
        var menuLink = e.target.closest('[data-w2-menu-link]');
        if (menuLink) {
            e.preventDefault();
            _gatedSilverCatClick('', '', 0);
            return;
        }

        var addBtn   = e.target.closest('.add-ctrl__btn, .wla-best__btn');
        var itemCard = addBtn ? null : e.target.closest('.item, .wla-best__card');
        if (!addBtn && !itemCard) return;

        // If the card itself is wrapped in <a>, the URL gate already covered it.
        var card = addBtn ? (addBtn.closest('.item') || addBtn.closest('.wla-best__card')) : itemCard;
        if (!card || card.tagName === 'A') return;

        var itemSlug = card.getAttribute('data-item-slug') || '';
        var slug     = localStorage.getItem('slug');
        var business = localStorage.getItem('business');
        var hasOutletPick = slug && slug !== 'null' && business && business !== 'null';

        e.preventDefault();
        if (hasOutletPick) {
            // Outlet known — jump straight to the menu (with the item preselected if we have a slug).
            var qs = itemSlug ? '?item_slug=' + encodeURIComponent(itemSlug) : '';
            window.location.href = '/order/' + slug + qs;
            return;
        }

        // No outlet yet — queue a sensible destination, then open the location flow.
        // Catalog URL words are brand-configurable (default products / product-detail).
        var _cfg = window.AppConfig || {};
        var _listSlug = _cfg.catalogSlug || 'products';
        var _detailSlug = _cfg.catalogDetailSlug || 'product-detail';
        window._lpPendingNav = itemSlug ? '/' + _detailSlug + '/' + itemSlug : '/' + _listSlug;
        var ud2 = userData();
        showLocationStep(ud2.token && ud2.contactMappingId ? 'savedAddresses' : 'location');
        showOverlay();
    }, true);

    updateHeaderInfoBar();

    // Publish the real header height as --site-header-h so the location bar's
    // sticky `top` docks flush under it. Keeps the offset correct regardless of
    // logo size / nav padding (no magic numbers); re-synced on resize + font load.
    (function syncHeaderHeight() {
        function sync() {
            var h = document.querySelector('.site-header');
            if (!h) return;
            var px = Math.round(h.getBoundingClientRect().height);
            if (px > 0) document.documentElement.style.setProperty('--site-header-h', px + 'px');
        }
        sync();
        window.addEventListener('resize', sync, { passive: true });
        window.addEventListener('load', sync, { passive: true });
    })();

    // Sticky scroll behavior — add `location-bar-scrolled` class on scroll, remove at top.
    (function attachStickyScroll() {
        var bar = document.getElementById('locationInfoBar');
        if (!bar) return;
        var ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            window.requestAnimationFrame(function () {
                var y = window.pageYOffset || document.documentElement.scrollTop || 0;
                bar.classList.toggle('location-bar-scrolled', y > 8);
                ticking = false;
            });
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    })();

    // Keep the bar in sync after the flow runs. The visibility/contents are otherwise
    // computed only once on load, so a selection made inside the modal (or in another tab)
    // wouldn't reflect until a full reload — and a cancelled "Change" could leave it stale.
    modalEl.addEventListener('hidden.bs.modal', updateHeaderInfoBar);
    // menu.js dispatches this when the order type changes in the SAME tab (its strip,
    // or the outlet default it adopts on load), which fires no `storage` event. The bar
    // carries its own .headerOrderType copy, so without this the mobile bar went stale
    // while the desktop chip updated. Subscribed HERE rather than widening headerV2's
    // selector: this function owns the bar's copy, and two writers for one element is
    // how they drift apart.
    document.addEventListener('ordertype:changed', updateHeaderInfoBar);
    window.addEventListener('storage', function (e) {
        if (!e.key || _LP_LOCATION_KEYS.indexOf(e.key) !== -1) updateHeaderInfoBar();
    });

    // ─── Auto-open on first visit ───────────────────────────
    // CI3 wla_home_20260507.js:2483-2512 — modal is suppressed only when the user has a
    // confirmed outlet tuple (slug + business). userLat/userLng alone don't count because
    // they're written before order-type selection completes. If a user does GPS but never
    // picks an order type, slug/business stay empty and the modal must reopen.
    function maybeAutoOpen() {
        if (!AppConfig.autoOpenLocationModal) return;
        var slug     = localStorage.getItem('slug');
        var business = localStorage.getItem('business');
        var hasOutlet = slug && slug !== 'null' && business && business !== 'null';
        if (hasOutlet) return;
        // CI3 parity (wla_20260417.js:2134): don't stack the location modal on top of the
        // first-login welcome form. This Bootstrap modal's focus-trap would steal keystrokes
        // from the welcome form's inputs, leaving it visible but un-typeable. firstLoginProfile.js
        // runs just before this script, so the overlay is already shown when name is empty.
        // The user can reopen location selection from the header pill after finishing the form.
        var pp = document.getElementById('profilePromptModal');
        if (pp && !pp.hasAttribute('hidden')) return;
        var ud = userData();
        showLocationStep(ud.token ? 'savedAddresses' : 'location');
        showOverlay();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', maybeAutoOpen);
    } else {
        maybeAutoOpen();
    }
})();

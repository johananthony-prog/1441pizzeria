'use strict';

/**
 * Shared add/edit delivery-address form controller (map + reverse-geocode + save).
 *
 * One self-contained module driving the #addAddModal partial
 * (app/Views/themes/ue_default/partials/address_form_modal.php), reused by BOTH
 * checkout.js and manageAddresses.js. Replaces the previous arrangement where
 * each page carried its own copy of the map/geocode logic (checkout inline,
 * Manage Addresses delegated to location_picker.js — which silently no-ops on
 * single-outlet brands because the location flow is disabled there).
 *
 * CI3 parity: the address form is standalone, NOT coupled to the outlet/location
 * picker (manage_address.php #addAddModal). Edit reuses the add modal pre-filled;
 * the presence of deliveryAddressId in the save body is what makes the upstream
 * UPDATE rather than INSERT.
 *
 * Usage:
 *   const form = createAddressForm({
 *     businessId,                       // parent business id
 *     outlet: { lat, lng, slug },       // current outlet (checkout) — map fallback + serviceability + switch
 *     serviceability: true|false,       // gate the save on /client/checkDelivery (checkout: true, manage: false)
 *     onSaved: (saved, resp) => {},     // post-save hook (caller refreshes its list / selection / toast)
 *     onError: (msg) => {},             // save failure (defaults to alert)
 *   });
 *   form.openAdd();
 *   form.openEdit(addr);                // addr: { id, addressLine1, addressLine2, locality, city, state,
 *                                       //         pinCode, mobile, email, lat, lng, label }
 */

import { getApiBase } from './config.js';
import { requestGeolocation } from './geo.js?v=20260923a';

// The map pin is a static CSS element (.addr-map__pin) centred over #addrMapCanvas
// and rendered in the modal markup — the map moves under it (drag-the-map UX), so no
// google.maps.Marker / L.marker instance is created here.

function el(id) { return document.getElementById(id); }

function esc(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function userData() {
    try { return JSON.parse(localStorage.getItem('userdata') || 'null') || {}; }
    catch { return {}; }
}

// "locality, city" for the confirmed-location card — appends city only when the locality
// doesn't already contain it (avoids "Kolkata, Kolkata" / "Panchkula, Panchkula").
function locCity(locality, city) {
    locality = locality || ''; city = city || '';
    if (city && locality.toLowerCase().indexOf(city.toLowerCase()) === -1) {
        return locality ? (locality + ', ' + city) : city;
    }
    return locality || city;
}

// Google flow requires BOTH a maps key AND maps_flow=1 — same gate the home picker uses.
// A key-bearing brand with maps_flow=0 is a HYBRID brand and uses Leaflet + AJAX.
function hasMapKey() {
    return Boolean(window.AppConfig?.mapsKey) && Number(window.AppConfig?.mapsFlow) === 1;
}

function loadLeaflet() {
    if (window.L?.map) return Promise.resolve();
    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        s.onload = resolve; document.head.appendChild(s);
    });
}

function loadGoogleMaps() {
    if (window.google?.maps?.Map) return Promise.resolve();
    if (window._gmapsPromise) return window._gmapsPromise;
    window._gmapsPromise = new Promise((resolve) => {
        window._gmapsReady = resolve;
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${window.AppConfig.mapsKey}&libraries=places&loading=async&callback=_gmapsReady`;
        document.head.appendChild(s);
    });
    return window._gmapsPromise;
}

function apiKeyHeaders() { return { 'api-key': window.AppConfig?.staticApiKey || '' }; }

// Render a save/validation failure inline in the form's styled error banner
// (#addrFormError → .addr-form-error), NOT a native alert(). This is the default
// onError for callers that don't pass their own (e.g. checkout) — the upstream
// "…not Serviceable By This Outlet" message now surfaces in the form instead of a
// browser alert. Manage Addresses supplies its own toast handler and is unaffected.
function showInlineFormError(message) {
    const err = el('addrFormError');
    // No native alert() fallback — a blocking OS dialog looks broken and doesn't match the
    // design. If the styled banner is somehow absent, warn to the console instead (non-blocking).
    if (!err) { console.warn('[addressForm]', message); return; }
    err.textContent = message;
    err.hidden = false;
    err.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function createAddressForm(opts = {}) {
    const cfg = {
        businessId:     opts.businessId || window.AppConfig?.businessId || '',
        outlet:         opts.outlet || {},
        serviceability: opts.serviceability !== false, // default ON (checkout); manage passes false
        onSaved:        typeof opts.onSaved === 'function' ? opts.onSaved : () => {},
        onError:        typeof opts.onError === 'function' ? opts.onError : showInlineFormError,
    };

    const state = { map: null, geocoder: null, lat: null, lng: null, serviceable: false, svcChecked: false, infoReady: false, outletAvailable: false, geocoding: false, label: 'home', editId: null };

    // ─── Modal open/close ─────────────────────────────────────────
    function open()  { const m = el('addAddModal'); if (m) m.hidden = false; }
    function close() { const m = el('addAddModal'); if (m) m.hidden = true; }

    // ─── Save-button gate ─────────────────────────────────────────
    function setSaveBtnState(enabled, message) {
        const btn = el('saveNewAddressBtn');
        const err = el('addrFormError');
        if (btn) btn.disabled = !enabled;
        if (err) {
            if (enabled || !message) { err.hidden = true; err.textContent = ''; }
            else                     { err.hidden = false; err.textContent = message; }
        }
    }
    function evaluateSaveBtnState() {
        const lat      = el('addrLat')?.value || '';
        const lng      = el('addrLng')?.value || '';
        const locality = el('addrLocality')?.value?.trim() || '';
        const city     = el('addrCity')?.value?.trim()     || '';
        if (!lat || !lng)                 { setSaveBtnState(false, 'Select location on map to continue'); return; }
        if (state.serviceable !== true)   { setSaveBtnState(false, '');                                   return; }
        if (!locality || !city)           { setSaveBtnState(false, 'Select location on map to continue'); return; }
        setSaveBtnState(true, 'Save Address');
    }

    function setConfirmLocationBtnState(enabled) {
        const btn = el('addrConfirmLocationBtn');
        if (!btn) return;
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '1' : '0.5';
    }

    // Single source of truth for the bottom-of-map state, driven by the state flags.
    function refreshMapPanel() {
        const pinPlaced      = state.lat != null && state.lng != null;
        const resolved       = state.infoReady === true;
        const serviceable    = state.serviceable === true;
        const notServiceable = pinPlaced && state.svcChecked === true && !serviceable;
        const showOutlet = notServiceable && state.outletAvailable === true;
        const showInfo   = resolved && serviceable;
        const showLoading = pinPlaced && state.geocoding === true && !resolved;
        el('addrOutletCard') && (el('addrOutletCard').hidden = !showOutlet);
        el('addrMapInfo')    && (el('addrMapInfo').hidden    = !showInfo);
        el('addrMapLoading') && (el('addrMapLoading').hidden = !showLoading);
        el('addrSvcError')   && (el('addrSvcError').hidden   = true);
        el('addrMapHint')    && (el('addrMapHint').hidden    = pinPlaced);
        el('addrConfirmLocationBtn')    && (el('addrConfirmLocationBtn').hidden    = notServiceable);
        el('addrConfirmNotServiceable') && (el('addrConfirmNotServiceable').hidden = !notServiceable);
        setConfirmLocationBtnState(serviceable && resolved);
        // Toggling the cards above changed the panel height (desktop auto-height layout),
        // which resizes the map container — re-render so it doesn't show gray tiles.
        setTimeout(resizeMap, 80);
    }

    // Re-render the map after a container resize WITHOUT letting the resize's own moveend
    // re-geocode. invalidateSize preserves the centre, but getCenter() jitters by ~1e-5 after
    // a resize — past the dedupe tolerance — so the map-move handler would fire a second,
    // redundant geocode of the same point (the "2 calls / fluctuating between 2 addresses" bug).
    // The flag makes the move handlers skip that one programmatic moveend.
    function resizeMap() {
        const m = state.map;
        if (!m) return;
        state.suppressMoveGeo = true;
        if (typeof m.invalidateSize === 'function') m.invalidateSize(); // default pan:true PRESERVES the centre
        else if (window.google?.maps?.event?.trigger) window.google.maps.event.trigger(m, 'resize');
        setTimeout(() => { state.suppressMoveGeo = false; }, 300);
    }

    // ─── Pin pipeline ─────────────────────────────────────────────
    async function onMarkerMove(lat, lng) {
        state.lat = lat; state.lng = lng;
        state.infoReady       = false;
        state.outletAvailable = false;
        state.geocoding       = true;
        const latEl = el('addrLat'); const lngEl = el('addrLng');
        if (latEl) latEl.value = lat; if (lngEl) lngEl.value = lng;

        if (cfg.serviceability) {
            state.serviceable = false; // clear prior verdict
            state.svcChecked  = false;
        } else {
            // Manage Addresses: no current outlet to validate against (CI3 manage form just
            // saves). Treat every pin as serviceable so the resolved label + save gate work.
            state.serviceable = true;
            state.svcChecked  = true;
        }
        setConfirmLocationBtnState(false);
        refreshMapPanel();

        if (hasMapKey()) reverseGeocode(lat, lng);
        else             hybridReverseGeocode(lat, lng);
        if (cfg.serviceability) await checkServiceability(lat, lng);
    }

    function reverseGeocode(lat, lng) {
        if (!state.geocoder) return;
        state.geocoder.geocode({ location: { lat, lng } }, (results, status) => {
            state.geocoding = false;
            if (status !== 'OK' || !results?.length) { refreshMapPanel(); return; }
            const comps = results[0].address_components;
            const full  = results[0].formatted_address || '';
            const get = (...types) => comps.find(c => types.some(t => c.types.includes(t)))?.long_name || '';
            const city     = get('administrative_area_level_2', 'locality');
            const locality = get('sublocality_level_1', 'sublocality', 'neighborhood') || city;
            const stateNm  = get('administrative_area_level_1');
            const pincode  = get('postal_code');
            if (el('addrLocality')) el('addrLocality').value = locality;
            if (el('addrCity'))     el('addrCity').value     = city;
            if (el('addrState'))    el('addrState').value    = stateNm;
            if (el('addrPincode'))  el('addrPincode').value  = pincode;
            // addrMapSearch is deliberately NOT cleared. This runs on every geocode,
            // including the one fired as the form opens, so clearing it wiped the text
            // of anyone who started typing while the map was still loading. It is also
            // the only thing on screen saying what was searched FOR — without it a
            // wrong result cannot be recognised as wrong, let alone corrected, since
            // the info box below reports where the pin landed, not what was asked.
            if (el('addrMapInfoLocality'))  el('addrMapInfoLocality').textContent = locCity(locality, city);
            if (el('addrMapInfoFull'))      el('addrMapInfoFull').textContent     = full;
            if (el('addrFormInfoLocality')) el('addrFormInfoLocality').textContent = locCity(locality, city);
            if (el('addrFormInfoFull'))     el('addrFormInfoFull').textContent     = full;
            el('addrFormInfo') && (el('addrFormInfo').hidden = !(locality || city || full));
            state.infoReady = Boolean(locality || city || full);
            refreshMapPanel();
            evaluateSaveBtnState();
        });
    }

    // ─── Hybrid (non-Google) flow ─────────────────────────────────
    function hybridReverseGeocode(lat, lng) {
        const ud = userData();
        let qs = `?lat=${lat}&lng=${lng}&businessId=${window.AppConfig?.businessId || ''}`;
        if (ud.token && ud.contactMappingId) {
            qs += `&contactMappingId=${encodeURIComponent(ud.contactMappingId)}&token=${encodeURIComponent(ud.token)}`;
        } else {
            qs += `&hashKey=${encodeURIComponent(window.AppConfig?.geocodeHashKey || '')}`;
        }
        fetch(`${getApiBase()}/maps/getGeocodeAddress${qs}`, { method: 'GET', headers: apiKeyHeaders(), credentials: 'omit' })
            .then(r => r.json())
            .then(d => {
                state.geocoding = false;
                if (!d || Number(d.status) !== 1) { refreshMapPanel(); return; }
                const locality = d.locality || d.city || '';
                const city     = d.city || '';
                const full     = d.formatted_Address || [locality, city].filter(Boolean).join(', ');
                if (el('addrLocality')) el('addrLocality').value = locality;
                if (el('addrCity'))     el('addrCity').value     = city;
                // Left alone for the same reason as the Google branch above.
                if (el('addrMapInfoLocality'))  el('addrMapInfoLocality').textContent = locCity(locality, city);
                if (el('addrMapInfoFull'))      el('addrMapInfoFull').textContent     = full;
                if (el('addrFormInfoLocality')) el('addrFormInfoLocality').textContent = locCity(locality, city);
                if (el('addrFormInfoFull'))     el('addrFormInfoFull').textContent     = full;
                el('addrFormInfo') && (el('addrFormInfo').hidden = !(locality || city || full));
                state.infoReady = Boolean(locality || city || full);
                refreshMapPanel();
                evaluateSaveBtnState();
            })
            .catch(() => { state.geocoding = false; refreshMapPanel(); });
    }

    let searchTimer = null;
    function hybridSearchLocality(keyword) {
        clearTimeout(searchTimer);
        const resultsEl = el('addrMapResults');
        keyword = (keyword || '').trim();
        if (keyword.length < 3) {
            if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ''; }
            return;
        }
        if (resultsEl) {
            resultsEl.innerHTML = '<li class="addr-map__result addr-map__result--loading"><span class="addr-map__spinner" aria-hidden="true"></span>Searching…</li>';
            resultsEl.hidden = false;
        }
        searchTimer = setTimeout(() => {
            const url = `${getApiBase()}/maps/getLocalityByName?localityName=${encodeURIComponent(keyword)}`;
            fetch(url, { method: 'GET', headers: apiKeyHeaders(), credentials: 'omit' })
                .then(r => r.json())
                .then(d => {
                    let items = (d && Number(d.status) === 1 && (d.search_results || d.localities || d.data)) || [];
                    if (!Array.isArray(items)) items = [];
                    renderLocalityResults(items.slice(0, 20));
                })
                .catch(() => renderLocalityResults([]));
        }, 300);
    }

    function renderLocalityResults(items) {
        const resultsEl = el('addrMapResults');
        if (!resultsEl) return;
        if (!items.length) {
            resultsEl.innerHTML = '<li class="addr-map__result addr-map__result--empty">No matches</li>';
            resultsEl.hidden = false;
            return;
        }
        resultsEl.innerHTML = items.map(it => {
            const name = it.localityName || it.locality || it.name || '';
            const city = it.cityName || it.city || '';
            const lat  = it.latitude || it.lat || 0;
            const lng  = it.longitude || it.lng || it.long || 0;
            return `<li class="addr-map__result" data-lat="${esc(String(lat))}" data-lng="${esc(String(lng))}" data-locality="${esc(name)}" data-city="${esc(city)}">`
                 + `<span class="addr-map__result-name">${esc(name)}</span>`
                 + (city ? `<span class="addr-map__result-city">${esc(city)}</span>` : '')
                 + '</li>';
        }).join('');
        resultsEl.hidden = false;
        resultsEl.querySelectorAll('.addr-map__result:not(.addr-map__result--empty)').forEach(li => {
            li.addEventListener('click', () => selectLocality(li));
        });
    }

    function selectLocality(li) {
        const lat = parseFloat(li.dataset.lat);
        const lng = parseFloat(li.dataset.lng);
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
        const resultsEl = el('addrMapResults');
        if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ''; }
        // The SELECTED place's own label goes into the box, replacing whatever was
        // typed to find it. Once a result is chosen, the useful reference is which
        // place was picked, not the fragment that found it: if the pin lands
        // somewhere wrong, the name sitting in the field is what makes that visible
        // — and it is the starting point for correcting it. It used to be cleared,
        // which left nothing on screen to judge the pin against.
        const searchEl = el('addrMapSearch');
        if (searchEl) {
            const picked = [li.dataset.locality, li.dataset.city].filter(Boolean).join(', ');
            if (picked) searchEl.value = picked;
        }
        // setView moves the map → the moveend handler snaps the pin to the new centre and
        // geocodes it (ONE call). Don't also call onMarkerMove here or it double-geocodes.
        if (state.map) state.map.setView([lat, lng], 16);
    }

    // ─── Serviceability (checkout only) ───────────────────────────
    async function checkServiceability(lat, lng) {
        try {
            const ud  = userData();
            const qs  = new URLSearchParams({ businessId: cfg.businessId, contactMappingId: ud.contactMappingId || '', token: ud.token || '', latitude: lat, longitude: lng });
            const res = await fetch(`${getApiBase()}/client/checkDelivery?${qs}`, { headers: { 'Accept': 'application/json' } });
            const data = await res.json();
            state.svcChecked = true;
            if (data?.status == 1) {
                state.serviceable     = true;
                state.outletAvailable = false;
                refreshMapPanel();
            } else {
                state.serviceable = false;
                await findNearestOutlet(lat, lng);
            }
            evaluateSaveBtnState();
        } catch { /* network error — don't block UI */ }
    }

    async function findNearestOutlet(lat, lng) {
        try {
            const parentId = window.AppConfig?.businessId || '';
            const res  = await fetch(`${getApiBase()}/client/getNearestOpenOutlet?latitude=${lat}&longitude=${lng}&parentBusinessId=${parentId}`, { headers: { 'Accept': 'application/json' } });
            const data = await res.json();
            const outlet = data?.address;
            const isCurrentOutlet = outlet && cfg.outlet?.slug && outlet.slug === cfg.outlet.slug;
            if (data?.status == 1 && outlet && !isCurrentOutlet) {
                const fmt12 = (h, m) => { const hr = ((+h % 24) + 24) % 24; const hh = hr % 12 || 12; return `${hh}:${String(+m || 0).padStart(2, '0')} ${hr < 12 ? 'AM' : 'PM'}`; };
                const openFrom = fmt12(outlet.onlineOrdersStartHours, outlet.onlineOrdersStartMins);
                const openTo   = fmt12(outlet.onlineOrdersEndHours,   outlet.onlineOrdersEndMins);
                const info  = el('addrOutletInfo');
                if (info) info.innerHTML =
                    `<p class="addr-outlet-card__loc"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${esc(outlet.locality || '')}, ${esc(outlet.city || '')}</p>
                    <p class="addr-outlet-card__hours"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> <strong>Open from</strong> ${esc(openFrom)} to ${esc(openTo)}</p>`;
                const switchBtn = el('addrSwitchOutletBtn');
                if (switchBtn) switchBtn.dataset.slug = outlet.slug || '';
                state.outletAvailable = true;
            } else {
                state.outletAvailable = false;
            }
            refreshMapPanel();
        } catch {
            state.outletAvailable = false;
            refreshMapPanel();
        }
    }

    // ─── Map init ─────────────────────────────────────────────────
    function fallbackCenter() {
        const lat = parseFloat(cfg.outlet?.lat), lng = parseFloat(cfg.outlet?.lng);
        return (lat && lng) ? { lat, lng } : null;
    }

    async function initLeafletMap(lat, lng) {
        await loadLeaflet();
        if (state.map) { state.map.remove(); state.map = null; }
        state.map = window.L.map('addrMapCanvas', { scrollWheelZoom: false, doubleClickZoom: false }).setView([lat, lng], 15);
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(state.map);
        setTimeout(resizeMap, 200); // re-render after open; suppressMoveGeo stops its moveend re-geocoding
        await onMarkerMove(lat, lng);
        // Centre-pin UX: the pin is a static CSS element (.addr-map__pin) fixed at the map centre,
        // so the map moves under it (drag-the-map). ANY map movement — panning, scroll-dragging, or
        // clicking — ends by geocoding the new centre, keeping the pin + coach-mark aligned. Dedupe
        // against the last geocoded centre so resize-driven moves (invalidateSize) don't loop.
        let moveGeoTimer = null;
        state.map.on('moveend', () => {
            const c = state.map.getCenter();
            if (state.suppressMoveGeo) return;               // programmatic resize (invalidateSize) → don't re-geocode
            if (state.lat != null && Math.abs(c.lat - state.lat) < 1e-5 && Math.abs(c.lng - state.lng) < 1e-5) return;
            clearTimeout(moveGeoTimer);
            moveGeoTimer = setTimeout(() => onMarkerMove(c.lat, c.lng), 400); // debounce geocode → ONE call after the map settles
        });
        state.map.on('click', (e) => { state.map.panTo(e.latlng); });      // pan → moveend re-centres + geocodes
        const searchEl = el('addrMapSearch');
        if (searchEl) searchEl.oninput = (e) => hybridSearchLocality(e.target.value);
    }

    async function initGoogleMap(lat, lng) {
        await loadGoogleMaps();
        const center = { lat, lng };
        state.map = new window.google.maps.Map(el('addrMapCanvas'), { center, zoom: 16, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false });
        state.geocoder = new window.google.maps.Geocoder();
        await onMarkerMove(lat, lng);
        // Centre-pin UX (mirrors the Leaflet path): the pin is a static CSS element (.addr-map__pin)
        // fixed at the map centre, so the map moves under it (drag-the-map). `idle` fires after the
        // map settles; dedupe skips programmatic/tile moves (centre unchanged), and the geocode is
        // debounced so panning fires ONE call.
        let moveGeoTimer = null;
        state.map.addListener('idle', () => {
            const ctr = state.map.getCenter(); if (!ctr) return;
            const cl = ctr.lat(), cn = ctr.lng();
            if (state.suppressMoveGeo) return;               // programmatic resize → don't re-geocode
            if (state.lat != null && Math.abs(cl - state.lat) < 1e-5 && Math.abs(cn - state.lng) < 1e-5) return;
            clearTimeout(moveGeoTimer);
            moveGeoTimer = setTimeout(() => onMarkerMove(cl, cn), 400);
        });
        state.map.addListener('click', (e) => { if (e.latLng) state.map.panTo(e.latLng); });
        const autocomplete = new window.google.maps.places.Autocomplete(el('addrMapSearch'), { componentRestrictions: { country: 'in' } });
        autocomplete.addListener('place_changed', async () => {
            const place = autocomplete.getPlace();
            if (!place.geometry?.location) return;
            const lt = place.geometry.location.lat();
            const ln = place.geometry.location.lng();
            state.map.panTo({ lat: lt, lng: ln }); // pan → idle handler snaps pin + geocodes (ONE call)
        });
    }

    async function initMapAt(lat, lng) {
        if (hasMapKey()) await initGoogleMap(lat, lng);
        else             await initLeafletMap(lat, lng);
    }

    // Geolocation failures show on the MAP step (#addrLocateError), not the form banner —
    // on mobile the "Use my location" button lives on the map step, so the message must too.
    function showLocateError(message) {
        const box = el('addrLocateError');
        if (!box) { console.warn('[addressForm]', message); return; }
        box.textContent = message;
        box.hidden = false;
    }

    async function addrLocateCurrent() {
        el('addrLocateError') && (el('addrLocateError').hidden = true);
        const geo = await requestGeolocation();
        if (!geo.ok) { showLocateError('Unable to get your location. Please allow location access — this needs a secure (HTTPS) page.'); return; }
        const { lat, lng } = geo;
        // Move the map centre → the moveend/idle handler snaps the pin and geocodes (ONE call).
        // Don't also call onMarkerMove here or it double-geocodes.
        if (state.map) {
            if (hasMapKey()) state.map.setCenter({ lat, lng });
            else             state.map.setView([lat, lng], 15);
        }
    }

    // ─── Shared open reset ────────────────────────────────────────
    function setActiveChip(label) {
        const modal = el('addAddModal');
        if (!modal) return;
        modal.querySelectorAll('[data-type]').forEach(c => c.classList.toggle('chip--active', c.dataset.type === label));
    }

    function resetForOpen() {
        open();
        state.lat = null; state.lng = null;
        state.serviceable = false; state.svcChecked = false;
        state.infoReady = false; state.outletAvailable = false; state.geocoding = false;
        el('addrOutletCard') && (el('addrOutletCard').hidden = true);
        el('addrSvcError')   && (el('addrSvcError').hidden   = true);
        el('addrMapInfo')    && (el('addrMapInfo').hidden    = true);
        el('addrMapHint')    && (el('addrMapHint').hidden    = false);
        if (el('addrMapResults')) { el('addrMapResults').hidden = true; el('addrMapResults').innerHTML = ''; }
        if (el('addrMapInfoLocality')) el('addrMapInfoLocality').textContent = '';
        if (el('addrMapInfoFull'))     el('addrMapInfoFull').textContent     = '';
        // Map step on each open (mobile two-screen swap).
        el('addAddModal')?.classList.remove('is-addr-form');
        el('addrFormInfo') && (el('addrFormInfo').hidden = true);
        const confirmBtn = el('addrConfirmLocationBtn');
        if (confirmBtn) { confirmBtn.hidden = false; confirmBtn.disabled = true; confirmBtn.style.opacity = '0.5'; }
    }

    // ─── Public: add / edit ───────────────────────────────────────
    async function openAdd() {
        state.editId = null;
        state.label = 'home';
        setActiveChip('home');
        if (el('addrModalTitle'))   el('addrModalTitle').textContent = 'Add New Address';
        if (el('saveNewAddressBtn')) el('saveNewAddressBtn').textContent = 'Save Address & Deliver Here';
        // Clear all fields.
        ['addrHouseNo', 'addrLandmark', 'addrEmail', 'addrLocality', 'addrCity', 'addrState', 'addrPincode', 'addrMapSearch'].forEach(id => { if (el(id)) el(id).value = ''; });
        resetForOpen();
        const phone = el('addrPhone');
        if (phone) phone.value = userData().mobile || '';
        setSaveBtnState(false, 'Select location on map to continue');

        const geo    = await requestGeolocation();
        const center = geo.ok ? geo : fallbackCenter();
        if (!center) return;
        await initMapAt(center.lat, center.lng);
    }

    async function openEdit(addr) {
        addr = addr || {};
        state.editId = addr.id != null ? String(addr.id) : null;
        state.label  = (addr.label || 'home').toLowerCase();
        setActiveChip(state.label);
        if (el('addrModalTitle'))    el('addrModalTitle').textContent    = 'Edit Address';
        if (el('saveNewAddressBtn')) el('saveNewAddressBtn').textContent = 'Update Address';
        if (el('addrHouseNo'))  el('addrHouseNo').value  = addr.addressLine1 || '';
        if (el('addrLandmark')) el('addrLandmark').value = addr.addressLine2 || '';
        if (el('addrPhone'))    el('addrPhone').value    = addr.mobile || userData().mobile || '';
        if (el('addrEmail'))    el('addrEmail').value    = addr.email || '';
        if (el('addrLocality')) el('addrLocality').value = addr.locality || '';
        if (el('addrCity'))     el('addrCity').value     = addr.city || '';
        if (el('addrState'))    el('addrState').value    = addr.state || '';
        if (el('addrPincode'))  el('addrPincode').value  = addr.pinCode || '';
        resetForOpen();

        const lat = parseFloat(addr.lat), lng = parseFloat(addr.lng);
        const hasCoords = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
        const center = hasCoords ? { lat, lng } : (fallbackCenter());
        if (center) await initMapAt(center.lat, center.lng);
        // With prefilled locality/city + coords (and serviceability off on manage), unlock save.
        evaluateSaveBtnState();
    }

    // ─── Save ─────────────────────────────────────────────────────
    async function save() {
        const house    = el('addrHouseNo')?.value?.trim()  || '';
        const phone    = el('addrPhone')?.value?.trim()    || '';
        const locality = el('addrLocality')?.value?.trim() || '';
        const city     = el('addrCity')?.value?.trim()     || '';
        if (!house) { cfg.onError('Please enter house / flat / block no.'); return; }
        if (!phone) { cfg.onError('Please enter phone number.'); return; }
        if (!locality || !city) { cfg.onError('Please pick a serviceable location on the map.'); return; }

        try {
            const ud  = userData();
            const url = `${getApiBase()}/client/addDeliveryAddress/${cfg.businessId}/${ud.contactMappingId || ''}/${ud.token || ''}`;
            const fields = {
                addressLine1: house,
                addressLine2: el('addrLandmark')?.value?.trim() || '',
                locality,
                city,
                state:   el('addrState')?.value?.trim()   || '',
                pinCode: el('addrPincode')?.value?.trim() || '',
                name:    state.label,
                latitude:  state.lat || '',
                longitude: state.lng || '',
                contactId: ud.contactId || '',
                mobile:    phone,
                email:     el('addrEmail')?.value?.trim() || '',
                type:      state.label,
            };
            const body = new URLSearchParams(fields);
            // Edit → include deliveryAddressId so the upstream takes the UPDATE branch. For ADD,
            // never send it: PHP treats "0" != NULL as true, so deliveryAddressId:0 forces an
            // UPDATE (WHERE id=0 → 0 rows), returning status:1 but inserting nothing.
            if (state.editId) body.set('deliveryAddressId', state.editId);

            const res  = await fetch(url, { method: 'POST', headers: { 'Accept': 'application/json' }, body });
            const resp = await res.json();
            if (resp?.status == 1) {
                const saved = { ...fields, id: resp?.rows?.deliveryAddressId || state.editId, label: state.label, lat: state.lat, lng: state.lng, isEdit: Boolean(state.editId) };
                close();
                cfg.onSaved(saved, resp);
            } else {
                cfg.onError(resp?.msg || resp?.message || 'Could not save address.');
            }
        } catch (err) {
            console.warn('[addressForm] Save failed:', err);
            cfg.onError('Could not save address. Please try again.');
        }
    }

    // ─── Wire listeners (once per instance) ───────────────────────
    el('saveNewAddressBtn')?.addEventListener('click', save);
    el('addrLocateBtn')?.addEventListener('click', addrLocateCurrent);
    el('addrConfirmLocationBtn')?.addEventListener('click', () => { el('addAddModal')?.classList.add('is-addr-form'); });
    el('addrBackToMapBtn')?.addEventListener('click', () => { el('addAddModal')?.classList.remove('is-addr-form'); });
    // Green card's "Change on map" — mobile swaps back to the map screen (desktop shows both
    // panels already), then focuses + flashes the map search field so the user can re-pick.
    el('addrChangeOnMapBtn')?.addEventListener('click', () => {
        el('addAddModal')?.classList.remove('is-addr-form');
        const input = el('addrMapSearch');
        const wrap  = input?.closest('.addr-map__search');
        setTimeout(() => {
            input?.focus();
            if (!wrap) return;
            wrap.classList.add('addr-map__search--flash');
            setTimeout(() => wrap.classList.remove('addr-map__search--flash'), 1200);
        }, 60);
    });
    el('addrSwitchOutletBtn')?.addEventListener('click', () => {
        const slug = el('addrSwitchOutletBtn')?.dataset.slug;
        if (slug) window.location.href = `/order/${slug}`;
    });
    el('addAddModal')?.addEventListener('click', (e) => {
        // Self-contained close (overlay / cross) so the modal works on pages without a
        // global close handler (e.g. Manage Addresses). Harmless where one already exists.
        if (e.target.closest('.popup-close') || e.target === el('addAddModal')) { close(); return; }
        const chip = e.target.closest('[data-type]');
        if (!chip) return;
        setActiveChip(chip.dataset.type);
        state.label = chip.dataset.type;
    });

    return { openAdd, openEdit, close };
}

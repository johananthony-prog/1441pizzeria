/**
 * raiseConcern.js — "Raise a Concern" (Help & Support) global modal.
 *
 * Opened from the profile sidebar ([data-raise-concern]). Replaces the old
 * /contact-us redirect with the CI3 "raise a concern" popup behaviour.
 *
 * Verified contract (api.uengage.in, tested live with a real session token):
 *   GET  {apiBase}/support/getConcernType/{pId}/{contactMappingId}   [token header]
 *        → { status:1, concern_types:[{id, name, inputType, ...}] }
 *   GET  {apiBase}/pay/getOrderInfo?...&action=close_order           [token header]  (refund order list)
 *   GET  {apiBase}/client/getAllStores/{pId}?mobile=                 [token header]  (outlet list)
 *   POST {apiBase}/support/raiseConcern/{pId}/{contactMappingId}     [token header]
 *        form: { token, concernType, concern_details }
 *
 * NOTE: path order is {pId}/{contactMappingId} — the API validates the session
 * token against the contactMappingId in the path (CI3's JS had the two swapped).
 *
 * inputType drives the form: 1 = order picker (Refund), 2 = outlet + comment
 * (Quality), 3 = comment only (Feedback). concernType sent to raiseConcern is
 * the concern type's `id`.
 */
import { getApiBase, getBusinessId, apiCallForm } from './config.js';

const API = getApiBase();
const PID = getBusinessId();

const INPUT = { ORDER: 1, OUTLET: 2, COMMENT: 3 };

const $ = (id) => document.getElementById(id);

function getUser() {
    try { return JSON.parse(localStorage.getItem('userdata') || '{}'); }
    catch (e) { return {}; }
}

function authHeaders() {
    return { token: getUser().token || '' };
}

function getModal(id) {
    const el = $(id);
    if (!el || !window.bootstrap || !bootstrap.Modal) return null;
    return bootstrap.Modal.getOrCreateInstance(el);
}

function setState(msg) {
    const root = $('rcAccordion');
    if (root) root.innerHTML = '<p class="rc-state">' + msg + '</p>';
}

function showStatus(msg, ok) {
    const el = $('rcStatus');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle('rc-status--ok', !!ok);
    el.classList.toggle('rc-status--err', !ok);
}

function clearStatus() {
    const el = $('rcStatus');
    if (el) { el.hidden = true; el.textContent = ''; }
}

// ── Accordion construction ───────────────────────────────────────────────

const COPY = 'We are really sorry for this experience. Submit and our team will get back to you as soon as possible.';

function makeCard(type, idx) {
    const id        = Number(type.id);
    const inputType = Number(type.inputType) || id;
    const name      = String(type.name || 'Help');
    const bodyId    = 'rcBody' + id;

    const item = document.createElement('div');
    item.className = 'accordion-item';

    const header = document.createElement('h2');
    header.className = 'accordion-header';
    const btn = document.createElement('button');
    btn.className = 'accordion-button collapsed';
    btn.type = 'button';
    btn.setAttribute('data-bs-toggle', 'collapse');
    btn.setAttribute('data-bs-target', '#' + bodyId);
    btn.textContent = name;
    header.appendChild(btn);

    const collapse = document.createElement('div');
    collapse.id = bodyId;
    collapse.className = 'accordion-collapse collapse';
    collapse.setAttribute('data-bs-parent', '#rcAccordion');

    const body = document.createElement('div');
    body.className = 'accordion-body';

    const note = document.createElement('p');
    note.textContent = COPY;
    body.appendChild(note);
    body.appendChild(makeFields(inputType));

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn-brand btn-sm mt-2';
    submit.textContent = 'Submit';
    submit.setAttribute('data-rc-submit', '');
    submit.dataset.rcId = String(id);
    submit.dataset.rcInput = String(inputType);
    body.appendChild(submit);

    collapse.appendChild(body);
    item.appendChild(header);
    item.appendChild(collapse);
    return item;
}

function makeFields(inputType) {
    const wrap = document.createElement('div');
    wrap.className = 'rc-fields';

    if (inputType === INPUT.ORDER) {
        wrap.appendChild(pickerField('Your Order ID', 'Choose order from list', 'order', 'order'));
    } else if (inputType === INPUT.OUTLET) {
        wrap.appendChild(pickerField('Select Outlet', 'Choose an outlet', 'outlet', 'outlet'));
        wrap.appendChild(commentField('outletComment', 'Comments'));
    } else {
        wrap.appendChild(commentField('feedback', 'Share your feedback…'));
    }
    return wrap;
}

function pickerField(label, placeholder, pick, fieldName) {
    const field = document.createElement('div');
    field.className = 'rc-field';
    const lbl = document.createElement('label');
    lbl.className = 'rc-field__label';
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rc-pick-input';
    input.placeholder = placeholder;
    input.readOnly = true;
    input.setAttribute('data-rc-pick', pick);
    input.setAttribute('data-rc-field', fieldName);
    field.appendChild(lbl);
    field.appendChild(input);
    return field;
}

function commentField(fieldName, placeholder) {
    const field = document.createElement('div');
    field.className = 'rc-field';
    const ta = document.createElement('textarea');
    ta.rows = 4;
    ta.placeholder = placeholder;
    ta.setAttribute('data-rc-field', fieldName);
    field.appendChild(ta);
    return field;
}

// ── Data loading ─────────────────────────────────────────────────────────

async function loadConcernTypes() {
    const user = getUser();
    if (!user.contactMappingId) {
        setState('Please log in to raise a concern.');
        return;
    }
    setState('Loading…');
    try {
        const res = await fetch(API + '/support/getConcernType/' + PID + '/' + user.contactMappingId, {
            headers: authHeaders(),
        });
        const data = await res.json();
        const types = (Number(data.status) === 1 && Array.isArray(data.concern_types))
            ? data.concern_types.filter((t) => Number(t.status) === 1)
            : [];
        if (!types.length) { setState('No help topics available right now.'); return; }
        const root = $('rcAccordion');
        root.innerHTML = '';
        types.forEach((t, i) => root.appendChild(makeCard(t, i)));
    } catch (e) {
        setState('Could not load help topics. Please try again.');
    }
}

async function openPicker(kind, targetInput) {
    const user = getUser();
    const titleEl = $('rcPickerTitle');
    const list = $('rcPickerList');
    list.innerHTML = '<p class="rc-state">Loading…</p>';
    if (titleEl) titleEl.textContent = kind === 'order' ? 'Select Order' : 'Select Outlet';
    getModal('rcPickerModal')?.show();

    try {
        if (kind === 'order') {
            const params = new URLSearchParams({
                mobile: user.mobile || '',
                parentBusinessId: String(PID),
                contactMappingId: user.contactMappingId || '',
                businessId: String(PID),
                token: user.token || '',
                action: 'close_order',
            });
            const res = await fetch(API + '/pay/getOrderInfo?' + params.toString(), { headers: authHeaders() });
            const data = await res.json();
            const rows = (Number(data.status) === 1 && Array.isArray(data.rows)) ? data.rows : [];
            if (!rows.length) { list.innerHTML = '<p class="rc-state">No past orders found.</p>'; return; }
            list.innerHTML = '';
            rows.forEach((o) => {
                list.appendChild(pickerRow(
                    '#' + o.id,
                    [o.locality, o.startTime].filter(Boolean).join(' · '),
                    () => { if (targetInput) targetInput.value = String(o.id); }
                ));
            });
        } else {
            const res = await fetch(API + '/client/getAllStores/' + PID + '?mobile=' + encodeURIComponent(user.mobile || ''), {
                headers: authHeaders(),
            });
            const data = await res.json();
            const stores = Array.isArray(data.stores) ? data.stores : [];
            if (!stores.length) { list.innerHTML = '<p class="rc-state">No outlets found.</p>'; return; }
            list.innerHTML = '';
            stores.forEach((s) => {
                const label = [s.locality, s.city].filter(Boolean).join(', ');
                list.appendChild(pickerRow(label, '', () => { if (targetInput) targetInput.value = label; }));
            });
        }
    } catch (e) {
        list.innerHTML = '<p class="rc-state">Could not load the list. Please try again.</p>';
    }
}

function pickerRow(title, sub, onSelect) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rc-list__item';
    const t = document.createElement('span');
    t.className = 'rc-list__title';
    t.textContent = title;
    row.appendChild(t);
    if (sub) {
        const s = document.createElement('span');
        s.className = 'rc-list__sub';
        s.textContent = sub;
        row.appendChild(s);
    }
    row.addEventListener('click', () => {
        onSelect();
        getModal('rcPickerModal')?.hide();
    });
    return row;
}

// ── Submit ───────────────────────────────────────────────────────────────

function fieldVal(card, name) {
    const el = card.querySelector('[data-rc-field="' + name + '"]');
    return el ? (el.value || '').trim() : '';
}

async function submitConcern(btn) {
    const card      = btn.closest('.accordion-item');
    const concernId = Number(btn.dataset.rcId);
    const inputType = Number(btn.dataset.rcInput);
    if (!card) return;

    let details;
    if (inputType === INPUT.ORDER) {
        const orderId = fieldVal(card, 'order');
        if (!orderId) { showStatus('Please select an order ID.', false); return; }
        details = [orderId];
    } else if (inputType === INPUT.OUTLET) {
        const outlet = fieldVal(card, 'outlet');
        const comment = fieldVal(card, 'outletComment');
        if (!outlet) { showStatus('Please select an outlet.', false); return; }
        if (!comment) { showStatus('Please add a comment.', false); return; }
        details = [outlet, comment];
    } else {
        const comment = fieldVal(card, 'feedback');
        if (!comment) { showStatus('Please add a comment.', false); return; }
        details = [comment];
    }

    const user = getUser();
    clearStatus();
    try {
        const data = await apiCallForm(
            '/support/raiseConcern/' + PID + '/' + user.contactMappingId,
            { token: user.token || '', concernType: concernId, concern_details: details.join(', ') },
            authHeaders()
        );
        if (Number(data.status) === 1) {
            showStatus(data.msg || 'Thank you! Our support team will get back to you shortly.', true);
            setTimeout(() => { getModal('raiseConcernModal')?.hide(); }, 2200);
        } else {
            showStatus(data.msg || 'Could not submit your concern. Please try again.', false);
        }
    } catch (e) {
        showStatus('Could not submit your concern. Please try again.', false);
    }
}

// ── Wiring ───────────────────────────────────────────────────────────────

function open() {
    if (typeof window.closeProfileSidebar === 'function') window.closeProfileSidebar();
    clearStatus();
    getModal('raiseConcernModal')?.show();
    loadConcernTypes();
}

function init() {
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-raise-concern]');
        if (trigger) { e.preventDefault(); open(); return; }

        const pick = e.target.closest('[data-rc-pick]');
        if (pick) { openPicker(pick.getAttribute('data-rc-pick'), pick); return; }

        const submit = e.target.closest('[data-rc-submit]');
        if (submit) { submitConcern(submit); return; }
    });

    $('raiseConcernModal')?.addEventListener('hidden.bs.modal', () => {
        $('raiseConcernForm')?.reset();
        clearStatus();
    });
}

init();

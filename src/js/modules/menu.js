/**
 * Menu v4 — Theobroma-style UX
 * 3-col desktop (sections | items | cart) · search overlay · variant popup · offers
 */
// getConfig (not a new named accessor) reads loyaltyBase/loyaltyAuthToken: adding
// an export to config.js and consuming it in the same deploy is the nested-import
// cache trap — config.js is imported unversioned and nginx caches /src/js for 30 days.
import { getApiBase, getMenuFeedBase, getCdnBase, getStaticApiKey, getCrmBase, getCrmAuthToken, getConfig } from './config.js';
import { trackProductViewed, trackAddToCart, trackRemoveFromCart, trackBeginCheckout } from './analytics.js?v=20260829';
import { fetchMenuMemberPricing, getMembershipDiscountForItem, getMembershipDiscountForVariant } from './membershipPricing.js';
// New module: pin the version so a 30-day-cached copy of this file can never
// resolve the import against a URL the browser has not seen.
import { requestGeolocation } from './geo.js?v=20260923a';
// Shared with checkout.js so both screens render the identical strip.
import { burnStripHTML, earnPointsForLine } from './loyaltyBurn.js?v=20261008a';
const FEED=`${getMenuFeedBase()}/feed/v2`,CDN=`${getCdnBase()}/uploads`;
const C=window.OutletConfig||{};
// Debug aid, WhatsApp-entry sessions only — confirms the live server-side
// entry_channel cookie value (via window.AppConfig, set in base.php) at the
// moment this page rendered, independent of nav-hiding behavior or any
// client-side proxy. Check via DevTools > Application > Local Storage >
// wa_entry_channel_debug. Remove once nav-hiding is confirmed working.
if(window.AppConfig?.entryChannel==='whatsapp'){
    try{
        localStorage.setItem('wa_entry_channel_debug',JSON.stringify({
            page:'order_menu_new',
            entryChannel:window.AppConfig.entryChannel,
            at:new Date().toISOString(),
        }));
    }catch(e){}
}
const bId=String(C.businessId||''),pId=String(C.pId||bId),isOpen=C.outlet_open!=0;
// Brand logo (full URL) — used only as the detail-popup hero fallback when an
// item has no image, mirroring CI3's grayscaled-logo behaviour. Listing cards
// show nothing when image is missing (CI3 parity), so they don't use it.
const bLogo=String(C.logo||'');
const startHours=String(C.startHours||'').trim();
// Why the outlet is closed: 'hours' = outside its operating window (the opening
// time is meaningful), anything else = ordering switched off, where the opening
// time means nothing and "Next available at 12:00 am" would mislead.
const isTempClosed=!isOpen&&String(C.closedReason||'')!=='hours';
// One copy everywhere a closed outlet blocks ordering — card pill, item popup,
// cart bar, checkout toast — so the message never varies by surface. The
// switched-off wording matches the store locator's badge (.sl-status-badge--unavailable).
function closedLabel(){return isTempClosed?'Outlet is temporarily unavailable':`Next available at ${startHours.toLowerCase()||'opening time'}`}
// Pill shown on every card when the outlet is closed. Time format mirrors the
// server-formatted "11:00 AM".
function nextAvailableHTML(){return!isOpen&&(isTempClosed||startHours)?`<div class="next-available">${esc(closedLabel())}</div>`:''}
const isCloud=C.isCloud==1;
// Grocery outlets (categoryId 15) share this view/module but have large SKU
// catalogs. They render category-wise and lazily (see renderGrocery) so the
// initial paint never builds thousands of cards in one blocking pass.
const isGrocery=C.categoryId==15;
const brands=Array.isArray(C.brands)?C.brands:[];
// Cloud kitchens require an explicit per-session pick (force selection).
// QSR brands fall back to C.brandId (always '0') — unused by load() when isCloud=0.
let brandId=isCloud?String(getStoredBrand()||''):String(C.brandId||'');
let isDine=C.dine_active==1;
const hasDineMenu=C.dine_menu==1;
const isSlotBased=C.isSlotBased==1;
// Pure-veg brands have no non-veg/egg items, so the veg/non-veg/egg diet filter
// is meaningless — hide it entirely (toolbar chips, filter sheet, search modal).
const isPureVeg=C.pureVeg==1;
// Backend-configured dynamic filter definitions (client/getFilterList,
// fetched client-side — see fetchFilterList()), each {name,field,fieldType,value}.
// Empty until that call resolves, and stays empty if it fails/is unauthorized
// or the outlet has none configured — either way buildTagCatalog() falls back
// to deriving tags from the item feed itself.
let apiFilterDefs=[];
// Confirmed working via a manual Postman request (2026-08-12) — the endpoint
// wants sha256(businessId + salt) UNCONDITIONALLY, not the salt-less branch
// an earlier pasted snippet described. Don't re-guess this again; if it ever
// stops authenticating, that's a signal to reconfirm with backend, not to
// try another formula from here. Declared up here (not next to
// fetchFilterList further down) because fetchFilterList() is invoked from
// the bootstrap line near the top of the file — a const declared below that
// call site would be in its temporal-dead-zone at call time.
const FILTER_LIST_SALT='Vjg0x6Gc';
// Fixed natural order for the static toolbar chips (matches their original
// markup order in order_menu_new.php) — used by chipSortKey/reorderToolbarChips
// as a stable sort key so a deactivated chip returns to its correct relative
// slot instead of staying wherever it happened to sit in the DOM while
// active. Tag chips sort after all static ones there, by their position in
// tagCatalog. Declared up here (not next to chipSortKey further down)
// because bindAll() calls syncFilterUI()/reorderToolbarChips() synchronously
// at module init — a const declared below that call site would be in its
// temporal-dead-zone at call time (same reason as FILTER_LIST_SALT above).
const STATIC_CHIP_ORDER=['in_stock','veg','non-veg','offer','rated'];

// QR table flow — when scanned URL is `/order/{slug}?t={tableId}`,
// the controller resolves the table name and exposes it via OutletConfig.
// Persist to localStorage so `goToCheckout()` (which already reads `tableId`)
// routes to `/checkout/{bId}/3/{tableId}` automatically. CI3 parity.
if(C.tableId&&C.tableName){
    try{
        localStorage.setItem('tableId',String(C.tableId));
        localStorage.setItem('tableName',String(C.tableName));
        localStorage.setItem('orderType','3'); // 3 = dine-in
        document.dispatchEvent(new CustomEvent('ordertype:changed'));
        // A QR scan is an authoritative outlet pick (user is physically at this table).
        // Commit the outlet identity too — otherwise the home page reads the previously
        // saved `business`/`slug`/`view_business` and lets the user order for the wrong
        // outlet. Mirrors commitAndRedirect() in location_picker.js.
        localStorage.setItem('business',bId);
        if(C.slug)localStorage.setItem('slug',String(C.slug));
        if(C.city)localStorage.setItem('city',String(C.city));
        if(C.locality)localStorage.setItem('locality',String(C.locality));
        localStorage.setItem('locationSelectedAt',String(Date.now()));
        document.cookie='view_business='+bId+'; path=/; max-age=2592000';
    }catch{}
}
// Default "In stock" filter hides OOS items. Skip the default on slot-based brands —
// items there are often flagged OOS for the current moment (server-side per-slot stock)
// and the user is expected to schedule into a future slot. Hiding everything would block
// browsing. Slot-based availability is surfaced inline via slotAvailable() per card.
// Search placeholder — "Search this outlet's menu — 149 items at Saguna More".
// Set here rather than in the view because the count only exists once the feed
// has resolved; the view ships the short form so the field is never empty or
// mid-sentence while the menu loads.
// Locality comes from OutletConfig (the server's own statement of which outlet
// this is), so it is right even on a shared link that never ran the location
// journey. Either part is dropped when unknown rather than printed empty.
function setSearchPlaceholder(){
    // The count is only claimed where the WHOLE catalogue is in hand. A grocery
    // outlet loads its sections lazily (loadGrocery/fetchGrocSection), so
    // allItems holds whatever has been browsed so far — printing that would
    // understate the shop, and the number would climb as you scrolled. The
    // outlet still gets named; only the count is withheld.
    const n=isGrocery?0:allItems.length;
    const where=(window.OutletConfig&&(OutletConfig.locality||OutletConfig.city))||'';
    let t="Search this outlet's menu";
    if(n) t+=` — ${n} item${n===1?'':'s'}`;
    if(where) t+=` at ${where}`;
    // All three entry points carry the same words: the header field (desktop),
    // the bottom bar's button (phone) and the overlay that button opens. They
    // used to say three different things — "Search Menu", "Search your favourite
    // items", "Search for items or more…" — for one search over one menu.
    const el=ge('menuSearchInput'); if(el) el.placeholder=t;
    const ov=ge('searchInput');     if(ov) ov.placeholder=t;
    const mb=ge('mobileSearchBtn'); const lbl=mb&&mb.querySelector('span'); if(lbl) lbl.textContent=t;
}
let cats=[],allItems=[],allOffers=[],allPromos=[],templateList=[],veg='',q='',sortBy='',picks=new Set(isSlotBased?[]:['in_stock']),cart=loadCart(),favs=loadFavs(),popularItems=[],mostOrderedItems=[],mostOrderedIds=new Set(),feedItemIds=new Set(),tagCatalog=[],activeTagKeys=new Set();
// `veg` holds '' | 'veg' (Pure Veg) | 'veg-egg' (Veg & Egg) | 'non-veg'.
// Whether THIS menu carries an egg dish — decides the whole shape of the dietary
// filter (dropdown + three sheet chips, or the plain Veg toggle). It LATCHES ON for
// the life of a loaded menu and is reset only by load()/loadGrocery(): grocery
// streams categories in one at a time, so a plain scan of allItems would flip the
// chip's shape on and off as the customer scrolls. Latching makes it monotonic —
// exact for restaurants (the feed arrives whole), best-effort but never flickering
// for grocery. The reset on a fresh load is what lets a cloud-kitchen brand switch
// drop back to the plain Veg chip (R22). Declared up here, not next to
// updateDietFilterUI(), because bindAll() calls syncFilterUI() at module init and
// that reads it — down there it would be in its temporal dead zone at call time.
let menuHasEgg=false;
// The portaled Pure Veg / Veg & Egg panel and the .diet-chip it is anchored to.
// Up here for the same temporal-dead-zone reason — syncFilterUI() reads both
// through dietMenuIsOpen() during bindAll()'s synchronous init.
let dietMenuEl=null,dietMenuAnchor=null;
// Filters persist across a refresh now (per-outlet — different outlets can
// have different in-stock/tag catalogs, so one brand-wide key would leak
// filters that don't make sense elsewhere). Search text (q) is deliberately
// NOT persisted — only picks/veg/sortBy/activeTagKeys. Saved on every
// render()/renderGrocery() call (i.e. after every filter-changing action:
// toolbar click, sheet Apply, Clear, sort), restored once here at module init,
// before the feed/getFilterList calls below even fire — so the very
// first render already reflects last session's filters instead of flashing
// the default state first.
const FILTER_STORAGE_KEY='menu_filters_'+bId;
function saveFilterState(){
    try{localStorage.setItem(FILTER_STORAGE_KEY,JSON.stringify({picks:[...picks],veg,sortBy,tags:[...activeTagKeys]}))}catch(e){}
}
function restoreFilterState(){
    try{
        const raw=localStorage.getItem(FILTER_STORAGE_KEY);
        if(!raw)return;
        const saved=JSON.parse(raw)||{};
        // "In stock" is a system default, not a user filter — it's excluded from
        // filtersActive, from the Filters badge count and from the button's active
        // state. Persisting an opt-out therefore left the outlet showing
        // out-of-stock items for good, with the toolbar looking untouched. Restore
        // every other pick, but always start a fresh load with it back on; turning
        // it off still works, it just doesn't outlive the visit.
        if(Array.isArray(saved.picks)){picks=new Set(saved.picks);if(!isSlotBased)picks.add('in_stock');}
        // 'egg' was a filter of its own before egg was clubbed into Veg & Egg. It is
        // still sitting in the localStorage of anyone who used it, and no chip exists
        // to clear it any more, so migrate rather than restore it verbatim.
        if(typeof saved.veg==='string')veg=(saved.veg==='egg')?'veg-egg':saved.veg;
        if(typeof saved.sortBy==='string')sortBy=saved.sortBy;
        if(Array.isArray(saved.tags))activeTagKeys=new Set(saved.tags);
    }catch(e){}
}
restoreFilterState();
// "Brand USP" (e.g. "Clean") — identifies which tagCatalog entry (if any) is
// the outlet's live USP, sourced from the SAME client/getFilterList call
// that builds the dynamic tag catalog (see fetchFilterList/initUsp below):
// whichever entry has is_usp===1. Unlike every other tag, this one keeps its
// own dedicated toggle UI (chip + mobile bar + sidebar badge — buildUspUI
// below) and its own on/off state (uspOn) — it is EXCLUDED from the generic
// tagCatalog/activeTagKeys mechanism (see buildTagCatalog) so it never
// duplicates as a plain chip. Bestseller/New/custom tags are the ones that
// are plain tagCatalog entries, matched via activeTagKeys — Clean is not one
// of them. Empty (uspTagKey==='') until fetchFilterList resolves, and stays
// that way if the outlet has no live USP or the call fails — every usp-*
// branch below is then a no-op.
let uspTagKey='',uspTitle='',uspIconSrc='',uspColor='',uspOn=false;
function uspActive(){return uspOn}
function itemHasUsp(i){return itemTagKeys(i).has(uspTagKey)}
// Persists the same way usp_toggle.js does on the home page (same
// localStorage key convention, same event) so a toggle flipped on one page
// is reflected on the other, even though they're otherwise independent fetches.
function setUspOn(on){
    uspOn=on;
    try{localStorage.setItem('usp_toggle_'+uspTagKey,on?'1':'0')}catch(e){}
    window.dispatchEvent(new CustomEvent('usp:change',{detail:{tagKey:uspTagKey,on}}));
    syncFilterUI();render();
}
// Membership slashed pricing — { mode:'member'|'guest', buckets:[...] } once fetched, else null.
// Gated on OutletConfig.membershipApplicable; consumed by priceLineHTML + the variant popup.
let memberPricing=null;
// All-inclusive pricing flag from the feed (rows.business.aiFlag). When 1 the feed `sp`
// is already tax-inclusive; reconcileCartFromServer must keep that inclusive price rather
// than the server line's net-of-tax subTotal (CI3 parity — never de-tax on the menu).
let aiFlag=0;
// Tax-inclusive gross-up factor for an all-inclusive (aiFlag=1) feed item: sp / sp_without_taxes
// (exact), falling back to (1 + tax%). Returns 1 (no gross-up) for non-aiFlag brands or when the
// feed item / its tax data is missing, so a NET price is never wrongly inflated.
function aiIncFactor(feed){
    if(aiFlag!==1||!feed)return 1;
    const inc=Number(feed.sp),net=Number(feed.sp_without_taxes);
    if(inc>0&&net>0)return inc/net;
    const t=Number(feed.tax)||0;
    return t>0?1+t/100:1;
}
const membershipApplicable=C.membershipApplicable==1;
// Per-item earn badges (item-based loyalty brands only). Map of item_slug →
// catalog row once loadEarnCatalog() resolves, else null. Consumed by
// priceLineHTML via earnBadgeHTML. Gated server-side on
// wallet_rules.item_based_loyalty so brands on the flat milestone model — which
// the catalog endpoint rejects outright — never make the call.
const itemLoyalty=C.itemLoyalty==1;
let earnCatalog=null,earnMode='guest',walletBalance=null;
// Points this cart has ALREADY committed at checkout, summed from the server cart's
// wallet_points_redeemed. NOT subtracted from the balance — CRM debits at redeem
// time, so wallet_balance already excludes them (see spendableBalance). Kept because
// redeemedBySlug and the redeem sheet still need to know which lines hold points.
let committedBurnPts=0;
// Promo state read off the same cart response. Needed because points and a promo are
// mutually exclusive unless the outlet opts in (checkout enforces the same rule), and
// the menu can now redeem — so it has to know before it writes.
let appliedPromoCode='',walletPromoCombinedAllowed=false;
// Which items those points went on, item_slug -> points. Netting the balance alone
// left the sheet showing the redeemed line as an ordinary offer at its full cost —
// the customer sees the balance drop with nothing to say which item took it.
let redeemedBySlug=new Map();
// The catalog balance is ALREADY net of the cart's redemptions — applyWallet debits
// CRM on redeem and removeWallet credits it back (verified: 4780 → 4690 → 4780), so
// netting committedBurnPts off here charged the customer twice and printed 4600
// against a real 4690. committedBurnPts stays: redeemedBySlug and the sheet still
// need to know WHICH lines hold points, just not to re-deduct them.
function spendableBalance(){
    return Math.max(0,(walletBalance!=null?Math.floor(+walletBalance||0):0));
}
// Called with whatever cart lines the menu just received. Repaints only on a real
// change — every add/remove brings a fresh response and most carry no redemption.
function noteCommittedBurn(lines){
    let ls=Array.isArray(lines)?lines:[];
    if(ls.length&&ls[0]&&Array.isArray(ls[0].items))ls=ls.flatMap(g=>g.items||[]);
    let total=0;
    const bySlug=new Map();
    ls.forEach(li=>{
        const pts=Math.floor(+(li&&li.wallet_points_redeemed)||0);
        if(pts<=0)return;
        total+=pts;
        // Same id walk the cart sync uses: a variant/combo line is keyed by a
        // promoted id, and its parentId is the one the menu knows.
        const it=findItem(li.itemId)||(li.parentId&&String(li.parentId)!=='0'?findItem(li.parentId):null);
        if(it&&it.slug)bySlug.set(String(it.slug),(bySlug.get(String(it.slug))||0)+pts);
    });
    const same=total===committedBurnPts&&bySlug.size===redeemedBySlug.size
        &&[...bySlug].every(([k,v])=>redeemedBySlug.get(k)===v);
    if(same)return;
    committedBurnPts=total;
    redeemedBySlug=bySlug;
    paintLoyaltyBalance();
    const ov=ge('menuRedeemOverlay');
    if(ov&&!ov.hidden)renderMenuRedeemSheet();
}
const pendingSyncs=new Set();
// In-car GPS fix — hoisted to top-of-module state for the same reason pendingSyncs is: the
// module entry point warms it, which runs before the in-car block further down is evaluated,
// and a `let` read from inside its temporal dead zone throws and takes the whole menu with it.
// TTL rather than page lifetime — see ensureInCarLocation.
const CAR_LOC_TTL_MS=300000; // 5 min
let carLoc=null,carLocReq=null,carLocTs=0;
let slotsData=[],selSlot=restoreSlot(),serverOrderId='',pendingDeepItem=null;
function getStoredBrand(){try{return isCloud?(sessionStorage.getItem('cloud_brand_id_'+bId)||''):''}catch{return ''}}
function setStoredBrand(id){try{sessionStorage.setItem('cloud_brand_id_'+bId,String(id))}catch{}}
// A stored later-slot whose window has fully elapsed (its end — or start, if end unknown — is
// at or before now) must NOT be restored: it would sit pre-selected on a past date, suppress
// the slot popup (initSlot only auto-opens when no date is stored) and flag every prep-time
// item "Select Next Slot". Built in local wall-clock time to match slotAvailable/saveSlot.
function slotWindowPast(date,startH,endH){
    if(!date)return false;
    const[yr,mo,dy]=date.split('-').map(Number);
    if(!yr||!mo||!dy)return false;
    const b=(Number(endH)>0?Number(endH):Number(startH)||0),h=Math.floor(b),m=Math.round((b-h)*60);
    const end=new Date(yr,mo-1,dy,h,m,0);
    return!isNaN(end.getTime())&&end.getTime()<=Date.now();
}
function clearStoredSlot(){['slot_date','slot_id','slot_label','slot_startH','slot_endH'].forEach(k=>localStorage.removeItem(k))}
function restoreSlot(){
    const date=localStorage.getItem('slot_date')||'',startH=parseFloat(localStorage.getItem('slot_startH')||'0'),endH=parseFloat(localStorage.getItem('slot_endH')||'0');
    // Drop a stale slot so initSlot reopens the picker for a fresh, valid choice.
    if(date&&slotWindowPast(date,startH,endH)){clearStoredSlot();return{date:'',id:'',label:'',startH:0,endH:0}}
    return{date,id:localStorage.getItem('slot_id')||'',label:localStorage.getItem('slot_label')||'',startH,endH};
}
function saveSlot(d,id,lbl,sh,eh){selSlot={date:d,id:String(id),label:lbl,startH:sh,endH:eh};localStorage.setItem('slot_date',d);localStorage.setItem('slot_id',String(id));localStorage.setItem('slot_label',lbl);localStorage.setItem('slot_startH',String(sh));localStorage.setItem('slot_endH',String(eh))}
// The slot's time range (e.g. "12:00 PM - 9:00 PM") from the stored "Day | range" label.
function slotTimeRange(){const l=selSlot.label||'';const i=l.indexOf(' | ');return i>=0?l.slice(i+3).trim():l.trim()}
// CI3 parity: the cart API carries the selected slot as slotId/slotDate/slotTime (NOT the
// checkout's selected_slot ISO). This is how a slot picked locally — including one chosen
// while logged out — reaches the server on the first authenticated cart call, so prep-time
// items validate against the chosen slot. Empty object when no slot is selected.
function slotCartParams(){
    if(!isSlotBased||!selSlot.date||!selSlot.id)return{};
    return{slotId:String(selSlot.id),slotDate:selSlot.date,slotTime:slotTimeRange()};
}
function loadFavs(){try{const s=localStorage.getItem('v4_favs_'+bId);return new Set(s?JSON.parse(s):[])}catch{return new Set()}}
function saveFavs(){try{localStorage.setItem('v4_favs_'+bId,JSON.stringify([...favs]))}catch{}}
function toggleFav(id){const k=String(id);if(favs.has(k))favs.delete(k);else favs.add(k);saveFavs()}

// Analytics: normalize the cart into the shape analytics.js expects (begin_checkout / purchase).
function analyticsItems(){return cart.items.map(i=>({id:i.parentId||i.id,name:i.name,qty:i.qty,price:i.price,veg:i.veg}))}

// Browse-event helpers. All reached via the window.Analytics bridge rather than adding
// new names to this module's `import './analytics.js'`: that nested import carries no
// version query while menu.js itself is cache-busted, and nginx caches /src/js for 30
// days — a fresh menu.js paired with a stale analytics.js would throw SyntaxError and
// take the entire menu page down. The bridge degrades to a no-op instead.
//
// Each is de-duplicated against the last value it sent. These fire from handlers that
// re-run for reasons unrelated to user intent (a debounced search pause re-triggered by
// a filter chip, a category re-clicked, Apply pressed twice) and GA4/Meta would otherwise
// receive near-identical duplicates that inflate every rate computed from them.
let _lastSearch='',_lastCat='',_lastFilters='';
function trackSearchOnce(term,results){
    if(!term||term===_lastSearch)return;
    _lastSearch=term;
    window.Analytics?.trackSearch?.({term,results});
}
function trackCategoryOnce(href){
    // Hrefs come in two shapes: '#cat-123' for real sections and '#popular-picks' (and
    // friends) for the synthetic rails. Strip the '#' first, THEN the 'cat-' prefix —
    // doing it in one pass left the '#' on the synthetic ones.
    const id=String(href||'').replace(/^#/,'').replace(/^cat-/,'');
    if(!id||id===_lastCat)return;
    _lastCat=id;
    // Synthetic rails have no row in `cats`; falling back to the slug is intended.
    const cat=cats.find(c=>String(c.id)===id);
    window.Analytics?.trackCategoryViewed?.({category:cat?.name||id,categoryId:id});
}
function trackFiltersOnce(){
    const names=activeFilterDisplayNames();
    const key=names.join('|')+'#'+(sortBy||'');
    if(key===_lastFilters)return;
    _lastFilters=key;
    // Nothing selected → the user cleared everything; that's still a real action, but an
    // empty payload is noise, so only report an actual filter set.
    if(!names.length&&!sortBy)return;
    window.Analytics?.trackFilterApplied?.({filters:names.join(', '),sort:sortBy||''});
}

// ── Small UI helpers: toast, description tooltip, share ──
function showToast(msg){
    document.querySelector('.menu-toast')?.remove();
    const t=document.createElement('div');t.className='menu-toast';t.textContent=msg;
    document.body.appendChild(t);
    setTimeout(()=>t.remove(),2200);
}
// A home-page deep link (item or section) blocked by the active USP filter used
// to get the transient bottom toast — too easy to miss, especially when the
// user's action (clicking an item) primed a strong expectation that a whole
// modal would open. This is that modal instead: reuses .popup-overlay/.popup-sheet
// (same pattern as every other popup here), stays open until dismissed, and its
// primary action turns the filter off via setUspOn(false) (this module's own
// USP state — see initUsp/setUspOn) then runs onProceed().
//
// `detail` is just the specific fact (item/section name) — the generic "why"
// lives in the title, built once here from uspTitle/uspIconSrc/uspColor (set by
// initUsp() once getFilterList resolves) so this reads as part of the same
// feature the user already saw on the toolbar chip/mobile bar, not a generic
// unrelated dialog with a mismatched (theme --brand) CTA color.
// A deep-linked item this outlet doesn't stock. Global search and the SEO
// product pages work at BRAND level, so their "Add" can land on an outlet whose
// menu never carried that item — say so plainly, and offer the outlet switch,
// instead of dropping the user on a menu that silently ignored their click.
function showItemUnavailableModal(label){
    document.getElementById('itemUnavailModal')?.remove();
    const C=window.OutletConfig||{};
    const where=[C.outletName,C.locality].filter(Boolean).join(', ');
    const el=document.createElement('div');
    el.id='itemUnavailModal';
    el.innerHTML=`<div class="popup-overlay">
        <div class="popup-sheet popup-sheet--sm iu-sheet">
            <button class="iu-sheet__close" id="iuClose" type="button" aria-label="Close"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            <h3 class="iu-sheet__title">Item not available</h3>
            <p class="iu-sheet__text"><b class="iu-sheet__item">${label?esc(label):'That item'}</b> isn't served at this outlet right now. Browse the full menu to find something similar.</p>
            ${where?`<span class="iu-sheet__outlet"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/></svg>${esc(where)}</span>`:''}
            <button type="button" class="iu-sheet__cta" id="iuBrowse">Browse this menu</button>
        </div>
    </div>`;
    document.body.appendChild(el);
    const close=()=>el.remove();
    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)close()};
    el.querySelector('#iuClose').onclick=close;
    el.querySelector('#iuBrowse').onclick=close;
}
// "ghee-gond-laddu" → "Ghee Gond Laddu" — the deep-link only carries the slug.
function slugLabel(slug){
    return String(slug||'').split(/[-_]+/).filter(Boolean)
        .map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}

function showUspBlockedModal(detail,actionLabel,onProceed){
    document.getElementById('uspBlockedModal')?.remove();
    const el=document.createElement('div');
    el.id='uspBlockedModal';
    const colorAttr=uspColor?` style="--usp-color:${esc(uspColor)};--usp-ink:#fff"`:'';
    el.innerHTML=`<div class="popup-overlay">
        <div class="popup-sheet popup-sheet--sm usp-blocked-sheet"${colorAttr}>
            <button class="icon-btn-close usp-blocked-sheet__close" id="uspBlockedClose" type="button" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            ${uspIconSrc?`<span class="usp-blocked-sheet__icon-badge"><img src="${esc(uspIconSrc)}" alt=""></span>`:''}
            <h3 class="usp-blocked-sheet__title">Not available in ${esc(uspTitle)} Mode</h3>
            <p class="usp-blocked-sheet__text">${esc(detail)}</p>
            <button type="button" class="usp-blocked-sheet__cta" id="uspBlockedProceed">${esc(actionLabel)}</button>
        </div>
    </div>`;
    document.body.appendChild(el);
    const close=()=>el.remove();
    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)close()};
    el.querySelector('#uspBlockedClose').onclick=close;
    el.querySelector('#uspBlockedProceed').onclick=()=>{
        close();
        setUspOn(false);
        onProceed();
    };
}
function openDescTip(anchor,text){
    document.querySelector('.popup-desc-tip')?.remove();
    const tip=document.createElement('div');tip.className='popup-desc-tip';tip.setAttribute('role','tooltip');
    tip.innerHTML=`<button class="popup-desc-tip-close" type="button" aria-label="Close">×</button><p></p>`;
    tip.querySelector('p').textContent=text;
    document.body.appendChild(tip);
    const r=anchor.getBoundingClientRect();
    const tw=tip.offsetWidth,th=tip.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;
    let left=Math.min(Math.max(8,r.left),vw-tw-8);
    let top=r.bottom+8;
    if(top+th>vh-8)top=Math.max(8,r.top-th-8);
    tip.style.left=left+'px';tip.style.top=top+'px';
    const close=()=>{tip.remove();document.removeEventListener('mousedown',outside,true);};
    const outside=e=>{if(!tip.contains(e.target)&&e.target!==anchor)close();};
    tip.querySelector('.popup-desc-tip-close').onclick=close;
    setTimeout(()=>document.addEventListener('mousedown',outside,true),0);
}
// Build the share payload — text format matches CI3's mobile app:
// "Checkout {item} by {outletName}, {locality} {city}" + deep-link URL.
function buildSharePayload(item){
    const C=window.OutletConfig||{};
    const outlet=C.outletName||C.brandName||'';
    const place=[C.locality,C.city].filter(Boolean).join(' ').trim();
    const by=outlet?` by ${outlet}`:'';
    const where=place?`, ${place}`:'';
    const text=`Checkout ${item.name}${by}${where}`;
    const qs=item.slug?`?item_slug=${encodeURIComponent(item.slug)}`:`?item=${encodeURIComponent(item.id)}`;
    const url=`${location.origin}${location.pathname}${qs}`;
    return{title:item.name,text,url};
}
// Hybrid share: try navigator.share first (mobile → OS-native sheet with contacts,
// Quick Share, WhatsApp, Gmail, etc.). Falls back to a custom HTML share sheet only
// when the Web Share API is unavailable (most desktop browsers, HTTP context).
async function shareItem(item){
    const payload=buildSharePayload(item);
    if(navigator.share){
        try{await navigator.share(payload);return;}
        catch(e){if(e&&e.name==='AbortError')return;/* fall through to custom sheet */}
    }
    openShareSheet(item,payload);
}
function openShareSheet(item,payload){
    const {text,url}=payload;
    const eUrl=encodeURIComponent(url);
    const eText=encodeURIComponent(text);
    closeShareSheet();
    const el=document.createElement('div');el.id='shareModal';
    el.innerHTML=`<div class="popup-overlay share-overlay">
      <div class="popup-sheet share-sheet">
        <button class="popup-close" id="shareClose" type="button" aria-label="Close">×</button>
        <h3 class="share-sheet__title">Share this item</h3>
        <p class="share-sheet__sub">${esc(item.name)}</p>
        <div class="share-sheet__grid">
          <a class="share-opt" href="https://www.facebook.com/sharer/sharer.php?u=${eUrl}" target="_blank" rel="noopener noreferrer">
            <span class="share-opt__icon share-opt__icon--fb"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-7.5h2.5l.4-3H13.5V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1V10.5H8v3h2.2V21h3.3z"/></svg></span>
            <span class="share-opt__label">Facebook</span>
          </a>
          <a class="share-opt" href="https://twitter.com/intent/tweet?text=${eText}&url=${eUrl}" target="_blank" rel="noopener noreferrer">
            <span class="share-opt__icon share-opt__icon--tw"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></span>
            <span class="share-opt__label">X</span>
          </a>
          <button class="share-opt" type="button" id="shareCopyBtn">
            <span class="share-opt__icon share-opt__icon--copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
            <span class="share-opt__label">Copy link</span>
          </button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(el);
    document.body.classList.add('share-open');
    const overlay=el.querySelector('.popup-overlay');
    ge('shareClose')?.addEventListener('click',closeShareSheet);
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeShareSheet()});
    ge('shareCopyBtn')?.addEventListener('click',async()=>{
        const ok=await copyText(url);
        showToast(ok?'Link copied':'Could not copy link');
        closeShareSheet();
    });
    document.addEventListener('keydown',shareEscHandler);
}
function closeShareSheet(){
    const m=ge('shareModal');if(m)m.remove();
    document.body.classList.remove('share-open');
    document.removeEventListener('keydown',shareEscHandler);
}
function shareEscHandler(e){if(e.key==='Escape')closeShareSheet()}
async function copyText(text){
    try{await navigator.clipboard.writeText(text);return true;}
    catch{
        const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
        document.body.appendChild(ta);ta.focus();ta.select();
        let ok=false;try{ok=document.execCommand('copy');}catch{}
        ta.remove();return ok;
    }
}

if(bId&&ge('dynamicMenuContent')){
    // Boot the menu FIRST. Analytics must never sit ahead of this: base.php loads
    // analytics.js versioned while this module imports './analytics.js' unversioned, so
    // the two can resolve to different cached copies. A stale copy installs a
    // window.Analytics WITHOUT the newer methods, and a throw here would take out
    // bindAll/loadLib/initCloud/load — i.e. the whole menu — until the cache caught up.
    // (That regression shipped: "window.Analytics?.trackStoreViewed is not a function".)
    bindAll();loadLib();initCloud();fetchFilterList();initGuestLoyalty();if(!isCloud||brandId)load()
    // Warm the in-car GPS fix here, not only on the order-type switch: a page that loads
    // ALREADY in in-car mode (stored orderType) never runs that handler. Without this the
    // first add pays the full geolocation wait inside a pendingSyncs promise, and a tap on
    // "Go to checkout" in the meantime blocks on drainSyncs() with nothing on screen.
    if(inCarActive())ensureInCarLocation()
    // Store viewed — fired here rather than in load(), which re-runs on brand switch and
    // dine-in toggle and would double-count a single visit.
    // OutletConfig on this page exposes outletName/brandName — there is no `name` key.
    // Optional CALL (?.()) not just optional access: a bridge missing this method must
    // be a no-op, never a TypeError. try/catch is the belt to that braces.
    try{
        window.Analytics?.trackStoreViewed?.({
            businessId:bId,name:C.outletName||C.brandName,locality:C.locality,city:C.city,slug:C.slug,
        });
    }catch(e){/* analytics must never break the menu */}
}

// Upper bound on the qty-1 lines one cart entry may expand into (see
// cartEntryToWireLines). checkout.js's auto-heal push carries the same ceiling.
const MAX_WIRE_LINES_PER_ENTRY=99;

// Build the /client/cart wire lines for ONE local cart entry, carrying its
// customizations. Mirrors addToCart's line shape so bulk-sync (logout→login,
// or already-logged-in revisit) preserves variants/addons/combos/BOGO — a bare
// {itemId, qty} would drop them and the server would re-add the base item only.
//
// A CUSTOMIZED entry of qty N goes up as N lines of qty 1, not one line of qty N.
// insertIntoCart() writes a sub-item's qty exactly as sent, with no relation to its
// parent's, so {qty:2, subItems:[{qty:1}]} lands as a qty-2 parent over a qty-1 child.
// One tap of "−" then runs `qty=qty-1 ... where (id=? OR parentOrderItemId=?)` over
// both and leaves the add-on at qty 0, which is what the POS is handed (RCA: order
// 48792947, add-on "Complementary Dal" sent with quantity 0).
// Repeating the line is what the incremental path already does — addToCart fires one
// qty-1 add per tap — and the server loops `foreach ($cart_arr['items'])` with no
// dedupe, so N entries become N independent parent rows, each owning its own add-on
// child. Every parent is then qty 1, so "−" deletes a whole row and no child can be
// stepped to 0. Scaling the children instead would keep one row but leave it at the
// mercy of the same ±1 stepper, and would change what a paid add-on bills.
// Plain lines keep qty N — they have no child to fall out of step with.
function cartEntryToWireLines(it){
    const pid=String(it.parentId||it.id);
    // Clamp to a positive integer — this is the one spot that echoes a LOCAL cart
    // entry's .qty verbatim into a server payload (bulk-sync on login). A corrupted
    // value here (e.g. localStorage hand-edited to a fraction, then reloaded before
    // login) would otherwise ship straight to /client/cart, which performs no
    // integer validation of its own and prices the line off whatever it receives.
    const qty=Math.max(1,Math.round(Number(it.qty))||1);
    const line={itemId:pid,qty};
    if(Array.isArray(it.bogoWire)&&it.bogoWire.length){
        // BOGO: nested wire + viewType=3 so the server runs BOGO logic on the line.
        line.parentItemId="0";line.viewType=3;line.subItems=it.bogoWire;
    }else if(Array.isArray(it.subItems)&&it.subItems.length){
        if(it.subItems.some(s=>s&&s.isCombo)){line.parentItemId="0";line.subItems=comboWireSubs(it.subItems);}
        else line.subItems=it.subItems;
    }
    if(!line.subItems)return[line];
    // Bound the expansion. The clamp above rejects NaN, fractions and negatives but
    // not magnitude, and a customised entry now becomes one line — and one server
    // row — per unit, so a corrupted localStorage qty amplifies into that many rows
    // instead of a single qty-N one. A real cart line never approaches this; a value
    // past it is corruption, and dropping the excess beats inserting it.
    return Array.from({length:Math.min(qty,MAX_WIRE_LINES_PER_ENTRY)},()=>({...line,qty:1}));
}

// When the user logs in via the global login modal (base.php), bulk-sync the local
// cart to the server in ONE call before reloading. This ensures checkout init only
// needs a single view call — server cart already matches local at that point.
window._onLoginSuccess = async function(){
    // We reload below, so the welcome form (firstLoginProfile.js) must open AFTER the
    // reload via the justLoggedIn flag — opening it inline in _completeLogin would flash
    // it for a moment and then get wiped by this reload. Set the flag synchronously
    // (before the awaited sync) so _completeLogin sees it and skips the inline open.
    try{ localStorage.setItem('justLoggedIn','1'); }catch(e){}
    if(cart.items.length){
        const items=cart.items.flatMap(cartEntryToWireLines);
        await syncCart('add',items);
    }
    location.reload();
};

// If the user is already logged in and the local cart has items the server doesn't
// know about (no serverItemId stamped), bulk-push them in one call. Covers the case
// where the user logged in on a previous page (where menu's _onLoginSuccess never ran)
// and now visits the menu with a guest cart that was never synced.
//
// IMPORTANT: this MUST run only AFTER fetchServerCart()'s authoritative read has
// reconciled local → server (stamping serverItemId on every server-resident item).
// Running it before the read — as it used to, at page-init — re-pushed items the
// server already had but whose add-response serverItemId hadn't been stamped locally
// (lost/in-flight response, combos), inflating the cart count (the "3 items → 4/5"
// bug). The once-guard keeps later fetchServerCart calls (slot changes) from re-pushing.
let _bulkSyncDone=false;
function maybeBulkSyncOnLoad(){
    if(_bulkSyncDone)return;
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(!ud||!ud.token||!cart.items.length)return;
    _bulkSyncDone=true;
    const needSync=cart.items.filter(it=>!it.serverItemId);
    if(!needSync.length)return;
    const items=needSync.flatMap(cartEntryToWireLines);
    syncCart('add',items);
}

function initCloud(){
    if(!isCloud)return;
    document.body.classList.add('cloud-kitchen');
    bindBrandPill();bindBrandModal();
    if(brandId)syncBrandPill(brandId);else openBrandModal(true);
}
function bindBrandPill(){[ge('cloudBrandPill'),ge('cloudBrandPillMobile')].forEach(p=>{if(p)p.onclick=()=>openBrandModal(false)})}
function bindBrandModal(){
    const m=ge('cloudBrandModal');if(!m)return;
    m.querySelectorAll('.cloud-brand-row').forEach(btn=>{
        btn.onclick=()=>pickBrand(btn.dataset.brandId,btn.dataset.brandName,btn.dataset.brandLogo);
    });
    // Close affordances — only honoured when the modal is NOT in force-select mode
    // (i.e., the user already has a brand picked and is just browsing others).
    ge('cloudBrandClose')?.addEventListener('click',()=>{if(m.dataset.forceSelect!=='1')closeBrandModal()});
    m.addEventListener('click',e=>{if(e.target===m&&m.dataset.forceSelect!=='1')closeBrandModal()});
}
function openBrandModal(force){
    const m=ge('cloudBrandModal');if(!m)return;
    m.hidden=false;m.removeAttribute('hidden');
    m.dataset.forceSelect=force?'1':'0';
    document.body.style.overflow='hidden';
    // Highlight the currently selected brand row
    m.querySelectorAll('.cloud-brand-row').forEach(btn=>{
        const active=brandId&&String(btn.dataset.brandId)===String(brandId);
        btn.classList.toggle('is-active',!!active);
        if(active)btn.setAttribute('aria-current','true');else btn.removeAttribute('aria-current');
    });
}
function closeBrandModal(){
    const m=ge('cloudBrandModal');if(!m)return;
    m.hidden=true;m.setAttribute('hidden','');
    document.body.style.overflow='';
}
function pickBrand(id,name,logo){
    if(!id)return;
    const changed=String(id)!==String(brandId);
    brandId=String(id);setStoredBrand(brandId);
    syncBrandPill(brandId);
    closeBrandModal();
    if(changed||!cats.length){cats=[];allItems=[];allOffers=[];allPromos=[];load();}
}
function syncBrandPill(id){
    const b=brands.find(x=>String(x.id)===String(id));if(!b)return;
    const name=b.name||'Brand';
    ['cloudBrandPill','cloudBrandPillMobile'].forEach(pillId=>{
        const pill=ge(pillId);if(!pill)return;
        const nameEl=pill.querySelector('.cloud-brand-card__name');
        if(nameEl)nameEl.textContent=name;
        const logos=Array.from(pill.querySelectorAll('.cloud-brand-card__logo'));
        if(!logos.length)return;
        const selected=logos.find(el=>String(el.dataset.brandId)===String(id));
        const ordered=selected?[selected,...logos.filter(el=>el!==selected)]:logos;
        ordered.forEach((el,idx)=>{
            el.classList.remove('cloud-brand-card__logo--1','cloud-brand-card__logo--2','cloud-brand-card__logo--3');
            el.classList.add(`cloud-brand-card__logo--${idx+1}`);
            el.classList.toggle('is-active',el===selected);
        });
    });
}

function loadLib(){try{const s=document.createElement('script');s.src='/assets/fuse/fuse.min.js';document.head.appendChild(s)}catch{}}

async function load(){
    if(isGrocery)return loadGrocery();   // grocery uses per-section API loading, not the feed
    spin(true);
    let url=`${FEED}/feed_${bId}.json?t=${Date.now()}`;
    if(isDine)url=`${FEED}/feed_${bId}_dinein.json?t=${Date.now()}`;
    if(isCloud&&brandId)url=`${FEED}/feed_${bId}_${brandId}.json?t=${Date.now()}`;
    try{
        const r=await fetch(url);if(!r.ok)throw r.status;
        const d=await r.json();
        if(!d||d.status===0||!d.rows){showClosed();return}
        aiFlag=Number(d.rows.business?.aiFlag)||0;
        templateList=d.rows.templates||[];
        cats=buildCats(d.rows.menu||[]);
        collectFeedItemIds(d.rows.menu||[]);   // must precede showFeatured() — it filters on this
        allItems=[];cats.forEach(c=>c.subcats.forEach(s=>allItems.push(...s.items)));
        setSearchPlaceholder();
        menuHasEgg=false;                // fresh menu (incl. a cloud-kitchen brand switch) re-derives it — R22
        updateDietFilterUI();
        buildTagCatalog();renderTagChips();
        // Re-derive every chip's .active state (including tag chips) now that
        // both allItems and tagCatalog are guaranteed fresh — load()/
        // fetchGrocSection() and fetchFilterList() resolve independently, so
        // either can finish first.
        syncFilterUI();
        spin(false);showMenu(true);
        showFeatured(d.rows.popular||[]); // must be before render() and buildSidebar()
        buildSidebar();render();renderOfferStrip(d.rows.promos||[]);showRating(d.rows.reviews);updateBar();observeScroll();buildPopularGrid();buildPopularMenu();
        // Fetch wallet balance only when user is logged in (matches CI3 getWalletData() guard)
        // Item-based brands get the balance from the earn catalog instead — one
        // endpoint, one number. Only milestone brands need this second call.
        if(localStorage.getItem('userdata')&&!burnCatalogEnabled())fetchWalletCoins();
        // Pull the saved server cart (logged-in only) so the sticky-bar total + menu steppers
        // reflect items added on another page/device. Guards on login + reconciles internally.
        fetchServerCart();
        // fetchMostOrderedItems guards on its own (logged-in or ?mock_favs=1)
        fetchMostOrderedItems();
        // Membership slashed pricing — gated on the outlet flag. Repaints on arrival.
        loadMemberPricing();
        // Per-item earn badges — needs allItems, so it runs after the feed, and
        // repaints on arrival like member pricing does.
        loadEarnCatalog();
        if(isSlotBased)initSlot();
        // Deep-link: open item popup if URL has ?item={id} (e.g. from reservation page Add button)
        const _deepId=new URLSearchParams(location.search).get('item');
        if(_deepId){
            const _it=allItems.find(x=>String(x.id)===String(_deepId));
            if(_it)openOrDeferPopup(_it);
            else showItemUnavailableModal('');
        }
        // Deep-link from /products listing: ?section_slug=…&item_slug=… (CI3 parity).
        // Scroll to the section first (if provided), then open the item popup.
        const _params=new URLSearchParams(location.search);
        const _secSlug=_params.get('section_slug');
        const _slugParam=_params.get('item_slug');
        // Late-loading images above the target push it down, so a single scroll
        // lands short — a sliver of the previous section stays above the heading
        // and the scroll-spy then highlights that previous category. Re-aim with
        // instant corrections as the layout settles (no extra jank) and re-assert
        // the active highlight each time. Mirrors CI3's url-scroll settle window.
        if(_secSlug){
            const _c=findCatBySlug(_secSlug);
            if(_c){
                const _scrollToSection=()=>{
                    const _aim=behavior=>{scrollToCat('cat-'+_c.id,behavior);setCatActive(_c.id);};
                    requestAnimationFrame(()=>requestAnimationFrame(()=>_aim('smooth')));
                    setTimeout(()=>_aim('auto'),300);
                    setTimeout(()=>_aim('auto'),700);
                };
                // Home-page category tiles link here regardless of the USP filter's
                // state — if it's ON and this section has nothing matching, scrolling
                // to it would just land on an empty/hidden section with no explanation.
                // Filter stays on unless the user explicitly turns it off in the modal.
                // Reuses the real filt() so this agrees with what's actually rendered,
                // not a USP-only approximation.
                if(uspActive()&&!filt(_c.subcats.flatMap(sc=>sc.items)).length){
                    showUspBlockedModal(`${_c.name} has no items matching this filter.`,'Turn off filter & view section',_scrollToSection);
                } else {
                    _scrollToSection();
                }
            }
            else console.warn('[menu] section_slug not matched in feed:',_secSlug);
        }
        if(_slugParam){
            const _target=normSlug(_slugParam);
            const _it=allItems.find(x=>x.slug===_slugParam)
                   || allItems.find(x=>normSlug(x.slug)===_target);
            if(_it){
                // Same reasoning as the section case above — don't silently open (or
                // silently fail to open) the modal for an item the active filter
                // excludes; say so instead, via a real modal (not the toast used for
                // lighter confirmations) since the user's click primed a strong
                // expectation that a whole modal would open here. Filter stays on
                // unless the user explicitly turns it off.
                if(uspActive()&&!itemHasUsp(_it)){
                    showUspBlockedModal(`${_it.name} isn't included in this filter.`,'Turn off filter & view item',()=>openOrDeferPopup(_it));
                } else {
                    openOrDeferPopup(_it);
                }
            }
            else {
                console.warn('[menu] item_slug not matched in feed:',_slugParam);
                showItemUnavailableModal(slugLabel(_slugParam));
            }
        }
    }catch(e){console.error('[menu]',e);showClosed()}
}

// Stamp the owning sectionId onto each normalized item — mk() drops it, but
// membership "sections" buckets match on it. Harmless for every other consumer.
function tagSec(it,secId){it.sectionId=secId;return it}
// Fetch menu member-pricing (member or guest) and repaint the cards once it lands.
// No-op when the outlet doesn't offer membership. Silent on failure.
async function loadMemberPricing(){
    if(!membershipApplicable)return;
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    const pricing=await fetchMenuMemberPricing({businessId:bId,parentBusinessId:pId,user:ud});
    if(!pricing||!pricing.buckets.length)return;
    memberPricing=pricing;
    // Repaint everything that renders item cards through priceLineHTML.
    render();buildPopularGrid();buildPopularMenu();
}

// ── Per-item earn badges ─────────────────────────────────────────────────
// POST {crmBase}/loyalty/item_wise/earn_burn_catalog — menu-load pricing only
// (redemption at checkout is a separate flow and is NOT driven from here).
// Guest mode (no contactMappingId/token) is priced at the brand's lowest active
// tier and is cached server-side; a logged-in call carries the customer's own
// tier and wallet and is never cached. One call per menu load, carrying the
// slugs actually on screen, per the contract's Case 01.
//
// Deliberately silent on every failure path: the endpoint 400s for a brand with
// the flag off (Case 07) or on any internal error (Case 08), and a menu that
// can't price its badges must still be a working menu.
// Will the earn catalog run for this brand? itemLoyalty comes from wallet_rules in
// the LIVE db, which reads 0 for every brand while the feature is configured in
// UAT — so the flag can only gate the call when we're pointed at the same
// environment it describes. Against a different loyalty host (dev → crm-uat) let
// the endpoint decide, exactly as it's designed to (it rejects a brand that's off).
// Also tells fetchWalletCoins whether the balance is already coming from here.
function burnCatalogEnabled(){
    const cfg=getConfig();
    const base=String(cfg.loyaltyBase||getCrmBase()||'');
    if(!base||!String(cfg.loyaltyAuthToken||'')||!pId)return false;
    const sameEnv=base===String(getCrmBase()||'');
    const mock=new URLSearchParams(location.search).get('mock_loyalty')==='1';
    return !(sameEnv&&!itemLoyalty&&!mock);
}
async function loadEarnCatalog(){
    // loyaltyBase/loyaltyAuthToken let dev point this one feature at crm-uat;
    // both fall back to the live CRM values server-side (base.php).
    const cfg=getConfig();
    const base=String(cfg.loyaltyBase||getCrmBase()||'');
    const tok=String(cfg.loyaltyAuthToken||'');
    // Read here too, not just in burnCatalogEnabled(): the fallback below used
    // `mock` from that function's scope, so ?mock_loyalty=1 threw a ReferenceError
    // and took the whole catalog load down instead of serving the preview.
    const mock=new URLSearchParams(location.search).get('mock_loyalty')==='1';
    if(!base||!tok||!pId)return;
    if(!burnCatalogEnabled())return;
    // Needs the feed: the response is keyed by item_slug and gets matched against
    // the rendered items.
    if(!allItems.length)return;
    // parent_id + business_id (the outlet — rates are per outlet menu). item_slugs
    // narrows the catalog to specific items (filters and the like) and is
    // deliberately NOT sent on a menu load: the whole-catalog response is the same
    // for every guest of this outlet, which is what makes the server cache pay off.
    const body={parent_id:Number(pId)||pId,business_id:Number(bId)||bId};
    // Customer mode (Case 02): the pair together or not at all — one alone leaves
    // the endpoint in guest mode anyway and just leaks the token. With it, rates
    // come from the customer's own tier and the response carries their live
    // wallet balance plus per-item `affordable`.
    let ud=null;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(ud&&ud.contactMappingId&&ud.token){
        body.contactMappingId=ud.contactMappingId;
        body.token=ud.token;
    }
    let d=null;
    try{
        // Path carries the /crm_api prefix every other CRM route uses — the
        // contract document omits it, but that's where the route is mounted.
        // `token`, not `authorization`: this route's middleware differs from the
        // rest of crm_api, which is why the CRM auth token 401s here.
        const r=await fetch(`${base}/crm_api/loyalty/item_wise/earn_burn_catalog`,{
            method:'POST',
            headers:{'Content-Type':'application/json',token:tok},
            body:JSON.stringify(body),
        });
        if(r.ok)d=await r.json();
    }catch{/* menu must survive a dead catalog */}
    let res=d&&d.status===true?d.result:null;
    if(!res&&mock)res=mockEarnCatalog();
    if(!res||!Array.isArray(res.items)||!res.items.length)return;
    // An order-level block (no active tier, no allocation_pct) zeroes every item —
    // show no badges at all rather than a grid of "0 points".
    if(res.earn_blocked_reason)return;
    const map=new Map();
    res.items.forEach(it=>{if(it&&it.item_slug)map.set(String(it.item_slug),it)});
    earnCatalog=map;
    // Arrived from the loyalty rail's "View all": switch the eligible filter on now
    // that the catalog it needs has landed. The param is stripped straight after, so
    // turning the filter off and then reloading doesn't quietly turn it back on.
    const _ep=new URLSearchParams(location.search);
    if(_ep.get('eligible')==='1'){
        picks.add('eligible');
        _ep.delete('eligible');
        const _qs=_ep.toString();
        try{history.replaceState(null,'',location.pathname+(_qs?'?'+_qs:'')+location.hash)}catch(e){}
    }
    // Reveal the "Earn or redeem" chip now there is a catalog behind it. syncFilterUI
    // runs long before this resolves, so the chip can't be unhidden from there alone.
    syncFilterUI();
    earnMode=String(res.mode||'guest');
    walletBalance=res.wallet_balance==null?null:Math.floor(+res.wallet_balance||0);
    if(earnMode==='customer'&&walletBalance!=null){
        // showMemberLoyalty (the loyalty band) is the ONE balance display for an
        // item-based brand — paintCoinsBanner is the old milestone-wallet UI and
        // showed the same number a second time in a separate component.
        showMemberLoyalty(res);
    }
    else{
        // The band no longer quotes the rate, but a configured order-level rate is
        // still the test for whether this brand HAS a live programme worth asking
        // the guest to log in for — the milestone rules call has nothing to say
        // about item-based brands, so this response is the only source for it.
        const pct=parseFloat(res.allocation_pct||0);
        if(pct>0)showGuestLoyalty();
    }
    if(earnCatalog.size)render(),buildPopularGrid(),buildPopularMenu();
}
// Dev preview only (?mock_loyalty=1) — a response in the contract's shape built
// from the feed, so the badge design can be reviewed before the endpoint ships.
// Deliberately covers all three states: an earning item, a configured-zero one
// (cheap lines stand in for the blacklisted-drinks class), and an unconfigured
// one (earn_multiplier null → no badge anywhere).
// The preview balance. Taken from the MENU rather than a fixed figure: a constant
// either covers every item on a cheap menu or none on an expensive one, and then
// the preview only ever shows one of the two strip states. The median price puts
// roughly half the catalog within reach, which is the point of looking at it.
function mockBalance(){
    const ps=allItems.map(i=>Math.round(+i.sp||0)).filter(p=>p>0).sort((a,b)=>a-b);
    return ps.length?ps[Math.floor(ps.length/2)]:0;
}
function mockEarnCatalog(){
    const MOCK_BALANCE=mockBalance();
    const items=allItems.filter(i=>i.slug).map((i,idx)=>{
        const price=+i.sp||0;
        if(idx%7===6)return{item_slug:i.slug,price,earn_multiplier:null,earn_point:0,earn_skip_reason:'item_not_configured',is_redeemable:false,redeem_at_point:0};
        if(price>0&&price<80)return{item_slug:i.slug,price,earn_multiplier:0,earn_point:0,earn_skip_reason:'blacklisted_class',is_redeemable:false,redeem_at_point:0};
        // UAT returns redeem_at_point at roughly the rupee price — mirror that so
        // the preview exercises both halves of the strip.
        const redeem=Math.round(price);
        // `affordable` against the mock balance below, so the preview shows BOTH
        // strip states: claimable items highlighted with the earn half dropped,
        // dearer ones keeping "Get free for N OR Earn +M". Without it every item
        // looked identical and the condition couldn't be reviewed at all.
        return{item_slug:i.slug,price,earn_multiplier:1,earn_rate_per_rupee:0.2,earn_point:Math.floor(price*0.2),is_redeemable:true,redeem_at_point:redeem,affordable:redeem<=MOCK_BALANCE};
    });
    return{mode:'customer',allocation_basis:'lowest_tier',earn_blocked_reason:null,wallet_balance:MOCK_BALANCE,items,total_items:items.length,cached:false};
}
// One earn row for an item, or null when it has none. `earn_multiplier: null`
// means the item carries no rule at all (Case 05) — a different state from a
// configured 0% rate, and the contract requires no badge for it.
function earnRowFor(i){
    if(!earnCatalog||!i||!i.slug)return null;
    const row=earnCatalog.get(String(i.slug));
    if(!row||row.earn_multiplier==null)return null;
    return row;
}
// Full-bleed strip at the BOTTOM of a card — the same position and bleed rules
// as .membership-unlock. The markup itself lives in loyaltyBurn.js so the menu
// and the checkout (cart rows, "Craving More?" cards) render one component from
// one source; this wrapper just resolves the catalog row for a menu item.
// walletBalance goes with it: the strip drops its earn half and highlights when
// this customer's points already cover the item. Null while logged out, which is
// exactly when nothing is claimable.
function earnStripHTML(i){return burnStripHTML(earnRowFor(i),{balance:walletBalance});}
function buildCats(secs){return secs.map(sec=>{const sc=[];for(const r of sec.items||[]){if((+r.sp||0)>0||!(r.variants||[]).length){let d=sc.find(s=>s.name==='');if(!d){d={name:'',items:[]};sc.push(d)}d.items.push(tagSec(mk(r),sec.sectionId))}else sc.push({name:r.itemName||'',items:(r.variants||[]).map(c=>tagSec(mk(c),sec.sectionId))})}return{id:sec.sectionId,slug:sec.sectionsSlug||sec.sectionSlug||'',name:sec.sectionName||'',image:sec.image||'',subcats:sc}})}
function catSubHTML(name){const s=String(name||''),i=s.indexOf(' - ');return i<0?esc(s):`${esc(s.slice(0,i))}<span class="menu-cat-head__sub"> - ${esc(s.slice(i+3))}</span>`}
// Feed sometimes sends the literal strings "null"/"undefined" for optional copy
// (e.g. content/how-to-cook) — treat those as empty so tags/tabs stay hidden.
// Feed sends junk for empty copy: not just "null"/"undefined" but HTML-wrapped
// forms like "<p>null</p>". Strip tags + nbsp to test the VISIBLE text; return the
// original markup only when it has real content, else '' so tags/tabs stay hidden.
function cleanStr(v){const raw=String(v??'').trim();const t=raw.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/gi,' ').trim().toLowerCase();return(t===''||t==='null'||t==='undefined')?'':raw}
// Structured per-item tag config (Menu Hub v2 / tagsConfig — see BrandUspService).
// Each tag: {tagKey, name, color, icon, displayMode:'name'|'icon'}. `hidden` tags are
// dropped entirely at the point items reach the card templates. Defensive against a
// brand whose feed hasn't shipped `tags` yet — falls back to all-empty, same as an
// item with no tags at all.
function normalizeTags(t){
    if(!t||typeof t!=='object')return{primary:[],secondary:[]};
    return{primary:Array.isArray(t.primary)?t.primary:[],secondary:Array.isArray(t.secondary)?t.secondary:[]};
}
function mk(r){const sp=+r.sp||0,vs=r.variants||[],ts=r.templates||[];const ps=vs.map(v=>+v.sp||0).filter(p=>p>0);const fr=ps.length?Math.min(...ps):sp;
// Variant items (Regular/Medium…) carry their real mrp/sp per option — the parent
// record's own mrp/sp are usually both 0. Pull the cheapest variant's mrp so the
// card's "from" price shows the same strike-through the customisation modal does.
const frVariant=vs.length?vs.find(v=>(+v.sp||0)===fr):null;
const mrp=frVariant?(+frVariant.mrp||0):(+r.mrp||0);
const tmplIdStr=r.templateId||ts.map(t=>t.templateId).filter(Boolean).join(',');const oos=(+r.status===-1)||(+r.out_of_stock===1)||(+r.outOfStock===1);const _vprep=vs.length>0?(vs[0].preparation_time||''):'';const prepTime=(_vprep&&_vprep!=='00:00:00'?_vprep:'')||r.preparation_time||'';const viewType=+r.viewType||0;const isBogo=viewType===3;const isCombo=viewType===2&&ts.length>0;const wizardSteps=r.wizardSteps||[];const images=(r.image?[r.image]:[]).concat(parseSecImgs(r.secondaryImages));return{id:r.id||'',slug:r.itemSlug||r.slug||'',name:String(r.itemName||'').replace(/^[\s\-–—·•.]+/,''),desc:r.description||'',image:r.image||'',images,sp:fr||sp,mrp,veg:normVeg(r.vegNonvegBoth),best:r.recommended==1,isNew:r.newItem==1,featured:r.featured==1,highlyOrdered:r.highlyOrderedItem==1,offerTag:(r.offerTag||'').toString().trim(),hasSubs:vs.length>0,subCnt:vs.length,subs:vs,hasTmpl:ts.length>0||!!tmplIdStr,tmpls:ts,tmplIds:tmplIdStr,disc:mrp>fr&&fr>0?Math.round((mrp-fr)/mrp*100):0,rat:+r.avgRating||0,oos,prepTime,viewType,isBogo,isCombo,wizardSteps,nutrition:Array.isArray(r.nutrition)?r.nutrition:[],content:cleanStr(r.content),custom_tags:(r.custom_tags||'').toString().trim(),tags:normalizeTags(r.tags),usp_tag:r.usp_tag===true}}

// Every item id in the feed menu, at EVERY variant nesting level (buildCats only
// flattens one). Used to reject Featured/popular rows that no longer exist in the menu.
function collectFeedItemIds(secs){
    const walk=r=>{if(r&&r.id!=null)feedItemIds.add(String(r.id));(r.variants||[]).forEach(walk)};
    (secs||[]).forEach(sec=>(sec.items||[]).forEach(walk));
}

// Resolve a rendered card's item by id. The main list lives in allItems, but the
// Featured Items rail and server "Your Favourites" rail can carry items NOT in
// allItems (e.g. a promoted variant whose id is a deep variant id) — popularCard()
// builds those fresh via mk(). Look across all three pools so a card click always
// finds its item and opens the modal, instead of falling through to add-to-cart.
function findItem(id){
    const s=String(id);
    let it=allItems.find(x=>String(x.id)===s);
    if(it)return it;
    it=mostOrderedItems.find(x=>String(x.id)===s);
    if(it)return it;
    const p=popularItems.find(x=>String(x.id||'')===s);
    return p?mk(p):null;
}

// ── Multiple-image (secondaryImages) support — CI3 parity ──
// Feed carries `secondaryImages` as a comma-separated string (or array) of
// filenames living under the same CDN/{pId}/ path as the main image. mk() folds
// them into an `images` array (main first). Cards show a stacked-image badge;
// item popups render a swipeable gallery with dots.
function parseSecImgs(v){
    if(!v||v==='null')return[];
    const arr=Array.isArray(v)?v:String(v).split(',');
    return arr.map(s=>String(s).trim()).filter(s=>s&&s!=='null');
}
// CDN url for an image filename (empty filename → empty string).
// Used for the item modal / gallery, where we want the full-resolution original.
function imgUrl(f){return f?`${CDN}/${pId}/${f}`:'';}
// CDN url for a *card* thumbnail — a smaller, webp-encoded square crop served from
// the /crops/{w}/ path (full-res original is reserved for the modal via imgUrl()).
// Renders the 160 crop as a baseline; the global cardImage.js observer upgrades
// cards that render wider than 160px to the 256 crop (measures the actual
// rendered width after layout, deliberately ignoring devicePixelRatio).
// Restaurants use the webp 160-crop; grocery images have no generated crop (the
// /crops/ path 502s) so grocery falls back to the full-res original, which 200s.
function cardImgUrl(f){if(!f)return'';if(/^https?:/.test(f))return f;return isGrocery?`${CDN}/${pId}/${f}`:`${CDN}/${pId}/crops/160/${f}.webp`;}
// Add-on thumbnail for the customise modal. Uses the full-res original (not a
// /crops/ variant) to match the combo and BOGO addon renderers below — add-on
// images are uploaded through the same dashboard flow but aren't guaranteed a
// generated crop. No image → no cell at all (empty string): never a brand-logo
// stand-in (on a food option a logo reads as that option's photo) and never a
// reserved blank, which just leaves a hole beside the illustrated rows.
function addonThumbHTML(x){
    const src=imgUrl(x.image);
    return src?`<span class="popup-addon__thumb"><img src="${src}" alt="" loading="lazy"></span>`:'';
}
// Stacked-squares badge shown on a card when the item has >1 image
const MULTI_IMG_BADGE=`<span class="menu-multi-img" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>`;
const hasMultiImg=i=>(i.images||[]).filter(Boolean).length>1;
// Hero markup for an item popup: single <img> when 1 image, swipe gallery when many.
// Falls back to the grayscaled brand logo when no item image exists (CI3 parity).
function galleryHTML(item){
    const urls=(item.images||[]).map(imgUrl).filter(Boolean);
    if(urls.length<=1){
        const u=urls[0]||'';
        return u?`<img src="${u}" alt="${esc(item.name)}">`:(bLogo?`<img src="${esc(bLogo)}" alt="" class="popup-img-fallback">`:'');
    }
    return `<div class="menu-gallery"><div class="menu-gallery__track">${urls.map(u=>`<img src="${u}" alt="${esc(item.name)}" loading="lazy">`).join('')}</div><div class="menu-gallery__dots"></div></div>`;
}
// Wire dots + touch-swipe for any galleries inside `root`. Mirrors CI3 initializeSlider.
function initGallery(root){
    root.querySelectorAll('.menu-gallery').forEach(g=>{
        const track=g.querySelector('.menu-gallery__track');
        const dotsC=g.querySelector('.menu-gallery__dots');
        const slides=track?track.children:[];
        if(!track||slides.length<=1){if(dotsC)dotsC.style.display='none';return;}
        let index=0,startX=0,curX=0;
        const go=i=>{index=i;track.style.transform=`translateX(-${i*100}%)`;dots.forEach(d=>d.classList.remove('active'));dots[i].classList.add('active')};
        dotsC.innerHTML='';
        for(let i=0;i<slides.length;i++){const d=document.createElement('span');if(i===0)d.classList.add('active');d.addEventListener('click',()=>go(i));dotsC.appendChild(d)}
        const dots=dotsC.querySelectorAll('span');
        g.addEventListener('touchstart',e=>{startX=e.touches[0].clientX;curX=startX},{passive:true});
        g.addEventListener('touchmove',e=>{curX=e.touches[0].clientX},{passive:true});
        g.addEventListener('touchend',()=>{const diff=startX-curX;if(diff>50&&index<slides.length-1)go(index+1);else if(diff<-50&&index>0)go(index-1)});
    });
}

// ── Offers — populates the .menu-offer-card in the outlet strip ──
function renderOfferStrip(list){
    allPromos=list||[];
    refreshOffers();
}
// Show a promo only when its valid_oType covers the active order type (CI3 parity,
// order_menu_new.php:2350). No valid_oType / no order type → applies to all.
function offerAppliesToOrderType(promo,ot){
    const types=(promo&&promo.valid_oType)
        ?String(promo.valid_oType).split(',').map(x=>parseInt(x.trim(),10)).filter(n=>!isNaN(n))
        :[];
    return !ot||!types.length||types.includes(ot);
}
// Resolve the active order type as a number. Prefer the visibly-selected
// .ot-btn.on button (the on-screen source of truth) over localStorage, which can
// drift stale — otherwise a delivery-only promo can stay hidden on a Delivery view.
function activeOrderType(){
    const otMap={delivery:1,pickup:2,dine_in:3,in_car:4};
    const btn=document.querySelector('.ot-btn.on');
    const fromBtn=btn&&otMap[btn.dataset.ot];
    if(fromBtn)return fromBtn;
    return parseInt(localStorage.getItem('orderType')||'',10);
}
// Filter the feed promos by the active order type and paint the strip. Re-run
// whenever the order type changes so a delivery-only promo hides in pickup/dine-in.
function refreshOffers(){
    const ot=activeOrderType();
    allOffers=allPromos.filter(p=>offerAppliesToOrderType(p,ot));
    // Temporary instrumentation: run `localStorage.offersDebug=1` then reload to
    // trace why an offer shows/hides per order type. Remove once verified.
    if(localStorage.getItem('offersDebug')==='1'){
        console.group(`[offers] orderType=${ot} | feed promos=${allPromos.length} | visible=${allOffers.length}`);
        allPromos.forEach(p=>console.log(`${offerAppliesToOrderType(p,ot)?'SHOW':'HIDE'}  ${p.code||'(no code)'}  valid_oType=${JSON.stringify(p.valid_oType??null)}`));
        console.groupEnd();
    }
    const card=ge('offerFeatured'),title=ge('offerFeaturedTitle'),sub=ge('offerFeaturedSub'),count=ge('offerFeaturedCount');
    if(!card)return;
    if(!allOffers.length){card.hidden=true;return }
    card.hidden=false;
    const first=allOffers[0];
    const headline=first.title||first.display_name||'Offer available';
    if(title)title.textContent=headline;
    // Right-side badge gets the total count ("5 OFFERS"); subtitle shows the
    // code or an "Auto-applied at checkout" hint so the two don't duplicate.
    if(count)count.textContent=`${allOffers.length} OFFER${allOffers.length===1?'':'S'}`;
    if(sub)sub.textContent=first.code?`Use code ${first.code}`:'Auto-applied at checkout';
    card.onclick=()=>{const sheet=ge('offerSheet');if(sheet)sheet.hidden=false};
}
function offerRowHTML(p){
    const title=esc(p.title||p.display_name||'Offer');
    const desc=esc(p.description||'');
    const code=esc(p.code||'');
    const minOrder=(+p.min_order_value||0);
    return`<div class="offer-row">
        <div class="offer-row__ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><path d="M9 9h.01"/><path d="M15 15h.01"/></svg></div>
        <div class="offer-row__body">
            <div class="offer-row__title">${title}</div>
            ${desc?`<div class="offer-row__desc">${desc}</div>`:''}
            ${minOrder>0?`<div class="offer-row__meta">Min order ₹${minOrder}</div>`:''}
        </div>
        ${code?`<button class="offer-copy-btn" data-code="${code}" type="button">${code}</button>`:''}
    </div>`;
}
function openOfferSheet(){
    const sheet=ge('offerSheet'),list=ge('offerList');
    if(!sheet||!list)return;
    if(!allOffers.length){
        list.innerHTML='<p style="text-align:center;color:var(--fg-3);padding:24px 0">No offers right now.</p>';
    } else {
        const memberOffers=allOffers.filter(p=>String(p.is_membership_offer)==='1');
        const regularOffers=allOffers.filter(p=>String(p.is_membership_offer)!=='1');
        let html='';
        if(memberOffers.length){
            html+=`<div class="offer-section">
                <div class="offer-section__head offer-section__head--member">Just for you</div>
                ${memberOffers.map(offerRowHTML).join('')}
            </div>`;
        }
        if(regularOffers.length){
            html+=`<div class="offer-section">
                <div class="offer-section__head">Explore More</div>
                ${regularOffers.map(offerRowHTML).join('')}
            </div>`;
        }
        list.innerHTML=html;
    }
    sheet.hidden=false;
}

// ── Featured → stored for injection into render() ──
// popularItems is hoisted to top-of-module state to avoid TDZ when load() resumes
// before this declaration site (cloud-kitchen refresh path hits this).
// rows.popular can carry stale promo rows that no longer exist in rows.menu (a
// withdrawn combo keeps its popular entry, with NULL sp+mrp) — those rendered as a
// "₹0" Featured card with a live ADD button for an item you can't actually order.
// Keep only ids present in the feed menu tree. The check is against feedItemIds (ALL
// nesting levels), not allItems (one level) — brands do promote a deep variant here.
function showFeatured(list){
    popularItems=(list||[]).filter(p=>!feedItemIds.size||feedItemIds.has(String(p.id||'')));
    /* rendered inline by render() as first section */
}

// ── Popular grid for search — 3-column card grid ──
function buildPopularGrid(){
    const g=ge('popularGrid');if(!g)return;
    const popular=allItems.filter(i=>i.best||i.isNew).slice(0,6);
    if(!popular.length){ge('searchPopular')?.remove();return}
    const pop=p=>p.hasSubs||p.hasTmpl||p.isBogo;
    g.innerHTML=popular.map(p=>{
        // Always render the image block (brand-logo grayscale fallback when the
        // item has no image) so every card is the same height — a mixed grid of
        // image / no-image cards looked broken on mobile.
        const img=p.image?cardImgUrl(p.image):(bLogo||'');
        const imgTag=img?`<img src="${img}" alt="${esc(p.name)}" loading="lazy"${!p.image&&bLogo?' style="filter:grayscale(0.9)"':''}>`:'';
        return`<div class="srch-card card-add" data-id="${p.id}" data-nm="${esc(p.name)}" data-pr="${p.sp}" data-pop="${pop(p)?1:0}" data-veg="${p.veg}">
  <div class="srch-card-img">${imgTag}</div>
  <div class="srch-card-body">
    ${tagRowHTML(p)}
    <div class="srch-name">${esc(p.name)}</div>
    ${secondaryTagsHTML(p)}
    <div class="srch-foot">${searchPriceHTML(p,p.sp,'srch-price')}${searchAddHTML(p)}</div>
    ${searchUnlockHTML(p)}
    ${nextAvailableHTML()}
  </div>
</div>`}).join('')}

// ── Popular menu thumbnails for search — shows categories (CI3 parity) ──
function buildPopularMenu(){
    const g=ge('popularMenuGrid');if(!g)return;
    if(!cats.length){ge('popularMenuSection')?.remove();return}
    g.innerHTML=cats.map(c=>{
        const img=c.image?cardImgUrl(c.image):(bLogo||'');
        const imgTag=img?`<img src="${img}" alt="${esc(c.name)}" loading="lazy"${!c.image&&bLogo?' style="filter:grayscale(0.9)"':''}>`:'';
        return`<div class="srch-thumb srch-cat" data-cid="${c.id}">
  ${imgTag}
  <div class="srch-thumb-name">${esc(c.name)}</div>
</div>`}).join('')}

// Grocery categories load lazily, so their count is unknown until the section is
// fetched. Show a chevron instead of a blank (or misleading 0); updateNavCount()
// swaps in the real number once the section loads.
const GROC_CHEVRON='<svg class="menu-cat-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
// ── Sidebar — emits .menu-cat rows inside the left rail ──
function buildSidebar(){
    const nav=ge('sectionList'),ms=ge('menuSheetList');if(!nav)return;
    const popLink=popularItems.length?`<a class="menu-cat active" href="#popular-picks" data-cid="popular-picks"><span class="menu-cat-name">Featured Items</span><span class="menu-cat-count">${popularItems.length}</span></a>`:'';
    const links=cats.map(c=>{
        const count=(isGrocery&&!c.loaded)?GROC_CHEVRON:c.subcats.reduce((s,sc)=>s+sc.items.length,0);
        const hasSubs=c.subcats.length>1 && c.subcats.some(sc=>sc.name);
        const expand=hasSubs?'<span class="menu-cat-expand" aria-hidden="true">+</span>':'';
        const row=`<a class="menu-cat" href="#cat-${c.id}" data-cid="${c.id}"><span class="menu-cat-name">${esc(c.name)} ${expand}</span><span class="menu-cat-count">${count}</span></a>`;
        // The #sub- index is the subcat's position in the UNFILTERED c.subcats, so
        // the link keeps pointing at the right <section> once filters drop some of
        // them (render() uses the same original index — see `_j` there).
        const subRows=hasSubs?`<div class="menu-sub-wrap" data-parent="${c.id}">${c.subcats.map((sc,j)=>({sc,j})).filter(x=>x.sc.name).map(({sc,j})=>`<a class="menu-sub" href="#sub-${c.id}-${j}">${esc(sc.name)} <span class="menu-cat-count">${sc.items.length}</span></a>`).join('')}</div>`:'';
        return row+subRows;
    }).join('');
    nav.innerHTML=popLink+links;

    // Mobile category sheet — clean list rows; first item gets .is-active
    if(ms){
        const popSheet=popularItems.length?`<a class="ms-row is-active" href="#popular-picks"><span class="ms-row__name">Featured Items</span><span class="ms-row__count">${popularItems.length}</span></a>`:'';
        ms.innerHTML=popSheet+cats.map((c,i)=>{
            const count=(isGrocery&&!c.loaded)?GROC_CHEVRON:c.subcats.reduce((s,sc)=>s+sc.items.length,0);
            const hasSubs=c.subcats.length>1 && c.subcats.some(sc=>sc.name);
            // The "+" is a real <button> sibling of the row link (not nested inside
            // the <a>) so a tap lands on the button, never the row's navigation.
            const plus=hasSubs?'<button type="button" class="ms-row__plus" aria-label="Show subcategories">+</button>':'';
            const active=(!popularItems.length && i===0)?' is-active':'';
            const row=`<div class="ms-row${active}"><a class="ms-row__link" href="#cat-${c.id}"><span class="ms-row__name">${esc(c.name)}</span></a>${plus}<span class="ms-row__count">${count}</span></div>`;
            const subRows=hasSubs?`<div class="ms-sub-wrap" data-parent="${c.id}">${c.subcats.map((sc,j)=>({sc,j})).filter(x=>x.sc.name).map(({sc,j})=>`<a class="ms-sub" href="#sub-${c.id}-${j}"><span class="ms-sub__name">${esc(sc.name)}</span><span class="ms-row__count">${sc.items.length}</span></a>`).join('')}</div>`:'';
            return row+subRows;
        }).join('');
    }

    // Click: scroll to section, mark active. If the row has sub-categories,
    // also expand the sub-list inline so the user sees the sub options
    // alongside the scrolled section. The "+" icon click still toggles
    // (handled separately) so users can collapse if they want.
    if(nav)nav.onclick=e=>{
        if(e.target.closest('.menu-cat-expand'))return; // expand handler owns this click
        // Sub-category link — same nav path as a category: if the active filters
        // (or a stale search, e.g. a failed voice search) removed the #sub- target,
        // clear them and re-render so it exists, then scroll. Without this,
        // .menu-sub falls through to native anchor scrolling and the "No results"
        // filter state lingers.
        const subA=e.target.closest('a.menu-sub');
        if(subA){
            e.preventDefault();
            const _subId=subA.getAttribute('href')?.slice(1);
            clearFiltersForNav(_subId);
            scrollToCat(_subId);
            return;
        }
        const a=e.target.closest('a.menu-cat');if(!a)return;e.preventDefault();
        const _navHref=a.getAttribute('href');
        clearFiltersForNav(_navHref?.slice(1));
        trackCategoryOnce(_navHref);
        scrollToCat(_navHref?.slice(1));
        // Grocery: load the clicked category's items immediately (don't wait for
        // the scroll-into-view observer). Grocery-only; no-op for restaurants.
        if(isGrocery&&_navHref?.startsWith('#cat-'))queueGrocSection(_navHref.slice(5),true);
        nav.querySelectorAll('.menu-cat').forEach(x=>x.classList.remove('active'));
        a.classList.add('active');
        const wrap=a.nextElementSibling;
        if(wrap&&wrap.classList.contains('menu-sub-wrap')){
            collapseSubsExcept(nav,wrap,'.menu-sub-wrap','.menu-cat-expand');
            wrap.classList.add('open');
            const exp=a.querySelector('.menu-cat-expand');
            if(exp)exp.textContent='−';
        }
    };
    // Single handler for the mobile sheet (no second listener elsewhere — see the
    // note where menuSheet is wired). Behaviour:
    //  • tap the "+"               → toggle the sub-list only (accordion), sheet stays open
    //  • tap a category WITH subs  → scroll + expand inline (accordion), sheet stays open
    //  • tap a category WITHOUT subs → scroll + close the sheet
    //  • tap a sub-category        → scroll + close the sheet
    // The whole category card is the click target (not just the link/“+”).
    if(ms)ms.onclick=e=>{
        const closeSheet=()=>{const sh=ge('menuSheet');if(sh)sh.hidden=true;};
        // "+" toggles the sub-list only — no scroll, sheet stays open.
        const plus=e.target.closest('.ms-row__plus');
        if(plus){
            e.preventDefault();
            const wrap=plus.closest('.ms-row')?.nextElementSibling;
            if(wrap&&wrap.classList.contains('ms-sub-wrap')){
                const open=wrap.classList.toggle('open');
                if(open)collapseSubsExcept(ms,wrap,'.ms-sub-wrap','.ms-row__plus');
                plus.textContent=open?'−':'+';
                plus.setAttribute('aria-label',open?'Hide subcategories':'Show subcategories');
            }
            return;
        }
        // Sub-category selected → scroll to it and close the sheet.
        const subA=e.target.closest('.ms-sub');
        if(subA){
            e.preventDefault();
            const _subId=subA.getAttribute('href')?.slice(1);
            clearFiltersForNav(_subId);
            scrollToCat(_subId);
            closeSheet();
            return;
        }
        // Whole category card is clickable.
        const row=e.target.closest('.ms-row');
        if(!row)return;
        e.preventDefault();
        const link=row.querySelector('.ms-row__link');
        const _msHref=link?.getAttribute('href')||row.getAttribute('href');
        clearFiltersForNav(_msHref?.slice(1));
        trackCategoryOnce(_msHref);
        scrollToCat(_msHref?.slice(1));
        // Grocery: load the tapped category's items immediately (grocery-only).
        if(isGrocery&&_msHref?.startsWith('#cat-'))queueGrocSection(_msHref.slice(5),true);
        // Mark the tapped row active for every category (not just ones with
        // subs) — the scroll observer only drives the desktop rail, so without
        // this the initial Featured Items highlight would never move in the sheet.
        ms.querySelectorAll('.ms-row').forEach(r=>r.classList.remove('is-active'));
        row.classList.add('is-active');
        const wrap=row.nextElementSibling;
        if(wrap&&wrap.classList.contains('ms-sub-wrap')){
            // Has sub-categories → expand inline (accordion), keep the sheet open.
            collapseSubsExcept(ms,wrap,'.ms-sub-wrap','.ms-row__plus');
            wrap.classList.add('open');
            const exp=row.querySelector('.ms-row__plus');
            if(exp){exp.textContent='−';exp.setAttribute('aria-label','Hide subcategories');}
        } else {
            // No sub-categories → navigate and close the sheet.
            closeSheet();
        }
    };
}

// Accordion helper — collapse every open sub-list in `container` except `keep`,
// resetting each "+" toggle back to collapsed. Shared by the desktop sidebar
// (#sectionList) and the mobile sheet (#menuSheetList). The "+" toggle always
// lives inside the wrap's previous sibling (the .menu-cat / .ms-row row), so one
// lookup works for both. `plusSel` is the toggle's selector for that container.
function collapseSubsExcept(container,keep,wrapSel,plusSel){
    if(!container)return;
    container.querySelectorAll(wrapSel+'.open').forEach(w=>{
        if(w===keep)return;
        w.classList.remove('open');
        const p=w.previousElementSibling?.querySelector(plusSel);
        if(p){p.textContent='+';if(p.tagName==='BUTTON')p.setAttribute('aria-label','Show subcategories');}
    });
}
// Single source of truth for filter highlights. The same veg/picks/sortBy state
// drives three separate control sets (toolbar chips, filter sheet, search modal);
// re-deriving every control's .active class from state keeps them in sync no
// matter which set the user clicked. Module-scoped so both bindAll's chip handlers
// and clearFiltersForNav (below) can drive it.
function syncFilterUI(){
    // Single-value chips: Non-Veg everywhere, plus the sheet's Veg / Veg & Egg /
    // Non-Veg. Each stands for exactly one value of `veg`, so exact match.
    document.querySelectorAll('[data-veg-filter],.diet-btn,.srch-diet-btn').forEach(b=>{
        const v=b.dataset.vegFilter||b.dataset.diet;
        if(v)b.classList.toggle('active',!!veg&&v===veg);
    });
    // The Veg group chip (toolbar + search modal) stands for BOTH veg options, so it
    // reflects whichever is picked and renames itself to match (R4). The caret — and
    // with it the whole dropdown affordance — only exists on a menu that has an egg
    // dish; otherwise this is the plain Veg toggle it has always been (R2).
    document.querySelectorAll('.diet-chip').forEach(b=>{
        b.classList.toggle('active',veg==='veg'||veg==='veg-egg');
        const lbl=b.querySelector('.diet-chip__label');
        if(lbl)lbl.textContent=!menuHasEgg?'Veg':(veg==='veg-egg'?'Veg & Egg':veg==='veg'?'Pure Veg':'Veg');
        // Marker follows the label: the yellow egg square while Veg & Egg is the active
        // pick, the green veg square for Veg / Pure Veg — matching the sheet's chips.
        const mark=b.querySelector('.veg-mark,.egg-mark');
        if(mark){const isEgg=veg==='veg-egg';mark.classList.toggle('egg-mark',isEgg);mark.classList.toggle('veg-mark',!isEgg);}
        // toggleAttribute, NOT .hidden: the caret is an <svg>, and `hidden` is an
        // HTMLElement property that SVGElement doesn't implement — assigning it just
        // sets a JS expando and leaves the HTML attribute (and display:none) in place.
        const caret=b.querySelector('.diet-chip__caret');
        if(caret)caret.toggleAttribute('hidden',!menuHasEgg);
        // With a dropdown attached, "Show all items" in it is the reset, so the chip
        // drops its ✕. Without one (egg-less menu) the ✕ is the only way to clear.
        const x=b.querySelector('.menu-chip__x');
        if(x)x.hidden=menuHasEgg;
        b.setAttribute('aria-haspopup',menuHasEgg?'menu':'false');
        b.setAttribute('aria-expanded',dietMenuIsOpen()&&dietMenuAnchor===b?'true':'false');
    });
    document.querySelectorAll('[data-quick],.pick-btn,.srch-pick-btn').forEach(b=>
        b.classList.toggle('active',picks.has(b.dataset.quick||b.dataset.pick)));
    // The redeemable chip only exists while its filter is on (the band's "View
    // items" CTA turns it on) — otherwise it's a filter nobody could satisfy.
    const rc=ge('chipRedeemable');if(rc)rc.hidden=!picks.has('redeemable');
    // No toolbar chip for 'eligible' — the points strip owns it end to end, both
    // turning it on and turning it off. A chip as well put the same switch in two
    // places, one of them in a row of generic facets where it read as unrelated to
    // the balance it acts on.
    syncLoyaltyEligibleToggle();
    document.querySelectorAll('.sort-btn,.srch-sort-btn').forEach(b=>
        b.classList.toggle('active',!!sortBy&&b.dataset.sort===sortBy));
    document.querySelectorAll('.menu-chip--tag').forEach(b=>{
        const k=b.dataset.tagKey;
        b.classList.toggle('active',(uspTagKey&&k===uspTagKey)?uspOn:activeTagKeys.has(k));
    });
    // USP filter chip (toolbar) + sidebar "Filtered by X" badge + mobile status bar —
    // all built + unhidden by buildUspUI() only once getFilterList resolves with
    // a live USP tag (see initUsp/fetchFilterList). Desktop: chip/badge hidden by
    // default, shown only while on (menu.css). Mobile (≤991px): the chip is forced
    // always-visible by a CSS override regardless of `hidden` — .active is what
    // actually distinguishes on/off there, since it's the only always-present
    // control (the header toggle is home-page-only now — see usp_toggle.js).
    // The mobile status bar is ALWAYS visible too (never hidden) once built — it's
    // the primary mobile discovery surface for the whole feature, so its text swaps
    // between an off-state prompt and the on-state item count instead of
    // appearing/disappearing.
    if(uspTagKey){
        const chip=ge('uspFilterChip');if(chip)chip.classList.toggle('active',uspOn);
        const badge=ge('uspFilteredBadge');if(badge)badge.hidden=!uspOn;
        const badgeMobile=ge('uspFilteredBadgeMobile');if(badgeMobile)badgeMobile.hidden=!uspOn;
        const bar=ge('uspMobileBar');
        if(bar){
            bar.classList.toggle('active',uspOn);
            const countEl=ge('uspMobileBarCount');
            if(countEl){
                countEl.textContent=uspOn
                    ?`Showing ${filt(allItems).length} of ${allItems.length} — filtered by ${uspSummaryLabel()}`
                    :`Tap to see only ${uspTitle} items`;
            }
        }
        // The switch's visual slide (thumb position/fill — theme.css
        // [aria-checked="true"] .usp-toggle__switch) is driven entirely by this
        // attribute, not the .active class above — without it the graphic never
        // flips even though uspOn/the text/the filtering are all correctly toggled.
        const barSwitch=ge('uspMobileBarSwitch');
        if(barSwitch)barSwitch.setAttribute('aria-checked',uspOn?'true':'false');
    }
    reorderToolbarChips();
    reorderSearchChips();
}
// Small generic "Filtered by X, Y" helper text — NOT tied to Clean/USP
// specifically (that dedicated bar/badge is gone), just a plain summary of
// whatever's currently active, visible on both mobile and desktop (unlike
// the old sidebar badge, which was desktop-only since the sidebar itself is
// hidden on mobile). Sits in the same spot the old bar/badge occupied, in
// order_menu_new.php, right below the toolbar.
function activeFilterDisplayNames(){
    const names=[];
    // in_stock is deliberately excluded — it's on by DEFAULT for most brands
    // (see the initial `picks` state), so including it here would show
    // "Filtered by In Stock" permanently from first load, even with nothing
    // actually user-applied. Same exclusion filtersActive already uses
    // elsewhere (userPicks = picks minus in_stock) for the same reason.
    // "Pure Veg" only reads as a distinct thing next to "Veg & Egg" — on an egg-less
    // menu the same filter is just "Veg". Also the analytics label (trackFiltersOnce).
    if(veg==='veg')names.push(menuHasEgg?'Pure Veg':'Veg');
    else if(veg==='veg-egg')names.push('Veg & Egg');
    else if(veg==='non-veg')names.push('Non-Veg');
    if(picks.has('offer'))names.push('On Offer');
    if(picks.has('rated'))names.push('Rated 4+');
    if(picks.has('redeemable'))names.push('Redeemable now');
    if(picks.has('eligible'))names.push('Eligible items');
    activeTagKeys.forEach(k=>{
        if(uspTagKey&&k===uspTagKey)return; // appended separately below — avoid double-counting
        const entry=tagCatalog.find(t=>t.tagKey===k);
        if(entry)names.push(entry.name);
    });
    if(uspOn&&uspTagKey)names.push(uspTitle);
    return names;
}
// The USP bar always names the USP tag itself first, then summarizes any
// OTHER active filters as "and other"/"and others" rather than spelling each
// one out — e.g. just "new" alone, "new and other" (exactly one more active),
// or "new and others" (two or more).
function uspSummaryLabel(){
    const names=activeFilterDisplayNames(); // [...other names, uspTitle] — uspTitle is always last while uspOn
    const otherCount=names.length-1;
    return otherCount<=0?uspTitle:`${uspTitle} and ${otherCount===1?'other':'others'}`;
}
// Every applied (.active) toolbar chip bubbles to the front: the USP/Clean
// chip first among them (if active), then In Stock (if active) — otherwise
// each just sits wherever it naturally falls, same as any other inactive
// chip. Everything inactive keeps its original relative order after all the
// actives. Runs after every .active update above so the row always reflects
// the CURRENT filter state, regardless of which control (toolbar click,
// sheet Apply, sort, Clear) changed it. Uses Node.append() on the existing
// elements (not innerHTML rebuild), so click handlers/tag-chip state are
// untouched — just reordered.
// data-pick/data-diet are the search modal's own attribute names for the
// same quick-pick/veg-filter chips (.srch-pick-btn/.srch-diet-btn) — folded
// in here so reorderSearchChips() below can share this same priority scheme.
function chipSortKey(b){
    const quick=b.dataset.quick||b.dataset.vegFilter||b.dataset.pick||b.dataset.diet||b.dataset.dietKey;
    if(quick){
        const idx=STATIC_CHIP_ORDER.indexOf(quick);
        return idx>=0?idx:STATIC_CHIP_ORDER.length;
    }
    if(b.classList.contains('menu-chip--tag')){
        const idx=tagCatalog.findIndex(t=>t.tagKey===b.dataset.tagKey);
        return STATIC_CHIP_ORDER.length+1+(idx>=0?idx:9999);
    }
    return 99999;
}
// True for the generic tag-chip copy of the USP tag (renderTagChips()) —
// the one actually rendered/visible in the toolbar, filter sheet, and search
// modal alike. NOT .menu-chip--usp (#uspFilterChip): that dedicated toolbar
// chip is permanently `display:none` there (menu.css — superseded by this
// tag-chip copy + the mobile status bar), so treating it as "the" USP chip
// to pin first would promote an invisible element while the real, visible
// "Clean" chip stays wherever chipSortKey's generic tag ordering puts it.
function isUspChip(b){
    return !!uspTagKey&&b.classList.contains('menu-chip--tag')&&b.dataset.tagKey===uspTagKey;
}
function reorderToolbarChips(){
    const bar=ge('menuToolbarChips');
    if(!bar)return;
    // #filterBtn ("Filters" + count badge) stays pinned first always — it's
    // the entry point to the sheet, not a filter chip itself, even though it
    // also gets .active (via the badge count) whenever anything's applied.
    const filterBtn=ge('filterBtn');
    const kids=[...bar.children].filter(b=>b!==filterBtn);
    const uspActive=kids.find(b=>isUspChip(b)&&b.classList.contains('active'));
    const afterUsp=kids.filter(b=>b!==uspActive);
    const inStockActive=afterUsp.find(b=>b.dataset.quick==='in_stock'&&b.classList.contains('active'));
    const rest=afterUsp.filter(b=>b!==inStockActive);
    const actives=rest.filter(b=>b.classList.contains('active')).sort((a,b)=>chipSortKey(a)-chipSortKey(b));
    const inactives=rest.filter(b=>!b.classList.contains('active')).sort((a,b)=>chipSortKey(a)-chipSortKey(b));
    const ordered=[...(filterBtn?[filterBtn]:[]),...(uspActive?[uspActive]:[]),...(inStockActive?[inStockActive]:[]),...actives,...inactives];
    bar.append(...ordered);
}
// Same "applied filters bubble to the front, USP then In Stock first" rule
// as reorderToolbarChips(), for the search modal's filter-chip row
// (order_menu_new.php's .search-filter-chips). That row mixes static
// srch-*-btn buttons with the dynamic #srchTagChips catalog (tags + the USP
// entry) — #srchTagChips is `display:contents` (menu.css) so its children
// already render as if they were direct siblings; querying '.menu-chip'
// instead of bar.children (as reorderToolbarChips does) reaches into it, and
// appending flattens those chips out to be actual direct children of `bar` —
// harmless, since #srchTagChips was only ever a scoping target for
// renderTagChips()'s innerHTML write, not a layout wrapper.
function reorderSearchChips(){
    const bar=ge('searchFilterChips');
    if(!bar)return;
    const kids=[...bar.querySelectorAll('.menu-chip')];
    const uspActive=kids.find(b=>isUspChip(b)&&b.classList.contains('active'));
    const afterUsp=kids.filter(b=>b!==uspActive);
    const inStockActive=afterUsp.find(b=>(b.dataset.quick||b.dataset.pick)==='in_stock'&&b.classList.contains('active'));
    const rest=afterUsp.filter(b=>b!==inStockActive);
    const actives=rest.filter(b=>b.classList.contains('active')).sort((a,b)=>chipSortKey(a)-chipSortKey(b));
    const inactives=rest.filter(b=>!b.classList.contains('active')).sort((a,b)=>chipSortKey(a)-chipSortKey(b));
    const ordered=[...(uspActive?[uspActive]:[]),...(inStockActive?[inStockActive]:[]),...actives,...inactives];
    bar.append(...ordered);
}
// Navigating via a category (sidebar or sheet) resets the user-applied filters
// (veg / quick picks / sort) and any active text search back to the page default —
// the default in-stock filter is preserved (mirrors the initial `picks` state).
// This is a LAST RESORT, only when the filters (or a stale search query, e.g. a
// failed voice search) excluded `targetId` so it isn't rendered: scrollToCat would
// find nothing and the filter would look "stuck". When the target section survived
// the filters it stays in the DOM and the filters stay applied — browsing to a
// category with "Veg" on must keep showing veg items, not silently drop the filter.
// Re-syncs every chip's highlight, then re-renders so the target exists before
// scrollToCat runs.
function clearFiltersForNav(targetId){
    if(targetId&&document.getElementById(targetId))return;
    const dirty=!!(q||veg||sortBy)||[...picks].some(p=>p!=='in_stock')||(!isSlotBased&&!picks.has('in_stock'))||activeTagKeys.size;
    if(!dirty)return;
    q='';veg='';sortBy='';picks=new Set(isSlotBased?[]:['in_stock']);activeTagKeys.clear();
    const mi=ge('menuSearchInput');if(mi)mi.value='';
    const si=ge('searchInput');if(si)si.value='';
    syncFilterUI();
    render();
}
let _scrollLock=false,_scrollTimer;
function scrollToCat(id,behavior='smooth'){if(!id)return;const t=document.getElementById(id);if(!t)return;const hh=document.querySelector('.site-header')?.offsetHeight||0;const tb=document.querySelector('.menu-toolbar')?.offsetHeight||0;const y=t.getBoundingClientRect().top+window.pageYOffset-(hh+tb+12);_scrollLock=true;clearTimeout(_scrollTimer);_scrollTimer=setTimeout(()=>{_scrollLock=false;},800);window.scrollTo({top:Math.max(0,y),behavior})}

// Deep-link helpers (?section_slug / ?item_slug), shared by the restaurant feed
// path and the grocery path. master_menu_*.slug (URL source) and the CDN feed
// are nominally kept in sync, but feed section slugs can arrive null and item
// slugs drift on bracket/case/whitespace — normalize before matching, falling
// back to a slugified name ('tea-cakes' === slugify('Tea Cakes')).
const normSlug=s=>String(s||'').toLowerCase().replace(/[\[\]()]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
function findCatBySlug(slug){const t=normSlug(slug);return cats.find(x=>x.slug===slug)||cats.find(x=>normSlug(x.slug)===t)||cats.find(x=>normSlug(x.name)===t);}
// The scroll observer is locked during programmatic scroll, so set the active
// rail + sheet state explicitly — mirrors the sidebar click handler.
function setCatActive(cid){
    const nav=ge('sectionList');
    if(nav){nav.querySelectorAll('.menu-cat').forEach(x=>x.classList.remove('active'));nav.querySelector(`.menu-cat[data-cid="${cid}"]`)?.classList.add('active');}
    const ms=ge('menuSheetList');
    if(ms){ms.querySelectorAll('.ms-row').forEach(r=>r.classList.remove('is-active'));ms.querySelector(`.ms-row__link[href="#cat-${cid}"]`)?.closest('.ms-row')?.classList.add('is-active');}
}

// Measure the brand header height once (and on resize) so sticky elements can
// dock flush against its bottom edge. Stored on <html> as --site-header-h so
// CSS can pick it up.
function syncHeaderHeight(){
    const h=document.querySelector('.site-header');
    if(!h)return;
    const px=Math.round(h.getBoundingClientRect().height);
    if(px>0)document.documentElement.style.setProperty('--site-header-h', px+'px');
}

function observeScroll(){
    const nav=ge('sectionList');if(!nav)return;
    const container=ge('dynamicMenuContent');if(!container)return;
    let ticking=false;
    function update(){
        if(_scrollLock){ticking=false;return;}
        // Re-query live DOM each frame — render() replaces innerHTML on
        // add-to-cart / filter changes / fetchMostOrderedItems.
        const sections=[...container.querySelectorAll('[data-cid]')];
        if(!sections.length){ticking=false;return;}
        const hh=document.querySelector('.site-header')?.offsetHeight||0;
        const tb=document.querySelector('.menu-toolbar')?.offsetHeight||0;
        // scrollToCat lands sections at hh+tb+12 from the top. Using the same
        // value as threshold means any trackpad momentum (even 3-4px) overshoots
        // the destination and re-activates the previous category. +64 gives a
        // 52px buffer: the user must scroll 52px backward before a category
        // de-activates, matching how CI3 handles programmatic vs manual scroll.
        const threshold=hh+tb+64;
        // Walk in DOM order; keep the LAST section whose top ≤ threshold
        // that has a matching sidebar link. Sections like your-favourites /
        // your-favourites-api have no sidebar entry — skipping them keeps
        // the previous highlight instead of going blank mid-scroll.
        let link=null;
        for(const s of sections){
            if(s.getBoundingClientRect().top>threshold)break;
            const l=nav.querySelector('.menu-cat[data-cid="'+s.dataset.cid+'"]');
            if(l)link=l;
        }
        // Nothing above threshold yet — activate first section that has a link.
        if(!link){
            for(const s of sections){
                const l=nav.querySelector('.menu-cat[data-cid="'+s.dataset.cid+'"]');
                if(l){link=l;break;}
            }
        }
        if(!link){ticking=false;return;}
        nav.querySelectorAll('.menu-cat').forEach(l=>l.classList.toggle('active',l===link));
        // Auto-expand sub-list for the active category; collapse any other open one.
        const wrap=link.nextElementSibling;
        if(wrap?.classList.contains('menu-sub-wrap')){
            if(!wrap.classList.contains('open')){
                collapseSubsExcept(nav,wrap,'.menu-sub-wrap','.menu-cat-expand');
                wrap.classList.add('open');
                const exp=link.querySelector('.menu-cat-expand');
                if(exp)exp.textContent='−';
            }
            // Highlight the active sub-section within this category (CI3 parity).
            // Sub-sections: <section id="sub-{catId}-{j}"> in content,
            // <a class="menu-sub" href="#sub-{catId}-{j}"> in sidebar.
            // Sub-sections are smaller than parent sections so they need a more
            // generous threshold — use 40% of the viewport height so a sub-section
            // header that's clearly in view registers immediately.
            const subThreshold=Math.round(window.innerHeight*0.4);
            const cid=link.dataset.cid;
            const subSections=[...container.querySelectorAll('section[id^="sub-'+cid+'-"]')];
            let activeSub=null;
            for(const ss of subSections){
                if(ss.getBoundingClientRect().top>subThreshold)break;
                activeSub=ss;
            }
            nav.querySelectorAll('.menu-sub').forEach(l=>l.classList.remove('active'));
            if(activeSub){
                nav.querySelector('.menu-sub[href="#'+activeSub.id+'"]')?.classList.add('active');
            }
        } else {
            collapseSubsExcept(nav,null,'.menu-sub-wrap','.menu-cat-expand');
            nav.querySelectorAll('.menu-sub').forEach(l=>l.classList.remove('active'));
        }
        ticking=false;
    }
    window.addEventListener('scroll',()=>{if(!ticking){ticking=true;requestAnimationFrame(update);}},{passive:true});
    requestAnimationFrame(update);
}

// ── Render — bestsellers carousel + category sections with .menu-grid .item cards
function render(){
    saveFilterState();
    // Grocery: large catalogs render category-wise + lazily. The restaurant
    // render body below is never entered for grocery (zero regression risk).
    if(isGrocery){renderGrocery();return;}
    const c=ge('dynamicMenuContent');if(!c)return;let out='';
    // in_stock is a default filter — it filters items but doesn't count toward
    // the filters-active flag (so bestsellers/sidebar visibility stay normal).
    const userPicks=new Set([...picks].filter(p=>p!=='in_stock'));
    const filtersActive=!!(q||veg||userPicks.size||sortBy||activeTagKeys.size||(uspOn&&uspTagKey));
    // Only price-sort flattens all sections into a single list; every other
    // filter (veg, bestseller, rating, in_stock, etc.) preserves sections.
    const isPriceSort=sortBy==='price-asc'||sortBy==='price-desc';
    const visibleCats=new Set();
    // cid / "sub-{cid}-{j}" → the count actually rendered under the current
    // filters, so syncSidebarVisibility can show the same numbers in the nav.
    const navCounts=new Map();
    // Filters button badge excludes the default "In stock" pick (userPicks,
    // same exclusion filtersActive above already uses) — so it reads empty/
    // hidden by default and only climbs once the user actually applies
    // something, instead of permanently showing "(1)" from first load.
    const _n=userPicks.size+(veg?1:0)+(sortBy?1:0)+activeTagKeys.size;const _fc=ge('menuFilterCount');if(_fc){_fc.textContent=_n?` (${_n})`:'';_fc.hidden=!_n;}ge('filterBtn')?.classList.toggle('active',_n>0);

    out+=buildTopRailsHTML(filtersActive);

    // Data-empty: feed returned no menu sections at all (vs filter-empty handled below).
    if(!cats.length||!allItems.length){
        c.innerHTML=emptyStateHTML('no-data');
        syncSidebarVisibility(visibleCats,filtersActive);
        return;
    }

    if(isPriceSort){
        // Flat view: only when sorting by price — flatten all sections into one list
        const flatItems=filt(allItems);
        if(flatItems.length){
            out+=`<div class="menu-cat-head"><h3>Results</h3><span class="sep"></span><span class="subtitle">${flatItems.length} item${flatItems.length===1?'':'s'}</span></div>`;
            out+=`<div class="menu-grid">${flatItems.map(card).join('')}</div>`;
        } else {
            out=emptyStateHTML('no-match');
        }
    } else {
        // Section view — apply filters within each subcategory
        for(const cat of cats){
            // `_j` is the subcat's position in the UNFILTERED cat.subcats — the
            // sidebar's #sub- links are built from that same index, so they keep
            // resolving once filters drop some subcats out of `fs`.
            const fs=cat.subcats.map((sc,j)=>({...sc,_j:j,items:filt(sc.items)})).filter(sc=>sc.items.length);
            if(!fs.length)continue;
            visibleCats.add(String(cat.id));
            navCounts.set(String(cat.id),fs.reduce((n,sc)=>n+sc.items.length,0));
            out+=`<section id="cat-${cat.id}" data-cid="${cat.id}">`;
            if(cat.subcats.length===1){
                out+=`<div class="menu-cat-head"><h3>${catSubHTML(cat.name)}</h3><span class="sep"></span><span class="subtitle">${fs[0].items.length} item${fs[0].items.length===1?'':'s'}</span></div>`;
                out+=`<div class="menu-grid">${fs[0].items.map(card).join('')}</div>`;
            } else {
                fs.forEach(sc=>{
                    navCounts.set(`sub-${cat.id}-${sc._j}`,sc.items.length);
                    out+=`<section id="sub-${cat.id}-${sc._j}">`;
                    const headHTML=sc.name?`${esc(cat.name)}<span class="menu-cat-head__sub"> - ${esc(sc.name)}</span>`:catSubHTML(cat.name);
                    out+=`<div class="menu-cat-head"><h3>${headHTML}</h3><span class="sep"></span><span class="subtitle">${sc.items.length} item${sc.items.length===1?'':'s'}</span></div>`;
                    out+=`<div class="menu-grid">${sc.items.map(card).join('')}</div>`;
                    out+=`</section>`;
                });
            }
            out+=`</section>`;
        }
        if(!out)out=emptyStateHTML('no-match');
    }
    c.innerHTML=out;
    syncSidebarVisibility(visibleCats,filtersActive,navCounts);
}

// Top rails (Bestsellers / server Favourites / Saved Items) shared by the
// restaurant render() and renderGrocery(). Hidden whenever a filter is active,
// matching the original inline behaviour. Returns concatenated HTML.
function buildTopRailsHTML(filtersActive){
    let out='';
    // "In stock" doesn't count toward filtersActive (it's on by default), so the
    // rails still render while it's applied — they each have to honour it
    // themselves or an out-of-stock item leaks into a rail while the main list
    // hides it.
    const inStock=i=>!picks.has('in_stock')||!i.oos;
    // Bestsellers (horizontal scroll of .feat cards) + scroll arrows
    if(popularItems.length&&!filtersActive){
        const popMapped=popularItems.map(p=>{
            const id=String(p.id||'');
            const fromAll=id?allItems.find(x=>String(x.id)===id):null;
            return fromAll||mk(p);
        }).filter(i=>i.name).filter(inStock);
        if(popMapped.length){
            out+=`<div id="popular-picks" data-cid="popular-picks">
                <div class="menu-cat-head"><h3>Featured Items</h3><span class="sep"></span><span class="subtitle">${popMapped.length} item${popMapped.length===1?'':'s'}</span></div>
                ${sectionRailHTML(popMapped.map(popularCard).join(''))}
            </div>`;
        }
    }
    // Your Favourites (server-driven) — user's most-ordered items. Capped at 5.
    // Filter before the cap so hiding an out-of-stock favourite promotes the next
    // one into the rail rather than shrinking it.
    if(!filtersActive&&mostOrderedItems.length){
        const favVisible=mostOrderedItems.filter(inStock).slice(0,5);
        const favCount=favVisible.length;
        if(favCount){
            out+=`<div id="your-favourites-api" data-cid="your-favourites-api">
                <div class="menu-cat-head"><h3>Your Favourites</h3><span class="sep"></span><span class="subtitle">${favCount} item${favCount===1?'':'s'}</span></div>
                ${sectionRailHTML(favVisible.map(favRowLg).join(''),'section-rail--favlg')}
            </div>`;
        }
    }
    // Saved Items — heart-toggled, localStorage-backed.
    if(!filtersActive&&favs.size>0){
        const favMapped=[...favs].map(id=>allItems.find(x=>String(x.id)===String(id))).filter(Boolean).filter(inStock);
        if(favMapped.length){
            out+=`<div id="your-favourites" data-cid="your-favourites">
                <div class="menu-section-head">
                    <h2>Saved Items</h2>
                    <span class="count">· ${favMapped.length} item${favMapped.length===1?'':'s'}</span>
                </div>
                ${sectionRailHTML(favMapped.map(favRow).join(''),'section-rail--fav')}
            </div>`;
        }
    }
    return out;
}

// ── Grocery — per-category data loading (categoryId 15 only) ─────────────────
// Grocery catalogs are huge, so we DON'T use the all-in-one static feed. Instead
// we mirror CI3's flow with sanctioned api.uengage.in endpoints:
//   • client/getMenuSections/{businessId}             → section list (sidebar + shells)
//   • client/getSectionVariantsFeed?businessId&sectionId → ONE section, feed-shaped
//     (rows.menu + rows.templates) so buildCats/templateList work unchanged
// The first category loads immediately; the rest load when scrolled to / clicked
// (a real network request per category), and a throttled background pass fills
// the remainder so search/filter cover the whole catalog. Reuses card()/filt()/
// mk()/buildSidebar, so grocery looks identical to the restaurant menu.
let _grocObs=null;            // observer that fetches sections as they near view

function grocFiltered(cat){return filt(cat.subcats.flatMap(sc=>sc.items));}
function grocBaseCount(cat){return cat.subcats.reduce((n,sc)=>n+sc.items.length,0);}

// Grocery entry point — replaces the feed-based load() for categoryId 15.
async function loadGrocery(){
    spin(true);
    try{
        const r=await fetch(`${getApiBase()}/client/getMenuSections/${encodeURIComponent(bId)}`);
        if(!r.ok)throw r.status;
        const d=await r.json();
        const secs=((d&&d.rows)||[]).filter(s=>s.status==null||+s.status===1);
        secs.sort((a,b)=>(+a.sequence||0)-(+b.sequence||0));
        cats=secs.map(s=>({id:String(s.id),slug:s.sectionsSlug||'',name:s.sectionName||'',image:s.image||'',subcats:[{name:'',items:[]}],loaded:false,loading:false}));
        allItems=[];templateList=[];   // grocery template pool is merged in per-section (getSectionVariantsFeed)
        menuHasEgg=false;              // re-derived per section as they stream in (see fetchGrocSection)
        updateDietFilterUI();
        if(!cats.length){showClosed();return;}
        setSearchPlaceholder();
        spin(false);showMenu(true);
        buildSidebar();renderGrocery();updateBar();observeScroll();
        // Item-based brands get the balance from the earn catalog instead — one
        // endpoint, one number. Only milestone brands need this second call.
        if(localStorage.getItem('userdata')&&!burnCatalogEnabled())fetchWalletCoins();
        fetchServerCart();fetchMostOrderedItems();loadMemberPricing();loadEarnCatalog();
        _grocQueue=[];_grocBusy=false;_grocDrained=false;
        queueGrocSection(cats[0].id,true);   // first category only; the rest load
                                             // on scroll/click (observer) or when a
                                             // search/filter triggers grocEnsureAllLoaded()
        applyGrocDeepLink();                 // ?section_slug=… from store-locator / product listing
    }catch(e){console.error('[grocery]',e);showClosed();}
}

// Deep-link from store-locator / product listing (?section_slug=… [&item_slug=…]).
// Grocery loads sections lazily and unloaded shells are a fixed 360px tall, so a
// deep scroll over not-yet-loaded sections lands short. Prioritise the target AND
// every section above it (so their real heights resolve), then re-aim + re-highlight
// across the async load window — mirrors the restaurant deep-link settle pattern.
// When item_slug is also present we open its popup once that section's items load
// (the restaurant feed path does this in load(); grocery can't until the section
// fetch returns). If only item_slug arrives (no section_slug), we don't know which
// category holds it — grocery has no all-in-one feed to search — so we backfill
// every section and open the item the moment it surfaces. See locateGrocItem().
function applyGrocDeepLink(){
    const params=new URLSearchParams(location.search);
    const secSlug=params.get('section_slug');
    const itemSlug=params.get('item_slug');
    if(!secSlug&&!itemSlug)return;

    const c=secSlug?findCatBySlug(secSlug):null;
    if(secSlug&&!c)console.warn('[grocery] section_slug not matched:',secSlug);

    // Open the item popup once its category has loaded its items (deduped — fires once).
    // Same USP-filter reasoning as the restaurant deep-link (load()) — an item the
    // active filter excludes gets the blocked-modal instead of its own item modal;
    // filter stays on unless the user explicitly turns it off there.
    let _opened=false;
    const tryOpenItem=()=>{
        if(_opened||!itemSlug)return false;
        const it=locateGrocItem(itemSlug);
        if(!it)return false;
        _opened=true;
        if(uspActive()&&!itemHasUsp(it))showUspBlockedModal(`${it.name} isn't included in this filter.`,'Turn off filter & view item',()=>openPopup(it));
        else openPopup(it);
        return _opened;
    };

    if(c){
        const idx=cats.findIndex(x=>x===c);
        const above=cats.slice(0,idx+1);                       // target + everything above it
        for(const cat of above)queueGrocSection(cat.id,true);  // jump ahead of the background backfill
        const aim=behavior=>{scrollToCat('cat-'+c.id,behavior);setCatActive(c.id);};
        requestAnimationFrame(()=>requestAnimationFrame(()=>aim('smooth')));
        // Re-aim every 300ms while the sections above are still streaming in (their
        // heights shift the target), plus two settle ticks once they've all loaded.
        // Hard-capped so it can never spin or fight a manual scroll for long.
        // USP-empty check only runs once settled — items aren't loaded yet before
        // that, so emptiness can't be known upfront the way the restaurant flow
        // (whole feed already in memory) can. The scroll itself already happened
        // progressively during the wait; this only adds the explanatory modal.
        let ticks=0,settled=0,_uspEmptyShown=false;
        const poll=setInterval(()=>{
            aim('auto');tryOpenItem();
            if(above.every(x=>x.loaded)){
                settled++;
                if(!_uspEmptyShown&&uspActive()&&!filt(c.subcats.flatMap(sc=>sc.items)).length){
                    _uspEmptyShown=true;
                    showUspBlockedModal(`${c.name} has no items matching this filter.`,'Turn off filter & view section',()=>{scrollToCat('cat-'+c.id,'smooth');setCatActive(c.id);});
                }
            }
            if((settled>=2&&(_opened||!itemSlug))||++ticks>=18)clearInterval(poll);
        },300);
        return;
    }

    // No usable section_slug but we have an item_slug: scan loaded sections, backfill
    // the rest in the background, and jump to + open the item once it appears.
    if(itemSlug){
        grocEnsureAllLoaded();
        let ticks=0;
        const poll=setInterval(()=>{
            const it=locateGrocItem(itemSlug);
            if(it){
                const cat=cats.find(cc=>cc.subcats.some(sc=>sc.items.includes(it)));
                if(cat){scrollToCat('cat-'+cat.id,'auto');setCatActive(cat.id);}
                if(uspActive()&&!itemHasUsp(it))showUspBlockedModal(`${it.name} isn't included in this filter.`,'Turn off filter & view item',()=>openPopup(it));
                else openPopup(it);
                clearInterval(poll);
            }else if(cats.every(cc=>cc.loaded)||++ticks>=40){
                if(!it)console.warn('[grocery] item_slug not matched in any section:',itemSlug);
                clearInterval(poll);
            }
        },300);
    }
}
// Find a loaded grocery item by slug (exact, then normalized — same matching the
// restaurant item_slug deep-link uses). Returns undefined until its section loads.
function locateGrocItem(slug){
    const t=normSlug(slug);
    return allItems.find(x=>x.slug===slug)||allItems.find(x=>normSlug(x.slug)===t);
}

// One-at-a-time fetch queue — guarantees a single in-flight getMenuItems request
// (no parallel bursts). Scroll/click enqueue with priority so the section the user
// wants jumps ahead of the background backfill.
let _grocQueue=[],_grocBusy=false,_grocDrained=false;
function queueGrocSection(cid,priority){
    cid=String(cid);
    const cat=cats.find(c=>String(c.id)===cid);
    if(!cat||cat.loaded||cat.loading)return;
    const at=_grocQueue.indexOf(cid);
    if(at>-1){if(priority){_grocQueue.splice(at,1);_grocQueue.unshift(cid);}}
    else priority?_grocQueue.unshift(cid):_grocQueue.push(cid);
    pumpGrocQueue();
}
function pumpGrocQueue(){
    if(_grocBusy)return;
    const cid=_grocQueue.shift();
    if(cid==null){grocMaybeDrain();return;}
    _grocBusy=true;
    fetchGrocSection(cid).finally(()=>{_grocBusy=false;pumpGrocQueue();});
}
// Once every section has loaded: refresh sidebar counts and, if a filter/search
// is active, re-render so it now covers the whole catalog.
function grocMaybeDrain(){
    if(_grocDrained||!cats.length||!cats.every(c=>c.loaded))return;
    _grocDrained=true;
    buildSidebar();
    const up=new Set([...picks].filter(p=>p!=='in_stock'));
    if(q||veg||up.size||sortBy)renderGrocery();
}

// Fetch one section (deduped) and paint just that section's grid. Uses
// getSectionVariantsFeed, which returns the SAME shape as the static feed
// (rows.menu + rows.templates), so we reuse buildCats and the global templateList
// pool — grocery customisation then behaves identically to the restaurant menu.
async function fetchGrocSection(cid){
    const cat=cats.find(c=>String(c.id)===String(cid));
    if(!cat||cat.loaded||cat.loading)return;
    cat.loading=true;
    try{
        const r=await fetch(`${getApiBase()}/client/getSectionVariantsFeed?businessId=${encodeURIComponent(bId)}&sectionId=${encodeURIComponent(cid)}&app_version=2.0`);
        if(r.ok){
            const d=await r.json();
            const menu=(d&&+d.status===1&&d.rows&&d.rows.menu)||[];
            const built=buildCats(menu);                 // reuse the feed builder (variants + templates)
            cat.subcats=built.length?built[0].subcats:[{name:'',items:[]}];
            for(const t of (d?.rows?.templates||[]))     // merge this section's customisation pool
                if(!templateList.some(x=>String(x.templateId)===String(t.templateId)))templateList.push(t);
            cat.loaded=true;
            allItems=[].concat(...cats.map(c=>c.subcats.flatMap(s=>s.items)));
            // Grocery has no all-in-one feed, so the dietary UI can only learn about egg
            // items as sections arrive. This must run on EVERY section load, not only the
            // empty-section path, or a catalogue whose egg items sit in populated sections
            // never upgrades the Veg chip. updateDietFilterUI latches menuHasEgg on, so the
            // chip settles into its final shape and never flickers back.
            updateDietFilterUI();
            buildTagCatalog();renderTagChips();
            // Re-derive every chip's .active state (including tag chips) now that
            // both allItems and tagCatalog are guaranteed fresh — load()/
            // fetchGrocSection() and fetchFilterList() resolve independently, so
            // either can finish first.
            syncFilterUI();
            renderGrocSectionGrid(cid);
        }
    }catch(e){console.error('[grocery section]',cid,e);}
    finally{cat.loading=false;}
}

// Paint a single section's grid in place (used as each section streams in) — no
// full rebuild, so loaded sections and scroll position stay put.
function renderGrocSectionGrid(cid){
    const cat=cats.find(c=>String(c.id)===String(cid));if(!cat)return;
    const sec=document.getElementById('cat-'+cid);if(!sec)return;
    updateNavCount(cid,grocBaseCount(cat));   // fill the sidebar count now the section is loaded
    if(grocBaseCount(cat)===0){sec.hidden=true;syncNavVis(cid,true);return;}
    const userPicks=new Set([...picks].filter(p=>p!=='in_stock'));
    const filtersActive=!!(q||veg||userPicks.size||sortBy||activeTagKeys.size||(uspOn&&uspTagKey));
    const items=grocFiltered(cat);
    if(filtersActive&&!items.length){sec.hidden=true;return;}
    sec.hidden=false;sec.removeAttribute('data-groc-shell');
    const sub=sec.querySelector('.menu-cat-head .subtitle');if(sub)sub.textContent=`${items.length} item${items.length===1?'':'s'}`;
    const grid=sec.querySelector('.menu-grid');
    if(grid){grid.classList.remove('menu-grid--ph');grid.style.minHeight='';grid.removeAttribute('data-groc-grid');grid.innerHTML=items.map(card).join('');}
}
function syncNavVis(cid,hidden){
    document.querySelectorAll(`#sectionList .menu-cat[href="#cat-${cid}"]`).forEach(a=>{a.style.display=hidden?'none':'';});
}
// Fill in a category's sidebar count once its section loads (getMenuSections has
// no per-section count, so the rail shows blank until the items arrive).
function updateNavCount(cid,n){
    document.querySelectorAll(`#sectionList .menu-cat[href="#cat-${cid}"] .menu-cat-count`).forEach(el=>{el.textContent=n;});
    const ms=document.querySelector(`#menuSheetList .ms-row__link[href="#cat-${cid}"]`)?.closest('.ms-row')?.querySelector('.ms-row__count');
    if(ms)ms.textContent=n;
}

// Re-render loaded section grids in place — cart mutations only (no refetch, no
// full rebuild). Off-screen/unloaded sections are left untouched.
function rerenderLoadedGroc(){
    // Search / voice / price-sort renders ONE flat results list with no #cat- sections
    // (see renderGrocery's q||isPriceSort branch), so repaint that single grid — the
    // per-category loop below finds nothing in that view, leaving ADD+ stuck. Mirror
    // the flat branch exactly: filt(allItems) → card().
    const isPriceSort=sortBy==='price-asc'||sortBy==='price-desc';
    if(q||isPriceSort){
        const grid=ge('dynamicMenuContent')?.querySelector('.menu-grid');
        if(grid)grid.innerHTML=filt(allItems).map(card).join('');
        return;
    }
    for(const cat of cats){
        if(!cat.loaded)continue;
        const sec=document.getElementById('cat-'+cat.id);if(!sec||sec.hidden)continue;
        const grid=sec.querySelector('.menu-grid');if(!grid)continue;
        grid.innerHTML=grocFiltered(cat).map(card).join('');
    }
}

// Cart-mutation re-render dispatcher: restaurants rebuild everything (render());
// grocery only repaints loaded grids. Keeps the restaurant path byte-identical.
function cartRerender(){if(isGrocery)rerenderLoadedGroc();else render();refreshMenuRedeemUI();}

// Search/filter needs the whole catalog — enqueue every still-unloaded section
// (serialised by the queue). Browsing stays lazy; this only fires when the user
// actually searches or filters, so on-scroll requests remain visible per category.
function grocEnsureAllLoaded(){for(const c of cats)queueGrocSection(c.id);}

function renderGrocery(){
    saveFilterState();
    const c=ge('dynamicMenuContent');if(!c)return;
    const userPicks=new Set([...picks].filter(p=>p!=='in_stock'));
    const filtersActive=!!(q||veg||userPicks.size||sortBy||activeTagKeys.size||(uspOn&&uspTagKey));
    const isPriceSort=sortBy==='price-asc'||sortBy==='price-desc';
    // Excludes the default "In stock" pick (userPicks) — see render()'s
    // comment on the same calculation for why.
    const _n=userPicks.size+(veg?1:0)+(sortBy?1:0)+activeTagKeys.size;const _fc=ge('menuFilterCount');if(_fc){_fc.textContent=_n?` (${_n})`:'';_fc.hidden=!_n;}ge('filterBtn')?.classList.toggle('active',_n>0);

    if(_grocObs){_grocObs.disconnect();_grocObs=null;}
    if(!cats.length){c.innerHTML=emptyStateHTML('no-data');syncSidebarVisibility(new Set(),filtersActive);return;}
    if(filtersActive)grocEnsureAllLoaded();   // search/filter spans all categories → backfill on demand

    // Active search or price-sort → one flat results list over what's loaded so
    // far (the background pass keeps filling allItems for completeness).
    if(q||isPriceSort){
        const flat=filt(allItems);
        c.innerHTML=flat.length
            ?`<div class="menu-cat-head"><h3>Results</h3><span class="sep"></span><span class="subtitle">${flat.length} item${flat.length===1?'':'s'}</span></div><div class="menu-grid">${flat.map(card).join('')}</div>`
            :emptyStateHTML(allItems.length?'no-match':'no-data');
        syncSidebarVisibility(new Set(),true);
        return;
    }

    // One <section> per category. Loaded → real cards; not-yet-loaded → a shell
    // (spinner) that the observer/click fetches on demand.
    const visibleCats=new Set();
    // Loaded categories only — an unloaded shell has no real count yet, so it
    // keeps its chevron placeholder in the nav (see syncSidebarVisibility).
    const navCounts=new Map();
    let out=buildTopRailsHTML(filtersActive);
    for(const cat of cats){
        const loaded=cat.loaded;
        const items=loaded?grocFiltered(cat):[];
        if(loaded&&grocBaseCount(cat)===0)continue;          // truly empty section
        if(loaded&&filtersActive&&!items.length)continue;    // filtered out
        visibleCats.add(String(cat.id));
        if(loaded)navCounts.set(String(cat.id),items.length);
        const body=loaded
            ?`<div class="menu-grid">${items.map(card).join('')}</div>`
            :`<div class="menu-grid menu-grid--ph" data-groc-grid="${cat.id}" style="min-height:360px"><div class="spinner" aria-hidden="true"></div></div>`;
        out+=`<section id="cat-${cat.id}" data-cid="${cat.id}"${loaded?'':' data-groc-shell="1"'}>
            <div class="menu-cat-head"><h3>${catSubHTML(cat.name)}</h3><span class="sep"></span><span class="subtitle">${loaded?items.length+' item'+(items.length===1?'':'s'):'Loading…'}</span></div>
            ${body}
        </section>`;
    }
    c.innerHTML=out||emptyStateHTML(allItems.length?'no-match':'no-data');
    syncSidebarVisibility(visibleCats,filtersActive,navCounts);

    // Fetch a section's items just before its shell enters the viewport.
    _grocObs=new IntersectionObserver(entries=>{
        for(const e of entries){
            if(!e.isIntersecting)continue;
            _grocObs.unobserve(e.target);
            queueGrocSection(e.target.dataset.cid,true);
        }
    },{rootMargin:'300px 0px'});
    c.querySelectorAll('section[data-groc-shell]').forEach(s=>_grocObs.observe(s));
}

// Empty-state markup. `kind` ∈ {'no-data', 'no-match'}:
//   no-data : feed has zero menu sections (brand still onboarding / regenerating feed)
//   no-match: items exist but active filters hide everything
function emptyStateHTML(kind){
    if(kind==='no-match'){
        return `<div class="menu-empty menu-empty--card">
    <svg class="menu-empty__icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        <line x1="8" y1="11" x2="14" y2="11"></line>
    </svg>
    <h3 class="menu-empty__title">No items match your filters</h3>
    <p class="menu-empty__sub">Try removing a filter to see more results.</p>
    <button type="button" class="btn btn--secondary" data-empty-action="clear-filters">Clear filters</button>
</div>`;
    }
    const slotHint=isSlotBased?'Items will appear here once the kitchen publishes its menu.':'Please check back in a few minutes.';
    return `<div class="menu-empty menu-empty--card">
    <svg class="menu-empty__icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 9h18M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 9v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9"></path>
        <line x1="9" y1="14" x2="15" y2="14"></line>
    </svg>
    <h3 class="menu-empty__title">Menu is being updated</h3>
    <p class="menu-empty__sub">${slotHint}</p>
    <button type="button" class="btn btn--primary" data-empty-action="reload">Refresh</button>
</div>`;
}

// Empty-state markup for the search modal's #searchResults pane — same
// `.menu-empty--card` component as the main grid's no-match state (see
// emptyStateHTML above), so mobile search matches the desktop look. Title/sub
// reflect whether the miss came from a typed query, active filters, or both.
function searchEmptyStateHTML(){
    const title=q?`No results for "${esc(q)}"`:'No items match your filters';
    const sub=q&&(veg||picks.size||sortBy)
        ?'Try a different search term or remove a filter.'
        :q?'Try a different search term.':'Try removing a filter to see more results.';
    return `<div class="menu-empty menu-empty--card">
    <svg class="menu-empty__icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        <line x1="8" y1="11" x2="14" y2="11"></line>
    </svg>
    <h3 class="menu-empty__title">${title}</h3>
    <p class="menu-empty__sub">${sub}</p>
    <button type="button" class="btn btn--secondary" data-empty-action="clear-search">Clear filters</button>
</div>`;
}

// The nav lists exactly what's rendered: a category (and each of its sub-links)
// is shown only when the current filters left it with at least one item. That's
// what lets a category click KEEP the filters applied — there's no such thing as
// clicking a category with nothing in it, so clearFiltersForNav never has to fire.
// `counts` (cid / sub-id → filtered item count) rewrites the nav counts to match.
//
// The one exception is a flat render — price sort, or grocery's flat search —
// where the content has no <section id="cat-…"> at all, so `visibleCats` is empty
// and hiding everything would leave the user with no nav to escape through. There
// we keep every category visible; clicking one finds no target and clearFiltersForNav
// drops back to the unfiltered menu, which is the escape hatch.
function syncSidebarVisibility(visibleCats,filtersActive,counts){
    const keepAllVisible=filtersActive&&visibleCats.size===0;
    const setCount=(el,key)=>{
        if(!el)return;
        // Only rewrite when we have a real number for this key — grocery's
        // not-yet-loaded categories show a chevron placeholder, not a count.
        const v=counts?.get(key);
        if(v==null){if(el.dataset.baseCount!=null)el.textContent=el.dataset.baseCount;return;}
        if(el.dataset.baseCount==null)el.dataset.baseCount=el.textContent;
        el.textContent=String(v);
    };
    const main=ge('sectionList');
    if(main){
        main.querySelectorAll('.menu-cat[href^="#cat-"]').forEach(a=>{
            const cid=a.getAttribute('href').slice(5);
            a.style.display=(keepAllVisible||visibleCats.has(cid))?'':'none';
            setCount(a.querySelector('.menu-cat-count'),cid);
        });
        // Sub-links point at <section id="sub-{cid}-{j}">, which render() emits only
        // for subcats that survived the filter — hide the ones with no target left.
        main.querySelectorAll('.menu-sub[href^="#sub-"]').forEach(a=>{
            const sid=a.getAttribute('href').slice(1);
            a.style.display=(keepAllVisible||counts?.has(sid))?'':'none';
            setCount(a.querySelector('.menu-cat-count'),sid);
        });
    }
    if(main){const pop=main.querySelector('.menu-cat[href="#popular-picks"]');if(pop)pop.style.display=filtersActive?'none':'';}
    ['menuSheetList'].forEach(id=>{
        const n=ge(id);if(!n)return;
        // Each category is a .ms-row wrapper (link + "+") followed by its .ms-sub-wrap.
        // Hide/show the wrapper and its sub-list together.
        n.querySelectorAll('.ms-row__link[href^="#cat-"]').forEach(a=>{
            const cid=a.getAttribute('href').slice(5);
            const show=(keepAllVisible||visibleCats.has(cid))?'':'none';
            const row=a.closest('.ms-row');if(row){row.style.display=show;setCount(row.querySelector('.ms-row__count'),cid);}
            const wrap=row?.nextElementSibling;
            if(wrap&&wrap.classList.contains('ms-sub-wrap'))wrap.style.display=show;
        });
        n.querySelectorAll('.ms-sub[href^="#sub-"]').forEach(a=>{
            const sid=a.getAttribute('href').slice(1);
            a.style.display=(keepAllVisible||counts?.has(sid))?'':'none';
            setCount(a.querySelector('.ms-row__count'),sid);
        });
        const pop=n.querySelector('.ms-row[href="#popular-picks"], a[href="#popular-picks"]');if(pop)pop.style.display=filtersActive?'none':'';
    });
}

// Does an item's diet value satisfy the active `veg` filter? An item with NO diet
// value matches nothing while any dietary filter is on (R9 — CI3 compares for
// equality too; it used to default to 'veg' and pollute the Veg results).
//
// Egg is never a filter of its own any more: it is clubbed into Veg & Egg on the
// vegetarian side, and Non-Veg carries it on the other (R8 — confirmed product
// behaviour, and what the app does). So every egg dish is reachable from exactly
// two filters, and from neither Pure Veg nor nothing at all.
function dietMatches(v){
    if(!v)return false;
    return veg==='veg'     ? v==='veg'
         : veg==='veg-egg' ? (v==='veg'||v==='egg')
         : veg==='non-veg' ? (v==='non-veg'||v==='egg')
         : true;
}
function filt(items){
    let l=items;
    if(veg)l=l.filter(i=>dietMatches(i.veg));
    if(picks.has('offer'))l=l.filter(i=>i.disc>0);
    if(picks.has('in_stock'))l=l.filter(i=>!i.oos);if(picks.has('rated'))l=l.filter(i=>i.rat>=4);
    // Redeemable = the signed-in customer's balance already covers this item
    // (catalog `affordable`). Only reachable from the band's "View items" CTA.
    if(picks.has('redeemable'))l=l.filter(i=>earnRowFor(i)?.affordable===true);
    // Eligible = the loyalty catalog prices this item at all (earn, redeem or both).
    // Wider than 'redeemable' on purpose: that one is gated on the balance already
    // covering the item, so a guest or a new customer sees nothing through it.
    // Tested against what the card actually SHOWS, not merely against having a
    // catalog row: an item blacklisted at a 0% rate still has a row, and filtering
    // on the row alone let through items whose strip renders nothing at all.
    if(picks.has('eligible'))l=l.filter(itemIsEligible);
    // Bestseller/New are no longer separate hardcoded picks — they're plain
    // entries in tagCatalog (matched by real tag membership via the feed's
    // item.tags, not the old best/isNew boolean flags), so they filter
    // through this one generic path along with every other tag. Clean/USP is
    // NOT one of these — it keeps its own dedicated on/off state (uspOn).
    if(activeTagKeys.size)l=l.filter(i=>matchesActiveTags(i));
    if(uspOn&&uspTagKey)l=l.filter(i=>itemHasUsp(i));
    if(q){if(window.Fuse){l=new Fuse(l,{keys:['name','desc'],threshold:.35}).search(q).map(r=>r.item)}else{const lq=q.toLowerCase();l=l.filter(i=>i.name.toLowerCase().includes(lq))}}
    if(sortBy==='price-asc')l=[...l].sort((a,b)=>a.sp-b.sp);if(sortBy==='price-desc')l=[...l].sort((a,b)=>b.sp-a.sp);if(sortBy==='rating')l=[...l].sort((a,b)=>b.rat-a.rat);
    return l}

// ── Dynamic tag filters ──────────────────────────────────────────────────
// Two sources feed one catalog: (1) apiFilterDefs — real backend-configured
// filters from client/getFilterList (see fetchFilterList() below for the
// call + its auth caveat), each a {name,field,fieldType,value} definition
// matched generically against the item; (2) client-derived tags — Menu Hub
// v2 tags.primary/secondary plus a manually-injected 'highly_ordered' entry,
// used to fill in (or fully cover, if the API call is empty/unauthorized)
// whatever the API list doesn't. Multiple active chips use AND logic — an
// item must satisfy every selected filter, not just one.
const FEED_FIELD_ALIAS={newItem:'isNew',highlyOrderedItem:'highlyOrdered',recommended:'best',vegNonvegBoth:'veg',out_of_stock:'oos',avgRating:'rat'};
// Fetched directly from the browser (not proxied server-side) so it's visible
// and debuggable in the Network tab, matching the app's own call site. Token
// is sha256(businessId + FILTER_LIST_SALT) — confirmed working via a manual
// Postman request (FILTER_LIST_SALT is declared near the top of this file,
// not here — see the comment there for why); an earlier salt-less attempt
// (matching a literal reading of a pasted app-code snippet) was rejected by
// the live endpoint, so trust the Postman-confirmed formula, not the snippet.
// businessId isn't a secret (it's already in the page URL) — but the salt
// itself now IS a real, confirmed value shipped in public JS, which is worth
// revisiting (e.g. moving the signing server-side, .env-held, like
// BrandUspService) if this endpoint ever needs to resist forged requests.
// Any failure — network error, non-1 status, unexpected shape, a 401 — leaves
// apiFilterDefs empty; buildTagCatalog() below already falls back to
// deriving tag chips from the item feed, so a wrong/rejected token degrades
// silently instead of breaking the page.
// Pure-JS SHA-256 (FIPS 180-4) — deliberately NOT crypto.subtle.digest().
// SubtleCrypto only exists in a "secure context" (HTTPS, or literally
// localhost/127.0.0.1); this project's local dev setup serves brand domains
// over plain http:// via /etc/hosts entries, which browsers do NOT treat as
// secure — crypto.subtle is undefined there even though it'd work fine on
// the real HTTPS production domains. A pure-JS implementation works
// identically in both environments, so testing isn't HTTPS-only.
function sha256Hex(str){
    const K=[
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const bytes=new TextEncoder().encode(str);
    const bitLen=bytes.length*8;
    const padLen=(((bytes.length+8)>>6)+1)<<6;
    const data=new Uint8Array(padLen);
    data.set(bytes);
    data[bytes.length]=0x80;
    const dv=new DataView(data.buffer);
    dv.setUint32(padLen-4,bitLen>>>0,false);
    dv.setUint32(padLen-8,Math.floor(bitLen/0x100000000),false);
    const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let off=0;off<padLen;off+=64){
        const w=new Uint32Array(64);
        for(let i=0;i<16;i++)w[i]=dv.getUint32(off+i*4,false);
        for(let i=16;i<64;i++){
            const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
            const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
            w[i]=(w[i-16]+s0+w[i-7]+s1)|0;
        }
        let [a,b,c,d,e,f,g,h]=H;
        for(let i=0;i<64;i++){
            const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);
            const ch=(e&f)^((~e)&g);
            const t1=(h+S1+ch+K[i]+w[i])|0;
            const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);
            const maj=(a&b)^(a&c)^(b&c);
            const t2=(S0+maj)|0;
            h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
        }
        H=[H[0]+a,H[1]+b,H[2]+c,H[3]+d,H[4]+e,H[5]+f,H[6]+g,H[7]+h].map(x=>x|0);
    }
    return H.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
}
async function fetchFilterList(){
    if(!bId)return;
    try{
        const token=sha256Hex(String(bId)+FILTER_LIST_SALT);
        // Backend renamed the endpoint from getFilterListtest to getFilterList —
        // same auth/params, path only.
        const url=`${getApiBase()}/client/getFilterList?businessId=${encodeURIComponent(bId)}&parentId=${encodeURIComponent(pId)}&timestamp=${encodeURIComponent(new Date().toISOString())}&version=2.1`;
        const r=await fetch(url,{headers:{Token:token,Accept:'application/json'}});
        // Log the server's own explanation (status code + JSON body — the
        // "UnAuthorized Access" shape includes a submsg naming WHICH check
        // failed, e.g. bad token vs. stale timestamp) instead of just giving
        // up silently. This is the one thing worth surfacing loudly: everyone
        // debugging this call needs the real rejection reason, not a guess.
        if(!r.ok){
            console.warn(`[menu] getFilterList rejected (HTTP ${r.status}), using feed-derived tags:`,await r.text().catch(()=>'<no body>'));
            return;
        }
        const d=await r.json();
        if(!d||+d.status!==1||!Array.isArray(d.list)){
            console.warn('[menu] getFilterList returned non-1 status, using feed-derived tags:',d);
            return;
        }
        // Real entry shape is {tagKey,title,icon,color,displayMode,is_usp} — NOT the
        // {field,fieldType,value} shape an earlier (wrong) assumption used. The
        // dietary section is identified by its entries' tagKeys (veg/non-veg/egg),
        // not a 'field' property — real entries have no such property at all.
        const DIETARY_KEYS=new Set(['veg','pure-veg','veg-egg','non-veg','egg']);
        const section=d.list.find(sec=>!(sec.list||[]).some(e=>DIETARY_KEYS.has(String(e?.tagKey||'').toLowerCase())));
        const entries=section?(section.list||[]).filter(e=>e&&e.tagKey):[];
        apiFilterDefs=entries.map(e=>({
            tagKey:String(e.tagKey),name:e.title||e.tagKey,color:e.color||'',icon:e.icon||'',displayMode:e.displayMode||'name'
        }));
        // Whichever entry (if any) is flagged as the outlet's live "Brand USP" —
        // this menu-page toggle is sourced entirely from here, using THIS page's
        // real outlet id — a separate, independent fetch from the home page's
        // (usp_toggle.js, keyed off window.AppConfig.homeOutletId instead;
        // see initUsp()).
        initUsp(entries.find(e=>+e.is_usp===1)||null);
        buildTagCatalog();renderTagChips();
        // Re-derive every chip's .active state (including tag chips) now that
        // both allItems and tagCatalog are guaranteed fresh — load()/
        // fetchGrocSection() and fetchFilterList() resolve independently, so
        // either can finish first.
        syncFilterUI();
    }catch(e){console.warn('[menu] getFilterList failed, using feed-derived tags',e);}
}
// Sets up menu.js's own USP state from the getFilterList is_usp:1 entry
// (or clears it if there isn't one) and builds the toolbar chip / mobile bar /
// sidebar badge markup. On/off state persists under the SAME localStorage key
// usp_toggle.js uses on the home page ('usp_toggle_{tagKey}'), so a toggle
// flipped on one page is reflected on the other without any shared code.
function initUsp(entry){
    if(!entry||!entry.tagKey){uspTagKey='';return;}
    uspTagKey=String(entry.tagKey);
    // entry is the RAW getFilterList entry ({tagKey,title,icon,color,...} —
    // see fetchFilterList()'s comment above), NOT the later-remapped
    // apiFilterDefs shape (which renames title -> name). Reading .name here
    // was always undefined, silently falling back to the raw tagKey for every
    // buildUspUI() surface (badge/mobile bar) — the toolbar chip looked fine
    // only because it's actually the separate, correctly-titled generic tag
    // chip (tagCatalog), not this dedicated one.
    uspTitle=entry.title||uspTagKey;
    uspColor=entry.color||'';
    uspIconSrc=entry.icon||'';
    // One-shot promotion of the home page's "Browse menu" CTA intent (see
    // usp_toggle.js's initBehavior) — that module only runs on the home page,
    // so the redirect landing here (the menu page) needs its own copy of this
    // consumption step, or the queued intent is set but never applied.
    try{
        const pendingKey='usp_pending_on_'+uspTagKey;
        if(localStorage.getItem(pendingKey)==='1'){
            localStorage.removeItem(pendingKey);
            localStorage.setItem('usp_toggle_'+uspTagKey,'1');
        }
    }catch(e){}
    let stored=false;
    try{stored=localStorage.getItem('usp_toggle_'+uspTagKey)==='1'}catch(e){}
    uspOn=stored;
    buildUspUI();
    syncFilterUI();
}
// Builds every menu-page USP surface from scratch (they're static, empty,
// `hidden` shells in order_menu_new.php/header.php until this runs) and wires
// their clicks directly to setUspOn — no proxying to a separate
// [data-usp-toggle] element (usp_toggle.js is a separate, home-page-only fetch).
function buildUspUI(){
    const chipIcon=uspIconSrc?`<img src="${esc(uspIconSrc)}" alt="" class="menu-chip--usp__icon" width="14" height="14" loading="lazy">`:'';
    const barIcon=uspIconSrc?`<img src="${esc(uspIconSrc)}" alt="" class="usp-toggle__icon" width="16" height="16" loading="lazy">`:'';
    const colorStyle=uspColor?`--usp-color:${esc(uspColor)};--usp-ink:#fff`:'';
    const chipInner=`${chipIcon}${esc(uspTitle)}<span class="menu-chip--usp__mini-switch" aria-hidden="true"></span><span class="menu-chip--usp__x" aria-hidden="true">&times;</span>`;

    // Toolbar chip. Visible (hidden=false) unconditionally once a live USP tag
    // exists — this is the default OFF-state control, not something that only
    // appears once applied; .active (syncFilterUI) is what shows on vs. off.
    const chip=ge('uspFilterChip');
    if(chip){
        chip.hidden=false;
        if(colorStyle)chip.style.cssText=colorStyle;
        chip.innerHTML=chipInner;
        chip.onclick=()=>setUspOn(!uspOn);
    }

    const badgeTitle=ge('uspFilteredBadgeTitle');
    if(badgeTitle)badgeTitle.textContent=uspTitle;
    const badge=ge('uspFilteredBadge');
    if(badge){
        badge.hidden=!uspOn;
        if(colorStyle)badge.style.cssText=colorStyle;
    }
    // Mirrors the desktop sidebar badge above, inside the mobile "MENU"
    // category sheet (order_menu_new.php) — that sheet is mobile's equivalent
    // of the desktop sidebar, so it needs the same "Filtered by X" indicator;
    // .usp-mobile-bar (in the toolbar) shows the count/prompt but isn't
    // visible once that sheet is open over it.
    const badgeTitleMobile=ge('uspFilteredBadgeMobileTitle');
    if(badgeTitleMobile)badgeTitleMobile.textContent=uspTitle;
    const badgeMobile=ge('uspFilteredBadgeMobile');
    if(badgeMobile){
        badgeMobile.hidden=!uspOn;
        if(colorStyle)badgeMobile.style.cssText=colorStyle;
    }

    // One-time hover/focus-reveal coachmark on the mobile-bar switch below
    // (see order_menu_new.php's .usp-toggle-wrap/.usp-callout markup) — no
    // separate control, just an explanatory tooltip attached to the existing
    // toggle. Shown until dismissed (first "Got it" or toggle tap) — see
    // dismissUspCoachmark. Persisted per-tag in localStorage so it doesn't
    // reappear on a later visit either.
    let coachmarkSeen=false;
    try{coachmarkSeen=localStorage.getItem('usp_coachmark_seen_'+uspTagKey)==='1'}catch(e){}
    const toggleWrap=ge('uspToggleWrap');
    const calloutTitle=ge('uspCalloutTitle');
    if(toggleWrap)toggleWrap.classList.toggle('usp-toggle-wrap--eligible',!coachmarkSeen);
    if(calloutTitle)calloutTitle.textContent=`Tap to see only ${uspTitle} items`;
    // "Got it" both confirms AND applies — the coachmark's whole premise is
    // "tap to see only X items", so accepting it should actually turn the
    // filter on in the same tap rather than just closing the tooltip and
    // leaving a second, separate tap on the switch to do the real work.
    const dismissBtn=document.querySelector('#uspCallout [data-usp-dismiss]');
    if(dismissBtn)dismissBtn.onclick=()=>{setUspOn(true);dismissUspCoachmark();};
    // Devices without real hover (touchscreens) fire focus AND click on the
    // same tap — the tooltip would reveal (:focus-within) and get dismissed
    // by dismissUspCoachmark() in the same instant, never actually rendering.
    // Desktop hover reveals it BEFORE the click, so a mouse click can safely
    // toggle+dismiss immediately. On touch, the first tap while still
    // eligible only reveals it (via the focus it already gained); a second
    // tap — after "Got it" or once dismissed — performs the real toggle.
    const canHover=!!(window.matchMedia&&window.matchMedia('(hover: hover)').matches);

    const bar=ge('uspMobileBar');
    const barSwitch=ge('uspMobileBarSwitch');
    if(bar&&barSwitch){
        bar.hidden=false;
        if(colorStyle)bar.style.cssText=colorStyle;
        barSwitch.setAttribute('aria-label','Toggle '+uspTitle);
        barSwitch.innerHTML=`${barIcon}<span class="usp-toggle__label">${esc(uspTitle)}</span><span class="usp-toggle__switch" aria-hidden="true"></span>`;
        barSwitch.onclick=()=>{
            if(!canHover&&toggleWrap?.classList.contains('usp-toggle-wrap--eligible'))return;
            setUspOn(!uspOn);dismissUspCoachmark();
        };
    }
}
// "Got it"/toggle-tap dismissal for the coachmark — flags it seen in
// localStorage (checked in buildUspUI above) and immediately drops the
// --eligible modifier so it stops reappearing on hover for the rest of this
// pageview too, not just on the next load.
function dismissUspCoachmark(){
    try{localStorage.setItem('usp_coachmark_seen_'+uspTagKey,'1')}catch(e){}
    const wrap=ge('uspToggleWrap');
    if(wrap)wrap.classList.remove('usp-toggle-wrap--eligible');
}
// Ordered list of every active filter's display name, In Stock first (it's
// the default-on filter) and the USP/Clean tag always LAST (this is its own
// status bar, so it's the trailing, "and finally" name) — everything else
// (dietary, bestseller/offer/new/rated quick-picks, any other active dynamic
// tag chip) falls in between in a fixed, stable order. Used to build the USP
// bar's "filtered by X, Y and Z" text so it reflects EVERY active filter, not
// just the USP one, once more than one is on at the same time.
// FEED_FIELD_ALIAS covers the couple of raw feed field names some tagKeys
// alias to (e.g. newItem→isNew) — used only to detect/exclude entries that
// duplicate an existing static chip (see STATIC_FILTER_FIELDS below), NOT for
// per-item matching: the real API has no field/fieldType/value shape at all,
// every entry (API-sourced or Menu Hub v2-derived) is matched by tagKey
// membership in the item's own tag set.
// client/getFilterList (tagCatalog's source) and the menu feed's own
// item.tags.primary/secondary don't share a casing convention for the same
// conceptual tag — e.g. one brand's filter list carries "Chef Special" while
// its feed items carry "chef special" — so tag chips would render (from the
// filter API) but never actually match any item (from the feed) without this.
// Backend data inconsistency between the two endpoints; normalizing the
// comparison here is defensive, same spirit as normalizeLabel() below.
function tagKeyNorm(k){return String(k||'').trim().toLowerCase()}
function itemTagKeys(i){
    const s=new Set();
    if(i.highlyOrdered)s.add('highly_ordered');
    ((i.tags&&i.tags.primary)||[]).forEach(t=>t&&t.tagKey&&s.add(tagKeyNorm(t.tagKey)));
    ((i.tags&&i.tags.secondary)||[]).forEach(t=>t&&t.tagKey&&s.add(tagKeyNorm(t.tagKey)));
    return s;
}
function matchesActiveTags(i){
    const ik=itemTagKeys(i);
    return[...activeTagKeys].every(k=>ik.has(tagKeyNorm(k)));
}
// Rebuilds the catalog: API defs first (real backend config, when reachable),
// then client-derived Menu Hub tags for whatever the API doesn't cover, then
// the manual 'highly_ordered' entry — skipped only if the API list already
// has an equivalent (tagKey resolves to highlyOrdered) so it doesn't duplicate.
// The manual entry is otherwise always present, regardless of whether any
// loaded item has the flag yet — mirrors the app's manual injection
// ("append so chip always appears").
// tagKeys already driving a dedicated, always-shown chip elsewhere (toolbar
// quick-chips + filter sheet Availability/Rating groups). Bestseller/New/Clean
// used to be in this set too, but their static picks are gone now — Bestseller
// and New are plain tag chips like any other (matched via real tag membership,
// not the old best/isNew boolean flags), and Clean/USP has no dedicated toggle
// UI anymore either. Only In Stock and Rated 4+ remain hardcoded, computed
// conditions rather than brand-configured tags. highlyOrderedItem is
// deliberately NOT in this set: there's no pre-existing chip for it, which is
// the whole point of this feature.
const STATIC_FILTER_FIELDS=new Set(['oos','rat']);
// Belt-and-suspenders: different brands' tag catalogs don't all use the same
// tagKey for "the same" static filter. Catch those by matching the DISPLAY
// NAME instead, case/punctuation-insensitive, against the remaining static
// filters' own labels.
const STATIC_FILTER_LABELS=new Set(['in stock','veg','pure veg','veg & egg','non-veg','egg','on offer','rated 4+']);
const normalizeLabel=s=>String(s||'').toLowerCase().replace(/[!?.]/g,'').trim();
function buildTagCatalog(){
    const seen=new Map();
    apiFilterDefs.forEach(d=>{
        const tagKey=String(d.tagKey||'').trim();if(!tagKey)return;
        if(STATIC_FILTER_FIELDS.has(FEED_FIELD_ALIAS[tagKey]||tagKey))return;
        if(STATIC_FILTER_LABELS.has(normalizeLabel(d.name)))return;
        // The is_usp:1 entry ALSO gets its own dedicated toggle (buildUspUI's
        // chip + mobile bar + sidebar badge) — it's included here too (not
        // excluded), but renderTagChips()/syncFilterUI() special-case its
        // tagKey to drive/reflect uspOn instead of activeTagKeys, so both
        // surfaces stay in sync as one control rather than two independent ones.
        if(!seen.has(tagKey))seen.set(tagKey,{tagKey,name:d.name||tagKey,color:d.color||'',icon:d.icon||''});
    });
    // Deliberately NOT deriving anything from allItems[].tags.primary/secondary
    // here — that's the feed's own per-item tag data, which drives ITEM CARD
    // badges (tagRowHTML) and nothing else. The filter list is sourced
    // strictly from apiFilterDefs (client/getFilterList) so it never shows
    // a filter chip the API didn't actually return, even if some item in the
    // feed happens to carry a similarly-named tag.
    const hasApiHighly=apiFilterDefs.some(d=>(FEED_FIELD_ALIAS[d.tagKey]||d.tagKey)==='highlyOrdered');
    const catalog=[...seen.values()];
    if(!hasApiHighly)catalog.unshift({tagKey:'highly_ordered',name:'Highly Ordered',color:'',icon:''});
    tagCatalog=catalog;
}
function tagFilterChipHTML(t){
    const isHighly=t.tagKey==='highly_ordered'||(FEED_FIELD_ALIAS[t.tagKey]||t.tagKey)==='highlyOrdered';
    const icon=isHighly?TREND_ICON:(t.icon?`<img src="${esc(t.icon)}" alt="" loading="lazy">`:'');
    // × once active (the removal affordance, generic .menu-chip__x — every
    // filter chip gets this now, not just tags). The switch-LOOK (toggle
    // graphic shown while off) is NOT part of this — that stays specific to
    // Clean/USP's own dedicated chip/mobile-bar (buildUspUI); the USP entry
    // rendered through THIS function (also present in tagCatalog now) uses
    // the plain × like every other tag, not the switch-look.
    // Deliberately no --tag-color styling here — per-tag color is reserved
    // for the ITEM CARD badge (tagChipHTML), not the filter control. Every
    // filter chip (colored tag or not) renders in the same plain/neutral look.
    return `<button type="button" class="menu-chip menu-chip--tag" data-tag-key="${esc(t.tagKey)}">${icon}${esc(t.name)}<span class="menu-chip__x" aria-hidden="true">&times;</span></button>`;
}
// Re-derives the chip HTML and re-wires clicks every time it's called — safe to
// call repeatedly (grocery streams sections in one at a time, each potentially
// surfacing new tags), since it clears its own previous chips first instead of
// appending duplicates on every call.
function renderTagChips(){
    document.querySelectorAll('.menu-chip--tag').forEach(b=>b.remove());
    const html=tagCatalog.map(tagFilterChipHTML).join('');
    const bar=ge('menuToolbarChips');if(bar)bar.insertAdjacentHTML('beforeend',html);
    const sheet=ge('filterTagChips');if(sheet)sheet.innerHTML=html;
    // Search modal (mobile) copy — same catalog/markup as the toolbar/sheet, so
    // every tag/USP chip toggleable there is toggleable here too, one shared state.
    const srch=ge('srchTagChips');if(srch)srch.innerHTML=html;
    document.querySelectorAll('.menu-chip--tag').forEach(b=>b.onclick=()=>{
        const k=b.dataset.tagKey;
        const inSearch=!!b.closest('#searchOverlay');
        // The USP tag's chip drives/reflects uspOn (via setUspOn, same as
        // buildUspUI's dedicated chip/bar), NOT activeTagKeys — so this
        // instance and the dedicated one are one control, not two independent
        // toggles for the same tag. setUspOn() already re-renders the main
        // grid; from inside the search modal that leaves #searchResults stale,
        // so also re-run the active search query here.
        if(uspTagKey&&k===uspTagKey){
            setUspOn(!uspOn);
            if(inSearch)doSearch(ge('searchInput')?.value||'');
            return;
        }
        activeTagKeys.has(k)?activeTagKeys.delete(k):activeTagKeys.add(k);
        syncFilterUI();
        if(inSearch)doSearch(ge('searchInput')?.value||'');
        else if(!b.closest('#filterSheet'))render();
    });
}

// ── Section rail (horizontal scroller with left/right arrows) ───────────────
// Reused by Featured Items, Your Favourites, and any future horizontal rails.
function sectionRailHTML(innerHTML,modifier){
    const mod=modifier?` ${modifier}`:'';
    return`<div class="section-rail${mod}">
        <button type="button" class="section-rail__arrow left" aria-label="Scroll left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button type="button" class="section-rail__arrow right" aria-label="Scroll right">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <div class="section-rail__scroll">${innerHTML}</div>
    </div>`;
}

// ── Card component helpers (shared by .feat / .item / .fav-row) ─────────────
// Maps a vegNonvegBoth value to its marker class. egg → amber, non-veg → red, else veg.
function vegCls(v){return v==='egg'?'egg-mark':(v==='non-veg'?'nonveg-mark':'veg-mark')}
// Feed diet values are 'veg' | 'non-veg' | 'egg'; template rows sometimes carry the
// legacy 0/1/2 codes. Anything else — and an empty string is common, every BOGO /
// variant-parent row ships one — normalises to '' so nothing is rendered. CI3 flags
// an item only on an exact match, so a green dot on an unmarked item is a claim the
// data never made (La Pino'z "BOGO On Mutton Burger." was showing veg).
const VEG_CODES={'0':'veg','1':'non-veg','2':'egg'};
function normVeg(v){const s=String(v??'').trim().toLowerCase();return(s==='veg'||s==='non-veg'||s==='egg')?s:(VEG_CODES[s]||'');}
// Marker span for a raw feed value — empty string for an unknown/blank value.
function vegDotHTML(v,cls=''){const n=normVeg(v);return n?`<span class="${cls?cls+' ':''}${vegCls(n)}"></span>`:'';}
// Controls the dietary filter across toolbar, filter sheet and search modal.
// Pure-veg brands hide the whole group — there's nothing to filter by. Otherwise
// the shape depends on whether THIS menu carries an egg dish: with one, the Veg
// chip becomes a Pure Veg / Veg & Egg dropdown (R1) and the sheet grows a third
// chip (R16); without one, everything stays exactly as it has always been (R2).
//
// menuHasEgg is declared with the rest of the module state near the top of this
// file, NOT here — bindAll() calls syncFilterUI() synchronously at module init and
// that reads it, so a `let` declared down here would be in its temporal dead zone
// at call time (same reason as FILTER_LIST_SALT and STATIC_CHIP_ORDER up there).
function updateDietFilterUI(){
    if(!isPureVeg&&allItems.some(i=>i.veg==='egg'))menuHasEgg=true;
    document.querySelectorAll('.diet-filter-opt').forEach(b=>{b.hidden=isPureVeg;});
    document.querySelectorAll('.egg-filter-opt').forEach(b=>{b.hidden=isPureVeg||!menuHasEgg;});
    if(isPureVeg&&veg)veg='';
    else if(!menuHasEgg&&veg==='veg-egg')veg='';   // brand/menu with no egg can't hold a Veg & Egg pick
    closeDietMenu();
    syncFilterUI();
}
// ── Pure Veg / Veg & Egg dropdown ──────────────────────────────────────────
// Lives on <body>, positioned fixed against whichever .diet-chip opened it.
// It CANNOT be nested inside the chip: both rows that host one
// (.menu-toolbar__chips and .search-filter-chips) are overflow-x:auto, which
// forces overflow-y to auto as well — a nested panel gets clipped at the row's
// bottom edge AND makes the chip row itself vertically scrollable (measured:
// 119px clipped, row scrollHeight 34px → 153px).
// dietMenuEl/dietMenuAnchor are declared with the module state at the top of this
// file for the same temporal-dead-zone reason as menuHasEgg: syncFilterUI() reads
// them (via dietMenuIsOpen) during bindAll()'s synchronous init.
const DIET_OPTS=[{v:'veg',label:'Pure Veg'},{v:'veg-egg',label:'Veg & Egg'}];
function dietMenuBuild(){
    if(dietMenuEl)return dietMenuEl;
    dietMenuEl=document.createElement('div');
    dietMenuEl.className='diet-menu';
    dietMenuEl.id='dietMenu';
    dietMenuEl.setAttribute('role','menu');
    dietMenuEl.hidden=true;
    dietMenuEl.innerHTML=DIET_OPTS.map(o=>
        `<button type="button" class="diet-menu__opt" role="menuitemradio" aria-checked="false" data-diet-opt="${o.v}">`
        +`<span class="diet-menu__label">${esc(o.label)}</span><span class="diet-menu__radio" aria-hidden="true"></span></button>`
    ).join('')
    // Shown only while a dietary filter is on — it is the reset, so with nothing
    // applied there is nothing for it to do. This is why the chip itself carries no
    // ✕ once it has a dropdown: clearing lives in here instead.
    +`<button type="button" class="diet-menu__reset" data-diet-reset hidden>Show all items</button>`;
    dietMenuEl.addEventListener('click',e=>{
        const opt=e.target.closest('[data-diet-opt]'),reset=e.target.closest('[data-diet-reset]');
        if(!opt&&!reset)return;
        const fromSearch=!!dietMenuAnchor?.closest('#searchFilterChips');
        if(reset)veg='';
        else{const pick=opt.dataset.dietOpt;veg=(veg===pick)?'':pick;}  // re-picking the active option clears it (R11)
        closeDietMenu();
        syncFilterUI();trackFiltersOnce();
        // Not srchVal() — that's a closure inside bindAll(), out of scope here.
        if(fromSearch)doSearch(ge('searchInput')?.value||'');else render();
    });
    document.body.appendChild(dietMenuEl);
    return dietMenuEl;
}
function dietMenuPosition(){
    if(!dietMenuEl||dietMenuEl.hidden||!dietMenuAnchor)return;
    const r=dietMenuAnchor.getBoundingClientRect();
    // Anchor left-aligned under the chip, nudged back inside the viewport when the
    // chip sits near the right edge (the toolbar scrolls, so it often does).
    const w=dietMenuEl.offsetWidth||240;
    const left=Math.max(8,Math.min(r.left,window.innerWidth-w-8));
    dietMenuEl.style.left=`${Math.round(left)}px`;
    dietMenuEl.style.top=`${Math.round(r.bottom+6)}px`;
}
function openDietMenu(chip){
    const m=dietMenuBuild();
    dietMenuAnchor=chip;
    m.querySelectorAll('[data-diet-opt]').forEach(b=>{
        const on=b.dataset.dietOpt===veg;
        b.classList.toggle('diet-menu__opt--on',on);
        b.setAttribute('aria-checked',on?'true':'false');
    });
    const reset=m.querySelector('[data-diet-reset]');
    if(reset)reset.hidden=!veg;
    m.hidden=false;
    dietMenuPosition();
    chip.setAttribute('aria-expanded','true');
}
function closeDietMenu(){
    if(!dietMenuEl||dietMenuEl.hidden)return;
    dietMenuEl.hidden=true;
    dietMenuAnchor?.setAttribute('aria-expanded','false');
    dietMenuAnchor=null;
}
function dietMenuIsOpen(){return !!dietMenuEl&&!dietMenuEl.hidden;}
// Pure-veg brands: every item is veg by definition, so the dot is redundant
// noise — hide it instead of showing a green mark on every single card.
// A BOGO whose deal pool mixes veg and non-veg choices also gets no dot — the
// deal isn't one or the other until the customer picks.
function vegMarkHTML(i){
    if(isPureVeg)return'';
    if(i.isBogo&&bogoHasMixedVeg(i))return'';
    return vegDotHTML(i.veg);
}
function bogoHasMixedVeg(item){
    if(!item.isBogo||!item.wizardSteps?.length)return false;
    const vegs=[];
    for(const step of item.wizardSteps){
        const tmpl=templateList.find(t=>String(t.templateId)===String(step.pizzaTemplateId));
        for(const x of(tmpl?.template||[])){const n=normVeg(x.vegNonvegBoth);if(n)vegs.push(n)}
    }
    return vegs.includes('veg')&&(vegs.includes('non-veg')||vegs.includes('egg'));
}
// Perceived-brightness (YIQ) check on a #rrggbb tag color — decides whether
// the chip needs dark or white text/icon to stay readable against its own
// solid color fill. Threshold picked from this brand's actual tag palette:
// splits dark fills that read fine with white text (olive #5E551F≈82,
// orange #CE7910≈134, navy #1D265E≈42) from light ones that don't (light
// green #83C590≈171). Malformed/missing color falls back to "dark" (white
// text) since that's the safer default against an unknown fill.
function tagColorIsLight(hex){
    const h=String(hex||'').replace('#','');
    if(h.length!==6)return false;
    const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
    if([r,g,b].some(Number.isNaN))return false;
    return(r*299+g*587+b*114)/1000>150;
}
// Renders one Menu Hub v2 tag ({tagKey,name,color,icon,displayMode}) as a chip.
// displayMode is 'name' (label only), 'icon' (icon only), or 'name_icon' (both) —
// per the locked API contract (tags_usp_api_contract.docx). Any mode requesting
// an icon falls back to name-only if the API sent no icon file. --tag-color
// carries the tag's own color for the chip to style with — EXCEPT icon-only
// tags, which render as a bare glyph with no colored/bordered pill behind
// them (nothing to contrast against without a label).
function tagChipHTML(t,extraClass=''){
    const label=esc(t.name||t.tagKey||'');
    const wantsIcon=(t.displayMode==='icon'||t.displayMode==='name_icon')&&t.icon;
    const wantsName=t.displayMode!=='icon';
    const iconOnly=wantsIcon&&!wantsName;
    const hasColor=(t.color&&!iconOnly)?' tag--has-color':'';
    const lightBg=(t.color&&!iconOnly&&tagColorIsLight(t.color))?' tag--light-bg':'';
    const iconOnlyClass=iconOnly?' tag--icon-only':'';
    const style=(t.color&&!iconOnly)?` style="--tag-color:${esc(t.color)}"`:'';
    const iconHtml=wantsIcon?`<img src="${esc(t.icon)}" alt="${wantsName?'':label}" loading="lazy">`:'';
    const nameHtml=wantsName?label:'';
    const body=(iconHtml+nameHtml)||label; // never render an empty chip
    return `<span class="tag tag--dyn${hasColor}${lightBg}${iconOnlyClass}${extraClass}"${style}>${body}</span>`;
}
// Secondary tags render in their OWN row below the item name/title (a separate
// call site per card template — see each template's "below title" insertion
// point), never inside tagRowHTML's top row.
function secondaryTagsHTML(i){
    const secondary=(i.tags&&i.tags.secondary)||[];
    if(!secondary.length)return'';
    return `<div class="tag-row tag-row--secondary">${secondary.map(t=>tagChipHTML(t,' tag--secondary')).join('')}</div>`;
}
// Tag row always renders so the item-name below it sits at a consistent
// vertical position whether or not the item has any tags.
// Veg/non-veg dot lives inside the row, alongside the tags. Bestseller/New
// are NOT hardcoded here anymore (i.best/i.isNew are still real fields, still
// used elsewhere — e.g. buildPopularGrid's search-overlay selection — just
// not for this badge) — the feed's own tags.primary array is now the single
// source for every badge, Bestseller/New included, so a merchant-configured
// duplicate (same item flagged BOTH recommended==1 AND tagged "Bestseller")
// doesn't render twice. Offer is the one exception: it's a computed
// price-comparison signal (mrp vs sp), not a merchant-assigned tag, so it
// stays derived from i.disc/i.offerTag rather than the tags array. This is
// the "top of card" row; secondary tags get their own row below the title
// (secondaryTagsHTML above), and hidden tags never render at all (the feed's
// `hidden` bucket is intentionally not read anywhere in this file).
function tagRowHTML(i,opts={}){
    const vegHtml=vegMarkHTML(i);
    const tags=[];
    if(!opts.skipOffer){
        if(i.offerTag)tags.push(`<span class="tag tag--offer">${esc(i.offerTag)}</span>`);
        else if(i.disc>0)tags.push('<span class="tag tag--offer">Offer</span>');
    }
    ((i.tags&&i.tags.primary)||[]).forEach(t=>tags.push(tagChipHTML(t,' tag--primary')));
    const tagsHtml=tags.join('');
    return `<div class="tag-row">${vegHtml}${tagsHtml}</div>`;
}
// "Highly Ordered" tag — personal: shown only if the logged-in user has ordered
// this item often (i.e. it's in mostOrderedIds, populated by fetchMostOrderedItems).
const TREND_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>';
function trendTagHTML(i){return(i.highlyOrdered||mostOrderedIds.has(String(i.id)))?`<div class="trend-tag">${TREND_ICON} Highly Ordered</div>`:''}
// Price display: trim to ≤2 decimals, drop trailing zeros (239.20 → 239.2, 80 → 80).
function fmtP(n){return String(Math.round((+n||0)*100)/100)}
// Points, grouped — a four-figure balance reads as a quantity, not a price,
// so it gets separators where fmtP deliberately leaves rupee amounts bare.
function ptsFmt(n){return (Math.floor(+n)||0).toLocaleString('en-IN')}
// What this brand calls its points ("Hearts", "GIPL Coins"), for use straight
// after a numeral. Copied rather than imported from loyaltyBurn.js — a nested
// import carries no version query against a 30-day cache, so importing a newly
// added name is how a stale child kills the page. Six lines beats that.
function ptsUnit(){
    const raw=String(window.OutletConfig?.walletName||'').trim();
    return (!raw||/^(points?|wallet)$/i.test(raw))?'pts':raw;
}
// `195 Hearts` / `195 pts` — a figure and its unit, already formatted.
function ptsWithUnit(n){return `${ptsFmt(n)} ${ptsUnit()}`}
// Membership price is always shown floored (₹278.85 → ₹278) per design.
function fmtMP(n){return String(Math.floor(+n||0))}
// Lock glyph for the guest "Unlock with Membership" strip (no emoji — design rule).
const LOCK_ICON='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
function priceLineHTML(i,opts={}){
    const sp=+i.sp||0,mrp=+i.mrp||0;
    // Feed gap: sp AND mrp both NULL/0 (no variant supplied a price either) → render
    // nothing instead of a bogus "₹0" (matches storeViewMenu's `sp > 0` guard).
    if(sp<=0&&mrp<=0)return'';
    const md=memberPricing?getMembershipDiscountForItem(i,memberPricing):null;
    // Member — show the slashed member price + savings caption in place of the normal line.
    if(md&&md.mode==='member'){
        const fromPx='';
        return`<div class="price-line price-line--member">`
            +`<span class="price-line__member-pill">`
            +`<span class="price-line__member-strike">₹${fmtP(md.mrp)}</span>`
            +`<span class="price-line__member-price">${fromPx}₹${fmtMP(md.memberPrice)}</span>`
            +`</span>`
            +`<span class="price-line__member-save">Saving <b>₹${fmtP(md.mrp-Math.floor(md.memberPrice))}</b> - Member Benefit</span>`
            +`</div>`;
    }
    // Variant items quote the lowest variant price (Math.min in mk()). The detail
    // modal doesn't reprice this line on variant switch, so opt-in callers (the
    // modal) prefix "Starts from" to read it as a range, not a fixed price. Menu
    // cards don't pass fromPrefix, so they keep the bare price.
    const useFrom=i.hasSubs&&!i.isBogo&&opts.fromPrefix;
    // mrp/sp here are already the cheapest variant's own values (see mk()), so the
    // strike-through is accurate for variant items too, not just simple ones —
    // EXCEPT in the modal's "Starts from" line (useFrom): that doesn't reprice on
    // variant switch, so a strike tied to only the cheapest variant would go stale
    // (e.g. still show ₹199 after picking Medium, whose mrp is ₹349). Each variant
    // row already carries its own accurate strike, so skip it only there — a
    // simple (non-variant) item opened in the same modal still shows its strike.
    const hasStrike=mrp>sp&&sp>0&&!opts.spOnly&&!useFrom;
    const current=i.isBogo?`Starts at ₹${sp}`:(useFrom?`Starts from ₹${sp}`:`₹${sp}`);
    const strike=hasStrike?`<span class="price-line__strike">₹${mrp}</span>`:'';
    const savePct=hasStrike?Math.round((mrp-sp)/mrp*100):0;
    const save=savePct>0?`<span class="price-line__save">Save ${savePct}%</span>`:'';
    // Guests render the normal price here; the "Unlock with Membership" strip is a
    // separate full-bleed element at the card bottom — see unlockStripHTML().
    return`<div class="price-line">${strike}<span class="price-line__current">${current}</span>${save}</div>`;
}
// Guest "Unlock for ₹X with Membership" — a full-bleed strip rendered at the BOTTOM
// of a card (below the price/content), per design. Returns '' unless the item is
// guest-eligible. The card root carries .card-add, so the delegated click handler
// intercepts .membership-unlock first and routes to /memberships.
function unlockStripHTML(i){
    const md=memberPricing?getMembershipDiscountForItem(i,memberPricing):null;
    if(!md||md.mode!=='guest')return'';
    const planId=(md.bucket&&md.bucket.membership_plan_id!=null)?esc(String(md.bucket.membership_plan_id)):'';
    return`<button class="membership-unlock" type="button" data-plan-id="${planId}">${LOCK_ICON}<span>Unlock for ₹${fmtMP(md.memberPrice)} with Membership</span></button>`;
}
// Compact membership treatment for the search overlay's bespoke price markup
// (thin result rows + popular tiles don't use priceLineHTML). `it` may be a raw
// feed item or a normalized one — getMembershipDiscountForItem handles both.
// Member → struck MRP + member price in the given price `cls`; else normal price.
function searchPriceHTML(it,sp,cls){
    if((+sp||0)<=0&&(+it.mrp||0)<=0)return'';   // unpriced feed row → no "₹0"
    const md=memberPricing?getMembershipDiscountForItem(it,memberPricing):null;
    // Member → struck MRP + member price + "Saving ₹X" caption on the amber
    // highlight (mirrors the card pill). Guest/non-member → plain price.
    if(md&&md.mode==='member')
        return`<span class="srch-member">`
            +`<span class="${cls} srch-member__price"><s class="srch-mrp">₹${fmtP(md.mrp)}</s> ₹${fmtMP(md.memberPrice)}</span>`
            +`<span class="srch-member-save">Saving <b>₹${fmtP(md.mrp-Math.floor(md.memberPrice))}</b> - Member Benefit</span>`
            +`</span>`;
    const prefix=it.isBogo?'Starts at ':'';
    const mrp=+it.mrp||0;
    const hasStrike=!it.isBogo&&mrp>sp&&sp>0;
    const strike=hasStrike?`<s class="srch-mrp">₹${fmtP(mrp)}</s> `:'';
    const savePct=hasStrike?Math.round((mrp-sp)/mrp*100):0;
    const save=savePct>0?`<span class="price-line__save">Save ${savePct}%</span>`:'';
    return`<div class="srch-price-row"><span class="${cls}">${strike}${prefix}₹${fmtP(sp)}</span>${save}</div>`;
}
// Guest → compact inline "Unlock for ₹X" pill (mini variant of the card strip).
function searchUnlockHTML(it){
    const md=memberPricing?getMembershipDiscountForItem(it,memberPricing):null;
    if(!md||md.mode!=='guest')return'';
    const planId=(md.bucket&&md.bucket.membership_plan_id!=null)?esc(String(md.bucket.membership_plan_id)):'';
    return`<button class="membership-unlock membership-unlock--mini" type="button" data-plan-id="${planId}">${LOCK_ICON}<span>Unlock for ₹${fmtMP(md.memberPrice)} with Membership</span></button>`;
}
const STAR_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M4.57658 2.70419C5.20991 1.56806 5.52657 1 6 1C6.47343 1 6.79009 1.56806 7.42342 2.70419L7.58727 2.99812C7.76724 3.32097 7.85722 3.48239 7.99753 3.5889C8.13783 3.69541 8.31257 3.73495 8.66206 3.81402L8.98023 3.88601C10.2101 4.16428 10.825 4.30341 10.9713 4.77387C11.1176 5.24432 10.6984 5.73454 9.85995 6.71496L9.64304 6.96861C9.40479 7.24722 9.28566 7.38652 9.23207 7.55886C9.17848 7.7312 9.19649 7.91706 9.23251 8.28878L9.2653 8.6272C9.39206 9.9353 9.45544 10.5894 9.07243 10.8801C8.68941 11.1709 8.11366 10.9058 6.96216 10.3756L6.66426 10.2384C6.33704 10.0878 6.17343 10.0124 6 10.0124C5.82657 10.0124 5.66296 10.0878 5.33574 10.2384L5.03784 10.3756C3.88634 10.9058 3.31059 11.1709 2.92757 10.8801C2.54456 10.5894 2.60794 9.9353 2.7347 8.6272L2.76749 8.28878C2.80351 7.91706 2.82152 7.7312 2.76793 7.55886C2.71434 7.38652 2.59521 7.24722 2.35696 6.96861L2.14005 6.71496C1.30162 5.73454 0.882412 5.24432 1.02871 4.77387C1.17501 4.30341 1.78993 4.16428 3.01977 3.88601L3.33794 3.81402C3.68743 3.73495 3.86217 3.69541 4.00247 3.5889C4.14278 3.48239 4.23276 3.32097 4.41273 2.99812L4.57658 2.70419Z"/></svg>`;
function starsRowHTML(rat){
    if(!rat||rat<=0)return'';
    const full=Math.round(rat);
    let html='';
    for(let n=0;n<5;n++)html+=`<span class="stars-row__star${n<full?'':' stars-row__star--empty'}">${STAR_SVG}</span>`;
    return`<div class="stars-row" aria-label="${rat} out of 5">${html}</div>`;
}
// A bare templateId on an item is "customisable" only when it resolves to a
// non-empty row in the feed's template pool. Brands like Blossom carry a
// templateId with no matching/empty pool entry — that's stale data, not a real
// add-on, so don't flag the card. Combos (viewType 2) are always customisable.
function tmplHasItems(tid){const pool=templateList.find(t=>String(t.templateId)===String(tid));return !!pool&&(pool.template||pool.items||[]).length>0}
function isCustomisable(i){
    if(i.viewType===2)return true;
    const ids=new Set();
    if(i.tmplIds)String(i.tmplIds).split(',').forEach(s=>{const x=s.trim();if(x)ids.add(x)});
    (i.tmpls||[]).forEach(t=>{if(t.templateId)ids.add(String(t.templateId))});
    return [...ids].some(tmplHasItems);
}
function customisableLabelHTML(i){return isCustomisable(i)?'<span class="customisable-label">Customisable</span>':''}
// In-cart lines for a card. Normally a line's parentId == the card id. But for
// nested-variant items (e.g. "Chicken Thigh 3kg" → "Fillet") the server keys the
// cart line by the DEEP variant id, and reconcileCartFromServer persists that as the
// line's id/parentId — which no longer equals the expanded card's id, so the card
// would wrongly show ADD instead of the stepper. Also match when the line's
// id/parentId is one of THIS card's own variant ids (i.subs), which the feed always
// provides on the rendered card, so the match holds regardless of how it was keyed.
function cartLinesFor(i){
    const id=String(i.id);
    const subIds=Array.isArray(i.subs)&&i.subs.length?new Set(i.subs.map(s=>String(s.id))):null;
    return cart.items.filter(x=>{
        if(String(x.parentId)===id)return true;
        if(subIds&&(subIds.has(String(x.parentId))||subIds.has(String(x.id))))return true;
        return false;
    });
}
function descHTML(i){
    if(!i.desc)return'';
    // For long descriptions, truncate in JS so "Read more" can sit inline
    // at the end of the visible text. Tight slice (~58 chars) keeps the
    // result + " Read more" within 2 visual lines at the card width
    // (~40 chars per line at 12.5px on a ~280px column).
    const FULL_LIMIT = 65;
    if(i.desc.length <= FULL_LIMIT) return `<div class="item-desc">${esc(i.desc)}</div>`;
    const truncated = i.desc.slice(0, 58).replace(/[\s.,;:]+$/,'');
    return `<div class="item-desc">${esc(truncated)}… <button class="read-more" type="button" data-readmore="${i.id}">Read more</button></div>`;
}
// ADD button / stepper wrapped in a fixed-width .add-ctrl so the swap doesn't shift layout.
function addCtrlHTML(i,inC,totalQty,lastLineId){
    const pop=i.hasSubs||i.hasTmpl||i.isBogo;
    if(!isOpen||i.oos)return'';
    if(isSlotBased&&!slotAvailable(i))return`<div class="add-ctrl"><button class="add-ctrl__btn item-next-slot" type="button">Select Next Slot</button></div>`;
    if(inC){
        return`<div class="add-ctrl"><div class="add-ctrl__stepper" id="div-${i.id}"><button class="qb" data-id="${lastLineId}" data-d="m" type="button" aria-label="Decrease">−</button><span id="qty-${i.id}">${totalQty}</span><button class="qb" data-id="${i.id}" data-d="${pop?'pop':'p'}" type="button" aria-label="Increase">+</button></div></div>`;
    }
    return`<div class="add-ctrl"><button class="add-ctrl__btn" type="button">ADD +</button></div>`;
}

// Search-overlay add control. Mirrors addCtrlHTML's open/oos/slot guards so the
// search modal (popular grid + results) shows "Select Next Slot" for slot-based
// items that aren't available in the current slot, instead of a bare ADD+ / nothing.
function searchAddHTML(i){
    if(!isOpen||i.oos)return'';
    if(isSlotBased&&!slotAvailable(i))return`<button class="item-next-slot srch-add--slot" type="button">Select Next Slot</button>`;
    return`<button class="srch-add" type="button">ADD+</button>`;
}

// Card image — real CDN photo, else the brand logo (grayscaled) as a fallback
// so the image area stays filled instead of collapsing to blank white space,
// mirroring the item-popup behaviour. The caller still appends the multi-image
// badge separately (a logo fallback never carries one).
function cardImgTag(i){
    const img=i.image?cardImgUrl(i.image):'';
    if(img)return`<img src="${img}" alt="${esc(i.name)}" loading="lazy">`;
    return bLogo?`<img src="${esc(bLogo)}" alt="" class="card-img-fallback" loading="lazy">`:'';
}

// Bestseller card — .feat (image on top, body below), used in the Featured rail.
function popularCard(i){
    const img=i.image?cardImgUrl(i.image):'';
    const pop=i.hasSubs||i.hasTmpl||i.isBogo;
    const lines=cartLinesFor(i);
    const totalQty=lines.reduce((s,x)=>s+x.qty,0);
    const inC=totalQty>0;
    const lastLineId=inC?lines[lines.length-1].id:i.id;
    const isFav=favs.has(String(i.id));
    const featPrepHtml=isSlotBased&&i.prepTime&&i.prepTime!=='00:00:00'
        ?`<div class="item-preptime"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" fill="none">
<g clip-path="url(#clip0_1395_19376)">
<path fill-rule="evenodd" clip-rule="evenodd" d="M3.56841 0.667914C3.66469 0.814269 3.61786 1.00707 3.4638 1.09854L1.7094 2.1402C1.55534 2.23168 1.3524 2.18718 1.25611 2.04083C1.15983 1.89447 1.20666 1.70168 1.36072 1.6102L3.11512 0.568538C3.26918 0.477066 3.47212 0.521559 3.56841 0.667914ZM6.95787 0.667913C7.05416 0.521558 7.2571 0.477066 7.41116 0.568538L9.16554 1.61021C9.3196 1.70168 9.36644 1.89447 9.27015 2.04083C9.17386 2.18718 8.97092 2.23168 8.81686 2.1402L7.06247 1.09854C6.90842 1.00707 6.86158 0.814268 6.95787 0.667913ZM5.26313 1.97937C3.26473 1.97937 1.64471 3.51839 1.64471 5.41687C1.64471 7.31535 3.26473 8.85437 5.26313 8.85437C7.26153 8.85437 8.88155 7.31535 8.88155 5.41687C8.88155 3.51839 7.26153 1.97937 5.26313 1.97937ZM0.986816 5.41687C0.986816 3.17321 2.90139 1.35437 5.26313 1.35437C7.62488 1.35437 9.53945 3.17321 9.53945 5.41687C9.53945 7.66053 7.62488 9.47937 5.26313 9.47937C2.90139 9.47937 0.986816 7.66053 0.986816 5.41687ZM5.26313 3.4377C5.4448 3.4377 5.59208 3.57762 5.59208 3.7502V5.28743L6.59222 6.23757C6.72069 6.35961 6.72069 6.55747 6.59222 6.67951C6.46376 6.80155 6.25548 6.80155 6.12702 6.67951L5.03053 5.63784C4.96884 5.57924 4.93418 5.49975 4.93418 5.41687V3.7502C4.93418 3.57762 5.08146 3.4377 5.26313 3.4377Z" fill="#212121"/>
</g>
<defs>
<clipPath id="clip0_1395_19376">
<rect width="10" height="10" fill="white"/>
</clipPath>
</defs>
</svg> Preparation time : <b>${Math.round(toPrepH(i.prepTime))} hrs</b></div>`
        :'';
    const oosHTML=i.oos?'<span class="oos-pill">Out of Stock</span>':'';
    // Card body always opens the item modal (matches the search overlay, which
    // always carries .card-add) — even when the outlet is closed or a slot/prep-time
    // item isn't available in the current slot. The add-control below still reflects
    // the closed/oos/slot state (ADD+ hidden, "Select Next Slot", etc.).
    const clickCls=' card-add clickable';
    const unavailCls=i.oos?' unavailable':'';
    return `<div class="feat${clickCls}${unavailCls}" id="item-pop-${i.id}" data-id="${i.id}" data-nm="${esc(i.name)}" data-pr="${i.sp}" data-pop="${pop?1:0}" data-veg="${i.veg}">
  <div class="feat-img">
    ${cardImgTag(i)}
    ${img&&hasMultiImg(i)?MULTI_IMG_BADGE:''}
    ${oosHTML}
  </div>
  <div class="feat-body">
    ${tagRowHTML(i,{skipFeatured:true})}
    ${trendTagHTML(i)}
    <div class="feat-name">${esc(i.name)}</div>
    ${secondaryTagsHTML(i)}
    ${featPrepHtml}
    <div class="feat-foot">
      ${priceLineHTML(i,{spOnly:true,noFromPrefix:true})}
      ${addCtrlHTML(i,inC,totalQty,lastLineId)}
    </div>
    ${nextAvailableHTML()}
  </div>
  ${unlockStripHTML(i)}
  ${earnStripHTML(i)}
</div>`;
}

// Regular menu card — .item (horizontal: text-left, image-right, ADD/stepper
// below the image). The card root carries .card-add so any click on it routes
// through the delegated handler in bindAll() (popup vs add-to-cart).
function card(i){
    const img=i.image?cardImgUrl(i.image):'';
    const lines=cartLinesFor(i);
    const totalQty=lines.reduce((s,x)=>s+x.qty,0);
    const inC=totalQty>0;
    const lastLineId=inC?lines[lines.length-1].id:i.id;
    const slotOk=slotAvailable(i);
    const prepTimeHtml=isSlotBased&&i.prepTime&&i.prepTime!=='00:00:00'
        ?`<div class="item-preptime"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" fill="none">
<g clip-path="url(#clip0_1395_19376)">
<path fill-rule="evenodd" clip-rule="evenodd" d="M3.56841 0.667914C3.66469 0.814269 3.61786 1.00707 3.4638 1.09854L1.7094 2.1402C1.55534 2.23168 1.3524 2.18718 1.25611 2.04083C1.15983 1.89447 1.20666 1.70168 1.36072 1.6102L3.11512 0.568538C3.26918 0.477066 3.47212 0.521559 3.56841 0.667914ZM6.95787 0.667913C7.05416 0.521558 7.2571 0.477066 7.41116 0.568538L9.16554 1.61021C9.3196 1.70168 9.36644 1.89447 9.27015 2.04083C9.17386 2.18718 8.97092 2.23168 8.81686 2.1402L7.06247 1.09854C6.90842 1.00707 6.86158 0.814268 6.95787 0.667913ZM5.26313 1.97937C3.26473 1.97937 1.64471 3.51839 1.64471 5.41687C1.64471 7.31535 3.26473 8.85437 5.26313 8.85437C7.26153 8.85437 8.88155 7.31535 8.88155 5.41687C8.88155 3.51839 7.26153 1.97937 5.26313 1.97937ZM0.986816 5.41687C0.986816 3.17321 2.90139 1.35437 5.26313 1.35437C7.62488 1.35437 9.53945 3.17321 9.53945 5.41687C9.53945 7.66053 7.62488 9.47937 5.26313 9.47937C2.90139 9.47937 0.986816 7.66053 0.986816 5.41687ZM5.26313 3.4377C5.4448 3.4377 5.59208 3.57762 5.59208 3.7502V5.28743L6.59222 6.23757C6.72069 6.35961 6.72069 6.55747 6.59222 6.67951C6.46376 6.80155 6.25548 6.80155 6.12702 6.67951L5.03053 5.63784C4.96884 5.57924 4.93418 5.49975 4.93418 5.41687V3.7502C4.93418 3.57762 5.08146 3.4377 5.26313 3.4377Z" fill="#212121"/>
</g>
<defs>
<clipPath id="clip0_1395_19376">
<rect width="10" height="10" fill="white"/>
</clipPath>
</defs>
</svg> Preparation time : <b>${Math.round(toPrepH(i.prepTime))} hrs</b></div>`
        :'';
    const pop=i.hasSubs||i.hasTmpl||i.isBogo;
    // Whole card opens the modal in every state (closed / oos / slot-unavailable),
    // matching the search overlay. The add-control still reflects availability.
    const clickCls=' card-add clickable';
    const unavailCls=i.oos?' unavailable':'';
    const comboCls=i.isCombo?' item--combo':'';
    // Combo cards: cream-tinted card with a "Create Combo" CTA overlaid on the image
    // (replaces the standard ADD+ button while the combo is not yet in the cart).
    // Once in the cart it falls through to the normal stepper, whose + routes to the
    // combo popup (data-d="pop"). Layout matches the regular .item card so
    // width/click-area logic stays identical.
    const mediaInner=i.isCombo&&!inC&&isOpen&&!i.oos&&(!isSlotBased||slotOk)
        ?`<button class="item-create-combo" type="button">Create Combo</button>`
        :(i.oos?'<span class="oos-pill">Out of Stock</span>':addCtrlHTML(i,inC,totalQty,lastLineId));
    return `<div class="item${comboCls}${clickCls}${unavailCls}" id="item-${i.id}" data-id="${i.id}" data-nm="${esc(i.name)}" data-pr="${i.sp}" data-pop="${pop?1:0}" data-veg="${i.veg}">
  <div class="item-body">
    ${tagRowHTML(i)}
    ${trendTagHTML(i)}
    <div class="item-head"><div class="item-name">${esc(i.name)}</div></div>
    ${secondaryTagsHTML(i)}
    ${prepTimeHtml}
    ${priceLineHTML(i)}
    ${starsRowHTML(i.rat)}
    ${descHTML(i)}
    ${itemExtrasHtml(i)}
  </div>
  <div class="item-media">
    <div class="item-img">
      ${img?`<img src="${img}" alt="${esc(i.name)}" loading="lazy">`:''}
      ${img&&hasMultiImg(i)?MULTI_IMG_BADGE:''}
    </div>
    ${mediaInner}
    ${customisableLabelHTML(i)}
  </div>
  ${nextAvailableHTML()}
  ${unlockStripHTML(i)}
  ${earnStripHTML(i)}
</div>`;
}

// Larger horizontal card for the server-driven "Your Favourites" rail
// (most-ordered items). Wider image + full price line + ADD/stepper on right.
function favRowLg(i){
    const img=i.image?cardImgUrl(i.image):'';
    const lines=cartLinesFor(i);
    const totalQty=lines.reduce((s,x)=>s+x.qty,0);
    const inC=totalQty>0;
    const lastLineId=inC?lines[lines.length-1].id:i.id;
    const pop=i.hasSubs||i.hasTmpl||i.isBogo;
    const clickCls=' card-add clickable';
    const unavailCls=i.oos?' unavailable':'';
    return `<div class="fav-lg${clickCls}${unavailCls}" data-id="${i.id}" data-nm="${esc(i.name)}" data-pr="${i.sp}" data-pop="${pop?1:0}" data-veg="${i.veg}">
  <div class="fav-lg__img">${cardImgTag(i)}${img&&hasMultiImg(i)?MULTI_IMG_BADGE:''}</div>
  <div class="fav-lg__body">
    ${tagRowHTML(i,{skipOffer:true})}
    <div class="fav-lg__name">${esc(i.name)}</div>
    ${secondaryTagsHTML(i)}
    ${isCustomisable(i)?'<div class="fav-lg__custom">Customisable</div>':''}
    <div class="fav-lg__foot">
      ${priceLineHTML(i)}
      ${addCtrlHTML(i,inC,totalQty,lastLineId)}
    </div>
  </div>
  ${unlockStripHTML(i)}
  ${earnStripHTML(i)}
</div>`;
}

// Compact horizontal card used inside the "Your Favourites" rail.
function favRow(i){
    const img=i.image?cardImgUrl(i.image):'';
    const lines=cartLinesFor(i);
    const totalQty=lines.reduce((s,x)=>s+x.qty,0);
    const inC=totalQty>0;
    const lastLineId=inC?lines[lines.length-1].id:i.id;
    const pop=i.hasSubs||i.hasTmpl||i.isBogo;
    const clickCls=' card-add clickable';
    const unavailCls=i.oos?' unavailable':'';
    return `<div class="fav-row${clickCls}${unavailCls}" data-id="${i.id}" data-nm="${esc(i.name)}" data-pr="${i.sp}" data-pop="${pop?1:0}" data-veg="${i.veg}">
  <div class="fav-row__img">
    ${cardImgTag(i)}
    ${img&&hasMultiImg(i)?MULTI_IMG_BADGE:''}
  </div>
  <div class="fav-row__body">
    <div class="fav-row__head">${vegMarkHTML(i)}<div class="fav-row__name">${esc(i.name)}</div></div>
    ${isCustomisable(i)?'<div class="fav-row__custom">Customisable</div>':''}
    ${priceLineHTML(i)}
  </div>
  <div class="fav-row__action">${addCtrlHTML(i,inC,totalQty,lastLineId)}</div>
  ${unlockStripHTML(i)}
  ${earnStripHTML(i)}
</div>`;
}

// ── Variant popup ──
async function openPopup(item){
    ge('variantModal')?.remove();
    const img=item.image?`${CDN}/${pId}/${item.image}`:'';
    // Analytics: item detail opened (this compact menu's popup is the item-detail view).
    const _aItem={id:item.id,name:item.name,price:+item.sp||0,qty:1,veg:item.veg,image:img};
    trackProductViewed({value:+item.sp||0,items:[_aItem],item:_aItem});
    // CI3 parity (order_detail_new): sort variants cheapest-first and open on the
    // first one, so the modal's pre-selected price matches the card — which quotes
    // the lowest variant (Math.min in mk()). Without the sort, feed order wins and
    // the modal can open on a pricier variant than the card advertised.
    const vs=(item.subs||[]).slice().sort((a,b)=>(+a.sp||0)-(+b.sp||0));
    // CI3 parity (order_detail_new:3653-3667): an option is unorderable when the feed
    // flags EITHER out_of_stock=1 or status=-1. Both matter — Thank U's 1kg Red Velvet
    // carries both, and checking out_of_stock alone let it render as a normal option.
    const oosOpt=x=>+x?.out_of_stock===1||+x?.status===-1;
    const firstAvailVar=vs.findIndex(v=>!oosOpt(v));
    const allVarOos=vs.length>0&&firstAvailVar===-1;
    // The item itself can be flagged out of stock independently of its options.
    // allVarOos only covers "every variant is gone", so an item with add-ons but
    // no variants (vs.length===0) fell through it and kept a live Add to Cart.
    const itemOos=!!item.oos||allVarOos;

    // Show the shell immediately so the user gets instant feedback on click.
    // Template-items API can take >500ms; render a spinner overlay meanwhile.
    const shell=document.createElement('div');shell.id='variantModal';
    shell.innerHTML=`<div class="popup-overlay"><div class="popup-sheet popup-sheet--customise" style="position:relative;min-height:240px">
        ${img?`<img src="${img}" alt="" class="popup-hero-img">`:''}
        <div class="p-3"><h6 class="fw-bold mb-1" style="flex:1">${esc(item.name)}</h6></div>
        <div class="popup-loading" aria-label="Loading options"></div>
    </div></div>`;
    document.body.appendChild(shell);
    shell.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)shell.remove()};

    // Templates: hydrate from the in-memory pool (templateList) built from rows.templates.
    // Mirrors CI3's main_temp filter — no per-click HTTP call. Each per-item entry in
    // tmpls / variant.templates carries the min/max constraints; the pool supplies the items.
    const tCache=new Map();
    function loadTemplates(variant){
        const key=variant?`v${variant.id}`:'item';
        if(tCache.has(key))return tCache.get(key);
        const perItem=variant?.templates||item.tmpls||[];
        const tmplIdStr=variant?.templateId||item.tmplIds||'';
        const ids=tmplIdStr?String(tmplIdStr).split(',').map(s=>s.trim()).filter(Boolean):perItem.map(t=>t.templateId).filter(Boolean);
        const result=ids.map(tid=>{
            const pool=templateList.find(t=>String(t.templateId)===String(tid));
            if(!pool)return null;
            const meta=perItem.find(t=>String(t.templateId)===String(tid))||{};
            return {...pool,minQty:meta.minQty??0,maxQty:meta.maxQty??0,headerName:pool.headerName||pool.template?.[0]?.sectionName||'Add-on',items:pool.template||pool.items||[]};
        }).filter(Boolean);
        tCache.set(key,result);
        return result;
    }

    // Initial active variant = first IN-STOCK one (CI3 firstAvailableIndex). Falls back
    // to 0 when every option is out of stock so price/templates still resolve — CI3 does
    // the same and instead leaves the radio unchecked and the add button disabled.
    let activeIdx=vs.length>0?(firstAvailVar!==-1?firstAvailVar:0):-1;
    let ts=loadTemplates(vs[activeIdx]||null);

    // If the user already closed the shell while we were fetching, bail
    if(!document.body.contains(shell))return;
    shell.remove();
    // Stale templateId at item level (only when no variants)
    if(item.hasTmpl&&ts.length===0&&vs.length===0){
        item.hasTmpl=false;item.tmplIds='';item.tmpls=[];
        const pop=item.hasSubs||item.isBogo;
        const ce=document.getElementById('item-'+item.id);
        if(ce){ce.querySelector('.customisable-label')?.remove();ce.dataset.pop=pop?'1':'0';}
    }
    // viewType=2 → step-based combo wizard (CI3 open_combo)
    if(item.viewType===2&&ts.length>0){buildComboPopup(item,ts);return;}
    // viewType=3 → BOGO wizard (CI3 open_wizard)
    if(item.isBogo&&item.wizardSteps?.length>0){buildBogoPopup(item);return;}
    // Plain item (no variants, no templates, not BOGO) → simple detail popup
    if(vs.length===0&&ts.length===0&&!item.isBogo){buildSimplePopup(item);return;}

    // Build addon sections HTML for a given templates array
    function buildAddonsHtml(currentTs){
        if(!currentTs?.length)return '';
        let html='';
        for(const t of currentTs){
            // Sort items by price ascending (matches CI3 variant sort behavior)
            const ti=(t.items||t.templateItems||[]).slice().sort((a,b)=>(+a.sp||0)-(+b.sp||0));
            if(!ti.length)continue;
            const hdr=t.headerName||t.templateName||'Add-on';
            const minQ=+t.minQty||0,maxQ=+t.maxQty||0;
            const single=(minQ===1&&maxQ===1);
            const inputType=single?'radio':'checkbox';
            const tid=t.templateId||t.id||hdr;
            let qDesc='';
            if(minQ&&maxQ&&minQ===maxQ)qDesc=`Please select any ${maxQ} option${maxQ>1?'s':''}`;
            else if(!minQ&&maxQ)qDesc=`You can choose up to ${maxQ} option${maxQ>1?'s':''}`;
            else if(minQ&&maxQ)qDesc=`Select a minimum of ${minQ} and a maximum of ${maxQ}`;
            else if(minQ&&!maxQ)qDesc=`Select a minimum of ${minQ}`;
            const firstAvail=single?ti.findIndex(x=>!oosOpt(x)):-1;
            const isRequired=minQ>0;
            html+=`<section class="popup-section" data-tid="${esc(String(tid))}" data-min="${minQ}" data-max="${maxQ}">
                <div class="popup-section-head">
                    <h4 class="popup-section__title">${esc(hdr)} <span class="popup-section__badge popup-section__badge--${isRequired?'required':'optional'}">${isRequired?'REQUIRED':'OPTIONAL'}</span></h4>
                    ${qDesc?`<p class="popup-section__hint">${qDesc}</p>`:''}
                </div>
                <div class="popup-section-error" hidden></div>
                <div class="popup-addons">${ti.map((x,idx)=>{
                    // status=-1 counts as out of stock here too, the way the combo and
                    // BOGO wizards already read it. CI3's getTopping checks neither flag,
                    // so this is deliberately stricter than the CI3 add-on path.
                    const oos=oosOpt(x);
                    const sp=+x.sp||0;
                    const checked=(single&&idx===firstAvail)?' checked':'';
                    // Thumbnail decided per row, not per section: an item with no
                    // image collapses back to the plain 3-column row rather than
                    // holding open an empty cell beside its illustrated neighbours.
                    const thumb=addonThumbHTML(x);
                    // The diet marker is optional — vegDotHTML returns '' for a blank
                    // or unrecognised flag. Without a matching class the row keeps a
                    // column track it no longer fills, and every remaining child slides
                    // one track left: the 44px thumb lands in the 14px marker track and
                    // the body in the 44px thumb track, which is what made add-on names
                    // wrap one character per line. Flag its absence so the CSS can drop
                    // the track, the same way --media is only set when a thumb exists.
                    const dot=vegDotHTML(x.vegNonvegBoth);
                    return`<label class="popup-addon${thumb?' popup-addon--media':''}${dot?'':' popup-addon--nodot'}${oos?' off':''}${checked?' on':''}">
                        ${dot}
                        ${thumb}
                        <span class="popup-addon__body">
                            <span class="popup-addon__name">${esc(x.itemName||'')}</span>
                            <span class="popup-addon__price">${oos?'Out of stock':`+₹${sp.toFixed(0)}`}</span>
                        </span>
                        <input type="${inputType}" name="addon-${esc(String(tid))}" class="tc" data-pr="${sp}" data-id="${x.id}" data-nm="${esc(x.itemName||'')}" data-veg="${esc(normVeg(x.vegNonvegBoth))}"${oos?' disabled':''}${checked}>
                    </label>`;
                }).join('')}</div>
            </section>`;
        }
        return html;
    }

    // Variants section (static — built once)
    let variantsHtml='';
    if(vs.length){
        variantsHtml=`<section class="popup-section">
            <div class="popup-section-head">
                <h4 class="popup-section__title">Select an option <span class="popup-section__badge popup-section__badge--required">REQUIRED</span></h4>
                <p class="popup-section__hint">Select 1 option</p>
            </div>
            <div class="popup-variants">${vs.map((v,i)=>{
                const s=+v.sp||0,m=+v.mrp||0;
                // CI3 marks the row disabled, drops its click handler and appends an
                // "Out of Stock" caption beside the (still visible) price.
                const oos=oosOpt(v);
                const sel=i===activeIdx&&!oos;
                // Use short labels only — v.description contains the full
                // nutritional/marketing copy which would blow out the card.
                const sub=v.subtitle||v.serves||'';
                // Member-only: show this variant's slashed price (math on the variant,
                // bucket-matched on the parent). No savings caption — parent card carries it.
                const vd=memberPricing?getMembershipDiscountForVariant(item,v,memberPricing):null;
                const priceHtml=(vd&&vd.mode==='member')
                    ?`<s>₹${fmtP(vd.mrp)}</s> <b class="popup-variant__member">₹${fmtMP(vd.memberPrice)}</b>`
                    :(s<=0&&m<=0?'':`${m>s&&s?`<s>₹${m}</s> `:''}₹${s}`);
                return`<label class="popup-variant${sel?' on':''}${oos?' off':''}">
                    <span class="popup-variant__info">
                        <span class="popup-variant__name">${esc(v.itemName||v.variantName||'Option '+(i+1))}</span>
                        ${sub?`<span class="popup-variant__sub">${esc(sub)}</span>`:''}
                        <span class="popup-variant__price">${priceHtml}</span>
                        ${oos?'<span class="popup-variant__oos">Out of stock</span>':''}
                    </span>
                    <input type="radio" name="vr" value="${v.id}" data-pr="${s}" data-idx="${i}" data-veg="${esc(normVeg(v.vegNonvegBoth||v.veg||item.veg))}"${oos?' disabled':''}${sel?' checked':''}>
                </label>`;
            }).join('')}</div>
        </section>`;
    }
    let optionsHtml=variantsHtml+`<div id="addonsContainer">${buildAddonsHtml(ts)}</div>`;

    const shareBtn=`<button class="popup-share" id="popShare" type="button" aria-label="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>`;
    const stars=item.rat>0?starsRowHTML(item.rat):'';
    const initialPrice=vs.length>0?(+vs[activeIdx]?.sp||item.sp):item.sp;

    const el=document.createElement('div');el.id='variantModal';
    const stickyShareBtn=`<button class="popup-sticky__act" id="popShareSticky" type="button" aria-label="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>`;
    el.innerHTML=`<div class="popup-overlay">
    <div class="popup-sheet popup-sheet--customise">
        <div class="popup-actions">${shareBtn}<button class="popup-close" id="popClose" type="button" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
        <div class="popup-grid">
            <div class="popup-sticky-head" id="popStickyHead" aria-hidden="true">
                <span class="popup-sticky__thumb">${img?`<img src="${img}" alt="" loading="lazy">`:''}</span>
                <span class="popup-sticky__name">${vegMarkHTML(item)}<span>${esc(item.name)}</span></span>
                <span class="popup-sticky__acts">
                    ${stickyShareBtn}
                    <button class="popup-sticky__act" id="popCloseSticky" type="button" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                </span>
            </div>
            <div class="popup-left">
                <div class="popup-hero">${galleryHTML(item)}</div>
                <div class="popup-meta">
                    ${extrasTabsHTML(item,`<div class="popup-detail-tagrow">${tagRowHTML(item)}</div>`
                        +trendTagHTML(item)
                        +stars
                        +`<h2 class="popup-name">${esc(item.name)}</h2>`
                        +secondaryTagsHTML(item)
                        +priceLineHTML(item,{fromPrefix:true})
                        +unlockStripHTML(item),vs[activeIdx]||null)}
                </div>
                <div class="popup-footer">
                    ${earnStripHTML(item)}
                    ${(isSlotBased&&!slotAvailable(item))
                        ?`<button class="popup-cta popup-cta--slot" id="popSlot" type="button"><span class="popup-cta__label">Select Next Slot</span></button>`
                        :!isOpen
                        ?`<div class="popup-cta-disabled"><span class="popup-cta__label">${esc(closedLabel())}</span></div>`
                        :itemOos
                        ?`<div class="popup-cta-disabled"><span class="popup-cta__label">Out of stock</span></div>`
                        :`<button class="popup-cta" id="popAdd" type="button">
                        <span class="popup-cta__price">₹<span id="popPr">${initialPrice.toFixed(2)}</span></span>
                        <span class="popup-cta__label">Add to Cart</span>
                    </button>`}
                </div>
            </div>
            <div class="popup-right">
                ${optionsHtml}
            </div>
        </div>
    </div>
</div>`;
    document.body.appendChild(el);
    initGallery(el);
    bindPopupExtras(el,item);
    const closeModal = () => { el.remove(); };
    ge('popClose').onclick = closeModal;
    ge('popCloseSticky')?.addEventListener('click', closeModal);
    ge('popShareSticky')?.addEventListener('click', () => ge('popShare')?.click());
    // Sticky condensed header — shows once the hero scrolls past the top
    const heroEl = el.querySelector('.popup-hero');
    const stickyEl = ge('popStickyHead');
    if (heroEl && stickyEl && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            entries.forEach(e => stickyEl.classList.toggle('show', !e.isIntersecting));
        }, { root: el.querySelector('.popup-grid'), threshold: 0, rootMargin: '0px' });
        io.observe(heroEl);
    }
    // Variant + addon change handler — recomputes total, paints active variant
    const up=()=>{
        let p=0;
        const rd=el.querySelector('input[name="vr"]:checked');
        p=rd?+rd.dataset.pr:item.sp;
        el.querySelectorAll('.tc:checked').forEach(c=>p+=+c.dataset.pr||0);
        // No #popPr when the CTA is the disabled variant (closed / out of stock /
        // slot-unavailable) — the addon rows are still clickable, so don't throw.
        const pr=ge('popPr');if(pr)pr.textContent=p.toFixed(2);
        // Visual highlight of the selected variant
        el.querySelectorAll('.popup-variant').forEach(l=>{
            const inp=l.querySelector('input[type="radio"]');
            l.classList.toggle('on',!!inp?.checked);
        });
        el.querySelectorAll('.popup-addon').forEach(l=>{
            const inp=l.querySelector('input.tc');
            l.classList.toggle('on',!!inp?.checked);
        });
    };
    // Enforce maxQty: once the limit is reached, lock the remaining unchecked
    // options (disabled = no hover effect + tooltip via .maxed). To switch a
    // pick, the user unchecks the current one, which re-opens the slot.
    const enforceCaps=()=>{
        el.querySelectorAll('.popup-section[data-tid]').forEach(sec=>{
            const maxQ=+sec.dataset.max||0;
            if(maxQ<=0)return;
            const boxes=sec.querySelectorAll('input.tc[type="checkbox"]');
            if(!boxes.length)return; // radios are single-pick — no cap needed
            const maxed=sec.querySelectorAll('.tc:checked').length>=maxQ;
            boxes.forEach(b=>{
                const lab=b.closest('.popup-addon');
                if(lab&&lab.classList.contains('off'))return; // out-of-stock stays disabled
                const lock=maxed&&!b.checked;
                b.disabled=lock;
                if(lab)lab.classList.toggle('maxed',lock);
            });
        });
    };
    el.addEventListener('change',e=>{
        const inp=e.target;
        if(!inp.classList.contains('tc'))return;
        const sec=inp.closest('.popup-section[data-tid]');
        if(!sec)return;
        enforceCaps();
        // Clear min error once they start selecting
        const err=sec.querySelector('.popup-section-error');
        if(err&&sec.querySelectorAll('.tc:checked').length>0)err.hidden=true;
    });
    // Tapping a locked (maxed-out) option shows a toast explaining why it can't
    // be picked — the disabled input swallows change events, so we catch the
    // click on the label (CI3 parity: "Cannot add more items in this section").
    el.addEventListener('click',e=>{
        // Out-of-stock (.off) and maxed-out (.maxed) options both swallow change
        // events (disabled input), so we catch the label click to surface why.
        const oosLab=e.target.closest('.popup-addon.off');
        const maxLab=e.target.closest('.popup-addon.maxed');
        if(!oosLab&&!maxLab)return;
        // Scope the toast to the modal so it sits over the options (the global
        // bottom-pinned toast lands at the viewport edge, reading as "below").
        el.querySelector('.popup-toast')?.remove();
        const t=document.createElement('div');
        t.className='popup-toast';
        t.textContent=oosLab?'This item is out of stock':'Cannot add more items in this section';
        el.querySelector('.popup-sheet')?.appendChild(t);
        clearTimeout(el._toast);
        el._toast=setTimeout(()=>t.remove(),2000);
    });
    // Wire change → up() on every input, idempotent
    const wireInputs=()=>{
        el.querySelectorAll('input').forEach(i=>{
            if(i.dataset.bound)return;
            i.dataset.bound='1';
            i.addEventListener('change',up);
        });
    };
    wireInputs();
    enforceCaps();

    // Variant change: reload only addons for the newly selected variant
    function onVariantChange(idx){
        if(idx===activeIdx)return;
        activeIdx=idx;
        // Nutrition/allergens are per variant — repaint the tab for the new option.
        const nutEl=el.querySelector('.js-nutrition');
        if(nutEl)nutEl.innerHTML=nutritionPanelHTML(item,vs[idx]||null);
        const container=el.querySelector('#addonsContainer');
        if(!container)return;
        container.innerHTML=buildAddonsHtml(loadTemplates(vs[idx]));
        wireInputs();
        enforceCaps();
        up();
    }
    el.querySelectorAll('input[name="vr"]').forEach(inp=>{
        inp.addEventListener('change',()=>{if(inp.checked)onVariantChange(+inp.dataset.idx)});
    });

    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)el.remove()};
    ge('popShare')?.addEventListener('click',()=>shareItem(item));
    ge('popSlot')?.addEventListener('click',()=>{el.remove();showSlotModal()});
    const _popAdd=ge('popAdd');
    if(_popAdd)_popAdd.onclick=()=>{
        // Validate min/max per template section before adding to cart
        const sections=el.querySelectorAll('.popup-section[data-tid]');
        let firstInvalid=null;
        for(const sec of sections){
            const minQ=+sec.dataset.min||0,maxQ=+sec.dataset.max||0;
            const cnt=sec.querySelectorAll('.tc:checked').length;
            const err=sec.querySelector('.popup-section-error');
            let msg='';
            if(minQ>0&&cnt<minQ)msg=`Please select at least ${minQ} option${minQ>1?'s':''}`;
            else if(maxQ>0&&cnt>maxQ)msg=`Please select up to ${maxQ} option${maxQ>1?'s':''}`;
            if(msg){if(err){err.textContent=msg;err.hidden=false}if(!firstInvalid)firstInvalid=sec;}
            else if(err)err.hidden=true;
        }
        if(firstInvalid){firstInvalid.scrollIntoView({behavior:'smooth',block:'center'});return;}
        const rd=el.querySelector('input[name="vr"]:checked');
        let p=rd?+rd.dataset.pr:item.sp;
        const subItems=[];
        if(rd){
            const vName=rd.closest('.popup-variant')?.querySelector('.popup-variant__name')?.textContent?.trim()||'';
            subItems.push({itemId:String(rd.value),itemName:vName,sp:+rd.dataset.pr||0,qty:1,type:1,veg:normVeg(rd.dataset.veg||item.veg)});
        }
        el.querySelectorAll('.tc:checked').forEach(c=>{
            const aPr=+c.dataset.pr||0;
            p+=aPr;
            subItems.push({itemId:String(c.dataset.id||''),itemName:c.dataset.nm||'',sp:aPr,qty:1,type:2,veg:normVeg(c.dataset.veg)});
        });
        addToCart(rd?rd.value:item.id,item.name,p,item.id,item.veg,subItems);
        el.remove();
    };
}

// Small tag pills rendered directly on the item card; clicking opens the item
// modal and focuses the matching tab in the inline "More Details" block.
function itemExtrasHtml(i){
    const hasNut=hasNutrition(i);
    // Guard at render time too: feed sometimes sends "null"/"undefined" as content,
    // so re-run cleanStr here (not just in mk()) to keep the tag hidden when empty.
    const hasCook=!!cleanStr(i.content);
    if(!hasNut&&!hasCook)return'';
    const id=esc(String(i.id));
    let html='<div class="item-extras">';
    if(hasNut) html+=`<button class="item-extras__tag js-extras-btn" type="button" data-kind="nutrition" data-id="${id}">${EXTRAS_ICONS.nutrition}<span>Nutrition info</span></button>`;
    if(hasCook) html+=`<button class="item-extras__tag js-extras-btn" type="button" data-kind="content" data-id="${id}">${EXTRAS_ICONS.content}<span>How to Cook?</span></button>`;
    html+='</div>';
    return html;
}

// Icons shared by the card tags and the in-modal tabs (sized via CSS per context)
const EXTRAS_ICONS={
    desc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`,
    nutrition:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12.01" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>`,
    content:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c0 6-8 8-8 14a8 8 0 0 0 16 0c0-6-4-8-4-10-2 3-3 5-4 10-1-2-2-4-2-6 0 5-2 7-2 10"/></svg>`
};

// ── Nutrition / allergens ──
// The feed hangs the nutrition table off the parent item OR off each variant row —
// variant-priced items (a cake in three sizes) carry their own calories and
// allergens per size, and then the parent's own `nutrition` is an empty array.
// Reading only the parent is why allergens went missing on those items.
function nutritionOf(r){return Array.isArray(r&&r.nutrition)?r.nutrition:[]}
// Rows for the option the customer currently has selected; the parent's own table
// is the fallback when that variant carries none of its own.
function resolveNutrition(item,variant){const v=nutritionOf(variant);return v.length?v:nutritionOf(item)}
// Is there a nutrition table anywhere on this item? Gates the card tag and the
// modal tab — the panel itself resolves per selected variant.
function hasNutrition(item){return nutritionOf(item).length>0||(item.subs||[]).some(v=>nutritionOf(v).length>0)}

// One label/value line. `sub` is the entry name inside a grouped category
// ("Allergens" → "Wheat (Gluten)"), `note` the free-text remark beside the value.
function nutritionRowHTML(label,sub,val,note){
    return`<div class="popup-nutrition__row">`
        +`<span class="popup-nutrition__label">${esc(label||'')}${sub?`<small class="popup-nutrition__sub">${esc(sub)}</small>`:''}</span>`
        +`<span class="popup-nutrition__val">${esc(val||'')}${note?`<small class="popup-nutrition__note">${esc(note)}</small>`:''}</span>`
    +`</div>`;
}

// Mirrors CI3's nutrition table (common.php getNutritionArray + the grocery
// renderer). display_flag decides which fields hold the value:
//   1 → amount + unit   2 → info + remarks (allergens)   3 → value
// Each row is either flat, or grouped under `values[]` when the source rows share
// a category_name — then the row's own label is the category and each entry's
// label is the sub-label. The old renderer only understood flat flag-1 rows, so
// grouped allergens rendered with a blank value.
function nutritionRowsHTML(rows){
    return (rows||[]).map(n=>{
        const df=String(n.display_flag??'1');
        const vals=Array.isArray(n.values)?n.values:[];
        if(df==='3')return nutritionRowHTML(n.label,'',String(n.value??''),'');
        if(df==='2'){
            return vals.length
                ?vals.map(v=>nutritionRowHTML(n.label,v.label,v.info,v.remarks)).join('')
                :nutritionRowHTML(n.label,'',n.info,n.remarks);
        }
        const amt=v=>`${v.amount??''} ${v.unit??''}`.trim();
        return vals.length
            ?vals.map(v=>nutritionRowHTML(n.label,v.label,amt(v),'')).join('')
            :nutritionRowHTML(n.label,'',amt(n),'');
    }).join('');
}

// Panel body for the Nutrition tab. When the tab exists because *another* variant
// has a table, say so rather than showing a neighbouring size's figures.
function nutritionPanelHTML(item,variant){
    const rows=resolveNutrition(item,variant);
    return rows.length
        ?nutritionRowsHTML(rows)
        :`<p class="popup-nutrition__empty">Not available for this option.</p>`;
}

// Modal description: truncates long text with a "Read more" reveal — same
// expand/collapse idea AND same look as the card's .item-desc (CI3
// expand_description/collapse_description parity; .popup-readmore is styled
// identically to .read-more/.read-less in location_modal.css), just sized
// for the wider modal body (~2 lines at .popup-desc's 13px/1.5 line-height
// vs. the card's 65-char/2-line clamp). A dedicated class (rather than
// reusing .read-more/.read-less outright) keeps this out of the card's
// global document-level delegated handler, which looks up items by
// data-readmore id in allItems — not applicable here. Toggle wiring lives
// in bindPopupExtras().
const POPUP_DESC_LIMIT=120;
function popupDescHTML(desc){
    if(!desc)return'';
    if(desc.length<=POPUP_DESC_LIMIT)return`<p class="popup-desc">${esc(desc)}</p>`;
    const short=desc.slice(0,POPUP_DESC_LIMIT).replace(/[\s.,;:]+$/,'');
    return`<p class="popup-desc">${esc(short)}… <button class="popup-readmore" type="button" data-expand="1">Read more</button></p>`;
}

// Inline tabbed "More Details" block, embedded inside the item detail modal.
// One tab per available section (Nutrition info / How to Cook?). Returns '' when neither exists.
// Unified detail tabs: Description (always first when present) + Nutrition info +
// How to Cook?. Opening the modal directly lands on Description (first tab); the
// card "Nutrition info"/"How to Cook?" tags pre-select their tab post-build (see
// the .js-extras-btn handler). The standalone description paragraph is folded in
// here, so the popup builders no longer render it separately.
//
// `metaHtml` is the item's title block (badges / name / price / stars). The tab bar
// sits at the TOP of the modal body, so the title block rides inside the Description
// panel — it shows with the description on the first tab. With no Description tab
// there's nothing to pair it with, so it stays above the tab bar instead.
//
// `variant` is the initially selected variant, if any — the Nutrition panel shows
// that option's own table and is repainted by openPopup when the selection changes.
function extrasTabsHTML(item,metaHtml='',variant=null){
    const tabs=[];
    const descRaw=item.desc||'';
    const meta=metaHtml?`<div class="popup-metabox">${metaHtml}</div>`:'';
    if(descRaw) tabs.push({kind:'desc',label:'Description',ico:EXTRAS_ICONS.desc,body:`${meta}${popupDescHTML(descRaw)}`});
    if(hasNutrition(item)) tabs.push({kind:'nutrition',label:'Nutrition info',ico:EXTRAS_ICONS.nutrition,body:`<div class="popup-nutrition js-nutrition">${nutritionPanelHTML(item,variant)}</div>`});
    const cook=cleanStr(item.content); // hide the tab when content is empty / "null" / "undefined"
    if(cook) tabs.push({kind:'content',label:'How to Cook?',ico:EXTRAS_ICONS.content,body:`<div class="popup-content">${cook}</div>`});
    if(!tabs.length)return metaHtml;
    // Description alone needs no tab chrome — render it as a plain paragraph.
    if(tabs.length===1&&tabs[0].kind==='desc')return`${metaHtml}${popupDescHTML(descRaw)}`;
    const active=tabs[0].kind;
    const lead=descRaw?'':metaHtml; // no Description tab → title block stays above the tabs
    const tabBar=`<div class="extras-tabs" role="tablist">${tabs.map(t=>
        `<button class="extras-tab${t.kind===active?' on':''}" type="button" role="tab" data-tab="${t.kind}" aria-selected="${t.kind===active}">${t.ico}<span>${esc(t.label)}</span></button>`).join('')}</div>`;
    const panels=tabs.map(t=>`<div class="extras-panel${t.kind===active?' on':''}" data-panel="${t.kind}" role="tabpanel">${t.body}</div>`).join('');
    return`${lead}<div class="popup-extras js-popup-extras${lead?' popup-extras--after-meta':''}">${tabBar}<div class="popup-extras__body">${panels}</div></div>`;
}

// Wire tab switching + the description "Read more"/"Read less" toggle for the
// inline extras block inside an open modal. `item` is only needed for the
// description toggle (the full, untruncated text lives in JS, not the DOM —
// avoids escaping raw text into a data-* attribute).
function bindPopupExtras(el,item){
    const wrap=el.querySelector('.js-popup-extras');
    if(wrap){
        wrap.querySelectorAll('.extras-tab[data-tab]').forEach(btn=>{
            btn.onclick=()=>{
                const k=btn.dataset.tab;
                wrap.querySelectorAll('.extras-tab[data-tab]').forEach(b=>{const on=b.dataset.tab===k;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false');});
                wrap.querySelectorAll('.extras-panel').forEach(p=>p.classList.toggle('on',p.dataset.panel===k));
            };
        });
    }
    const descEl=el.querySelector('.popup-desc');
    const full=item?.desc||'';
    if(!descEl||full.length<=POPUP_DESC_LIMIT)return;
    const short=full.slice(0,POPUP_DESC_LIMIT).replace(/[\s.,;:]+$/,'');
    el.addEventListener('click',e=>{
        const btn=e.target.closest('.popup-readmore');
        if(!btn)return;
        if(btn.dataset.expand==='1'){
            descEl.classList.add('popup-desc--expanded');
            descEl.innerHTML=`${esc(full)} <button class="popup-readmore" type="button" data-expand="0">Read less</button>`;
        }else{
            descEl.classList.remove('popup-desc--expanded');
            descEl.innerHTML=`${esc(short)}… <button class="popup-readmore" type="button" data-expand="1">Read more</button>`;
        }
    });
}

// ── Simple item detail popup (plain items only — no variants, no templates, not BOGO) ──
function buildSimplePopup(item){
    const img=item.image?`${CDN}/${pId}/${item.image}`:'';
    const stars=item.rat>0?starsRowHTML(item.rat):'';
    const shareBtn=`<button class="popup-share" id="popShare" type="button" aria-label="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>`;
    const el=document.createElement('div');el.id='variantModal';
    el.innerHTML=`<div class="popup-overlay"><div class="popup-sheet popup-detail">
        <div class="popup-actions">${shareBtn}<button class="popup-close" id="popClose" type="button" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
        <div class="popup-detail-img">${galleryHTML(item)}</div>
        <div class="popup-detail-body">
            ${extrasTabsHTML(item,`<div class="popup-detail-tagrow">${tagRowHTML(item)}</div>`
                +trendTagHTML(item)
                +`<h2 class="popup-name">${esc(item.name)}</h2>`
                +secondaryTagsHTML(item)
                +priceLineHTML(item)
                +unlockStripHTML(item)
                +stars)}
        </div>
        <div class="popup-footer">
            ${earnStripHTML(item)}
            ${(isSlotBased&&!slotAvailable(item))
                ?`<button class="popup-cta popup-cta--slot" id="popSlot" type="button"><span class="popup-cta__label">Select Next Slot</span></button>`
                :!isOpen
                ?`<div class="popup-cta-disabled"><span class="popup-cta__label">${esc(closedLabel())}</span></div>`
                :item.oos
                ?`<div class="popup-cta-disabled"><span class="popup-cta__label">Out of stock</span></div>`
                :`<button class="popup-cta" id="popAdd" type="button">
                <span class="popup-cta__price">₹${item.sp.toFixed(2)}</span>
                <span class="popup-cta__label">Add to Cart</span>
            </button>`}
        </div>
    </div></div>`;
    document.body.appendChild(el);
    initGallery(el);
    bindPopupExtras(el,item);
    ge('popClose').onclick=()=>el.remove();
    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)el.remove()};
    ge('popAdd')?.addEventListener('click',()=>{addToCart(item.id,item.name,item.sp,item.id);el.remove()});
    ge('popSlot')?.addEventListener('click',()=>{el.remove();showSlotModal()});
    ge('popShare')?.addEventListener('click',()=>shareItem(item));
}

// ── Combo detail (template items, viewType=2) ──
// Summary-first pattern: all sections visible with pre-selected defaults.
// Tapping "Change" on a section opens a single-section bottom sheet.
// Each step can be single-pick (maxQty=1, radios) or multi-pick (maxQty>1, checkboxes).
// Functionality (per-step minQty/maxQty, addToCart, fixed combo price) matches CI3.
function buildComboPopup(item,ts){
    const img=item.image?`${CDN}/${pId}/${item.image}`:'';
    // Each selections[stepIdx] is an ARRAY of selection objects (length 0..maxQty).
    // Pre-selection: pick max(1, minQty) non-OOS items, capped at maxQty and available.
    const selections=ts.map(t=>{
        const minQ=+t.minQty||0,maxQ=+t.maxQty||1;
        const target=Math.min(Math.max(1,minQ),maxQ);
        const picked=[];
        for(const x of(t.items||[])){
            if(picked.length>=target)break;
            if(+x.out_of_stock===1)continue;
            picked.push({id:String(x.id),name:x.itemName||'',sp:+x.sp||0,image:x.image||'',veg:normVeg(x.vegNonvegBoth)});
        }
        return picked;
    });
    const totalCount=()=>selections.reduce((s,a)=>s+(a?a.length:0),0);
    // Dynamic combo: price = Σ selected component prices. item.sp is only the DEFAULT-selection
    // price and goes stale when a pricier item is picked (incl. when an OOS base item forces the
    // next option), so the footer total + add-to-cart price must recompute from the live picks.
    const comboPrice=()=>selections.reduce((sum,sels)=>sum+(sels||[]).reduce((s,x)=>s+(+x.sp||0),0),0);
    // A step whose every option is out of stock can never be fulfilled, so the whole
    // combo is unorderable — block "Add Combo" (mirror the per-section OOS state below).
    const blockedSteps=ts.filter(t=>{const items=t.items||[];return items.length>0&&items.every(x=>+x.out_of_stock===1);})
        .map(t=>t.headerName||'this section');
    // The combo item itself can also be out of stock, independently of its steps.
    const comboBlocked=blockedSteps.length>0||!!item.oos;
    const el=document.createElement('div');el.id='variantModal';
    el.innerHTML=`<div class="popup-overlay combo-detail-overlay"><div class="combo-detail">
        <div class="combo-detail__hero${img?'':' combo-detail__hero--noimg'}">
            <div class="combo-detail__actions">
                <button class="combo-detail__close" id="comboShare" type="button" aria-label="Share">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                </button>
                <button class="combo-detail__close" id="comboBack" type="button" aria-label="Close">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            ${img?`<div class="combo-detail__hero-img"><img src="${img}" alt="${esc(item.name)}" loading="lazy"></div>`:''}
            <div class="combo-detail__hero-body">
                <div class="combo-detail__head">
                    ${vegDotHTML(item.veg)}
                    <h2 class="combo-detail__name">${esc(item.name)}</h2>
                </div>
                ${item.desc?`<p class="combo-detail__desc">${esc(item.desc)}</p>`:`<p class="combo-detail__desc">${esc(item.name)}</p>`}
                ${priceLineHTML(item)}
            </div>
        </div>
        <div class="combo-detail__body">
            <div class="combo-detail__intro">
                <div class="combo-detail__count" id="comboCount"></div>
                <p class="combo-detail__notice">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    <span>We've pre-selected items for you &mdash; tap <strong>Change</strong> to swap any of them</span>
                </p>
            </div>
            <div class="combo-detail__sections" id="comboSections"></div>
        </div>
        <div class="combo-detail__footer">
            <button class="combo-detail__cta" id="comboAdd" type="button">
                <span class="combo-detail__cta-price">₹<span id="comboTotal">${(+item.sp||0).toFixed(2)}</span></span>
                <span class="combo-detail__cta-label">Add Combo</span>
            </button>
        </div>
    </div></div>`;
    document.body.appendChild(el);
    function renderSections(){
        const root=ge('comboSections');if(!root)return;
        const cnt=ge('comboCount');
        if(cnt){const n=totalCount();cnt.textContent=`Combo includes ${n} Item${n===1?'':'s'}`;}
        const tot=ge('comboTotal');if(tot)tot.textContent=comboPrice().toFixed(2);
        const addBtn=ge('comboAdd');
        if(addBtn){
            // Keep clicks flowing (no native `disabled`) so tapping surfaces the
            // tooltip explaining which section is out of stock.
            addBtn.classList.toggle('combo-detail__cta--blocked',comboBlocked);
            addBtn.setAttribute('aria-disabled',comboBlocked?'true':'false');
        }
        root.innerHTML=ts.map((t,idx)=>{
            const sels=selections[idx]||[];
            const tmplItems=t.items||[];
            const optCount=tmplItems.length;
            // Every option out of stock: nothing is selectable, so hide the count + Change
            // button and show an unavailable message instead of the "Tap Change to pick" prompt.
            const allOos=tmplItems.length>0&&tmplItems.every(x=>+x.out_of_stock===1);
            // Multi-pick (maxQty>1): one row per selected item, each with its own Change button.
            // Single-pick: one row (selected item) OR empty-state if no selection.
            let rowsHtml;
            if(allOos){
                rowsHtml=`<div class="combo-section__row combo-section__row--oos">
                    <div class="combo-section__sel">
                        <div class="combo-section__oos-msg">All items are currently out of stock</div>
                    </div>
                </div>`;
            }else if(sels.length===0){
                rowsHtml=`<div class="combo-section__row">
                    <div class="combo-section__thumb combo-section__thumb--ph"></div>
                    <div class="combo-section__sel">
                        <div class="combo-section__sel-name"><span class="combo-section__sel-text"><em>Tap Change to pick</em></span></div>
                    </div>
                    <button class="combo-section__change" type="button" data-step="${idx}">Change</button>
                </div>`;
            }else{
                rowsHtml=sels.map(s=>{
                    const selImg=s.image?`${CDN}/${pId}/${s.image}`:'';
                    const src=tmplItems.find(x=>String(x.id)===String(s.id));
                    const desc=src&&src.description?String(src.description):'';
                    return`<div class="combo-section__row combo-section__row--selected">
                        ${selImg?`<img src="${selImg}" alt="" class="combo-section__thumb" loading="lazy">`:(bLogo?`<img src="${esc(bLogo)}" alt="" class="combo-section__thumb popup-img-fallback" loading="lazy">`:'<div class="combo-section__thumb combo-section__thumb--ph"></div>')}
                        <div class="combo-section__sel">
                            <div class="combo-section__sel-name">${vegDotHTML(s.veg)}<span class="combo-section__sel-text">${esc(s.name)}</span></div>
                            ${s.sp?`<div class="combo-section__sel-price">₹${s.sp.toFixed(2)}</div>`:''}
                            ${desc?`<div class="combo-section__sel-desc">${esc(desc)}</div>`:''}
                        </div>
                        <button class="combo-section__change" type="button" data-step="${idx}">Change</button>
                    </div>`;
                }).join('');
            }
            return`<div class="combo-section" data-step="${idx}">
                <div class="combo-section__head">
                    <span class="combo-section__title">${esc(t.headerName||'Choose')}</span>
                    ${allOos?'':`<span class="combo-section__count">${optCount} option${optCount===1?'':'s'}</span>`}
                </div>
                ${rowsHtml}
            </div>`;
        }).join('');
        root.querySelectorAll('.combo-section__change').forEach(btn=>btn.addEventListener('click',()=>openSectionSheet(+btn.dataset.step)));
    }
    function openSectionSheet(stepIdx){
        const t=ts[stepIdx];
        const cur=selections[stepIdx]||[];
        const minQ=+t.minQty||0,maxQ=+t.maxQty||1;
        const isMulti=maxQ>1;
        const inputType=isMulti?'checkbox':'radio';
        const inputName=isMulti?`combo-sheet-multi-${stepIdx}`:'combo-sheet-pick';
        const inputCls=isMulti?'combo-option__check':'combo-option__radio';
        let subtitle;
        if(!isMulti)subtitle='Please select any one option';
        else if(minQ===maxQ)subtitle=`Please select ${maxQ} options`;
        else if(minQ>0)subtitle=`Please select ${minQ} to ${maxQ} options`;
        else subtitle=`Please select up to ${maxQ} options`;
        const curIds=new Set(cur.map(s=>s.id));
        const sheet=document.createElement('div');sheet.className='combo-sheet-wrap';
        sheet.innerHTML=`<div class="popup-overlay combo-sheet-overlay"><div class="popup-sheet combo-sheet">
            <button class="popup-close combo-sheet__close" type="button" aria-label="Close">×</button>
            <div class="combo-sheet__head">
                <h3 class="combo-sheet__title">${esc(t.headerName||'Choose')}</h3>
                <p class="combo-sheet__sub">${subtitle}</p>
            </div>
            <div class="combo-sheet__list">
                ${(t.items||[]).map(x=>{
                    const oos=+x.out_of_stock===1,sp=+x.sp||0;
                    const xi=x.image?`${CDN}/${pId}/${x.image}`:'';
                    const checked=curIds.has(String(x.id))&&!oos?' checked':'';
                    return`<label class="combo-option${oos?' combo-option--oos':''}">
                        ${xi?`<img src="${xi}" alt="" class="combo-option__img" loading="lazy">`:(bLogo?`<img src="${esc(bLogo)}" alt="" class="combo-option__img popup-img-fallback" loading="lazy">`:'<div class="combo-option__img combo-option__img--ph"></div>')}
                        <div class="combo-option__body">
                            <div class="combo-option__name">${vegDotHTML(x.vegNonvegBoth)}${esc(x.itemName||'')}</div>
                            ${sp?`<div class="combo-option__price">₹${sp.toFixed(2)}</div>`:''}
                        </div>
                        ${oos?'<span class="combo-option__oos">Out of Stock</span>':`<input class="${inputCls}" type="${inputType}" name="${inputName}" value="${x.id}" data-nm="${esc(x.itemName||'')}" data-sp="${sp}" data-image="${esc(x.image||'')}" data-veg="${esc(normVeg(x.vegNonvegBoth))}"${checked}>`}
                    </label>`;
                }).join('')}
            </div>
            <div class="combo-sheet__footer">
                <div class="combo-sheet__error" id="comboSheetErr" hidden></div>
                <button class="combo-sheet__cta" type="button">Select</button>
            </div>
        </div></div>`;
        document.body.appendChild(sheet);
        // Multi-pick: cap selections at maxQty by locking additional unchecked
        // options (disabled + .combo-option--maxed = dimmed, no hover, toast on click).
        if(isMulti){
            const checks=()=>Array.from(sheet.querySelectorAll(`input[type=checkbox][name="${inputName}"]`));
            const updateCap=()=>{
                const all=checks(),maxed=all.filter(c=>c.checked).length>=maxQ;
                all.forEach(c=>{
                    const lock=maxed&&!c.checked;
                    c.disabled=lock;
                    c.closest('.combo-option')?.classList.toggle('combo-option--maxed',lock);
                });
            };
            checks().forEach(c=>c.addEventListener('change',()=>{
                updateCap();
                // Clear any previous error once user changes selection
                const err=sheet.querySelector('#comboSheetErr');if(err)err.hidden=true;
            }));
            // Clicking a locked option explains why (disabled input swallows
            // change) — floating toast over the sheet, same as the variant modal.
            sheet.addEventListener('click',e=>{
                if(!e.target.closest('.combo-option--maxed'))return;
                sheet.querySelector('.popup-toast')?.remove();
                const t=document.createElement('div');
                t.className='popup-toast';
                t.textContent='Cannot add more items in this section';
                sheet.querySelector('.popup-sheet')?.appendChild(t);
                clearTimeout(sheet._toast);
                sheet._toast=setTimeout(()=>t.remove(),2000);
            });
            updateCap();
        }
        const closeSheet=()=>sheet.remove();
        sheet.querySelector('.combo-sheet__close').onclick=closeSheet;
        sheet.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)closeSheet()};
        sheet.querySelector('.combo-sheet__cta').onclick=()=>{
            const chosen=sheet.querySelectorAll(`input[name="${inputName}"]:checked`);
            const err=sheet.querySelector('#comboSheetErr');
            if(chosen.length<minQ){
                if(err){err.textContent=isMulti?`Please select at least ${minQ} option${minQ===1?'':'s'}`:'Please select an option';err.hidden=false;}
                return;
            }
            if(chosen.length>maxQ){
                if(err){err.textContent=`Please select at most ${maxQ} option${maxQ===1?'':'s'}`;err.hidden=false;}
                return;
            }
            selections[stepIdx]=Array.from(chosen).map(c=>({
                id:c.value,
                name:c.dataset.nm,
                sp:+c.dataset.sp||0,
                image:c.dataset.image||'',
                veg:normVeg(c.dataset.veg)
            }));
            renderSections();
            closeSheet();
        };
    }
    ge('comboBack').onclick=()=>el.remove();
    ge('comboShare')?.addEventListener('click',()=>shareItem(item));
    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)el.remove()};
    ge('comboAdd').addEventListener('click',()=>{
        if(comboBlocked){
            // Either the combo itself is out of stock, or a step is fully out of
            // stock so it can never be fulfilled. Say which.
            const names=blockedSteps.join(', ');
            const msg=!blockedSteps.length
                ?`${item.name} is currently out of stock`
                :blockedSteps.length>1
                ?`${names} are out of stock — combo unavailable`
                :`${names} is out of stock — combo unavailable`;
            el.querySelector('.popup-toast')?.remove();
            const t=document.createElement('div');
            t.className='popup-toast';
            t.textContent=msg;
            el.querySelector('.combo-detail')?.appendChild(t);
            clearTimeout(el._toast);
            el._toast=setTimeout(()=>t.remove(),2600);
            return;
        }
        // Flatten all per-step selection arrays into one subItems list.
        // Combo price is fixed at item.sp (CI3 parity); selection sp is informational.
        const subItems=[];
        for(const sels of selections){
            if(!sels)continue;
            for(const s of sels){
                // isCombo:true marks this as a combo constituent — addToCart maps it to the
                // mobile-app wire shape (price + isCombo, no sp) so the server prices the combo
                // ONCE. sp/itemName/veg kept for local cart display + combo re-open prefill.
                subItems.push({itemId:String(s.id),itemName:s.name,sp:+s.sp||0,qty:1,type:1,veg:normVeg(s.veg||item.veg),isCombo:true});
            }
        }
        addToCart(item.id,item.name,comboPrice()||+item.sp||0,item.id,item.veg,subItems);
        el.remove();
    });
    renderSections();
}

// ── BOGO wizard (viewType=3) — CI3 parity ──
// Each step has TWO sub-views (CI3 flow from item_view.php):
//   1. 'main'   — pick the main item (radio) — bottom shows "Customization" (+ "Previous" on step>0)
//   2. 'addons' — pick toppings/upgrades (checkbox sections) — bottom shows "Previous" + "Continue"/"Order Now"
// Sidebar shows numbered placeholder when step pending, checkmark badge + item name once picked.
function buildBogoPopup(item){
    const steps=item.wizardSteps||[];
    if(!steps.length)return;
    // selections[k] = { mainItem:{id,name,sp,sectionId}|null, addons:Map<templateId, Map<itemId,{id,name,sp}>> }
    const selections=steps.map(()=>({mainItem:null,addons:new Map()}));
    let stepIdx=0;
    let subView='main'; // 'main' | 'addons'

    function nthSuffix(n){const s=['st','nd','rd'];return s[((n+90)%100-10)%10-1]||'th';}
    function resolveTemplate(id){
        if(id==null||id==='')return null;
        return templateList.find(t=>String(t.templateId)===String(id))||null;
    }
    function mainItemsForStep(k){
        return resolveTemplate(steps[k]?.pizzaTemplateId)?.template||[];
    }
    function addonTemplatesForStep(k){
        // The applicable customisation sections + their min/max live on the SELECTED pizza's
        // template_arr — CI3 reads min/max from the item's own templates (menu.templates:
        // {templateId, minQty, maxQty}). Different pizzas carry different section sets, so this
        // must key off the chosen main item, not the step-level customisationTemplateId union.
        const mainId=selections[k]?.mainItem?.id;
        if(mainId){
            const main=mainItemsForStep(k).find(x=>String(x.id)===String(mainId));
            const arr=Array.isArray(main?.template_arr)?main.template_arr:[];
            if(arr.length){
                return arr.map(a=>{
                    const pool=resolveTemplate(a.templateId);
                    if(!pool)return null;
                    return {...pool,minQty:+a.minQty||0,maxQty:+a.maxQty||0};
                }).filter(Boolean);
            }
        }
        // Fallback (no pick yet, or item lacks template_arr): step-level union, no limits known.
        const raw=steps[k]?.customisationTemplateId;
        if(!raw)return [];
        return String(raw).split(',').map(s=>s.trim()).filter(Boolean)
            .map(resolveTemplate).filter(Boolean).map(t=>({...t,minQty:0,maxQty:0}));
    }
    function hasAddonsForStep(k){
        return addonTemplatesForStep(k).some(t=>(t.template||[]).length>0);
    }
    function priceForStep(k){
        const s=selections[k];if(!s||!s.mainItem)return 0;
        let p=+s.mainItem.sp||0;
        s.addons.forEach(group=>group.forEach(a=>{p+=+a.sp||0}));
        return p;
    }
    function totalPrice(){return selections.reduce((sum,_,k)=>sum+priceForStep(k),0)}

    // Shared price math for the BOGO summary surfaces (mobile bottom-sheet,
    // desktop sidebar, main-view Order Now CTA). Single source of truth for
    // which step is "free" and what the strike / final totals are.
    function bogoPrices(){
        const allPicked=selections.every(s=>!!s?.mainItem);
        let freeIdx=-1, original=0, freeAmt=0, final=0;
        if(allPicked){
            const sps=selections.map(s=>+s.mainItem.sp||0);
            const minSp=Math.min(...sps);
            // lastIndexOf → tied cheapest defaults to the 2nd item ("Buy 1 Get 2nd Free" UX)
            freeIdx=sps.lastIndexOf(minSp);
            original=totalPrice();
            freeAmt=+selections[freeIdx].mainItem.sp||0;
            final=original-freeAmt;
        }
        return {allPicked, freeIdx, original, freeAmt, final};
    }

    // BOGO re-opens FRESH: intentionally NO pre-fill from an existing cart entry. Each open of the
    // wizard is a new "add" flow, so the user must re-select both items (product decision — the old
    // pre-fill made the modal feel like it was editing the cart item and pre-checked stale picks).
    // The cart / card qty stepper is untouched and keeps reflecting the cart value.

    const el=document.createElement('div');el.id='variantModal';
    el.innerHTML=`<div class="popup-overlay"><div class="popup-sheet popup-sheet--bogo">
        <div class="popup-bogo-head">
            <h2 class="popup-bogo-title">${esc(item.name)}</h2>
            <button class="popup-close popup-close--inline" id="popClose" type="button" aria-label="Close">×</button>
        </div>
        <div class="popup-bogo-grid">
            <aside class="popup-bogo-steps" id="bogoSteps"></aside>
            <div class="popup-bogo-pane" id="bogoPane"></div>
        </div>
        <div class="popup-bogo-mfoot" id="bogoMobileFoot">
            <div class="popup-bogo-mfoot__savings" id="bogoMobileSavings" hidden></div>
            <div class="popup-bogo-mfoot__slots">${steps.map((_,k)=>`
                <div class="popup-bogo-mfoot__slot" data-slot="${k}">
                    <div class="popup-bogo-mfoot__slot-label">${k===0?'First':k===1?'Second':`${k+1}${nthSuffix(k+1)}`} Item</div>
                    <div class="popup-bogo-mfoot__slot-value">Select your ${k+1}${nthSuffix(k+1)} item</div>
                </div>`).join('')}</div>
            <button class="popup-bogo-mfoot__cta" id="bogoMobileAdd" type="button" disabled>
                <span class="popup-bogo-mfoot__cta-strike"></span>
                <span class="popup-bogo-mfoot__cta-total"></span>
                <span class="popup-bogo-mfoot__cta-label">Add to Cart</span>
            </button>
        </div>
    </div></div>`;
    document.body.appendChild(el);
    ge('popClose').onclick=()=>el.remove();
    el.querySelector('.popup-overlay').onclick=e=>{if(e.target===e.currentTarget)el.remove()};

    // Mobile bottom-sheet: Order Now CTA → commit to cart (enabled only when both picks done).
    ge('bogoMobileAdd')?.addEventListener('click',commitOrder);
    // Mobile bottom-sheet: slot interactions
    //   ✕ icon on filled slot      → clear that step's selection (mainItem + addons)
    //   ✎ icon on filled slot      → jump to that step's addon view to edit
    //   tap anywhere else on slot  → jump to that step's main view (re-pick pizza)
    el.querySelectorAll('.popup-bogo-mfoot__slot').forEach(s=>s.addEventListener('click',e=>{
        const k=+s.dataset.slot;
        if(e.target.closest('.popup-bogo-mfoot__slot-clear')){
            // Clear only the in-modal pick — the wizard is a fresh "add" flow, so this must NOT
            // touch the cart's existing BOGO (that stays until the user commits a new one).
            selections[k].mainItem=null;
            selections[k].addons=new Map();
            stepIdx=k;
            subView='main';
            renderPane();
            return;
        }
        if(e.target.closest('.popup-bogo-mfoot__slot-edit')){
            if(!selections[k]?.mainItem)return;
            stepIdx=k;
            subView=hasAddonsForStep(k)?'addons':'main';
            renderPane();
            return;
        }
        stepIdx=k;
        subView='main';
        renderPane();
    }));

    function renderSteps(){
        const sb=ge('bogoSteps');if(!sb)return;
        const editSvg='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        const {allPicked, freeIdx}=bogoPrices();
        sb.innerHTML=steps.map((s,k)=>{
            const isCurrent=k===stepIdx;
            const mainItem=selections[k].mainItem;
            const done=!!mainItem;
            const cls=isCurrent?' popup-bogo-step--active':'';
            const doneCls=done?' popup-bogo-step--done':'';

            // Addon chip + names list — chip is the inline entry-point to the addon view;
            // the names line below shows which addons were picked.
            let addonCount=0, addonsSp=0;
            const addonNames=[];
            if(done)selections[k].addons.forEach(group=>group.forEach(a=>{addonCount++;addonsSp+=+a.sp||0;addonNames.push(a.name);}));
            const chipText=addonCount===0?'Customise':`${addonCount} addon${addonCount===1?'':'s'} selected`;
            const chipHtml=done
                ? `<button type="button" class="popup-bogo-step-edit" data-step="${k}" aria-label="Edit customisation"><span>${chipText}</span>${editSvg}</button>`
                : '';
            const namesHtml=addonNames.length
                ? `<div class="popup-bogo-step-addons">+ ${addonNames.map(esc).join(', ')}</div>`
                : '';

            // Price row: variant price (or strike+Free for the BOGO free slot) plus (+₹X) for addons
            let priceHtml='';
            if(done){
                const mainSp=+mainItem.sp||0;
                const addonsSuffix=addonsSp>0?`<span class="popup-bogo-step-price-addons">(+₹${addonsSp.toFixed(0)})</span>`:'';
                if(allPicked&&k===freeIdx){
                    priceHtml=`<div class="popup-bogo-step-price">
                        <span class="popup-bogo-step-price-strike">₹${mainSp.toFixed(0)}</span>
                        <span class="popup-bogo-step-price-free">Free</span>
                        ${addonsSuffix}
                    </div>`;
                } else {
                    priceHtml=`<div class="popup-bogo-step-price">
                        <span class="popup-bogo-step-price-main">₹${mainSp.toFixed(0)}</span>
                        ${addonsSuffix}
                    </div>`;
                }
            }

            // When item is picked: name + ✕ on top, addon chip, price row
            // When not picked: number circle + placeholder text
            const inner=done
                ? `<div class="popup-bogo-step-head">
                       <span class="popup-bogo-step-name">${esc(mainItem.name)}</span>
                       <button type="button" class="popup-bogo-step-clear" data-step="${k}" aria-label="Remove selection">×</button>
                   </div>
                   ${chipHtml}
                   ${namesHtml}
                   ${priceHtml}`
                : `<span class="popup-bogo-step-num">${k+1}</span><span class="popup-bogo-step-label">Select your ${k+1}${nthSuffix(k+1)} Item</span>`;
            return`<div class="popup-bogo-step-wrap${done?' has-check':''}">
                ${done?'<span class="popup-bogo-step-check" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>':''}
                <div role="button" tabindex="0" class="popup-bogo-step${cls}${doneCls}" data-step="${k}">${inner}</div>
            </div>`;
        }).join('');
        sb.querySelectorAll('.popup-bogo-step').forEach(b=>b.addEventListener('click',e=>{
            const k=+b.dataset.step;
            if(e.target.closest('.popup-bogo-step-clear')){
                // Clear only the in-modal pick — fresh "add" flow, don't disturb the cart entry.
                selections[k].mainItem=null;
                selections[k].addons=new Map();
                stepIdx=k;
                subView='main';
                renderPane();
                return;
            }
            if(e.target.closest('.popup-bogo-step-edit')){
                if(!selections[k]?.mainItem)return;
                stepIdx=k;
                subView=hasAddonsForStep(k)?'addons':'main';
                renderPane();
                return;
            }
            // Default: jump to that step's main view (only forward-jump to a step that has no pick yet is blocked)
            if(k>stepIdx && !selections[k].mainItem)return;
            stepIdx=k;
            subView='main';
            renderPane();
        }));
    }

    function renderPane(){
        if(subView==='main')renderMainPane();
        else renderAddonsPane();
        renderSteps();
        renderMobileFoot();
        const sheet=el.querySelector('.popup-sheet--bogo');
        if(sheet)sheet.classList.toggle('popup-sheet--bogo-addons',subView==='addons');
    }

    function renderMobileFoot(){
        const mfoot=ge('bogoMobileFoot');if(!mfoot)return;
        const {allPicked, freeIdx, original, freeAmt, final}=bogoPrices();
        const editSvgInline='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        selections.forEach((s,k)=>{
            const slot=mfoot.querySelector(`.popup-bogo-mfoot__slot[data-slot="${k}"]`);
            if(!slot)return;
            const filled=!!s.mainItem;
            const isActive=k===stepIdx;
            slot.classList.toggle('popup-bogo-mfoot__slot--filled',filled);
            slot.classList.toggle('popup-bogo-mfoot__slot--active',isActive);
            const slotNum=k===0?'First':k===1?'Second':`${k+1}${nthSuffix(k+1)}`;

            // Addon chip + names list. Chip is the inline entry-point to the addon view;
            // the names line below shows which addons were picked.
            let addonCount=0,addonsSp=0;
            const addonNames=[];
            if(filled)s.addons.forEach(group=>group.forEach(a=>{addonCount++;addonsSp+=+a.sp||0;addonNames.push(a.name);}));
            const chipText=addonCount===0
                ? 'Customise'
                : `${addonCount} addon${addonCount===1?'':'s'} selected`;
            const chipHtml=filled
                ? `<button type="button" class="popup-bogo-mfoot__slot-edit" aria-label="Edit customisation"><span>${chipText}</span>${editSvgInline}</button>`
                : '';
            const namesHtml=addonNames.length
                ? `<div class="popup-bogo-mfoot__slot-addons">+ ${addonNames.map(esc).join(', ')}</div>`
                : '';

            const valueText=filled?esc(s.mainItem.name):`Select your ${k+1}${nthSuffix(k+1)} item`;

            // Price row: variant price (or strikethrough+Free for the BOGO free slot)
            // followed by an optional (+₹X) for the addon subtotal.
            let priceHtml='';
            if(filled){
                const mainSp=+s.mainItem.sp||0;
                const addonsSuffix=addonsSp>0?`<span class="popup-bogo-mfoot__slot-price-addons">(+₹${addonsSp.toFixed(0)})</span>`:'';
                if(allPicked&&k===freeIdx){
                    priceHtml=`<div class="popup-bogo-mfoot__slot-price">
                        <span class="popup-bogo-mfoot__slot-price-strike">₹${mainSp.toFixed(0)}</span>
                        <span class="popup-bogo-mfoot__slot-price-free">Free</span>
                        ${addonsSuffix}
                    </div>`;
                } else {
                    priceHtml=`<div class="popup-bogo-mfoot__slot-price">
                        <span class="popup-bogo-mfoot__slot-price-main">₹${mainSp.toFixed(0)}</span>
                        ${addonsSuffix}
                    </div>`;
                }
            }

            slot.innerHTML=`
                <div class="popup-bogo-mfoot__slot-head">
                    <span class="popup-bogo-mfoot__slot-label">${slotNum} Item</span>
                    ${filled?'<button type="button" class="popup-bogo-mfoot__slot-clear" aria-label="Remove selection">×</button>':''}
                </div>
                <div class="popup-bogo-mfoot__slot-row">
                    <div class="popup-bogo-mfoot__slot-value">${valueText}</div>
                </div>
                ${chipHtml}
                ${namesHtml}
                ${priceHtml}
            `;
        });
        const savings=ge('bogoMobileSavings');
        const cta=ge('bogoMobileAdd');
        const strikeEl=mfoot.querySelector('.popup-bogo-mfoot__cta-strike');
        const totalEl=mfoot.querySelector('.popup-bogo-mfoot__cta-total');
        if(allPicked){
            if(savings){savings.hidden=false;savings.textContent=`🎉 You are saving ₹${freeAmt.toFixed(0)} with BOGO!`;}
            if(strikeEl)strikeEl.textContent=`₹${original.toFixed(0)}`;
            if(totalEl)totalEl.textContent=`₹${final.toFixed(0)}`;
            if(cta)cta.disabled=!!item.oos;
        } else {
            if(savings)savings.hidden=true;
            if(strikeEl)strikeEl.textContent='';
            if(totalEl)totalEl.textContent='';
            if(cta)cta.disabled=true;
        }
    }

    function renderMainPane(){
        const pane=ge('bogoPane');if(!pane)return;
        const mains=mainItemsForStep(stepIdx);
        const sel=selections[stepIdx];

        pane.innerHTML=`
            <div class="popup-bogo-pane-body">
                <div class="popup-bogo-list">${mains.length?mains.map(x=>{
                    const oos=+x.out_of_stock===1||+x.status===-1;
                    const sp=+x.sp||0;
                    const img=x.image?`${CDN}/${pId}/${x.image}`:'';
                    const descFull=x.description||'';
                    const descShort=descFull.length>140?descFull.slice(0,140)+'…':descFull;
                    const isChecked=!!sel.mainItem&&String(x.id)===String(sel.mainItem.id);
                    return`<div class="popup-bogo-item${oos?' off':''}${isChecked?' on':''}" data-item-id="${esc(String(x.id))}">
                        <div class="popup-bogo-item-imgwrap">
                            ${img?`<img class="popup-bogo-item-img" src="${img}" alt="${esc(x.itemName||'')}" loading="lazy">`:'<div class="popup-bogo-item-img popup-bogo-item-img--ph"></div>'}
                            ${vegDotHTML(x.vegNonvegBoth,'popup-bogo-item-vegtag')}
                        </div>
                        <div class="popup-bogo-item-body" data-desc-short="${esc(descShort)}" data-desc-full="${esc(descFull)}">
                            <div class="popup-bogo-item-name">${esc(x.itemName||'')}</div>
                            ${descFull?`<p class="popup-bogo-item-desc">(${esc(descShort)})</p><button class="popup-bogo-readmore" type="button">Read more</button>`:''}
                            ${oos?'<span class="popup-bogo-item-oos">Out of stock</span>':(sp?`<div class="popup-bogo-item-price">₹${sp.toFixed(2)}</div>`:'')}
                        </div>
                        <button type="button" class="popup-bogo-select-btn${isChecked?' popup-bogo-select-btn--on':''}" data-id="${esc(String(x.id))}" data-nm="${esc(x.itemName||'')}" data-sp="${sp}" data-sid="${esc(String(x.sectionId||''))}" data-veg="${esc(normVeg(x.vegNonvegBoth))}"${oos?' disabled':''}>${isChecked?'Selected':'Select'}</button>
                    </div>`;
                }).join(''):`<p class="popup-bogo-empty">No options for this step.</p>`}</div>
                <div class="popup-bogo-pane-error" id="bogoPaneError" hidden></div>
            </div>
            ${(()=>{
                const {allPicked, original, final}=bogoPrices();
                if(!allPicked)return '';
                if(item.oos)return `<div class="popup-bogo-pane-foot popup-bogo-pane-foot--commit">
                    <div class="popup-cta-disabled"><span class="popup-cta__label">Out of stock</span></div>
                </div>`;
                return `<div class="popup-bogo-pane-foot popup-bogo-pane-foot--commit">
                    <button class="popup-cta popup-cta--main popup-bogo-commit" id="bogoMainCommit" type="button">
                        <span class="popup-bogo-commit__strike">₹${original.toFixed(0)}</span>
                        <span class="popup-bogo-commit__total">₹${final.toFixed(0)}</span>
                        <span class="popup-bogo-commit__label">Add to Cart</span>
                    </button>
                </div>`;
            })()}
        `;

        // Select button handlers — set mainItem + open customization directly
        pane.querySelectorAll('.popup-bogo-select-btn').forEach(btn=>btn.addEventListener('click',()=>{
            if(btn.disabled)return;
            // veg travels with the pick so the cart/checkout rows show the CHOSEN item's
            // diet — the BOGO wrapper itself has none to inherit.
            sel.mainItem={id:btn.dataset.id,name:btn.dataset.nm,sp:+btn.dataset.sp||0,sectionId:btn.dataset.sid,veg:btn.dataset.veg||''};
            clearError();
            if(hasAddonsForStep(stepIdx)){
                subView='addons';
                renderPane();
            } else {
                advanceToNextStep();
            }
        }));

        // Read more / Read less toggle — single block button below the description.
        // Adding --expanded to the <p> lifts the 2-line clamp.
        pane.addEventListener('click',e=>{
            const btn=e.target.closest('.popup-bogo-readmore');
            if(!btn)return;
            e.preventDefault();
            e.stopPropagation();
            const body=btn.closest('.popup-bogo-item-body');
            const p=body?.querySelector('.popup-bogo-item-desc');
            if(!body||!p)return;
            const expanded=p.classList.toggle('popup-bogo-item-desc--expanded');
            const text=expanded?body.dataset.descFull:body.dataset.descShort;
            p.textContent=`(${text||''})`;
            btn.textContent=expanded?'Read less':'Read more';
        });

        // "Order Now" CTA at the bottom of the main pane — only rendered when all picks are filled.
        ge('bogoMainCommit')?.addEventListener('click',commitOrder);
    }

    function renderAddonsPane(){
        const pane=ge('bogoPane');if(!pane)return;
        const addonTpls=addonTemplatesForStep(stepIdx);
        const sel=selections[stepIdx];

        // Pre-select the first available option for single-pick required sections
        // (min===1 && max===1, rendered as radios) — CI3 parity, so a mandatory
        // "pick exactly one" section starts satisfied rather than blocking commit silently.
        addonTpls.forEach(t=>{
            const items=t.template||[];
            const tid=String(t.templateId);
            if(!((+t.minQty||0)===1&&(+t.maxQty||0)===1))return;
            if((sel.addons.get(tid)?.size||0)>0)return;
            const first=items.find(x=>!(+x.out_of_stock===1||+x.status===-1));
            if(!first)return;
            const g=new Map();
            g.set(String(first.id),{id:String(first.id),name:first.itemName||'',sp:+first.sp||0});
            sel.addons.set(tid,g);
        });

        const addonSections=addonTpls.map(t=>{
            const items=t.template||[];
            if(!items.length)return '';
            const tid=String(t.templateId);
            const groupSel=sel.addons.get(tid)||new Map();
            const header=items[0]?.sectionName||'Add-ons';
            // Per-section selection limits (CI3 parity). single = radio (pick exactly one),
            // otherwise checkbox capped at maxQty. minQty>0 makes the section REQUIRED.
            const minQ=+t.minQty||0,maxQ=+t.maxQty||0;
            const single=(minQ===1&&maxQ===1);
            const inputType=single?'radio':'checkbox';
            let qDesc='';
            if(minQ&&maxQ&&minQ===maxQ)qDesc=`Please select any ${maxQ} option${maxQ>1?'s':''}`;
            else if(!minQ&&maxQ)qDesc=`You can choose up to ${maxQ} option${maxQ>1?'s':''}`;
            else if(minQ&&maxQ)qDesc=`Select a minimum of ${minQ} and a maximum of ${maxQ}`;
            else if(minQ&&!maxQ)qDesc=`Select a minimum of ${minQ}`;
            return`<section class="popup-bogo-section" data-addon-tid="${esc(tid)}" data-min="${minQ}" data-max="${maxQ}">
                <h3 class="popup-bogo-section-title">${esc(header)}</h3>
                ${qDesc?`<p class="popup-bogo-section-hint">${qDesc}</p>`:''}
                <div class="popup-bogo-list">${items.map(x=>{
                    const oos=+x.out_of_stock===1||+x.status===-1;
                    const sp=+x.sp||0;
                    const isChecked=groupSel.has(String(x.id));
                    return`<label class="popup-bogo-item popup-bogo-item--addon${oos?' off':''}${isChecked?' on':''}">
                        <span class="popup-bogo-item-name">${vegDotHTML(x.vegNonvegBoth,'popup-bogo-addon-veg')}${esc(x.itemName||'')}</span>
                        ${sp?`<span class="popup-bogo-item-price">₹${sp.toFixed(2)}</span>`:'<span class="popup-bogo-item-price"></span>'}
                        <input type="checkbox" class="popup-bogo-addon-cb" data-tid="${esc(tid)}" data-id="${x.id}" data-nm="${esc(x.itemName||'')}" data-sp="${sp}" data-veg="${esc(normVeg(x.vegNonvegBoth))}"${isChecked?' checked':''}${oos?' disabled':''}>
                    </label>`;
                }).join('')}</div>
            </section>`;
        }).join('');

        pane.innerHTML=`
            <div class="popup-bogo-pane-body">
                ${addonSections||'<p class="popup-bogo-empty">No customisations available for this item.</p>'}
                <div class="popup-bogo-pane-error" id="bogoPaneError" hidden></div>
            </div>
            <div class="popup-bogo-pane-foot popup-bogo-pane-foot--next-only">
                <button class="popup-cta popup-cta--main" id="bogoNext" type="button"><span class="popup-cta__label">Continue</span></button>
            </div>
        `;

        // Enforce maxQty by locking the remaining unchecked options once the section is
        // full (disabled + .maxed → dimmed, no hover). Combo-wizard parity: instead of an
        // error message, a tooltip toast explains the lock when a maxed option is tapped.
        const body=pane.querySelector('.popup-bogo-pane-body');
        const enforceCaps=()=>{
            pane.querySelectorAll('.popup-bogo-section').forEach(sec=>{
                const maxQ=+sec.dataset.max||0;
                if(maxQ<=0)return;
                const boxes=sec.querySelectorAll('input.popup-bogo-addon-cb[type="checkbox"]');
                if(!boxes.length)return; // radios are single-pick — no cap needed
                const maxed=sec.querySelectorAll('input.popup-bogo-addon-cb:checked').length>=maxQ;
                boxes.forEach(b=>{
                    const lab=b.closest('label.popup-bogo-item');
                    if(lab&&lab.classList.contains('off'))return; // out-of-stock stays disabled
                    const lock=maxed&&!b.checked;
                    b.disabled=lock;
                    if(lab)lab.classList.toggle('maxed',lock);
                });
            });
        };

        // Addon input handlers — also re-render sidebar / bottom-sheet so the user sees
        // their addon selections reflected live in the summary surfaces.
        pane.querySelectorAll('input.popup-bogo-addon-cb').forEach(cb=>cb.addEventListener('change',()=>{
            const sec=cb.closest('.popup-bogo-section');
            const tid=cb.dataset.tid;
            let group=sel.addons.get(tid);
            if(!group){group=new Map();sel.addons.set(tid,group);}
            if(cb.type==='radio'){
                // Single-pick section: this radio replaces any prior pick in the group.
                group.clear();
                group.set(cb.dataset.id,{id:cb.dataset.id,name:cb.dataset.nm,sp:+cb.dataset.sp||0,veg:cb.dataset.veg||''});
                sec.querySelectorAll('label.popup-bogo-item').forEach(l=>l.classList.remove('on'));
            } else if(cb.checked){
                group.set(cb.dataset.id,{id:cb.dataset.id,name:cb.dataset.nm,sp:+cb.dataset.sp||0,veg:cb.dataset.veg||''});
            } else {
                group.delete(cb.dataset.id);
                if(group.size===0)sel.addons.delete(tid);
            }
            cb.closest('label.popup-bogo-item')?.classList.toggle('on',cb.checked);
            enforceCaps();
            clearError();
            renderSteps();
            renderMobileFoot();
        }));

        // Tapping a locked (maxed-out) option surfaces a tooltip toast over the sheet —
        // the disabled input swallows the change event, so catch the label click.
        body?.addEventListener('click',e=>{
            if(!e.target.closest('label.popup-bogo-item.maxed'))return;
            const sheet=el.querySelector('.popup-sheet--bogo');
            sheet?.querySelector('.popup-toast')?.remove();
            const t=document.createElement('div');
            t.className='popup-toast';
            t.textContent='Cannot add more items in this section';
            sheet?.appendChild(t);
            clearTimeout(el._toast);
            el._toast=setTimeout(()=>t.remove(),2000);
        });
        enforceCaps();

        ge('bogoNext')?.addEventListener('click',()=>{
            // Validate per-section minimums before advancing (CI3 parity).
            for(const sec of pane.querySelectorAll('.popup-bogo-section')){
                const minQ=+sec.dataset.min||0;
                if(!minQ)continue;
                const tid=sec.dataset.addonTid;
                const picked=sel.addons.get(tid)?.size||0;
                if(picked<minQ){
                    const title=sec.querySelector('.popup-bogo-section-title')?.textContent||'this section';
                    showError(`Please select at least ${minQ} option${minQ>1?'s':''} from ${title}.`);
                    return;
                }
            }
            clearError();
            advanceToNextStep();
        });
    }

    function clearError(){const er=ge('bogoPaneError');if(er)er.hidden=true;}
    function showError(msg){
        const er=ge('bogoPaneError');if(er){er.textContent=msg;er.hidden=false;er.scrollIntoView({behavior:'smooth',block:'center'});}
    }

    function advanceToNextStep(){
        if(stepIdx<steps.length-1){
            stepIdx++;
            subView='main';
            renderPane();
            return;
        }
        // Last step's Continue → return to main view so the user can review
        // both picks + customisations in the sidebar/bottom-sheet before committing.
        // Cart commit is now triggered explicitly via the main-view "Order Now" CTA
        // (or the mobile bottom-sheet Order Now).
        subView='main';
        renderPane();
    }

    // Validate every step's required (minQty>0) addon sections against the data model.
    // The main-view "Order Now" CTA bypasses the per-step Continue check, so re-validate
    // here. Returns the first unmet step index, or -1 if all minimums are satisfied.
    function firstUnmetMinStep(){
        for(let k=0;k<steps.length;k++){
            if(!selections[k]?.mainItem)continue;
            for(const t of addonTemplatesForStep(k)){
                const minQ=+t.minQty||0;
                if(!minQ)continue;
                if((selections[k].addons.get(String(t.templateId))?.size||0)<minQ)return k;
            }
        }
        return -1;
    }

    function commitOrder(){
        // The BOGO item itself can be out of stock even when every step is pickable.
        if(item.oos){showError(`${item.name} is currently out of stock.`);return}
        if(!selections.every(s=>!!s?.mainItem))return;
        const unmet=firstUnmetMinStep();
        if(unmet!==-1){
            // Jump the user to the offending step's customisation view so they can fix it.
            stepIdx=unmet;
            subView='addons';
            renderPane();
            showError('Please complete the required customisations for this item.');
            return;
        }
        // CI3 parity (order_detail_new_20260506.js:1655-1670 parent + 5625-5660 variant
        // + 5941-5990 addon + 5720-5731 zeroing). BOGO sends a FLAT subItems array (variants
        // and addons as siblings, NOT nested), each with full CI3 metadata so the server's
        // checkMaxPriceWidget can correctly zero variants and keep addons paid.
        const flatSubItems=[];
        const descParts=[];
        selections.forEach((s,sIdx)=>{
            const variantSectionId=steps[sIdx]?.pizzaTemplateId||'';
            const variantTpl=resolveTemplate(variantSectionId);
            const variantSectionName=variantTpl?.template?.[0]?.sectionName||'';
            flatSubItems.push({
                itemId:String(s.mainItem.id),
                parentItemId:0,
                itemName:s.mainItem.name,
                qty:1,
                sp:0,                           // CI3: BOGO variants ALWAYS sp=0
                itemPrice:+s.mainItem.sp||0,    // original price preserved here
                sectionId:String(variantSectionId),
                sectionName:variantSectionName,
                step:sIdx,
                vegNonvegBoth:normVeg(s.mainItem.veg||item.veg),
            });
            // Interleave this variant's addons (siblings, not nested) so server can map
            // them back to their variant via sectionId.
            s.addons.forEach((group,tid)=>{
                const addonTpl=resolveTemplate(tid);
                const addonSectionName=addonTpl?.template?.[0]?.sectionName||'Add-ons';
                group.forEach(a=>{
                    const aSp=+a.sp||0;
                    flatSubItems.push({
                        itemId:String(a.id),
                        parentItemId:0,
                        itemName:a.name,
                        qty:1,
                        sp:aSp,
                        itemPrice:aSp,
                        sectionId:String(tid),
                        sectionName:addonSectionName,
                        vegNonvegBoth:normVeg(a.veg),
                    });
                    descParts.push('+ '+a.name);
                });
            });
        });
        // CI3 BOGO zeroing (line 5720-5731): always zero subItems[0].itemPrice
        // (the first variant). Server's checkMaxPriceWidget uses this to mark
        // variants for zeroing and compute parent.subTotal = MAX of children prices.
        if(flatSubItems.length>0){
            flatSubItems[0].itemPrice=0;
        }
        // Provisional local price (overwritten by server sync). Mirrors what
        // checkMaxPriceWidget will compute: max(variant.itemPrice) + Σ(addon.sp).
        const variantSps=selections.map(s=>+s.mainItem.sp||0);
        const maxVariantSp=variantSps.length?Math.max(...variantSps):0;
        const addonsTotalSp=selections.reduce((sum,s)=>{
            let p=0;
            s.addons.forEach(group=>group.forEach(a=>{p+=+a.sp||0}));
            return sum+p;
        },0);
        const provisionalPrice=maxVariantSp+addonsTotalSp;
        // Nested wire payload (CI3 open_wizard parity — order_details_new_aman.js:
        // changeWizardItem + addwizTopp). Each step's main item is a CHILD of the BOGO
        // line, and that item's addons nest inside ITS subItems — NOT siblings of it.
        // Keys mirror comboWireSubs (`price`, string-typed). Real prices are sent (no
        // client-side zeroing): the server applies the BOGO discount from viewType=3.
        const bogoWire=selections.map(s=>{
            const addons=[];
            s.addons.forEach(group=>group.forEach(a=>addons.push({
                itemId:String(a.id),
                qty:"1",
                parentItemId:"0",
                price:String(+a.sp||0),
            })));
            return {
                itemId:String(s.mainItem.id),
                qty:"1",
                parentItemId:"0",
                price:String(+s.mainItem.sp||0),
                subItems:addons,
            };
        });
        // Parent fields CI3 sends on the BOGO line itself — viewType=3 is the
        // critical trigger that tells the server "run BOGO logic on this line".
        const parentSp=+item.sp||0;
        const extraLineFields={
            itemName:item.name,
            parentItemId:0,
            sp:parentSp,
            itemPrice:parentSp,
            viewType:3,
            customization:descParts.length?1:0,
            description:descParts.join(' '),
            sectionName:'',
            vegNonvegBoth:normVeg(item.veg),
            bogoWire,                       // consumed by addToCart for the wire; not a server field
        };
        addToCart(item.id,item.name,provisionalPrice||parentSp,item.id,item.veg,flatSubItems,extraLineFields);
        el.remove();
    }

    renderPane();
}

// ── Search overlay ──
function openSearch(){
    const ov=ge('searchOverlay');if(!ov)return;
    ov.hidden=false;
    setTimeout(()=>ge('searchInput')?.focus(),80);
    const sp=ge('searchPopular'),pm=ge('popularMenuSection'),sr=ge('searchResults');
    if(sp)sp.hidden=false;if(pm)pm.hidden=false;if(sr)sr.hidden=true;
    syncSearchFilters();
    updateBar();          // reflect any items already in cart in the in-modal bar
    refreshSearchCards(); // re-sync card steppers/ADD to the live cart on every open
}
function syncSearchFilters(){
    document.querySelectorAll('.srch-diet-btn').forEach(b=>b.classList.toggle('active',b.dataset.diet===veg));
    syncFilterUI();   // the search modal's Veg group chip relabels through the shared path
    document.querySelectorAll('.srch-sort-btn').forEach(b=>b.classList.toggle('active',b.dataset.sort===sortBy));
    document.querySelectorAll('.srch-pick-btn').forEach(b=>b.classList.toggle('active',picks.has(b.dataset.pick)));
}
function closeSearch(){
    const ov=ge('searchOverlay');if(ov)ov.hidden=true;
    const si=ge('searchInput');if(si)si.value='';
    document.querySelectorAll('.srch-diet-btn,.srch-sort-btn,.srch-pick-btn').forEach(b=>b.classList.remove('active'));
    q='';render();
}
function doSearch(val){
    q=val.trim().toLowerCase();
    const sr=ge('searchResults'),sp=ge('searchPopular'),pm=ge('popularMenuSection');
    const hasFilters=!!(q||veg||picks.size||sortBy);
    if(!q){if(sr)sr.hidden=true;if(sp)sp.hidden=false;if(pm)pm.hidden=false;return}
    if(sp)sp.hidden=true;if(pm)pm.hidden=true;if(sr)sr.hidden=false;
    const results=filt(allItems).slice(0,40);
    // Search term + result count. Already debounced 280ms by the callers, so this emits
    // per typing pause rather than per keystroke. Zero-result searches matter most here —
    // they're a demand signal for items the brand doesn't list.
    trackSearchOnce(q,results.length);
    if(sr)sr.innerHTML=results.length?results.map(i=>{
        const img=i.image?cardImgUrl(i.image):'';
        const pop=i.hasSubs||i.hasTmpl;
        return`<div class="sr-item card-add" data-id="${i.id}" data-nm="${esc(i.name)}" data-pr="${i.sp}" data-pop="${pop?1:0}" data-veg="${i.veg}">
  ${img?`<img src="${img}" class="sr-img" alt="${esc(i.name)}" loading="lazy">`:''}
  <div class="sr-body">
    ${tagRowHTML(i)}
    <div class="sr-name">${esc(i.name)}</div>
    ${secondaryTagsHTML(i)}
    ${searchPriceHTML(i,i.sp,'sr-price')}
    ${searchUnlockHTML(i)}
    ${nextAvailableHTML()}
  </div>
  ${searchAddHTML(i)}
  ${earnStripHTML(i)}
</div>`}).join(''):searchEmptyStateHTML();
    // Freshly-rendered result cards default to ADD+ — reconcile against the live
    // cart so items already added show their qty stepper, not ADD+.
    refreshSearchCards();
}

// ── Voice search (Web Speech API) ──
// Native, client-side speech-to-text. No backend, no popup: the spoken text
// filters the main menu grid in place (same path as the toolbar input — sets
// the global `q` and re-renders). Gracefully degrades: the mic stays hidden on
// browsers without SpeechRecognition (e.g. Firefox).
let recog=null,recogBusy=false;
function speechApi(){return window.SpeechRecognition||window.webkitSpeechRecognition}
function voiceMics(){return document.querySelectorAll('.js-voice-mic')}
function initVoiceSearch(){
    const mics=voiceMics();if(!mics.length)return;
    if(!speechApi())return; // unsupported (e.g. Firefox) → leave mics hidden
    mics.forEach(mic=>{
        mic.hidden=false;
        // stopPropagation: the desktop mic sits inside the search <label>, so a
        // bare click would also focus the input — swallow it.
        mic.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();startVoiceSearch()});
    });
}
function applyVoiceQuery(txt){
    q=txt.trim().toLowerCase();
    const mi=ge('menuSearchInput');if(mi)mi.value=txt; // keep toolbar input in sync
    render();
}
function startVoiceSearch(){
    const Api=speechApi();if(!Api||recogBusy)return;
    const mics=voiceMics();
    const setListening=on=>mics.forEach(m=>m.classList.toggle('listening',on));
    recog=new Api();
    recog.lang='en-IN';recog.interimResults=true;recog.continuous=false;recog.maxAlternatives=1;
    recog.onstart=()=>{recogBusy=true;setListening(true)};
    recog.onresult=e=>{
        let txt='';for(let i=0;i<e.results.length;i++)txt+=e.results[i][0].transcript;
        applyVoiceQuery(txt); // live-filter the menu as the user speaks
        if(e.results[e.results.length-1].isFinal&&txt.trim())showToast(`Showing results for “${txt.trim()}”`);
    };
    recog.onerror=ev=>{
        if(ev.error==='not-allowed'||ev.error==='service-not-allowed')showToast('Microphone permission needed for voice search');
        else if(ev.error==='no-speech')showToast('Didn’t catch that — try again');
    };
    recog.onend=()=>{recogBusy=false;setListening(false)};
    try{recog.start()}catch{recogBusy=false;setListening(false)}
}

function showRating(r){if(!r||!r.avg_rating)return;const e=ge('outletRating');if(e)e.innerHTML=`<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" style="color:var(--star)"><path d="M4.57658 2.70419C5.20991 1.56806 5.52657 1 6 1C6.47343 1 6.79009 1.56806 7.42342 2.70419L7.58727 2.99812C7.76724 3.32097 7.85722 3.48239 7.99753 3.5889C8.13783 3.69541 8.31257 3.73495 8.66206 3.81402L8.98023 3.88601C10.2101 4.16428 10.825 4.30341 10.9713 4.77387C11.1176 5.24432 10.6984 5.73454 9.85995 6.71496L9.64304 6.96861C9.40479 7.24722 9.28566 7.38652 9.23207 7.55886C9.17848 7.7312 9.19649 7.91706 9.23251 8.28878L9.2653 8.6272C9.39206 9.9353 9.45544 10.5894 9.07243 10.8801C8.68941 11.1709 8.11366 10.9058 6.96216 10.3756L6.66426 10.2384C6.33704 10.0878 6.17343 10.0124 6 10.0124C5.82657 10.0124 5.66296 10.0878 5.33574 10.2384L5.03784 10.3756C3.88634 10.9058 3.31059 11.1709 2.92757 10.8801C2.54456 10.5894 2.60794 9.9353 2.7347 8.6272L2.76749 8.28878C2.80351 7.91706 2.82152 7.7312 2.76793 7.55886C2.71434 7.38652 2.59521 7.24722 2.35696 6.96861L2.14005 6.71496C1.30162 5.73454 0.882412 5.24432 1.02871 4.77387C1.17501 4.30341 1.78993 4.16428 3.01977 3.88601L3.33794 3.81402C3.68743 3.73495 3.86217 3.69541 4.00247 3.5889C4.14278 3.48239 4.23276 3.32097 4.41273 2.99812L4.57658 2.70419Z"/></svg> ${r.avg_rating}`}

// ── Cart ──
function loadCart(){try{const s=localStorage.getItem('v4_cart');if(s){const p=JSON.parse(s);if(p.bId==bId){(p.items||[]).forEach(it=>{if(!it.parentId)it.parentId=String(it.id)});return p}}}catch{}return{bId,items:[],total:0}}
// updateBar() repaints THIS page's cart bar. The v2 header carries its own cart
// button on every page and recomputes only on load, on bfcache restore, or on a
// `storage` event — which does not fire in the tab that wrote the value. So every
// add/remove here left the header badge stale until a reload or a navigation.
// Same hook location_picker.js:134 already uses; no-op on v1 brands.
function saveCart(){cart.total=cart.items.reduce((s,i)=>s+i.price*i.qty,0);localStorage.setItem('v4_cart',JSON.stringify(cart));updateBar();if(typeof window.hdr2RefreshHeader==='function')window.hdr2RefreshHeader()}
// Mobile-app combo wire shape (captured from CartScreenV3): each constituent is sent with
// `price` + `isCombo:true` (NOT `sp`), which tells the server it's a fixed-combo part so the
// combo is priced ONCE instead of adding the components on top (the 239→478 double-count).
// Customization fingerprint — two cart lines that share an itemId but carry different
// variant/addon/combo selections are DISTINCT lines, not one bumped qty. CI3 parity:
// add_to_cart compares JSON.stringify(subItems) (order_detail_new_20260506.js:6145) and
// checkout.js groups rows by the same signature (customizationSignature). Without it, a
// second combo with a different variant merges into the first line's qty and its new
// selection is lost — the server then clones the OLD combo (base price ₹0, stale addons).
function subItemsSig(subItems){
    const arr=Array.isArray(subItems)?subItems:(subItems&&typeof subItems==='object'?Object.values(subItems):[]);
    if(!arr.length)return '';
    return arr.map(s=>`${s?.itemId??''}_${s?.itemName??''}_${Number(s?.sp??0)}`).sort().join('|');
}
function comboWireSubs(subItems){
    return subItems.map(s=>({
        itemId:String(s.itemId),
        qty:String(+s.qty||1),
        parentItemId:"0",
        price:String(+s.sp||0),
        subItems:[],
        isCombo:true,
    }));
}
function addToCart(id,nm,pr,parentId,veg,subItems,extraLineFields){const pid=String(parentId||id);const bogoWire=extraLineFields&&extraLineFields.bogoWire;const lineFields={...(extraLineFields||{})};delete lineFields.bogoWire;const bk=isCloud?String(brandId||''):'';const bd=bk?brands.find(b=>String(b.id)===bk):null;const hasSubs=Array.isArray(subItems)&&subItems.length>0;const isCombo=hasSubs&&subItems.some(s=>s&&s.isCombo);const sig=subItemsSig(subItems);
// Build the server wire line (carries variant/addon/combo/BOGO customizations). Used for BOTH a
// fresh add AND a qty-bump of an existing identical line: a bare {itemId,qty} bump makes the
// server create an EMPTY, unpriced clone for BOGO/combo (renders blank + won't group with the
// existing deal). Simple items still bump with a bare payload (the server increments correctly).
const buildLine=()=>{const line={itemId:pid,qty:1,...lineFields};if(hasSubs){if(bogoWire){line.parentItemId="0";line.qty="1";line.subItems=bogoWire;}else if(isCombo){line.parentItemId="0";line.qty="1";line.subItems=comboWireSubs(subItems);}else line.subItems=subItems;}return line;};
const x=cart.items.find(i=>i.id==String(id)&&i.parentId==pid&&String(i.brandId||'')==bk&&subItemsSig(i.subItems)===sig);if(x){x.qty++;syncCart('add',[hasSubs?buildLine():{itemId:pid,qty:1}])}else{const entry={id:String(id),parentId:pid,name:nm,price:+pr||0,qty:1,veg:normVeg(veg),brandId:bk,brandName:bd?.name||'',brandLogo:bd?.logo||''};if(hasSubs)entry.subItems=subItems;if(bogoWire)entry.bogoWire=bogoWire;cart.items.push(entry);syncCart('add',[buildLine()])}saveCart();cartRerender();bumpCartPill();refreshSearchCards();trackAddToCart({value:+pr||0,businessId:bId,items:[{id:pid,name:nm,price:+pr||0,qty:1,veg:normVeg(veg)}],item:{id:pid,name:nm,price:+pr||0,qty:1,veg:normVeg(veg)}})}
function chgQty(id,d){
    // A customizable item can hold several cart lines under the SAME itemId (different
    // add-ons). The card stepper's − targets the LAST such line (lastLineId == itemId,
    // not unique); '+' only reaches here for single-line non-customizable items. Operate
    // on that one line and, on removal, splice ONLY that line object — never every line
    // sharing the itemId (the old `x.id!=id` filter wiped the whole stepper: GFB bug).
    const matches=cart.items.filter(x=>String(x.id)===String(id));
    const i=matches[matches.length-1];
    if(!i)return;
    const pid=String(i.parentId||i.id);
    i.qty+=d;
    if(i.qty<=0){cart.items=cart.items.filter(x=>x!==i);syncCart('delete',{itemId:i.serverItemId||pid,qty:1})}
    else if(d>0){syncCart('add',[{itemId:pid,qty:d}])}
    else if(d<0){syncCart('delete',{itemId:i.serverItemId||pid,qty:1})}
    if(d<0)trackRemoveFromCart({value:i.price||0,item:{id:pid,name:i.name,price:i.price||0,veg:i.veg}});
    saveCart();cartRerender();bumpCartPill();refreshSearchCards();
}

// ── Cart sync to server (CI3 parity) ──
// ─── In-car location ──────────────────────────────────────────
// The server refuses every orderType==4 cart call that arrives without coordinates inside
// the outlet's inCarRadius — including action=add, not just the checkout bill. So in-car
// cart calls carry a live GPS fix, the same one checkout.js sends, and it must be where the
// CAR is: userLat/userLng is the saved delivery address and answers a different question.
//
// Cached for CAR_LOC_TTL_MS rather than the page's lifetime. A menu session outlives a
// parked car — the customer browses, moves the vehicle, adds another item — and the server
// re-measures the distance on every add, so a fix held all session eventually fails against
// an outlet the car is actually sitting outside.
function inCarActive(){ return (localStorage.getItem('orderType')||'1') === '4' }
function ensureInCarLocation(){
    if(!inCarActive())return Promise.resolve(null);
    if(carLoc&&Date.now()-carLocTs>CAR_LOC_TTL_MS)carLoc=null;
    if(carLoc)return Promise.resolve(carLoc);
    if(carLocReq)return carLocReq;
    carLocReq=requestGeolocation()
        .then(g=>{
            carLoc=g.ok?{lat:String(g.lat),lng:String(g.lng)}:null;
            carLocTs=Date.now();
            carLocReq=null;
            return carLoc;
        });
    return carLocReq;
}
// Copy the fix onto an outgoing cart param set. No-op for every other order type, and when
// no fix is in hand — the server's own refusal then carries the reason.
async function applyInCarCoords(params){
    const loc=await ensureInCarLocation();
    if(loc){params.set('latitude',loc.lat);params.set('longitude',loc.lng)}
}

// Pushes every cart mutation to /client/cart immediately so the server cart matches
// localStorage. By the time the user reaches checkout, the server is already in sync
// and checkout fires only one view call. Silently no-ops if user not logged in —
// checkout's reconciliation handles that case.
// pendingSyncs is hoisted to top-of-module state — see comment near the let block.
function syncCart(action, payload){
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(!ud||!ud.token||!ud.contactId)return Promise.resolve();
    const ot=localStorage.getItem('orderType')||'1';
    const params=new URLSearchParams({
        businessId:bId,
        contactMappingId:ud.contactMappingId||'',
        token:ud.token,
        contactId:ud.contactId,
        isNew:1,
        orderType:ot,
        // Match checkout.js callCartApi — server needs subOrderType+pickup_time for the
        // pickup flow; without these, pickup adds are silently dropped on some outlets
        // (the symptom that made grocery cart totals come back as 0).
        subOrderType: ot === '2' ? 1 : '',
        pickup_time:  '',
        // CI3 parity (order_slot_based: `is_slot_based_ordering ?? 0`): send the raw outlet
        // config value, defaulting to 0 — not a hardcoded 0 and not coerced to a bool.
        is_slot_based_ordering: C.isSlotBased ?? 0,
        action,
        // CI3 parity: every cart call carries the selected slot so the server validates
        // prep-time items against it (and stores it for checkout). No-op when none picked.
        ...slotCartParams(),
    });
    if(action==='add'){params.set('cart',JSON.stringify({items:payload}))}
    else if(action==='delete'){params.set('itemId',String(payload.itemId||''))}
    const p=(async()=>{
        try{
            await applyInCarCoords(params);
            const fd=new FormData();for(const[k,v]of params)fd.append(k,v);
            const r=await fetch(`${getApiBase()}/client/cart`,{method:'POST',headers:{'Accept':'application/json'},body:fd});
            if(!r.ok)return;
            const d=await r.json();
            const lines=d?.result?.rows?.orderItemDetails||d?.rows?.orderItemDetails||[];
            // Every mutation returns the whole cart, so this is also the freshest
            // view of what the order has redeemed at checkout.
            noteCommittedBurn(lines);
            if(lines.length){
                // Match by itemId + customization signature, claiming each cart line at
                // most once. Several lines can share an itemId (same item, different
                // add-ons); the old itemId-only find() stamped them ALL with the first
                // server line's orderItemId, so a later − deleted the wrong line.
                const used=new Set();
                lines.forEach(li=>{
                    const lsig=subItemsSig(li.subItems);
                    // A variant/customisable line (VEG SINGLE + topping) is WIRED as itemId=parentId
                    // (46838035) but the server returns it keyed by the DEEP variant id (the promoted
                    // type-1 subItem, e.g. 46944453) — which equals the local entry's `id`, NOT its
                    // parentId. Match on id too, else serverItemId never stamps, the entry looks
                    // "unsynced", and maybeBulkSyncOnLoad re-pushes it on every revisit (qty inflates).
                    // A COMBO (e.g. "Cluckin' Standard + Fries + Flippinade") is wired as
                    // itemId=the combo id but the server returns it keyed by a PROMOTED combo
                    // id whose `parentId` is the wired combo id. So also match the server line's
                    // non-zero parentId against the local id/parentId — else combos hit the same
                    // never-stamped → re-push → qty-inflation bug as deep variants.
                    const lpar=li.parentId&&String(li.parentId)!=='0'?String(li.parentId):'';
                    const matchLi=it=>String(it.parentId||it.id)===String(li.itemId)||String(it.id)===String(li.itemId)
                        ||(lpar&&(String(it.parentId||it.id)===lpar||String(it.id)===lpar));
                    const m=cart.items.find(it=>!used.has(it)&&matchLi(it)&&subItemsSig(it.subItems)===lsig)
                        ||cart.items.find(it=>!used.has(it)&&matchLi(it));
                    if(m&&li.orderItemId){m.serverItemId=String(li.orderItemId);used.add(m)}
                });
                saveCart();
            }
        }catch{}
    })();
    pendingSyncs.add(p);
    p.finally(()=>pendingSyncs.delete(p));
    return p;
}
function drainSyncs(){return pendingSyncs.size?Promise.all([...pendingSyncs]):Promise.resolve()}

// ── Pull saved server cart on load (logged-in only) ──
// CI3 parity: a single /client/cart call with action=add & an empty cart returns the
// user's current server cart (checkout.js cold-loads the bill the same way). We use it
// so the sticky cart bar total and the menu's per-item steppers reflect a cart built on
// another page/device that localStorage doesn't know about. Server is authoritative —
// the local v4_cart is reconciled to match. Silent no-op when logged out or on any error.
async function fetchServerCart(){
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(!ud||!ud.token||!ud.contactId)return;
    // Let any pending local→server pushes (maybeBulkSyncOnLoad / quick adds) settle first,
    // so the fetched cart already includes them instead of reconciling against a stale one.
    await drainSyncs();
    const ot=localStorage.getItem('orderType')||'1';
    const params=new URLSearchParams({
        businessId:bId,
        contactMappingId:ud.contactMappingId||'',
        token:ud.token,
        contactId:ud.contactId,
        isNew:1,
        orderType:ot,
        subOrderType: ot==='2'?1:'',
        pickup_time:'',
        // CI3 parity (order_slot_based: `is_slot_based_ordering ?? 0`): raw config value, default 0.
        is_slot_based_ordering: C.isSlotBased ?? 0,
        action:'add',
        cart:'{"items":[]}',
        // CI3 parity: carry the selected slot so the pulled cart validates against it.
        ...slotCartParams(),
    });
    let d;
    try{
        await applyInCarCoords(params);
        const fd=new FormData();for(const[k,v]of params)fd.append(k,v);
        const r=await fetch(`${getApiBase()}/client/cart`,{method:'POST',headers:{'Accept':'application/json'},body:fd});
        if(!r.ok)return;
        d=await r.json();
    }catch{return}
    // CI3 contract: status===0 is a logical failure (expired session, MOV, etc.) — keep local cart.
    if(!d||Number(d.status)===0)return;
    const rows=d?.result?.rows||d?.rows||d||{};
    const od=rows?.orderDetails?.[0]||null;
    serverOrderId=od?.orderId||serverOrderId;
    const pid=od?.promoCodeId;
    appliedPromoCode=(pid!=null&&Number(pid)!==0)?String(od?.code||od?.promoCode||'applied'):'';
    walletPromoCombinedAllowed=String(od?.wallet_promo_combined_allowed??'')==='1';
    // Cart API returns personalized promoCodes for the logged-in user — replace the
    // static feed promos so ineligible promos (e.g. "new customer") disappear and
    // membership promos appear. CI3 parity: cart response drives the coupon display.
    if(Array.isArray(rows.promoCodes)&&rows.promoCodes.length)renderOfferStrip(rows.promoCodes);
    let lines=rows.orderItemDetails;
    // Cloud-kitchen responses nest lines by sub-brand: [{brandId, items:[...]}, ...] — flatten.
    if(Array.isArray(lines)&&lines.length&&lines[0]&&Array.isArray(lines[0].items)){
        lines=lines.flatMap(g=>(g.items||[]).map(it=>({...it,brandId:it.brandId??g.brandId,brandName:it.brandName??g.businessName,brandLogo:it.brandLogo??g.logo})));
    }
    if(!Array.isArray(lines))return;
    // Cold load: the one place the menu learns about a redemption made on another
    // page (checkout) without any local cart change to trigger a sync.
    noteCommittedBurn(lines);
    reconcileCartFromServer(lines);
}

// A cart line the server has flagged as no longer orderable (out of stock / not
// available in the selected slot) carries validateStatus===0 — on the line itself
// or on any sub-item. Mirrors checkout.js isCartLineUnavailable so the menu agrees
// with checkout. The server zeroes such a line's price, so without this guard it
// would land in the bar as "1 Item | ₹0". null/undefined is NOT blocked.
function cartLineBlocked(li){
    const blocked=v=>v!==null&&v!==undefined&&Number(v)===0;
    const subs=Array.isArray(li.subItems)?li.subItems:(li.subItems&&typeof li.subItems==='object'?Object.values(li.subItems):[]);
    return blocked(li.validateStatus)||subs.some(s=>blocked(s?.validateStatus));
}

// Rebuild local cart.items from server orderItemDetails (server is source of truth).
// Groups lines by itemId + customization signature (the server splits variants/BOGO
// into separate rows, AND the SAME item can appear multiple times with different
// add-ons), sums qty, and hydrates display fields from the in-memory feed item where
// possible so the menu cards/sticky bar render correctly. Then re-renders so steppers
// + the bar update.
function reconcileCartFromServer(lines){
    const groups=new Map();
    const serverPids=new Set();
    // Combo/variant lines the server keys by a promoted id whose parentId is the local item —
    // track those non-zero parentIds too so the preserve guard below recognises them as synced.
    const serverParentIds=new Set();
    lines.forEach(li=>{
        // Invalid/out-of-stock lines never count toward the menu's sticky bar — they
        // can't be ordered and the server prices them at 0. Checkout still surfaces
        // them in its own "no longer available" section from its own fresh fetch.
        if(cartLineBlocked(li))return;
        const pid=String(li.itemId||'');if(!pid)return;
        serverPids.add(pid);
        if(li.parentId&&String(li.parentId)!=='0')serverParentIds.add(String(li.parentId));
        // Key on itemId + customization signature, NOT itemId alone. The same item
        // ordered with different add-ons (e.g. one combo with a paid Ketchup, others
        // without) must stay distinct lines — exactly as addToCart/checkout treat them.
        // Grouping by itemId alone collapsed them into one and dropped the differing
        // add-on prices, so the menu total came out lower than checkout (₹1185 vs ₹1190).
        const sig=subItemsSig(li.subItems);
        const key=pid+'|'+sig;
        let g=groups.get(key);
        if(!g){g={pid,sig,qty:0,serverItemId:'',sub:0,line:li};groups.set(key,g)}
        const q=Number(li.qty||1);
        g.qty+=q;
        if(!g.serverItemId&&li.orderItemId)g.serverItemId=String(li.orderItemId);
        // Line subtotal (excl. tax), matching checkout.js renderCartLineHTML:
        //   • simple items → `subTotal` is ALREADY the line total (qty baked in) → use as-is
        //   • items WITH subItems (variants/addons) → `subTotal` is PER-UNIT → × qty
        const subs=Array.isArray(li.subItems)?li.subItems:(li.subItems&&typeof li.subItems==='object'?Object.values(li.subItems):[]);
        const unit=Number(li.subTotal)||Number(li.sp)||0;
        g.sub+=subs.length?unit*q:unit;
    });
    const next=[];
    groups.forEach(g=>{
        const li=g.line;
        const feed=allItems.find(x=>String(x.id)===g.pid);
        // Match by itemId AND signature so we preserve the RIGHT customization breakdown
        // (the add-on'd line vs the plain line). Fall back to a bare itemId match for
        // brands/items whose server subItem shape doesn't reproduce the local signature.
        // Also match on the server line's non-zero parentId (combos key by a promoted id whose
        // parentId is the local combo id) — see the stamping matcher above.
        const lpar=g.line&&g.line.parentId&&String(g.line.parentId)!=='0'?String(g.line.parentId):'';
        const matchPid=x=>String(x.parentId||x.id)===g.pid||String(x.id)===g.pid
            ||(lpar&&(String(x.parentId||x.id)===lpar||String(x.id)===lpar));
        const existing=cart.items.find(x=>matchPid(x)&&subItemsSig(x.subItems)===g.sig)
            ||cart.items.find(matchPid);
        const name=feed?.name||(li.parentName?`${li.parentName} [${li.itemName||''}]`:li.itemName)||existing?.name||'';
        const bk=isCloud?String(li.brandId||existing?.brandId||''):'';
        const bd=bk?brands.find(b=>String(b.id)===bk):null;
        const entry={
            id:g.pid,parentId:g.pid,name,
            // Per-unit price feeds the sticky-bar total (saveCart sums price×qty).
            price:g.qty?(g.sub/g.qty):(Number(li.sp)||feed?.sp||0),
            qty:g.qty,
            veg:normVeg(feed?.veg||existing?.veg),
            brandId:bk,brandName:bd?.name||existing?.brandName||'',brandLogo:bd?.logo||existing?.brandLogo||'',
            serverItemId:g.serverItemId||existing?.serverItemId||'',
        };
        // Preserve a locally-stored customization breakdown if we have one for this item.
        if(existing?.subItems)entry.subItems=existing.subItems;
        else if(li.subItems)entry.subItems=li.subItems;
        // li.subTotal only captures the base/variant price; add paid addon prices so saveCart()
        // gives the correct sticky-bar total (matching the server bill's Item Total). Sum them off
        // the SERVER line's subItems (authoritative subTotals) — NOT entry.subItems: for BOGO the
        // server zeroes the variant sp (0) while the local cart keeps it (595), so the customization
        // signatures diverge and `existing` can resolve to a DIFFERENT same-itemId deal (e.g. the
        // plain BOGO), dropping the addon and undercounting the bar (₹1785 vs ₹2043). Variants
        // (type 1) are skipped; only priced addons (subTotal > 0) count. Runs for ALL brands so
        // aiFlag=1 carts keep the server's BOGO-zeroing + addon prices (grossed up below).
        const srvSubs=Array.isArray(li.subItems)?li.subItems:(li.subItems&&typeof li.subItems==='object'?Object.values(li.subItems):[]);
        if(srvSubs.length){
            const addonUnit=srvSubs.reduce((s,c)=>{
                if(!c||Number(c.type)===1)return s;
                const v=Number(c.subTotal)||0;
                return v>0?s+v:s;
            },0);
            if(addonUnit>0)entry.price+=addonUnit;
        }
        // All-inclusive brand (aiFlag=1): the server subTotals above are NET of tax, so the price
        // is currently the net figure (e.g. ₹1143 vs the ₹1200 the menu shows). Gross it up to the
        // tax-inclusive amount using the feed's exact sp/sp_without_taxes ratio — this keeps the
        // server's BOGO-zeroing and addon prices (unlike trusting the pre-BOGO feed sp) while
        // restoring the inclusive figure. Stamp the factor so checkout's syncLocalPricesFromServer
        // can gross its own net reconcile up the same way. When the factor is unknown (feed item
        // missing) fall back to the last-known inclusive price rather than leaving it de-taxed.
        if(aiFlag===1){
            const f=aiIncFactor(feed);
            if(f>1){entry.price=Math.round(entry.price*f*100)/100;entry.incF=f;}
            else if(existing&&Number(existing.price)>0){entry.price=Number(existing.price);if(existing.incF)entry.incF=existing.incF;}
        }
        next.push(entry);
    });
    // Preserve genuinely-unsynced local items: added but never pushed to the server
    // (no serverItemId) AND absent from this server response — e.g. a guest cart
    // carried across a login that happened on another page. Without this, the
    // server-authoritative rebuild would drop them before maybeBulkSyncOnLoad()
    // (below) gets a chance to push them. Items that DO carry a serverItemId but are
    // missing from the response were removed elsewhere — correctly dropped.
    // (serverPids is the set of bare itemIds present in the response, built above.)
    cart.items.forEach(it=>{
        // Match the server's keying on BOTH parentId and the deep variant `id` — a variant line
        // the server returns keyed by the deep id (see reconcile match above) is present in
        // serverPids under that id, so guarding only on parentId would wrongly "preserve" it as an
        // unsynced phantom and let maybeBulkSyncOnLoad re-push it (the qty-inflation bug).
        const known=serverPids.has(String(it.parentId||it.id))||serverPids.has(String(it.id))
            ||serverParentIds.has(String(it.parentId||it.id))||serverParentIds.has(String(it.id));
        if(!it.serverItemId&&!known)next.push(it);
    });
    cart.items=next;
    saveCart();cartRerender();refreshSearchCards();
    // Local now mirrors server truth — every server-resident item carries its
    // serverItemId. Only now is it safe to push the still-unsynced local items
    // (maybeBulkSyncOnLoad skips anything already stamped, so no double-count).
    maybeBulkSyncOnLoad();
}
function refreshSearchCards(){
    const ov=ge('searchOverlay');if(!ov||ov.hidden)return;
    ov.querySelectorAll('.card-add[data-id]').forEach(card=>{
        const id=String(card.dataset.id);
        const it=allItems.find(x=>String(x.id)===id);
        const ci=cart.items.find(i=>i.id===id);
        const qty=ci?ci.qty:0;
        // The card's current add control is one of: qty stepper, ADD+, or the
        // Select-Next-Slot button. Reconcile all three so reopening the modal
        // after a slot change re-evaluates availability (not just cart qty).
        const ctrl=card.querySelector('.srch-qty, .srch-add, .item-next-slot');
        if(!ctrl)return;
        // Slot-unavailable items show "Select Next Slot" even when already in the cart —
        // mirror addCtrlHTML, where the slot guard precedes the in-cart stepper.
        const unavail=it&&isSlotBased&&!slotAvailable(it);
        if(qty>0&&!unavail){
            if(ctrl.classList.contains('srch-qty')){ctrl.querySelector('.srch-qty-num').textContent=qty;return}
            ctrl.outerHTML=`<div class="srch-qty"><button class="qb" data-id="${id}" data-d="m" type="button">−</button><span class="srch-qty-num">${qty}</span><button class="qb" data-id="${id}" data-d="p" type="button">+</button></div>`;
        } else {
            ctrl.outerHTML=it?searchAddHTML(it):(isOpen?`<button class="srch-add" type="button">ADD+</button>`:'');
        }
    });
}
// Small visual pulse on the sticky cart pill when count changes
function bumpCartPill(){const b=ge('floatingCartBar');if(!b)return;b.classList.remove('bump');void b.offsetWidth;b.classList.add('bump');setTimeout(()=>b.classList.remove('bump'),260)}
// Server-driven "Your Favourites" — user's most-ordered items.
// Logged-in only; silent fail (section just won't render).
// Dev preview: append `?mock_favs=1` to the URL to seed the rail with the
// first 5 feed items so the design can be reviewed without backend data.
async function fetchMostOrderedItems(){
    if(new URLSearchParams(location.search).get('mock_favs')==='1'){
        // Mutate the first allItems entry in place so the same flags propagate
        // to the click-through popup (which re-reads from allItems by id).
        // Without this, the card shows all tags but the popup shows none.
        const base=allItems[0];
        if(base){
            base.best=true;base.isNew=true;base.featured=true;
            if(!base.rat||base.rat<4)base.rat=5;
            mostOrderedItems=[base,...allItems.slice(1,5)];
        } else {
            mostOrderedItems=allItems.slice(0,5);
        }
        mostOrderedIds=new Set(mostOrderedItems.map(x=>String(x.id)));
        if(mostOrderedItems.length)render();
        return;
    }
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(!ud||!ud.contactMappingId||!ud.mobile||!ud.token)return;
    try{
        const url=`${getApiBase()}/client/getMostOrderedItemsByCustomer/${encodeURIComponent(pId)}/${encodeURIComponent(bId)}/${encodeURIComponent(ud.contactMappingId)}/${encodeURIComponent(ud.mobile)}`;
        const r=await fetch(url,{headers:{token:ud.token}});
        if(!r.ok)return;
        const d=await r.json();
        const raw=Array.isArray(d)?d:(d.data||d.items||d.result||[]);
        if(!Array.isArray(raw)||!raw.length)return;
        // Prefer the in-memory feed item (rich variants/templates); fall back to mk(row).
        // API returns rows keyed by itemSlug (+total_qty) — match on slug first, then id.
        // normSlug: strip special chars so "buy-1-get-2nd-free-(large)" matches "buy-1-get-2nd-free-large".
        const normSlug=s=>(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
        mostOrderedItems=raw.map(row=>{
            const slug=row.itemSlug||row.slug||'';
            const id=row.id||row.itemId;
            let fromFeed=null;
            if(id!=null&&id!=='')fromFeed=allItems.find(x=>String(x.id)===String(id));
            if(!fromFeed&&slug){
                fromFeed=allItems.find(x=>x.slug===slug);
                if(!fromFeed){const ns=normSlug(slug);fromFeed=allItems.find(x=>normSlug(x.slug)===ns);}
            }
            if(fromFeed)return fromFeed;
            return row.itemName?mk(row):null;
        }).filter(Boolean);
        mostOrderedIds=new Set(mostOrderedItems.map(x=>String(x.id)));
        if(mostOrderedItems.length)render();
    }catch(e){/* silent — section just won't show */}
}

// ── Loyalty, guest state ─────────────────────────────────────────────────
// The coins banner below is a balance — it has nothing to say until the
// customer is logged in. #loyaltyGuest takes the same slot for a guest and
// sells the programme instead: what the points are called, and what an order
// earns. Both come from the CRM's generic rules call (no token, no mobile —
// the same call the /loyalty page makes for a logged-out visitor), so the band
// stays hidden on brands carrying the wallet flag with nothing configured
// behind it. Cached per parent for the tab session: these are brand-level
// config, not per-visit data, and the menu is a page people bounce in and out of.
const LOYALTY_RULES_KEY=`v4_loyalty_rules_${pId}`;
async function fetchLoyaltyRules(){
    try{const c=sessionStorage.getItem(LOYALTY_RULES_KEY);if(c)return JSON.parse(c)}catch{}
    const base=getCrmBase();if(!base||!pId)return null;
    try{
        const r=await fetch(`${base}/crm_api/get/loyalty/rules/details`,{
            method:'POST',
            headers:{authorization:getCrmAuthToken(),'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({parent_id:pId}),
        });
        if(!r.ok)return null;
        const d=await r.json();
        try{sessionStorage.setItem(LOYALTY_RULES_KEY,JSON.stringify(d))}catch{}
        return d;
    }catch{return null}
}
// Reveal the logged-out band. Called from both sources: the CRM rules call
// (milestone brands) and the earn catalog (item-based brands).
//
// No "Earn N% back" line here. The band's job while logged out is to get the
// customer signed in, and a rate quoted beside that ask is a second thing to
// read on a strip that already competes with the menu for the same glance —
// one the guest can't act on and can't verify until they have an account. The
// earn line survives only on the SIGNED-IN band (showMemberLoyalty), where it
// is the fallback for a member whose catalog prices nothing redeemable and the
// band would otherwise have nothing to say. Both still share #loyaltyGuestEarn,
// so this path leaves it hidden rather than the markup dropping it.
function showGuestLoyalty(){
    const band=ge('loyaltyGuest');if(!band)return;
    const ud=localStorage.getItem('userdata');
    if(ud&&ud!=='null'&&ud!=='')return;   // logged in → showMemberLoyalty owns this slot
    const earn=ge('loyaltyGuestEarn');
    if(earn)earn.hidden=true;
    const btn=ge('loyaltyGuestLogin');
    if(btn&&!btn.dataset.bound){
        btn.dataset.bound='1';
        // 'loyalty' marks this as a DELIBERATE login (the customer chose it),
        // not a prompt we forced to unblock a cart/checkout action.
        btn.addEventListener('click',()=>window.showLogin&&window.showLogin('loyalty'));
    }
    band.hidden=false;
}
// Signed-in band. Day zero (balance 0) and day N are the same component with a
// live number and a different CTA: nothing to spend yet → explain the programme;
// a balance → take them to what it can already buy.
// The band's balance figure, net of what the cart has already committed. Split out
// so a cart response that changes that figure can repaint it without re-running the
// whole band (which needs the catalog response this doesn't).
function paintLoyaltyBalance(){
    const copy=ge('loyaltyGuestCopy');
    if(!copy||walletBalance==null)return;
    // "My Hearts" for a brand that named its unit, "My Points" for one that didn't —
    // "My pts" is the one combination that reads badly, so the default keeps the word.
    const u=ptsUnit();
    copy.innerHTML=`<b>${spendableBalance()}</b> My ${u==='pts'?'Points':u}`;
}
function showMemberLoyalty(res){
    const band=ge('loyaltyGuest');if(!band)return;
    paintLoyaltyBalance();
    // No "Get X free for N pts" teaser here. It named ONE item out of a catalog
    // that routinely prices the whole menu, so it read as the offer rather than as
    // an example of it — and being the single cheapest row, it was the same name on
    // every visit. "Show N eligible" and "View items" already lead to the real list.
    // The earn line survives only for a member the catalog prices nothing redeemable
    // for, where a "% back" promise is the band's one remaining thing to say.
    const earn=ge('loyaltyGuestEarn');
    if(earn){
        const pct=parseFloat(res.allocation_pct||0);
        const redeemable=(()=>{let n=0;earnCatalog?.forEach(r=>{if(r.is_redeemable&&(+r.redeem_at_point||0)>0)n++});return n})();
        if(!redeemable&&pct>0){earn.textContent=`Earn ${+pct.toFixed(2)}% back`;earn.hidden=false}
        else earn.hidden=true;
    }
    band.classList.add('menu-loyalty--member');
    band.hidden=false;
    // syncFilterUI already ran on the catalog response, BEFORE the member class
    // above existed — and the filter button is gated on it. Re-run the one part
    // that cares, or the band paints with no action at all.
    syncLoyaltyEligibleToggle();
    refreshLoyaltyBandCta();
    const btn=ge('loyaltyGuestLogin');
    if(btn&&!btn.dataset.memberBound){
        btn.dataset.memberBound='1';
        btn.addEventListener('click',()=>{
            if(btn.dataset.act==='view')openMenuRedeemSheet();
            // ?how=1 so the loyalty page opens its "How it works" modal on arrival
            // — this CTA promised an explanation, not just the wallet page.
            else location.href='/loyalty?how=1';
        });
    }
}
// Does this item have something the catalog can say about it — points to earn,
// points to spend, or both? One predicate, used by the filter AND by the count on
// the toggle, so the two can't disagree. Counting catalog ROWS instead was off by
// two on La Pino'z: one row can back more than one rendered item (variants share
// a slug, and a slug can appear in two sections), so the number promised 292 and
// the filter produced 294.
function itemIsEligible(i){
    const r=earnRowFor(i);
    if(!r)return false;
    const burn=r.is_redeemable?(+r.redeem_at_point||0):0;
    const priced=(+r.earn_point||0)>0||burn>0;
    if(!priced)return false;
    // Signed in, "eligible" means THIS BALANCE CAN CLAIM IT. The control lives on
    // the points strip, directly beside the figure it acts on, so a list holding a
    // 4,800-point item against a 200-point balance reads as the filter not working.
    // It also brings the menu in line with the loyalty page, whose "Eligible items"
    // rail drops everything the balance can't reach — one word, one meaning, across
    // the two surfaces.
    // Guests have no balance to measure against, so the wider "the programme prices
    // this at all" reading stands for them; otherwise the filter would empty the
    // menu for the very visitor it's meant to sell to.
    if(walletBalance==null)return true;
    // The catalog's own verdict wins when it gives one, including a `false` — it can
    // know things the raw figure can't (a hold on the balance, an expiry, a tier
    // rule), and the card's own points strip (loyaltyBurn.burnStripHTML) already
    // treats it as authoritative. Reading the balance over it put items in the list —
    // and in the count beside the toggle — whose strip showed them as not claimable.
    // The balance is consulted only when the field is absent altogether.
    if(typeof r.affordable==='boolean')return r.affordable;
    return burn>0&&burn<=walletBalance;
}
function eligibleCount(){
    if(!earnCatalog)return 0;
    return allItems.reduce((n,i)=>n+(itemIsEligible(i)?1:0),0);
}
// The points strip's own filter toggle. Lives here rather than in the band's
// one-time paint because the band is repainted once per catalog fetch while this
// has to track every filter change — including the toolbar chip clearing it.
function syncLoyaltyEligibleToggle(){
    const btn=ge('loyaltyShowEligible');if(!btn)return;
    const n=eligibleCount();
    const on=picks.has('eligible');
    // Signed-in only. A guest band has exactly one thing to ask for — Log in — and
    // a second solid button beside it competes with it for the same press.
    if(!ge('loyaltyGuest')?.classList.contains('menu-loyalty--member')){btn.hidden=true;return}
    // Nothing priced means nothing to filter to, and a toggle that empties the
    // menu is worse than no toggle. Kept visible while ON regardless, so the
    // customer can always get back out of it.
    btn.hidden=n===0&&!on;
    // Solid to apply, outlined to clear — the same button, so the control never
    // moves out from under the finger that just pressed it.
    btn.textContent=on?'Show all items':'View eligible items';
    btn.classList.toggle('menu-loyalty__cta--clear',on);
    btn.setAttribute('aria-pressed',on?'true':'false');
}
function affordableCount(){
    if(!earnCatalog)return 0;
    let n=0;earnCatalog.forEach(r=>{if(r.affordable===true)n++});
    return n;
}
// The CTA's label/action depends on whether there's anything in the cart to
// review — separate from showMemberLoyalty's one-time paint because the cart
// changes on every add/remove while the band itself is only repainted once
// per catalog fetch. Called from there AND from cartRerender.
function refreshLoyaltyBandCta(){
    const band=ge('loyaltyGuest');
    if(!band||band.hidden||!band.classList.contains('menu-loyalty--member'))return;
    const btn=ge('loyaltyGuestLogin');if(!btn)return;
    // One action per band. The eligible-items filter is what a signed-in customer
    // came here for, so while it has something to filter TO it owns the slot and
    // this button stands down. It comes back when the catalog prices nothing —
    // there's no filter to offer then, and the band would otherwise have no action
    // at all.
    const filterOwnsSlot=eligibleCount()>0||picks.has('eligible');
    btn.hidden=filterOwnsSlot;
    if(filterOwnsSlot)return;
    // The sheet's only section is the cart's REDEEMABLE lines, and menuRedeemCartRows
    // drops anything this balance can't reach — so a full cart on a small balance
    // still opens it empty (header, a balance ticker and nothing under them). Ask
    // the sheet itself what it has rather than counting cart lines: that's the one
    // test that can't disagree with what the customer is about to see.
    const hasRedeemableLines=menuRedeemCartRows().length>0;
    btn.textContent=hasRedeemableLines?'View items':'How it works';
    btn.dataset.act=hasRedeemableLines?'view':'how';
}

// ── Eligible items sheet ─────────────────────────────────────────────────
// Opened from the loyalty band's "View items" CTA. Lists the redeemable items
// already in the cart with a checkbox each, so the customer can tick and untick
// to see what a redemption would cost and save. Nothing starts ticked and
// nothing is spent here — the menu page never mutates a redemption; the real
// spend happens in checkout's picker. This is a preview of the earn/burn case.
//
// A redemption frees the WHOLE line, so a row costs its per-unit rate times the
// quantity ordered — quoting the catalog's per-unit figure on a 5x line told
// the customer 650 pts for something that will charge 3,250.
let menuRedeemSelection={};   // item_slug -> true when ticked
// Slugs the customer has actually toggled in this sheet session. Without it a
// re-render (the cart response lands after the sheet opened, or any add/remove
// repaints it) can't tell "never decided" from "deliberately unticked", so an
// already-redeemed row either loses its tick — silently staging the removal of a
// redemption nobody asked to undo — or springs back after being unticked.
let menuRedeemTouched=new Set();

function menuRedeemCartRows(){
    if(!earnCatalog)return[];
    const rows=new Map();
    cart.items.forEach(ci=>{
        const it=findItem(ci.parentId||ci.id);
        if(!it||!it.slug)return;
        const row=earnCatalog.get(String(it.slug));
        if(!row||!row.is_redeemable)return;
        if(rows.has(it.slug))return;
        const qty=cartLinesFor(it).reduce((s,x)=>s+x.qty,0)||1;
        const cost=Math.floor(+row.redeem_at_point||0)*qty;
        if(cost<=0)return;
        // Eligible means the balance can actually claim it — a line beyond reach is
        // not an option the customer has. Measured against the catalog balance, not
        // what's left after ticking, so rows don't vanish and reappear mid-selection.
        // A line that's ALREADY redeemed stays regardless: hiding it would strand
        // the only control that can undo it.
        if(walletBalance!=null&&cost>walletBalance&&!(redeemedBySlug.get(String(it.slug))>0))return;
        // What the line earns if it is NOT ticked — the other half of the choice
        // each row offers, and the reason the row can't just show a burn cost.
        rows.set(it.slug,{slug:String(it.slug),item:it,row,pts:cost,qty,price:(+it.sp||0)*qty,
                          earn:earnPointsForLine(row,qty),redeemed:redeemedBySlug.get(String(it.slug))||0});
    });
    return[...rows.values()];
}

// The sheet lists what's in the cart and nothing else. A "more eligible items"
// list was tried and pulled: it re-prints the catalog (for a brand that maps its
// whole menu, that IS the whole menu), and the rows it surfaces include
// zero-priced variant-GROUP labels — "Mutton Curry Cut Platinum Grade - 2kg" is a
// label holding three cuts, not something a bare id can add. See
// docs/Loyalty-Item-Wise-RCA-And-Fixes.md §4; checkout's picker dropped the same
// section for the same reason.
function menuRedeemRowHTML(entry){
    const it=entry.item;
    const img=it.image?cardImgUrl(it.image):'';
    // No image → no cell at all. Never a brand-logo stand-in (on a food row a logo
    // reads as that item's photo) and never a reserved blank, which just leaves a
    // hole beside the illustrated rows. Same rule as the customise modal's add-ons.
    const imgTag=img?`<img class="redeem-row__img" src="${esc(img)}" alt="${esc(it.name)}" loading="lazy">`:'';
    const pts=Math.floor(+entry.pts||0);
    const qtyNote=(entry.qty>1)?` <span class="redeem-row__pts-qty">for ${entry.qty}</span>`:'';
    const checked=!!menuRedeemSelection[entry.slug];
    const earn=Math.floor(+entry.earn||0);
    // The grid's own control, not a lookalike: a stepper here IS the cart line's
    // stepper, driven by the same document-level .qb handler.
    const lines=cartLinesFor(it);
    const totalQty=lines.reduce((s,x)=>s+x.qty,0);
    const lastLineId=totalQty>0?lines[lines.length-1].id:it.id;
    const body=`
        ${imgTag}
        <span class="redeem-row__body">
            <span class="redeem-row__name">${esc(it.name)}</span>
            <span class="redeem-row__price">
                <span class="redeem-row__price-normal">₹${fmtP(entry.price)}</span>
                <span class="redeem-row__price-free"><s>₹${fmtP(entry.price)}</s> ₹0</span>
            </span>
        </span>
        ${addCtrlHTML(it,totalQty>0,totalQty,lastLineId)}`;

    // Already redeemed on the server. It renders TICKED rather than locked, so
    // unticking it stages the removal the confirm button then sends — the same
    // shape as checkout's picker, where a redemption can be undone or moved to a
    // different item in one pass. It keeps the green "redeemed" marker until the
    // customer unticks it, so the row still says where the points went.
    const redeemed=Math.floor(+entry.redeemed||0);
    const already=redeemed>0;
    const staysRedeemed=already&&checked;
    return`<label class="redeem-row${staysRedeemed?' redeem-row--redeemed':''}" data-slug="${esc(entry.slug)}" data-points="${pts}" data-qty="${entry.qty}" data-earn="${earn}" data-price="${entry.price}"${already?` data-already="${redeemed}"`:''}>
        <input type="checkbox" class="redeem-row__check"${checked?' checked':''}>
        ${body}
        ${staysRedeemed
            ? `<span class="redeem-row__pts redeem-row__pts--redeemed">${ptsFmt(redeemed)} pts<span class="redeem-row__pts-qty">redeemed</span></span>`
            : `<span class="redeem-row__pts">${ptsFmt(pts)} pts${qtyNote}</span>`}
    </label>`;
}

// Totals come from what's TICKED, measured against what's actually spendable.
//
// Four figures, the same ones checkout's picker keeps, because a sheet that can
// undo as well as spend has to tell them apart:
//   selectedBurn   — what the whole selection costs (so reopening with 680 already
//                    redeemed reads 680, not 0)
//   pendingNewBurn — only what THIS update would newly spend; the balance math and
//                    the CTA need the narrower figure
//   freedByRemoval — points an unticked already-redeemed row hands back, spendable
//                    again in this same pass, so a redemption can be MOVED from one
//                    item to another without leaving the sheet
//   dirty          — whether anything differs from what the server already holds
function recomputeMenuRedeemTotals(){
    const rowEls=[...document.querySelectorAll('#menuRedeemCartList .redeem-row')];
    let selectedBurn=0,pendingNewBurn=0,save=0,freed=0,dirty=false;
    rowEls.forEach(r=>{
        const ticked=!!menuRedeemSelection[r.dataset.slug];
        const alreadyPts=Number(r.dataset.already)||0;
        const pts=Number(r.dataset.points)||0;
        if(ticked!==(alreadyPts>0))dirty=true;
        if(ticked){
            // An already-redeemed row costs what it actually cost, not what the
            // catalog quotes today — the price it was taken at is the committed one.
            selectedBurn+=alreadyPts>0?alreadyPts:pts;
            save+=Number(r.dataset.price)||0;
            if(alreadyPts<=0)pendingNewBurn+=pts;
        }else if(alreadyPts>0)freed+=alreadyPts;
    });
    // spendableBalance() is already net of everything committed, so handing back a
    // committed row's points means adding them on top.
    const spendable=spendableBalance()+freed;
    const remaining=spendable-pendingNewBurn;

    rowEls.forEach(r=>{
        const ticked=!!menuRedeemSelection[r.dataset.slug];
        const alreadyPts=Number(r.dataset.already)||0;
        const ptsEl=r.querySelector('.redeem-row__pts');
        // Green "redeemed" marker only while the row is still ticked: untick it and
        // it goes back to quoting a price, because that's what it is again.
        r.classList.toggle('redeem-row--redeemed',alreadyPts>0&&ticked);
        if(!ptsEl)return;
        if(alreadyPts>0&&ticked){
            ptsEl.className='redeem-row__pts redeem-row__pts--redeemed';
            ptsEl.innerHTML=`${ptsWithUnit(alreadyPts)}<span class="redeem-row__pts-qty">redeemed</span>`;
            r.classList.remove('redeem-row--short');
            return;
        }
        ptsEl.className='redeem-row__pts';
        const pts=Number(r.dataset.points)||0;
        const short=!ticked&&pts>remaining;
        r.classList.toggle('redeem-row--short',short);
        if(short)ptsEl.textContent=`${ptsWithUnit(pts-remaining)} short`;
        else{
            // Rebuild the qty note too — plain textContent here wiped the "for N"
            // that menuRedeemRowHTML rendered, so a 5x line read as a unit price
            // the moment anything was ticked.
            const q=Number(r.dataset.qty)||1;
            ptsEl.innerHTML=`${ptsWithUnit(pts)}${q>1?` <span class="redeem-row__pts-qty">for ${q}</span>`:''}`;
        }
    });

    // Balance ticker: plain figure until the selection would move it.
    const before=ge('menuRedeemBalanceBefore'),sep=ge('menuRedeemBalanceSep'),
          val=ge('menuRedeemBalanceValue'),unit=ge('menuRedeemBalanceUnit');
    if(val){
        // Struck = the TOTAL the account holds; bold = what's left after everything
        // this order has taken (already-committed points plus anything staged here).
        // "Spendable right now" as the before hid the total entirely and, with every
        // redemption already applied, printed the same number twice.
        const total=walletBalance!=null?Math.floor(+walletBalance||0):0;
        const after=Math.max(0,remaining);
        if(after!==total){
            if(before){before.textContent=ptsFmt(total);before.hidden=false}
            if(sep)sep.hidden=false;
            val.textContent=ptsFmt(after);
            if(unit)unit.textContent=`${ptsUnit()} left`;
        }else{
            if(before)before.hidden=true;
            if(sep)sep.hidden=true;
            val.textContent=ptsFmt(total);
            if(unit)unit.textContent=ptsUnit();
        }
    }
    const banner=ge('menuRedeemSavingsBanner');
    if(banner){
        if(save>0){const a=ge('menuRedeemSavingsAmt');if(a)a.textContent=`₹${fmtP(save)}`;banner.hidden=false}
        else banner.hidden=true;
    }
    // The footer carries the CTA now, so it stays up whenever there are rows to act
    // on; only the burn pill comes and goes with the selection.
    const footer=ge('menuRedeemBurnFooter');
    if(footer)footer.hidden=!rowEls.length;
    const pill=ge('menuRedeemBurnPill');
    if(pill){
        if(selectedBurn>0){const t=ge('menuRedeemBurnTotal');if(t)t.textContent=ptsWithUnit(selectedBurn);pill.hidden=false}
        else pill.hidden=true;
    }
    const cta=ge('menuRedeemConfirmBtn');
    if(cta){
        cta.disabled=!dirty;
        // The label names the price of the action: spending points says so, a
        // selection that only gives them back is just an update.
        cta.textContent=pendingNewBurn>0?`Get free for ${ptsWithUnit(pendingNewBurn)}`:'Update cart';
    }
}

function renderMenuRedeemSheet(){
    const cartItems=menuRedeemCartRows();

    // A row the customer hasn't touched shows the server's state: redeemed → ticked.
    // Done on every render, not just on open, because the cart response that reveals
    // a redemption often lands after the sheet is already on screen.
    cartItems.forEach(e=>{
        if(menuRedeemTouched.has(e.slug))return;
        if(e.redeemed>0)menuRedeemSelection[e.slug]=true;
        else delete menuRedeemSelection[e.slug];
    });

    const cartSection=ge('menuRedeemCartSection'),cartList=ge('menuRedeemCartList');
    if(cartSection&&cartList){
        if(cartItems.length){cartSection.hidden=false;cartList.innerHTML=cartItems.map(menuRedeemRowHTML).join('')}
        else{cartSection.hidden=true;cartList.innerHTML=''}
    }

    // Anything ticked in a previous pass that has since left the cart would keep
    // its points in the burn total with no row to untick it from.
    const inCartSlugs=new Set(cartItems.map(e=>e.slug));
    Object.keys(menuRedeemSelection).forEach(s=>{if(!inCartSlugs.has(s))delete menuRedeemSelection[s]});

    // Paints the balance ticker, the savings banner and every row's points column.
    recomputeMenuRedeemTotals();
}
function bindMenuRedeemSheetEvents(){
    const overlay=ge('menuRedeemOverlay');
    if(!overlay||overlay.dataset.bound)return;
    overlay.dataset.bound='1';
    overlay.addEventListener('click',e=>{
        if(e.target===overlay||e.target.closest('.popup-close')){overlay.hidden=true;return}
        // Stepper (−/+) on a row: the document-level .qb handler already drives
        // it, and cartRerender re-renders this sheet afterwards. The one case to
        // intercept is the variant/addon "+", which opens the item popup — that
        // can't sit under this overlay, so step out of the way first.
        const qb=e.target.closest('.qb');
        if(qb&&qb.dataset.d==='pop')overlay.hidden=true;
    });
    // Delegated: rows are re-rendered on every open and on every cart change.
    overlay.addEventListener('change',e=>{
        const check=e.target.closest('.redeem-row__check');
        if(!check)return;
        const rowEl=check.closest('.redeem-row');
        const slug=rowEl.dataset.slug;
        if(check.checked){
            // Gate at the moment of ticking: a row that doesn't fit what's left
            // reverts, and its shortfall label already says why. An already-redeemed
            // row is exempt — re-ticking it only restores what the server already
            // holds, so there is nothing to afford.
            if(!(Number(rowEl.dataset.already)||0)){
                let burn=0,freed=0;
                document.querySelectorAll('#menuRedeemCartList .redeem-row').forEach(r=>{
                    if(r===rowEl)return;
                    const a=Number(r.dataset.already)||0,on=!!menuRedeemSelection[r.dataset.slug];
                    if(on&&a<=0)burn+=Number(r.dataset.points)||0;
                    else if(!on&&a>0)freed+=a;
                });
                if((Number(rowEl.dataset.points)||0)>spendableBalance()+freed-burn){
                    check.checked=false;
                    recomputeMenuRedeemTotals();
                    return;
                }
            }
            menuRedeemSelection[slug]=true;
        }else delete menuRedeemSelection[slug];
        menuRedeemTouched.add(slug);
        recomputeMenuRedeemTotals();
    });
    ge('menuRedeemConfirmBtn')?.addEventListener('click',confirmMenuRedeem);
}

// ── Redemption writes ────────────────────────────────────────────────────
// The same two legacy endpoints checkout uses (item_based_loyalty=1 branches the
// backend into a per-line redemption instead of an order-level wallet apply).
// Deliberately duplicated from checkout.js rather than hoisted into loyaltyBurn.js:
// adding an export to a shared module and consuming it in the same deploy is the
// one change that breaks live, since nested imports are unversioned and cached for
// 30 days. Two small copies beat a SyntaxError on every menu page.
function redeemWriteParams(orderItemId){
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    return new URLSearchParams({
        businessId:bId,
        contactMappingId:ud?.contactMappingId||'',
        token:ud?.token||'',
        userId:ud?.contactId||'',
        mobileNo:ud?.mobile||ud?.mobileNo||'',
        parentBusinessId:pId||'',
        orderId:serverOrderId||'',
        item_based_loyalty:'1',
        orderItemId,
    });
}
async function applyMenuRedemption(orderItemId,points){
    if(!serverOrderId)return{status:0,msg:'Add items to your cart first.'};
    const p=redeemWriteParams(orderItemId);
    p.set('points',String(Math.floor(+points||0)));
    try{
        const r=await fetch(`${getApiBase()}/client/applyWallet?${p}`,{method:'GET',headers:{'Accept':'application/json'}});
        return await r.json();
    }catch{return{status:0,msg:'Could not redeem this item. Please try again.'}}
}
async function removeMenuRedemption(orderItemId){
    if(!serverOrderId)return{status:0,msg:'Add items to your cart first.'};
    try{
        const r=await fetch(`${getApiBase()}/client/removeWallet?${redeemWriteParams(orderItemId)}`,{method:'GET',headers:{'Accept':'application/json'}});
        return await r.json();
    }catch{return{status:0,msg:'Could not remove this redemption. Please try again.'}}
}

// The shared confirmation panel (partials/redeem_outcome_modal.php), in the same
// two registers checkout renders it: a spend celebrates, an undo reports.
const _MENU_ICON_CHECK ='<polyline points="20 6 9 17 4 12"/>';
const _MENU_ICON_RETURN='<polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>';
function renderRedeemOutcome({returned=false,points=null,balBefore=null}={}){
    const overlay=ge('redeemSuccessOverlay');
    const figure=Math.floor(Number(points==null?committedBurnPts:points))||0;
    if(!overlay||figure<=0){showToast('Cart updated.');return}

    overlay.classList.toggle('co-redeem-done--returned',returned);
    const icon=overlay.querySelector('.co-redeem-done__tick svg');
    if(icon)icon.innerHTML=returned?_MENU_ICON_RETURN:_MENU_ICON_CHECK;
    const set=(id,v)=>{const e=ge(id);if(e)e.textContent=v};
    set('redeemDoneLabel',returned?'Points returned':'Points to redeem');
    set('redeemDonePts',ptsFmt(figure));
    set('redeemDoneFootnote',returned?'Points are back on your balance':'Final redemption happens after payment');

    // Rupees the redeemed lines take off the bill, from the cart the sheet renders.
    const saved=returned?0:menuRedeemCartRows().reduce((sum,e)=>sum+(e.redeemed>0?e.price:0),0);
    const savedWrap=ge('redeemDoneSavedWrap');
    if(savedWrap){
        if(saved>0){set('redeemDoneSaved',`₹${fmtP(saved)}`);savedWrap.hidden=false}
        else savedWrap.hidden=true;
    }

    const before=balBefore==null?(walletBalance!=null?Math.floor(+walletBalance||0):0):balBefore;
    set('redeemDoneBalBefore',ptsFmt(before));
    set('redeemDoneBalAfter',ptsFmt(spendableBalance()));

    // What the cart still earns, redeemed lines excluded — they were paid for in
    // points, so there is no spend left on them to earn against.
    const earn=menuRedeemCartRows().reduce((sum,e)=>sum+(e.redeemed>0?0:e.earn),0);
    const earnRow=ge('redeemDoneEarnRow');
    if(earnRow){
        set('redeemDoneEarnLabel',returned?'This order now earns':'This order still earns');
        if(earn>0){set('redeemDoneEarn',`+${ptsWithUnit(earn)}`);earnRow.hidden=false}
        else earnRow.hidden=true;
    }
    overlay.hidden=false;
    ge('redeemDoneBtn')?.addEventListener('click',()=>{overlay.hidden=true},{once:true});
}

// The server lines behind one sheet row, with what redeeming each would cost.
// The sheet groups by ITEM (one row per item, qty summed across lines) while a
// redemption is applied per ORDER LINE, so one tick can mean several calls — an
// item added twice with different add-ons is two lines on the server.
// A line the local cart hasn't synced yet has no id and can't be redeemed; the
// caller refuses the whole update rather than silently redeeming part of it.
function menuRedeemServerLines(entry){
    const unit=Math.floor(+entry.row.redeem_at_point||0);
    return cartLinesFor(entry.item).map(l=>({
        orderItemId:l&&l.serverItemId?String(l.serverItemId):'',
        points:unit*(Number(l&&l.qty)||1),
    }));
}

// Sends the difference between what's ticked and what the server already holds —
// the same per-line apply/remove calls checkout's picker makes, against the same
// cart. A redemption made here is simply already applied when the customer reaches
// checkout; nothing has to be handed across.
async function confirmMenuRedeem(){
    const btn=ge('menuRedeemConfirmBtn');
    if(!btn||btn.disabled)return;
    // Same clubbing rule checkout enforces: points and a promo can't both apply to one
    // order unless the outlet opts in. Without this the server takes the redemption and
    // then re-prices the line when the promo recalculates, so the item the customer
    // made free quietly costs money again.
    if(appliedPromoCode&&!walletPromoCombinedAllowed){
        showToast('Remove the applied promo to redeem points.');
        return;
    }
    const entries=new Map(menuRedeemCartRows().map(e=>[e.slug,e]));
    const changed=[...document.querySelectorAll('#menuRedeemCartList .redeem-row')]
        .map(r=>({
            entry:entries.get(r.dataset.slug),
            wasAlready:(Number(r.dataset.already)||0)>0,
            nowChecked:!!menuRedeemSelection[r.dataset.slug],
        }))
        .filter(c=>c.entry&&c.nowChecked!==c.wasAlready);
    if(!changed.length)return;

    const ops=[];
    for(const c of changed){
        for(const line of menuRedeemServerLines(c.entry)){
            if(!line.orderItemId){showToast('Your cart is still syncing — try again in a moment.');return}
            ops.push({...line,apply:c.nowChecked});
        }
    }

    btn.disabled=true;btn.textContent='Updating…';
    // Captured before the writes: the refreshed cart no longer holds them, and an
    // undo has to say what came back and what the balance was.
    const spentBefore=committedBurnPts,balBefore=spendableBalance();
    const errors=[];
    for(const op of ops){
        const r=op.apply?await applyMenuRedemption(op.orderItemId,op.points)
                        :await removeMenuRedemption(op.orderItemId);
        if(Number(r?.status)!==1)errors.push(r?.msg||'Could not update this item.');
    }
    await fetchServerCart();      // re-reads wallet_points_redeemed → noteCommittedBurn
    await loadEarnCatalog();      // balance + per-item rates, straight from CRM
    // The server now holds what was staged, so the staged state stops being the
    // customer's pending intent and becomes the thing the rows report.
    menuRedeemTouched=new Set();
    renderMenuRedeemSheet();
    btn.textContent='Update cart';

    if(errors.length){errors.forEach(m=>showToast(m));return}
    const overlay=ge('menuRedeemOverlay');if(overlay)overlay.hidden=true;
    renderRedeemOutcome(ops.some(o=>o.apply)?{}:{returned:true,points:spentBefore-committedBurnPts,balBefore});
}

function openMenuRedeemSheet(){
    if(!earnCatalog)return;
    // Nothing touched yet — renderMenuRedeemSheet seeds every row from what the
    // server already holds, so an already-redeemed row opens ticked and unticking
    // it is how the customer takes that redemption back.
    menuRedeemSelection={};
    menuRedeemTouched=new Set();
    renderMenuRedeemSheet();
    bindMenuRedeemSheetEvents();
    const overlay=ge('menuRedeemOverlay');
    if(overlay)overlay.hidden=false;
}
// Repaints the sheet (if open) and the band's CTA after any cart mutation —
// hooked into cartRerender, the one choke point every add/remove/qty-change
// already goes through.
function refreshMenuRedeemUI(){
    refreshLoyaltyBandCta();
    const overlay=ge('menuRedeemOverlay');
    if(overlay&&!overlay.hidden)renderMenuRedeemSheet();
}

async function initGuestLoyalty(){
    const band=ge('loyaltyGuest');if(!band)return;
    // Wallet flags decide the milestone-model band; item-based brands reach it
    // through the catalog instead (loadEarnCatalog → showGuestLoyalty).
    if(!(C.walletOn==1))return;
    // Logged in → fetchWalletCoins owns this slot.
    const ud=localStorage.getItem('userdata');
    if(ud&&ud!=='null'&&ud!=='')return;
    // Dev preview (?mock_loyalty=1, paired with the view's own check): show the
    // band on an outlet with no programme behind it, filling only what the CRM
    // can't supply. Never reached without the flag in the URL.
    const mock=new URLSearchParams(location.search).get('mock_loyalty')==='1';
    const rules=await fetchLoyaltyRules();
    if(!mock&&(!rules||rules.status===false||rules.status===0))return;
    // The wallet's own name ("LP Coins", "Hearts") still comes off the rules — it
    // is what the band's one remaining line is about. The entry-tier rate used to
    // be read here too, for an "Earn N% back" line the band no longer carries.
    const wallet=String(rules?.walletName||'').trim();
    const nameEl=ge('loyaltyGuestWallet');
    if(wallet&&nameEl)nameEl.textContent=wallet;
    showGuestLoyalty();
}

// Paint the logged-in coins banner. Two callers, one painter: the earn catalog
// (item-based brands, whose balance rides along with the rates they already
// fetch) and getWalletDetails (milestone brands, which have no catalog).
function paintCoinsBanner(balance,walletName,rule){
    const banner=ge('coinsBanner');if(!banner)return;
    const bal=Math.floor(+balance||0);
    if(bal<=0)return;
    // Figure and label are separate elements now: the band prints "992 My LP Coins"
    // the way the item-based band prints "992 My Hearts", so the number is the
    // headline on both rather than being buried mid-sentence on one of them.
    const amt=ge('coinsAmount');if(amt)amt.textContent=String(bal);
    const wal=ge('coinsWallet');if(wal)wal.textContent=walletName||'Coins';
    const ruleEl=ge('coinsRule');if(ruleEl&&rule)ruleEl.textContent=rule;
    banner.hidden=false;
    const toggle=ge('coinsToggle'),details=ge('coinsDetails');
    if(toggle&&details&&!toggle.dataset.bound){
        toggle.dataset.bound='1';
        toggle.addEventListener('click',()=>{
            details.hidden=!details.hidden;
            banner.classList.toggle('open',!details.hidden);
            toggle.setAttribute('aria-expanded',String(!details.hidden));
        });
    }
}
// Milestone-model brands only — item-based brands get the same number out of the
// earn catalog they already call, so this second round trip is skipped for them
// (see the call sites' burnCatalogEnabled() guard). Keeps one balance on screen:
// two endpoints reading the same `wallet` row could otherwise disagree mid-flight.
async function fetchWalletCoins(){
    const banner=ge('coinsBanner');if(!banner)return;
    try{
        const ud=JSON.parse(localStorage.getItem('userdata')||'null');
        if(!ud||!ud.token)return;
        const res=await fetch(`${getApiBase()}/client/getWalletDetails?contactMappingId=${encodeURIComponent(ud.contactMappingId||'')}&businessId=${bId}&token=${encodeURIComponent(ud.token)}&parentBusinessId=${pId}&mobileNo=${encodeURIComponent(ud.mobile||'')}`);
        const d=await res.json();
        if(d.status!==1||!d.walletDetails?.length)return;
        // Sum balance across all wallet entries (groups by mobile, usually 1 row, but handle multi)
        const totalBal=Math.floor(d.walletDetails.reduce((s,w)=>s+(+w.available||0),0));
        // Wallet rule (e.g. "5% of Wallet Value can be paid...") — from first entry
        paintCoinsBanner(totalBal,d.walletName||'Coins',d.walletDetails[0].wallet_rule||'');
    }catch{}
}
function updateBar(){
    const bar=ge('floatingCartBar'),cnt=ge('cartCount'),tot=ge('cartTotal'),suf=ge('cartItemsSuffix');
    const n=cart.items.reduce((s,i)=>s+i.qty,0);
    // CI3 parity: when the outlet is closed the cart bar must not act as a
    // checkout entry point. Show it (so users still see what's in the cart)
    // but render it disabled — goToCheckout() blocks navigation and the label
    // reflects the closed state instead of "View Cart".
    if(bar){bar.hidden=!n; bar.classList.toggle('show', n>0); bar.classList.toggle('closed', n>0&&!isOpen)}
    if(cnt)cnt.textContent=n;
    if(suf)suf.textContent=n===1?'':'s';
    if(tot)tot.textContent=Math.round(cart.total);
    // Two lengths for the same state. The info title (desktop) has the pill's full
    // width; the CTA label (mobile) is a narrow inline pill, and feeding it the long
    // sentence pushed the bar past its 360px max-width and clipped the chevron.
    const lbl=isOpen?'View Cart':(isTempClosed?'Outlet is temporarily unavailable':'Outlet is currently closed');
    const ctaTxt=isOpen?'View Cart':(isTempClosed?'Unavailable':'Closed');
    const title=ge('floatingCartBar')?.querySelector('.menu-cart-info__title');
    const ctaLbl=ge('floatingCartBar')?.querySelector('.menu-cart-cta__label');
    if(title)title.textContent=lbl;
    if(ctaLbl)ctaLbl.textContent=ctaTxt;
    updateSearchBar(n,lbl,ctaTxt);
}
// The page floating cart bar sits behind the z-2100 search overlay, so the
// overlay carries its own identical "View Cart" pill. Mirrors floatingCartBar's
// show/closed state, count, total and label exactly (same component classes).
function updateSearchBar(n,lbl,ctaTxt){
    const bar=ge('searchCartBar');if(!bar)return;
    bar.classList.toggle('show', n>0); bar.classList.toggle('closed', n>0&&!isOpen);
    const c=ge('searchCartCount'),s=ge('searchCartSuffix'),t=ge('searchCartTotal');
    if(c)c.textContent=n;
    if(s)s.textContent=n===1?'':'s';
    if(t)t.textContent=Math.round(cart.total);
    const title=bar.querySelector('.menu-cart-info__title');
    const ctaLbl=bar.querySelector('.menu-cart-cta__label');
    if(title)title.textContent=lbl;
    if(ctaLbl)ctaLbl.textContent=ctaTxt??lbl;
}

// Right-side cart panel removed — the sticky .menu-cart-bar at the bottom is
// the only cart entry point on the menu page now.
function renderCartPanel(){ /* no-op */ }

async function goToCheckout(){if(!isOpen){showToast(isTempClosed?'Outlet is temporarily unavailable':(startHours?`Outlet is currently closed. Opens at ${startHours.toLowerCase()}`:'Outlet is currently closed'));return}const ud=localStorage.getItem('userdata');if(!ud||ud==='null'||ud===''){if(window.showLogin)window.showLogin();return}await drainSyncs();trackBeginCheckout({value:cart.total||0,items:analyticsItems(),deliveryType:localStorage.getItem('orderType')||'1'});const ot=localStorage.getItem('orderType')||'1';const tid=localStorage.getItem('tableId');if(ot==='3'&&tid&&tid!=='null'&&Number(tid)>0){location.href='/checkout/'+bId+'/'+ot+'/'+tid;}else{location.href='/checkout/'+bId+'/'+ot;}}

// ── Events ──
function bindAll(){
    // CI3 parity: a missing or broken item image must show NOTHING — never a
    // broken-image icon. Image 'error' events don't bubble, so capture them at
    // the document and drop any failed image inside the menu grid or a popup.
    // Once removed, the wrapper collapses via the `:not(:has(img))` rules in
    // menu.css. Listener-based (not inline onerror) to match the module's
    // delegated-handler style.
    document.addEventListener('error',e=>{
        const t=e.target;
        if(!(t&&t.tagName==='IMG'))return;
        // Inside an item popup, a broken item photo falls back to the
        // grayscaled brand logo so the image area stays filled — no collapse,
        // no flicker, no buttons-over-headings. Elsewhere (menu grid) a broken
        // image shows nothing, per CI3 parity.
        // Hero/detail photo and combo thumbnails keep their cell filled with
        // the grayscaled brand logo (removing a combo thumb would collapse its
        // grid cell and shift the row). Combo thumb classes sit on the <img>.
        // Add-on thumbs get no logo stand-in (a logo on a food option reads as that
        // option's photo). Drop the whole cell and the --media class so the row
        // collapses to the plain 3-column layout — matching how a row with no image
        // is built in the first place, rather than leaving a hole.
        const addonThumb=t.closest('.popup-addon__thumb');
        if(addonThumb){
            addonThumb.closest('.popup-addon')?.classList.remove('popup-addon--media');
            addonThumb.remove();
            return;
        }
        if((t.closest('.popup-detail-img,.popup-hero')||t.matches('.combo-section__thumb,.combo-option__img'))&&!t.classList.contains('popup-img-fallback')&&bLogo){
            t.classList.add('popup-img-fallback');
            t.removeAttribute('srcset');
            t.alt='';
            t.src=bLogo;
            return;
        }
        // Tag/USP icons (getFilterList-sourced — toolbar chips, filter
        // sheet, search modal, the mobile USP bar) live outside
        // #dynamicMenuContent/.popup-overlay, so they weren't covered by the
        // rule below. Same "never show a broken glyph" policy: an icon-only
        // chip has nothing left without its icon, so drop the whole chip;
        // everywhere else (label still present) just drop the <img>.
        if(t.closest('.tag--icon-only')){t.closest('.tag--dyn')?.remove();return;}
        if(t.matches('.usp-toggle__icon,.menu-chip--tag img,.tag--dyn img')){t.remove();return;}
        if(t.closest('#dynamicMenuContent,.popup-overlay'))t.remove();
    },true);
    // Reflect default picks (e.g. in_stock) across toolbar + filter-sheet + search chips.
    syncFilterUI();
    // Empty-state CTAs (clear filters / reload). Delegated so the buttons work
    // every time render() re-emits the empty-state markup.
    ge('dynamicMenuContent')?.addEventListener('click',e=>{
        const act=e.target.closest('[data-empty-action]')?.dataset.emptyAction;
        if(!act)return;
        if(act==='clear-filters'){
            picks.clear();veg='';q='';sortBy='';activeTagKeys.clear();
            syncFilterUI();
            render();
        } else if(act==='reload'){
            location.reload();
        }
    });
    // Desktop/tablet: inline input in the toolbar live-filters the main grid via render().
    // Mobile (≤767px): the toolbar input is CSS-hidden; bottom-bar trigger opens the modal.
    const mi=ge('menuSearchInput');
    if(mi){let t;mi.addEventListener('input',()=>{clearTimeout(t);const v=mi.value;t=setTimeout(()=>{q=v.trim().toLowerCase();render();trackSearchOnce(q,filt(allItems).length)},280)})}
    // Phone: the field now lives in the header (it used to be hidden below 768px
    // while the bottom bar carried a search button). Tapping it opens the SAME
    // full-screen overlay that button opened — popular searches, in-modal filters,
    // add-to-cart — rather than live-filtering behind a keyboard that would cover
    // most of the results and leave the sticky header holding the query.
    // Blur first so the phone keyboard rises once, for the modal's own input.
    // The inline `input` handler above is left alone: on this path nothing is ever
    // typed into this field, so it simply never fires.
    if(mi){
        const mq=window.matchMedia('(max-width: 767px)');
        mi.addEventListener('focus',()=>{if(!mq.matches)return;mi.blur();openSearch()});
    }
    ge('mobileSearchBtn')?.addEventListener('click',openSearch);
    initVoiceSearch();
    ge('searchBack')?.addEventListener('click',closeSearch);
    ge('searchOverlay')?.addEventListener('click',e=>{if(e.target.id==='searchOverlay')closeSearch()});
    const si=ge('searchInput');
    if(si){let t;si.oninput=()=>{clearTimeout(t);const v=si.value;t=setTimeout(()=>doSearch(v),280)}}
    // Search modal's own "Clear filters" CTA (searchEmptyStateHTML) — resets
    // query + filter state and falls back to the popular-searches view, same
    // as reopening the modal fresh.
    ge('searchResults')?.addEventListener('click',e=>{
        if(!e.target.closest('[data-empty-action="clear-search"]'))return;
        picks.clear();veg='';sortBy='';activeTagKeys.clear();
        if(si)si.value='';
        syncFilterUI();syncSearchFilters();
        doSearch('');
    });

    // Search modal filter chips — modify global state + re-run search
    const srchVal=()=>ge('searchInput')?.value||'';
    document.querySelectorAll('.srch-diet-btn').forEach(b=>b.onclick=()=>{veg=(veg===b.dataset.diet)?'':b.dataset.diet;syncFilterUI();doSearch(srchVal())});
    document.querySelectorAll('.srch-sort-btn').forEach(b=>b.onclick=()=>{sortBy=b.dataset.sort;syncFilterUI();doSearch(srchVal())});
    document.querySelectorAll('.srch-pick-btn').forEach(b=>b.onclick=()=>{const k=b.dataset.pick;picks.has(k)?picks.delete(k):picks.add(k);syncFilterUI();doSearch(srchVal())});

    // Veg filter + quick picks
    // Toolbar chips apply immediately — there is no Apply button on this surface, so the
    // click IS the commit. trackFiltersOnce de-dupes against the resulting filter set.
    document.querySelectorAll('[data-veg-filter]').forEach(b=>b.onclick=()=>{veg=(veg===b.dataset.vegFilter)?'':b.dataset.vegFilter;syncFilterUI();trackFiltersOnce();render()});
    // Dismissing the diet dropdown: a click anywhere else, or Escape, closes it and
    // changes nothing (R13). It is position:fixed against a chip that scrolls in two
    // directions (the page, and the chip rail itself), so it re-aims on both — capture
    // phase, since the rail's own scroll event doesn't bubble.
    document.addEventListener('click',e=>{
        if(!dietMenuIsOpen())return;
        if(e.target.closest('#dietMenu')||e.target.closest('.diet-chip'))return;
        closeDietMenu();syncFilterUI();
    });
    document.addEventListener('keydown',e=>{
        if(e.key==='Escape'&&dietMenuIsOpen()){closeDietMenu();syncFilterUI();dietMenuAnchor?.focus?.();}
    });
    window.addEventListener('scroll',dietMenuPosition,{passive:true});
    window.addEventListener('resize',dietMenuPosition,{passive:true});
    document.addEventListener('scroll',dietMenuPosition,{passive:true,capture:true});

    // The Veg group chip (toolbar + search modal). With an egg dish on the menu it
    // opens the Pure Veg / Veg & Egg dropdown; without one it is the plain Veg toggle
    // it has always been (R2). Its ✕ always clears outright, never opening the
    // dropdown first (R12) — hence the hit-test on .menu-chip__x before anything else.
    document.querySelectorAll('.diet-chip').forEach(b=>b.onclick=e=>{
        const fromSearch=!!b.closest('#searchFilterChips');
        const commit=()=>{syncFilterUI();trackFiltersOnce();if(fromSearch)doSearch(srchVal());else render();};
        if(e.target.closest('.menu-chip__x')){closeDietMenu();veg='';commit();return;}
        if(!menuHasEgg){veg=(veg==='veg')?'':'veg';commit();return;}
        if(dietMenuIsOpen()&&dietMenuAnchor===b)closeDietMenu();else openDietMenu(b);
        syncFilterUI();
    });
    document.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{const k=b.dataset.quick;picks.has(k)?picks.delete(k):picks.add(k);syncFilterUI();trackFiltersOnce();render()});
    // The points strip's eligible toggle — the band's only action once a catalog
    // has priced anything, so it turns the filter on AND back off.
    const elig=ge('loyaltyShowEligible');
    if(elig)elig.onclick=()=>{
        picks.has('eligible')?picks.delete('eligible'):picks.add('eligible');
        syncFilterUI();trackFiltersOnce();render();
        // Turning it on filters the menu below the fold — bring the list into view
        // rather than leaving the customer looking at an unchanged screen.
        if(picks.has('eligible'))ge('dynamicMenuContent')?.scrollIntoView({behavior:'smooth',block:'start'});
    };

    // Order-type dropdown (.ots) — open/close + option select
    const ots=ge('ots'),otsTrigger=ge('ots-trigger'),otsLabel=ge('ots-label');
    if(ots&&otsTrigger){
        otsTrigger.addEventListener('click',e=>{e.stopPropagation();ots.classList.toggle('open');otsTrigger.setAttribute('aria-expanded',ots.classList.contains('open'))});
        document.addEventListener('click',e=>{if(!ots.contains(e.target))ots.classList.remove('open')});
    }
    // Apply the actual OT switch — extracted so the confirm modal can call it on OK.
    function applyOrderType(b, ot) {
        const otMap={delivery:'1',pickup:'2',dine_in:'3',in_car:'4'};
        // Order-type switch on the menu — the other committed toggle besides checkout's
        // navigateToOt. `source` separates the two, since intent differs: switching here is
        // early browsing behaviour, switching at checkout is late-stage hesitation.
        window.Analytics?.trackDeliveryTypeSelected?.({deliveryType:ot,source:'menu'});
        localStorage.setItem('orderType',otMap[ot]||'1');
        // Switching TO in-car: warm the GPS fix now, while we still have the click that
        // confirmed the switch. Browsers treat a permission prompt raised from a user gesture
        // far better than one raised from a background fetch, and every cart call from here on
        // needs it. Stale fix from a previous in-car session is dropped — the car has moved.
        if(ot==='in_car'){carLoc=null;ensureInCarLocation()}
        document.dispatchEvent(new CustomEvent('ordertype:changed'));
        document.cookie=`order_type=${ot==='pickup'?'pick_up':ot};path=/;max-age=2592000`;
        document.querySelectorAll('.ot-btn').forEach(x=>{x.classList.remove('on');const t=x.querySelector('.ots-tick');if(t)t.remove()});
        b.classList.add('on');
        const tickSlot=b.querySelector(':scope > span:last-child');
        if(tickSlot&&!tickSlot.querySelector('.ots-tick'))tickSlot.innerHTML='<span class="ots-tick"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>';
        if(otsLabel){const lbl=b.querySelector('.ots-opt-body b');if(lbl)otsLabel.textContent=lbl.textContent}
        if(ots)ots.classList.remove('open');
        updateOtsStrip(ot);
        // Re-filter the offer strip for the new order type. When the dine-state
        // also flips, load() re-renders offers from a fresh feed anyway; this
        // covers the delivery↔pickup case where load() does not run.
        refreshOffers();
        if(hasDineMenu){const shouldDine=(ot==='dine_in'||ot==='pickup');if(shouldDine!==isDine){isDine=shouldDine;load()}}
    }

    document.querySelectorAll('.ot-btn').forEach(b=>b.onclick=()=>{
        if(b.disabled||b.classList.contains('off'))return;
        const ot=b.dataset.ot;
        // Already-active OT: just close the dropdown, no confirm popup.
        if(b.classList.contains('on')){if(ots)ots.classList.remove('open');return;}
        // Mirror checkout's order-type confirmation flow (checkout.js:3340 showOrderTypeConfirm).
        // Gate the switch behind a confirmation popup so users don't accidentally flip OT and
        // lose context (especially Delivery → Pickup which has different fulfillment).
        showOrderTypeConfirm(ot, () => applyOrderType(b, ot));
    });

    // Reconcile localStorage.orderType ↔ the PHP-rendered .on button on init.
    // Without this sync, a stale localStorage value (e.g. '4' from a previous session) silently
    // sends the wrong orderType to /checkout while the menu visually shows a different one.
    // If stored value maps to a currently-enabled OT, restore that visual; otherwise write the
    // PHP default into localStorage so goToCheckout() sends a consistent value.
    (() => {
        const otMap        = {delivery:'1',pickup:'2',dine_in:'3',in_car:'4'};
        const otReverseMap = {'1':'delivery','2':'pickup','3':'dine_in','4':'in_car'};
        const stored       = localStorage.getItem('orderType');
        const storedKey    = stored ? otReverseMap[stored] : null;
        const storedBtn    = storedKey
            ? document.querySelector(`.ot-btn[data-ot="${storedKey}"]`)
            : null;
        const isUsable     = storedBtn && !storedBtn.disabled && !storedBtn.classList.contains('off');

        if (isUsable) {
            // Honor the user's last choice: re-mark the matching button and refresh the strip.
            document.querySelectorAll('.ot-btn').forEach(x => {
                x.classList.remove('on');
                const t = x.querySelector('.ots-tick');
                if (t) t.remove();
            });
            storedBtn.classList.add('on');
            const tickSlot = storedBtn.querySelector(':scope > span:last-child');
            if (tickSlot && !tickSlot.querySelector('.ots-tick')) {
                tickSlot.innerHTML = '<span class="ots-tick"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>';
            }
            if (otsLabel) {
                const lbl = storedBtn.querySelector('.ots-opt-body b');
                if (lbl) otsLabel.textContent = lbl.textContent;
            }
            document.cookie = `order_type=${storedKey==='pickup'?'pick_up':storedKey};path=/;max-age=2592000`;
            updateOtsStrip(storedKey);
            if (hasDineMenu) {
                const shouldDine = (storedKey==='dine_in' || storedKey==='pickup');
                if (shouldDine !== isDine) { isDine = shouldDine; load(); }
            }
        } else {
            // No valid stored value — write the PHP-rendered default to localStorage.
            const defaultKey = document.querySelector('.ot-btn.on')?.dataset.ot;
            if (defaultKey && otMap[defaultKey]) {
                localStorage.setItem('orderType', otMap[defaultKey]);
                // The header rendered before this ran and cannot know the menu just
                // adopted the outlet's default — it would keep prompting "Set order
                // type" over a strip that already shows one. DOM event, not an import:
                // this is an ES module, headerV2.js is a plain script.
                document.dispatchEvent(new CustomEvent('ordertype:changed'));
            }
        }
    })();

    // Filter sheet
    ge('filterBtn')?.addEventListener('click',()=>{ge('filterSheet').hidden=false});
    ge('filterClose')?.addEventListener('click',()=>{ge('filterSheet').hidden=true});
    ge('filterSheet')?.addEventListener('click',e=>{if(e.target.id==='filterSheet')ge('filterSheet').hidden=true});
    document.querySelectorAll('.sort-btn').forEach(b=>b.onclick=()=>{sortBy=b.dataset.sort;syncFilterUI()});
    document.querySelectorAll('.diet-btn').forEach(b=>b.onclick=()=>{veg=(veg===b.dataset.diet)?'':b.dataset.diet;syncFilterUI()});
    document.querySelectorAll('.pick-btn').forEach(b=>b.onclick=()=>{const k=b.dataset.pick;picks.has(k)?picks.delete(k):picks.add(k);syncFilterUI()});
    ge('filterClear')?.addEventListener('click',()=>{sortBy='';veg='';picks.clear();activeTagKeys.clear();syncFilterUI();ge('filterSheet').hidden=true;render()});
    ge('filterApply')?.addEventListener('click',()=>{ge('filterSheet').hidden=true;trackFiltersOnce();render()});

    // Menu sheet (mobile)
    ge('menuToggleBtn')?.addEventListener('click',()=>{ge('menuSheet').hidden=false});
    ge('menuSheetClose')?.addEventListener('click',()=>{ge('menuSheet').hidden=true});
    ge('menuSheet')?.addEventListener('click',e=>{if(e.target.id==='menuSheet')ge('menuSheet').hidden=true});
    // #menuSheetList clicks (row link, sub-row, and the "+" expand toggle) are handled
    // by ms.onclick in buildSidebar(). Do NOT add a second listener here — two handlers
    // on the same element race, and the close-and-scroll one would swallow the toggle.

    // Store info sheet
    ge('storeInfoBtn')?.addEventListener('click',()=>{ge('storeInfoSheet').hidden=false});
    ge('siClose')?.addEventListener('click',()=>{ge('storeInfoSheet').hidden=true});
    ge('storeInfoSheet')?.addEventListener('click',e=>{if(e.target.id==='storeInfoSheet')ge('storeInfoSheet').hidden=true});

    // Offer sheet — the pill in the outlet strip opens + populates the modal
    ge('offerFeatured')?.addEventListener('click',e=>{e.stopPropagation();openOfferSheet()});
    ge('offerClose')?.addEventListener('click',()=>{ge('offerSheet').hidden=true});
    ge('offerSheet')?.addEventListener('click',e=>{if(e.target.id==='offerSheet')ge('offerSheet').hidden=true});

    // Global delegation: qty buttons, card add, proceed, offer copy
    document.addEventListener('click',e=>{
        // "Read more" / "Read less" toggle inline expansion of the description
        // (matches CI3's expand_description / collapse_description). Short-circuits
        // BEFORE .card-add so the click doesn't bubble into add-to-cart.
        const rm=e.target.closest('.read-more');
        if(rm){
    // One dietary filter at a time (R14) — the sheet's three chips are the three
    // values of `veg`, so plain exact-match toggling is all this needs.
            e.preventDefault();
            const it=allItems.find(x=>String(x.id)===String(rm.dataset.readmore));
            const desc=rm.closest('.item-desc');
            if(it&&desc){
                desc.classList.add('item-desc--expanded');
                desc.innerHTML=`${esc(it.desc)} <button class="read-less" type="button" data-readless="${it.id}">Read less</button>`;
            }
            return;
        }
        const rl=e.target.closest('.read-less');
        if(rl){
            e.preventDefault();
            const it=allItems.find(x=>String(x.id)===String(rl.dataset.readless));
            const desc=rl.closest('.item-desc');
            if(it&&desc){
                const truncated=it.desc.slice(0,58).replace(/[\s.,;:]+$/,'');
                desc.classList.remove('item-desc--expanded');
                desc.innerHTML=`${esc(truncated)}… <button class="read-more" type="button" data-readmore="${it.id}">Read more</button>`;
            }
            return;
        }
        if(e.target.closest('.item-next-slot')){showSlotModal();return}
        // Card "Nutrition info" / "How to Cook?" tags open the item modal, where the
        // tabbed "More Details" block lives — pre-select the tapped tab once it's built.
        const xb=e.target.closest('.js-extras-btn');
        if(xb){
            e.stopPropagation();
            const it=findItem(xb.dataset.id);
            if(!it)return;
            const kind=xb.dataset.kind;
            Promise.resolve(openPopup(it)).then(()=>{
                const wrap=document.querySelector('#variantModal .js-popup-extras');
                wrap?.querySelector(`.extras-tab[data-tab="${kind}"]`)?.click();
                wrap?.scrollIntoView({behavior:'smooth',block:'nearest'});
            });
            return;
        }
        const qb=e.target.closest('.qb');if(qb){if(qb.dataset.d==='pop'){const it=findItem(qb.dataset.id);if(it)openPopup(it);return}chgQty(qb.dataset.id,qb.dataset.d==='p'?1:-1);return}
        const sc=e.target.closest('.srch-cat');if(sc&&sc.dataset.cid){closeSearch();scrollToCat('cat-'+sc.dataset.cid);return}
        // Guest "Unlock with Membership" strip — wins over the card's open-popup click.
        const mu=e.target.closest('.membership-unlock');if(mu){e.preventDefault();e.stopPropagation();location.href='/memberships';return}
        const ca=e.target.closest('.card-add');if(ca&&ca.dataset.id){const inSearch=!!ca.closest('#searchOverlay');
        // In the search overlay, a tap on the card body (anywhere except the ADD+
        // button) opens the item details instead of adding to cart. Only ADD+ adds.
        if(inSearch&&!e.target.closest('.srch-add')){const it=allItems.find(x=>x.id==ca.dataset.id);if(it){const ov=ge('searchOverlay');if(ov)ov.hidden=true;openPopup(it);}return}
        const it=findItem(ca.dataset.id);
        // Customisable item: always open the options popup (both search + menu page).
        if(ca.dataset.pop==='1'){if(it){if(inSearch){const ov=ge('searchOverlay');if(ov)ov.hidden=true;}openPopup(it);}return}
        // Menu page: the whole card opens the detail modal — never a silent add-to-cart
        // (add happens inside the popup). Return even if the item can't be resolved so
        // an unresolved card click can't fall through and add a stray line.
        if(!inSearch){if(it)openPopup(it);return}
        // Search overlay, ADD+ on a simple item → add straight to cart.
        addToCart(ca.dataset.id,ca.dataset.nm,ca.dataset.pr,ca.dataset.id,ca.dataset.veg);return}
        if(e.target.closest('#cpProceed')){e.preventDefault();goToCheckout();return}
        const cb=e.target.closest('.offer-copy-btn');
        if(cb){
            e.preventDefault();e.stopPropagation();
            const code=cb.dataset.code;
            if(code){
                const orig=cb.textContent;
                copyText(code).then(ok=>{
                    if(!ok){showToast('Could not copy code');return}
                    cb.textContent='Copied!';cb.classList.add('copied');
                    showToast(`Code ${code} copied`);
                    setTimeout(()=>{cb.textContent=orig;cb.classList.remove('copied')},1500);
                });
            }
            return;
        }
    });

    // Proceed button (mobile floating bar)
    // Make the entire sticky cart pill clickable — not just the chevron button.
    ge('floatingCartBar')?.addEventListener('click',e=>{e.preventDefault();goToCheckout()});
    // In-modal "View Cart" pill — whole pill clickable, same as the page bar.
    // Outlet closed: leave the overlay open and let goToCheckout() surface the
    // "Outlet is currently closed" toast (z 10001, above the overlay) — exactly
    // like tapping the closed bar on the menu page. When open, close the overlay
    // first so the login modal / checkout nav isn't trapped behind the z-2100 overlay.
    ge('searchCartBar')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(isOpen)closeSearch();goToCheckout()});

    // Sync site-header height now + on resize (keeps sticky offsets exact)
    syncHeaderHeight();
    window.addEventListener('resize',syncHeaderHeight,{passive:true});

    // Scroll-to-top button is wired globally by scrollTop.js (base.php).

    // Section-rail arrows (Bestsellers / Favourites / future rails)
    document.addEventListener('click',e=>{
        const ar=e.target.closest('.section-rail__arrow');if(!ar)return;
        const scroller=ar.closest('.section-rail')?.querySelector('.section-rail__scroll');
        if(!scroller)return;
        const card=scroller.firstElementChild;
        const step=card?card.getBoundingClientRect().width+16:256;
        scroller.scrollBy({left:(ar.classList.contains('left')?-1:1)*step,behavior:'smooth'});
    });

    // Heart/favourite toggle on .feat cards — also re-renders so the
    // "Your Favourites" rail picks up / loses the item immediately.
    document.addEventListener('click',e=>{
        const fb=e.target.closest('.feat-fav');if(!fb)return;
        e.preventDefault();e.stopPropagation();
        const id=fb.dataset.fav;if(!id)return;
        toggleFav(id);
        fb.classList.toggle('on');
        const svg=fb.querySelector('svg');
        if(svg)svg.setAttribute('fill',fb.classList.contains('on')?'currentColor':'none');
        render();
    });

    // Sidebar sub-category expand/collapse on + icon click
    ge('sectionList')?.addEventListener('click',e=>{
        const exp=e.target.closest('.menu-cat-expand');
        if(exp){
            e.preventDefault();e.stopPropagation();
            const sectionList=ge('sectionList');
            const cat=exp.closest('.menu-cat');
            const wrap=cat?.nextElementSibling;
            if(wrap&&wrap.classList.contains('menu-sub-wrap')){
                const open=wrap.classList.toggle('open');
                if(open){
                    collapseSubsExcept(sectionList,wrap,'.menu-sub-wrap','.menu-cat-expand');
                    // Highlight the parent category when expanding via "+"
                    sectionList.querySelectorAll('.menu-cat').forEach(l=>l.classList.remove('active'));
                    cat.classList.add('active');
                }
                exp.textContent=open?'−':'+';
            }
        }
    });

    // Slot modal — chip opens, submit confirms, backdrop closes
    ge('slotChip')?.addEventListener('click',()=>showSlotModal());
    ge('slotSubmitBtn')?.addEventListener('click',submitSlot);
    // slotModal intentionally has no backdrop-close — user must pick a slot first
}

function updateOtsStrip(ot){const eta=ge('otsEtaMeta'),dir=ge('otsDirection');if(eta)eta.hidden=(ot!=='delivery');if(dir)dir.hidden=!['pickup','in_car'].includes(ot)}

// Order-type change confirmation popup — same flow as checkout's showOrderTypeConfirm
// (checkout.js:3340). Shown before applying a switch so users confirm fulfilment
// changes (e.g. Delivery → Pickup means no delivery partner).
function showOrderTypeConfirm(otKey, onConfirm) {
    const modal = ge('otConfirmModal');
    if (!modal) { onConfirm(); return; }
    const store = [C.locality, C.city].filter(Boolean).join(', ')
        || C.outletName || C.brandName || 'our outlet';
    // Same illustration set as checkout's confirmation modal — extracted to standalone
    // SVG files (each is a large raster wrapped in SVG so inlining them would balloon
    // menu.js by ~2 MB). Loaded on demand via <img src>, browser-cached after first show.
    const icons = {
        delivery: '/assets/icons/order-type/delivery.svg',
        pickup:   '/assets/icons/order-type/pickup.svg',
        dine_in:  '/assets/icons/order-type/dine_in.svg',
        in_car:   '/assets/icons/order-type/in_car.svg',
    };
    const meta = {
        delivery: { title: 'Delivery Order', desc: 'Your order will be delivered to your respective address', note: '', cancel: 'Cancel',        ok: 'Confirm Delivery' },
        pickup:   { title: 'Pickup Order',   desc: `You have to collect the order from ${store}`,                note: 'Delivery partners are not assigned for pickup orders.', cancel: 'Keep Delivery', ok: 'Yes, Switch to Pickup' },
        dine_in:  { title: 'Dine-In Order',  desc: 'You will be dining at our outlet',                            note: '', cancel: 'Cancel',        ok: 'Confirm Dine-In' },
        in_car:   { title: 'In-Car Order',   desc: 'Your order will be delivered to your car',                   note: '', cancel: 'Cancel',        ok: 'Confirm In-Car' },
    };
    const m = meta[otKey];
    if (!m) { onConfirm(); return; }
    const set = (id, v) => { const el = ge(id); if (el) el.textContent = v; };
    set('otConfirmTitle', m.title);
    set('otConfirmDesc',  m.desc);
    const iconEl = ge('otConfirmIcon');
    if (iconEl) {
        const src = icons[otKey] || '';
        iconEl.innerHTML = src ? `<img src="${src}" alt="" loading="lazy" decoding="async" style="max-width:170px;max-height:140px;display:block;margin:0 auto">` : '';
    }
    const noteEl = ge('otConfirmNote'); if (noteEl) { noteEl.textContent = m.note; noteEl.hidden = !m.note; }
    const close = () => { modal.hidden = true; };
    const cancelBtn = ge('otConfirmCancel');
    const okBtn     = ge('otConfirmOk');
    if (cancelBtn) { cancelBtn.textContent = m.cancel; cancelBtn.onclick = close; }
    if (okBtn)     { okBtn.textContent     = m.ok;     okBtn.onclick     = () => { close(); onConfirm(); }; }
    // Close affordances — backdrop click + the header X
    modal.onclick = (e) => { if (e.target === modal) close(); };
    modal.querySelector('.popup-close')?.addEventListener('click', close, { once: true });
    modal.hidden = false;
}

// ── Slot-based ordering helpers ──────────────────────────────────────────────
function toPrepH(pt){if(!pt)return 0;const p=pt.split(':').map(Number);return(p[0]||0)+(p[1]||0)/60+(p[2]||0)/3600}
// "9:00 PM" -> 21.0. Returns 0 if unparseable.
function displayHour(s){const m=String(s||'').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);if(!m)return 0;let h=parseInt(m[1],10)||0;const min=parseInt(m[2]||'0',10)||0;const ap=(m[3]||'').toUpperCase();if(ap==='PM'&&h<12)h+=12;if(ap==='AM'&&h===12)h=0;return h+min/60}
// End hour of the selected slot. Prefer the persisted endH; fall back to parsing the end of
// the stored label range ("… - 9:00 PM") so slots saved before endH was persisted still work.
function slotEndHour(){if(selSlot.endH)return selSlot.endH;const r=slotTimeRange(),i=r.indexOf(' - ');const eh=i>=0?displayHour(r.slice(i+3)):0;return eh||selSlot.startH}
function slotAvailable(item){
    if(!isSlotBased)return true;
    const pt=item.prepTime;if(!pt||pt==='00:00:00')return true;
    if(!selSlot.date||!selSlot.startH)return true;
    const[yr,mo,dy]=selSlot.date.split('-').map(Number);
    // Match the backend (pay_model.php): an item is available if it can be prepped by the
    // slot WINDOW END, not the start — the kitchen can deliver anywhere in the window.
    const eh=slotEndHour();
    const h=Math.floor(eh),m=Math.round((eh-h)*60);
    return new Date(Date.now()+toPrepH(pt)*3600000)<=new Date(yr,mo-1,dy,h,m,0);
}
// Deep-link popups must wait for the slot pick on slot-based brands: if we open the
// item popup now it stacks on top of the slot modal (item in front, slot behind).
// Defer it — submitSlot() opens the stashed item once a slot is chosen.
function openOrDeferPopup(it){
    if(isSlotBased&&!selSlot.date){pendingDeepItem=it;return}
    openPopup(it);
}
// True when the currently-selected slot still exists in the backend's offered list.
function slotStillOffered(){
    const day=slotsData.find(d=>d.date===selSlot.date);
    return!!day&&(day.slots||[]).some(s=>s&&Object.keys(s).length>0&&String(s.id)===String(selSlot.id));
}
async function initSlot(){
    if(!slotsData.length)await fetchSlots();
    // Authoritative staleness check: once the real slots are known, drop a selection the
    // backend no longer offers — e.g. an ongoing-but-unbookable window like 12:30–1:30 PM at
    // 1:00 PM, which slotWindowPast's end-time test can't catch. Reopens the picker.
    if(selSlot.date&&selSlot.id&&slotsData.length&&!slotStillOffered()){clearStoredSlot();selSlot={date:'',id:'',label:'',startH:0,endH:0}}
    updateSlotChip();
    if(!selSlot.date)showSlotModal();
    else render();
}
let _slotsFetch=null,_slotsFetched=false;
function fetchSlots(){
    if(_slotsFetch)return _slotsFetch;
    _slotsFetch=fetch(`${getApiBase()}/client/getSlotsList/${bId}`,{method:'GET',headers:{'api-key':getStaticApiKey()}})
        .then(r=>r.json())
        .then(d=>{if(d&&d.status===1&&Array.isArray(d.slots)&&d.slots.length)slotsData=d.slots;})
        .catch(e=>console.error('[slot]',e))
        .finally(()=>{_slotsFetch=null;_slotsFetched=true;});
    return _slotsFetch;
}
function showSlotModal(){
    const m=ge('slotModal');if(!m)return;
    m.hidden=false;
    if(slotsData.length)renderSlotDates();
    else if(!_slotsFetched)fetchSlots().then(()=>renderSlotDates());
    else renderSlotDates();
}
function updateSlotChip(){
    const c=ge('slotRow'),v=ge('slotChipVal');
    if(!c)return;
    c.hidden=false;
    if(v)v.textContent=selSlot.label||'Select slot';
}
function slotFmtDate(d){const y=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0');return`${y}-${mo}-${dy}`}
function slotDayLabel(ds){
    const t=slotFmtDate(new Date()),tm=slotFmtDate(new Date(Date.now()+86400000));
    if(ds===t)return'Today';
    if(ds===tm)return'Tomorrow';
    return new Date(ds+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
}
function renderSlotDates(){
    const db=ge('slotDateBtns');if(!db)return;
    const valid=slotsData.filter(d=>d.slots&&d.slots.some(s=>s&&Object.keys(s).length>0));
    if(!valid.length){db.innerHTML='<span class="slot-loading">No slots available</span>';return}
    let html='';
    valid.slice(0,2).forEach(d=>{
        const si=slotsData.indexOf(d);
        const act=d.date===selSlot.date?' slot-date-btn--active':'';
        html+=`<button type="button" class="slot-date-btn${act}" data-date="${d.date}" data-si="${si}">${slotDayLabel(d.date)}</button>`;
    });
    if(valid.length>2){
        html+=`<select id="slotDateSel" class="slot-date-select"><option value="">Select Date</option>`
            +valid.slice(2).map(d=>`<option value="${d.date}" data-si="${slotsData.indexOf(d)}"${d.date===selSlot.date?' selected':''}>${slotDayLabel(d.date)}</option>`).join('')
            +`</select>`;
    }
    db.innerHTML=html;
    db.querySelectorAll('.slot-date-btn').forEach(btn=>{
        btn.onclick=()=>{
            db.querySelectorAll('.slot-date-btn').forEach(b=>b.classList.remove('slot-date-btn--active'));
            btn.classList.add('slot-date-btn--active');
            const sel=ge('slotDateSel');if(sel)sel.value='';
            renderSlotTimes(+btn.dataset.si);
        };
    });
    const sel=ge('slotDateSel');
    if(sel)sel.onchange=()=>{
        const o=sel.selectedOptions[0];if(!o.value)return;
        db.querySelectorAll('.slot-date-btn').forEach(b=>b.classList.remove('slot-date-btn--active'));
        renderSlotTimes(+o.dataset.si);
    };
    const initSi=selSlot.date?slotsData.findIndex(d=>d.date===selSlot.date):-1;
    renderSlotTimes(initSi>=0?initSi:slotsData.indexOf(valid[0]));
}
function renderSlotTimes(si){
    const tb=ge('slotTimeBtns'),tl=ge('slotTimeLabel'),sub=ge('slotSubmitBtn');
    if(!tb)return;
    const entry=slotsData[si];if(!entry)return;
    const slots=(entry.slots||[]).filter(s=>s&&Object.keys(s).length>0);
    if(!slots.length){if(tl)tl.hidden=true;tb.innerHTML='<span class="slot-loading">No times available</span>';return}
    if(tl)tl.hidden=false;
    tb.innerHTML=slots.map(s=>{
        const lbl=`${s.startDisplayName} - ${s.endDisplayName}`;
        const act=String(s.id)===selSlot.id?' slot-time-btn--active':'';
        const eh=(parseFloat(s.endHours)||0)+(parseFloat(s.endMin)||0)/60;
        return`<button type="button" class="slot-time-btn${act}" data-id="${s.id}" data-date="${entry.date}" data-lbl="${lbl}" data-sh="${s.startHours||0}" data-eh="${eh}">${lbl}</button>`;
    }).join('');
    tb.querySelectorAll('.slot-time-btn').forEach(btn=>{
        btn.onclick=()=>{
            tb.querySelectorAll('.slot-time-btn').forEach(b=>b.classList.remove('slot-time-btn--active'));
            btn.classList.add('slot-time-btn--active');
            if(sub)sub.disabled=false;
        };
    });
    if(sub)sub.disabled=!tb.querySelector('.slot-time-btn--active');
}
// Persist the chosen slot server-side. CI3 parity (order_detail saveSlot()→/client/setSlot):
// the server validates each item's prepTime against its STORED slot, not just the per-request
// selected_slot param. Without this, a slot picked on the menu lives only in localStorage, the
// server keeps whatever slot it had (e.g. the first add's), and prep-time items stay flagged
// "Available after … select a later slot" on checkout even after a valid later slot is chosen.
async function setSlotApi(slotDate,slotTime){
    let ud;try{ud=JSON.parse(localStorage.getItem('userdata')||'null')}catch{ud=null}
    if(!ud||!ud.token||!ud.contactId)return false;
    const url=`${getApiBase()}/client/setSlot?contactId=${encodeURIComponent(ud.contactId)}`
        +`&contactMappingId=${encodeURIComponent(ud.contactMappingId||'')}`
        +`&businessId=${encodeURIComponent(bId)}&token=${encodeURIComponent(ud.token)}`
        +`&orderId=${encodeURIComponent(serverOrderId||'')}`
        +`&slotDate=${encodeURIComponent(slotDate)}&slotTime=${encodeURIComponent(slotTime)}`;
    try{
        const r=await fetch(url,{method:'GET',headers:{'Accept':'application/json'}});
        if(!r.ok)return false;
        const d=await r.json();
        return (d?.status??d?.result?.status)==1;
    }catch{return false}
}
async function submitSlot(){
    const tb=ge('slotTimeBtns');if(!tb)return;
    const active=tb.querySelector('.slot-time-btn--active');if(!active)return;
    const d=active.dataset.date,id=active.dataset.id,lbl=active.dataset.lbl;
    const sh=parseFloat(active.dataset.sh||'0');
    const eh=parseFloat(active.dataset.eh||'0');
    saveSlot(d,id,`${slotDayLabel(d)} | ${lbl}`,sh,eh);
    updateSlotChip();
    ge('slotModal').hidden=true;
    render();
    // Open any deep-linked item popup that was deferred until a slot was chosen.
    if(pendingDeepItem){const _p=pendingDeepItem;pendingDeepItem=null;openPopup(_p)}
    refreshSearchCards(); // search overlay may be open underneath — re-sync slot state (no-op if closed)
    // Push the slot to the server, then re-pull the cart so per-item OOS/validation reflects
    // the new slot (server is authoritative for prep-time availability).
    if(await setSlotApi(d,id)) await fetchServerCart();
}

function ge(id){return document.getElementById(id)}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function spin(s){const e=ge('menuLoading');if(e)e.hidden=!s}
function showMenu(s){const e=ge('menuContent');if(e)e.hidden=!s}
// Every dead end lands here — a closed outlet, an empty feed, a failed fetch —
// and the search field is NOT inside #menuContent, so it stays on screen after
// showMenu(false). Without this the short form shipped by the view as a loading
// state became the permanent one, which is the same words by accident rather
// than by decision. setSearchPlaceholder() emits the no-count form here, since
// allItems is empty.
function showClosed(){spin(false);const e=ge('closedMsg');if(e)e.hidden=false;showMenu(false);setSearchPlaceholder()}

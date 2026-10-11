/**
 * Pickup-location tooltip — shared by the menu page and checkout.
 *
 * Markup: app/Views/partials/pickup_tooltip.php renders a `.pickup-tip` popover
 * with an id; any element carrying `data-pickup-trigger="<id>"` toggles it.
 *
 * Behaviour: click the trigger to open the popover anchored beneath it; click it
 * again, click outside, or press Escape to close. Positioned with `position:fixed`
 * and clamped to the viewport so it never spills off-screen, with the arrow kept
 * under the trigger's centre. Multiple triggers may target the same popover.
 */
(function () {
    'use strict';

    const triggers = document.querySelectorAll('[data-pickup-trigger]');
    if (!triggers.length) return;

    let open = null; // { trigger, tip }

    function close() {
        if (!open) return;
        open.tip.hidden = true;
        open.trigger.setAttribute('aria-expanded', 'false');
        open = null;
    }

    function position(trigger, tip) {
        const margin = 12;
        const rect = trigger.getBoundingClientRect();
        const tw = tip.offsetWidth;

        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
        tip.style.left = left + 'px';
        tip.style.top = (rect.bottom + 10) + 'px';

        const arrow = tip.querySelector('.pickup-tip__arrow');
        if (arrow) {
            const center = rect.left + rect.width / 2 - left;
            arrow.style.left = Math.max(16, Math.min(center, tw - 16)) + 'px';
        }
    }

    function show(trigger, tip) {
        close();
        tip.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        position(trigger, tip);
        open = { trigger, tip };
    }

    triggers.forEach((trigger) => {
        const tip = document.getElementById(trigger.getAttribute('data-pickup-trigger'));
        if (!tip) return;
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open && open.tip === tip) { close(); return; }
            show(trigger, tip);
        });
    });

    document.addEventListener('click', (e) => {
        if (open && !open.tip.contains(e.target) && !open.trigger.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', close);
    window.addEventListener('scroll', () => { if (open) position(open.trigger, open.tip); }, { passive: true });
})();

'use strict';

/**
 * Slick initializer — CI3 parity (assets/themes/ue_silver/js/wla_home_*.js).
 * Any element with `data-slick` is bound to slick using its `data-option`
 * attribute as a config object. Markup matches CI3 exactly so widgets ported
 * from CI3 (offers, best_sellers, newly_launched, etc.) work unchanged.
 *
 * Example: <div data-slick data-option="slidesToShow: 3, autoplay: true, ...">
 *
 * Requires jQuery + slick (both loaded globally from base.php).
 */
(function ($) {
    if (typeof $ === 'undefined' || typeof $.fn.slick === 'undefined') return;

    function mySlick($elems) {
        $elems.each(function () {
            var $current = $(this);
            if ($current.hasClass('slick-initialized')) return;
            try {
                /* eslint-disable no-eval */
                var opts = eval('({' + ($current.attr('data-option') || '') + '})');
                /* eslint-enable no-eval */
                $current.slick(opts || {});
            } catch (err) {
                if (window.console) console.warn('slick init failed', this, err);
            }
        });
    }

    // Wait for window.load + one rAF tick so the layout is fully painted
    // before slick measures slide widths. Init too early and slick can latch
    // onto a transitional parent width (e.g. 720px from a Bootstrap container
    // breakpoint) instead of the final desktop width.
    $(window).on('load', function () {
        requestAnimationFrame(function () {
            mySlick($('[data-slick]'));
        });
    });

    // On resize: setPosition repositions but does NOT recompute slide widths,
    // so a viewport change that crosses a `responsive` breakpoint or otherwise
    // changes the parent's width needs a full unslick + reinit to pick up the
    // new dimensions. Debounced to avoid thrashing during drag-resize.
    var resizeTimer;
    $(window).on('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            $('[data-slick].slick-initialized').each(function () {
                try { $(this).slick('unslick'); } catch (e) {}
            });
            mySlick($('[data-slick]'));
        }, 150);
    });

    window.mySlick = mySlick;
})(window.jQuery);

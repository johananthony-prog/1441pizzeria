'use strict';

/**
 * Testimonial "Read more" — companion to the .wla-testimonial-carousel widget
 * (viewType 29). The body is CSS line-clamped to a fixed number of lines with a
 * reserved min-height, so every slide is the same height and autoplay/scroll
 * can't fluctuate the page. This module reveals the pre-rendered "Read more"
 * button only on slides whose text actually overflows the clamp, toggles the
 * `.is-expanded` state, pauses autoplay while a quote is open, and recollapses
 * on slide change.
 *
 * Requires jQuery + slick (global, from base.php). Runs after slick_init.js.
 */
(function ($) {
    if (typeof $ === 'undefined') return;

    var SEL = '.wla-testimonial-carousel';

    // Reveal/hide each body's button based on whether the clamped text overflows.
    // Resets to collapsed first so re-runs (e.g. after a resize re-init, where the
    // line count changes with width) re-measure cleanly.
    function refresh($carousel) {
        $carousel.find('.wla-testimonial__body').each(function () {
            var body = this;
            var $btn = $(body).siblings('.wla-testimonial__readmore');
            body.classList.remove('is-expanded');
            $btn.text('Read more').attr('aria-expanded', 'false');
            var overflows = body.scrollHeight - body.clientHeight > 2;
            $btn.toggleClass('is-on', overflows);
        });
        if ($carousel.hasClass('slick-initialized')) {
            try { $carousel.slick('setPosition'); } catch (e) {}
        }
    }

    function collapseAll($carousel) {
        $carousel.find('.wla-testimonial__body.is-expanded').each(function () {
            this.classList.remove('is-expanded');
            $(this).siblings('.wla-testimonial__readmore')
                .text('Read more').attr('aria-expanded', 'false');
        });
    }

    function setup() {
        $(SEL).each(function () {
            var $c = $(this);
            if ($c.data('tmReadmore')) { refresh($c); return; }
            $c.data('tmReadmore', true);

            refresh($c);

            // Recollapse + resume autoplay whenever the slide changes.
            $c.on('beforeChange', function () {
                collapseAll($c);
                if ($c.hasClass('slick-initialized')) {
                    try { $c.slick('slickPlay'); } catch (e) {}
                }
            });
        });
    }

    // Delegated toggle — survives slick's clone/re-init churn.
    $(document).on('click', '.wla-testimonial__readmore', function () {
        var $btn = $(this);
        var body = $btn.siblings('.wla-testimonial__body')[0];
        if (!body) return;
        var $c = $btn.closest(SEL);
        var expanded = body.classList.toggle('is-expanded');
        $btn.text(expanded ? 'Read less' : 'Read more').attr('aria-expanded', String(expanded));
        if ($c.hasClass('slick-initialized')) {
            try { $c.slick(expanded ? 'slickPause' : 'slickPlay'); } catch (e) {}
            try { $c.slick('setPosition'); } catch (e) {}
        }
    });

    // Run after slick_init.js has booted the carousel. Both bind window.load;
    // slick_init defers its .slick() call into a rAF, so wait two frames to be
    // sure the carousel (and its clones) exist before we measure.
    $(window).on('load', function () {
        requestAnimationFrame(function () {
            requestAnimationFrame(setup);
        });
    });

    // After slick_init re-inits on resize (150ms debounce), re-measure since the
    // wrapped line count — and thus what overflows — changes with viewport width.
    var resizeTimer;
    $(window).on('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            $(SEL).each(function () { $(this).removeData('tmReadmore'); });
            setup();
        }, 300);
    });
})(window.jQuery);

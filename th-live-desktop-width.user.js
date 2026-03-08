// ==UserScript==
// @name         QTM Live — Desktop Width Fix
// @namespace    https://th-live.online
// @version      0.12
// @description  Constrains QTM-platform live-streaming sites to a
//               phone-width column when viewed on a wide desktop screen.
//               Overrides the viewport meta at document-start and adds
//               a CSS phone-frame background.  Also emulates a mobile
//               User-Agent so the site's own JS believes it is running on
//               an iPhone, suppressing "download our app" overlays.
//               A toggle button lets you switch between phone width and
//               full width on the fly.
// @match        https://th-live.online/*
// @match        https://qqlive.online/*
// @match        https://www.qqlive.online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// To add more QTM-clone domains, copy one of the @match lines above and
// change the hostname.  All sites on this platform share the same #app
// structure and will be fixed by the same CSS.

(function () {
  'use strict';

  var PHONE_WIDTH  = 390;     // logical CSS px — matches iPhone 14 (common design baseline)
  var PHONE_HEIGHT = 844;     // logical CSS px — matches iPhone 14 screen height
  var VIEWPORT    = 'width=' + PHONE_WIDTH + ',initial-scale=1';

  // Read the REAL viewport dimensions before we override window.inner{Width,Height}.
  // screen.width/height are the physical screen CSS-pixel values and are never overridden.
  var realViewportWidth  = window.screen.width;
  var realViewportHeight = window.screen.height;
  if (realViewportWidth <= PHONE_WIDTH) return;

  // phoneMode must be declared here (before the property getters below reference it
  // via closure) even though it is assigned before any getter is ever called.
  var phoneMode = true;

  // ── 1. Override window.innerWidth / document.documentElement.clientWidth ───
  //
  // These must be intercepted at document-start — before flexible.js or any
  // Vant component initialises — so that every JS layout calculation that reads
  // these values uses PHONE_WIDTH instead of the actual desktop viewport width.
  //
  // Without this, flexible.js reads clientWidth = 1440 and sets
  //   html { font-size: 144px }
  // and Vant Sticky reads innerWidth = 1440 when it positions fixed elements,
  // making them span the full desktop screen.
  //
  // When the user toggles to full-width mode we delete the overrides so the
  // native browser values are restored automatically.

  try {
    Object.defineProperty(window, 'innerWidth', {
      get: function () { return phoneMode ? PHONE_WIDTH : realViewportWidth; },
      configurable: true
    });
  } catch (e) {}

  try {
    // document.documentElement.clientWidth is what most flexible.js variants read.
    // Overriding it on the *instance* (not Element.prototype) keeps the override
    // isolated to just this element.
    var _elCWDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', {
      get: function () {
        if (phoneMode) return PHONE_WIDTH;
        return _elCWDesc ? _elCWDesc.get.call(this) : realViewportWidth;
      },
      configurable: true
    });
  } catch (e) {}

  // ── 1b. Override window.innerHeight / document.documentElement.clientHeight ─
  //
  // The "download our app" bottom sheet (and any other component that reads
  // viewport height in JS) uses window.innerHeight to calculate its own height.
  // On a 900 px desktop screen it renders full-screen tall; on a 844 px phone it
  // renders as a compact banner.  Spoofing innerHeight to PHONE_HEIGHT makes
  // those JS calculations produce phone-sized results.
  //
  // CSS `vh` units are not affected by this override (they resolve against the
  // visual viewport regardless of JS property values), so the companion CSS rule
  // `height: auto !important` on `.van-popup--bottom` handles vh-based heights.

  var _elCHDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

  try {
    Object.defineProperty(window, 'innerHeight', {
      get: function () { return phoneMode ? PHONE_HEIGHT : realViewportHeight; },
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(document.documentElement, 'clientHeight', {
      get: function () {
        if (phoneMode) return PHONE_HEIGHT;
        return _elCHDesc ? _elCHDesc.get.call(this) : realViewportHeight;
      },
      configurable: true
    });
  } catch (e) {}

  // ── 2. Touch capability emulation ─────────────────────────────────────────
  //
  // Chrome DevTools Device Toolbar does more than just resize the viewport — it
  // also enables touch event emulation.  Without this, sites that check for
  // touch capability keep running their desktop code paths even in a 390 px
  // column:
  //
  //   • navigator.maxTouchPoints === 0 (desktop default) → Vant, Vue Router
  //     and many SPA frameworks skip swipe handlers, bottom-sheet gestures,
  //     and tap ripple effects entirely.
  //
  //   • 'ontouchstart' in window === false → older jQuery-style checks bail
  //     out of the touch branch.
  //
  // Overriding these at document-start (before any framework code runs)
  // activates the same mobile code paths the site would use on a real phone.
  //
  // The real values are saved so they can be restored when the user toggles to
  // full-width mode.

  var realMaxTouchPoints = navigator.maxTouchPoints;

  try {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: function () {
        return phoneMode ? 5 : realMaxTouchPoints;
      },
      configurable: true
    });
  } catch (e) {}

  // 'ontouchstart' in window is the classic touch-capability check.
  // Setting it to null is enough — the property exists (returns true for `in`)
  // and is falsy (avoids breaking code that also reads the value).
  // ensureOntouchstart() is also called when toggling back to phone mode.
  function ensureOntouchstart() {
    if (!('ontouchstart' in window)) {
      try { window.ontouchstart = null; } catch (e) {}
    }
  }
  ensureOntouchstart();

  // ── 2b. User-Agent and platform emulation ─────────────────────────────────
  //
  // QTM Live sites show a "download our mobile app" interstitial when they
  // detect a mobile viewport (innerWidth = 390, maxTouchPoints > 0) paired
  // with a desktop User-Agent string.  Their client-side logic reads
  //   navigator.userAgent / navigator.platform
  // and infers "desktop browser pretending to be mobile → show app promo".
  //
  // Overriding these to an iPhone Mobile Safari UA makes the site's JS believe
  // we are a genuine mobile browser, suppressing the interstitial and activating
  // the interactive live-room UI (chat, like/gift controls, navigation bar).
  //
  // NOTE: this only affects JS-readable values.  HTTP request headers are
  // unchanged, so server-side UA checks still see the real desktop UA.

  var realUserAgent = navigator.userAgent;
  var realPlatform  = navigator.platform;

  // Standard iPhone 14 / iOS 17 / Mobile Safari UA — widely recognised.
  var MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' +
                  ' AppleWebKit/605.1.15 (KHTML, like Gecko)' +
                  ' Version/17.0 Mobile/15E148 Safari/604.1';

  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: function () { return phoneMode ? MOBILE_UA : realUserAgent; },
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'platform', {
      get: function () { return phoneMode ? 'iPhone' : realPlatform; },
      configurable: true
    });
  } catch (e) {}

  // ── 3. Viewport meta override ──────────────────────────────────────────────
  //
  // Two independent observers keep the viewport meta locked to PHONE_WIDTH:
  //
  //   vpChildObserver  — watches the whole document for a new <meta> element
  //                      being inserted (catches the static HTML meta and any
  //                      createElement + appendChild calls).
  //   vpAttrObservers  — one per viewport meta; watches the content attribute
  //                      so that a plain JS assignment like
  //                        meta.content = '...'
  //                      is immediately reversed.
  //
  // querySelectorAll is used (not querySelector) so ALL duplicate viewport metas
  // are corrected — browsers use the *last* one, so any site-inserted tag that
  // comes after ours must also be locked.

  var vpAttrObservers = [];   // one entry per watched <meta name="viewport">
  var vpLocked = false;       // re-entrancy guard

  function disconnectVpAttrObservers() {
    for (var i = 0; i < vpAttrObservers.length; i++) vpAttrObservers[i].disconnect();
    vpAttrObservers = [];
  }

  function applyViewport() {
    if (vpLocked) return;
    vpLocked = true;

    var all = document.querySelectorAll('meta[name="viewport"]');

    if (all.length === 0) {
      // No viewport meta in the DOM yet — create one.  vpChildObserver will
      // fire when it is inserted and call applyViewport again.
      var m = document.createElement('meta');
      m.name    = 'viewport';
      m.content = VIEWPORT;
      (document.head || document.documentElement).appendChild(m);
      vpLocked = false;
      return;
    }

    // Lock every existing viewport meta.
    for (var i = 0; i < all.length; i++) {
      if (all[i].content !== VIEWPORT) all[i].content = VIEWPORT;
    }

    // Reconnect attribute observers.
    disconnectVpAttrObservers();
    for (var j = 0; j < all.length; j++) {
      (function watchMeta(el) {
        var obs = new MutationObserver(function () {
          if (el.content !== VIEWPORT) el.content = VIEWPORT;
        });
        obs.observe(el, { attributes: true, attributeFilter: ['content'] });
        vpAttrObservers.push(obs);
      }(all[j]));
    }

    vpLocked = false;
  }

  applyViewport();

  // Watch for new <meta name="viewport"> elements being added.
  var vpChildObserver = new MutationObserver(function (mutations) {
    for (var mi = 0; mi < mutations.length; mi++) {
      var added = mutations[mi].addedNodes;
      for (var ni = 0; ni < added.length; ni++) {
        var n = added[ni];
        if (n.nodeType !== 1) continue;
        var isVp = n.tagName === 'META' &&
                   (n.name === 'viewport' || n.getAttribute('name') === 'viewport');
        var containsVp = !isVp && n.querySelector && n.querySelector('meta[name="viewport"]');
        if (isVp || containsVp) { applyViewport(); return; }
      }
    }
  });
  vpChildObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', function () {
    vpChildObserver.disconnect();   // static DOM is complete; attribute observers take over
    applyViewport();

    // Poll for ~5 s to catch any late SPA viewport reset (e.g. Vue mounted hook).
    var ticks = 0;
    var MAX_POLL_TICKS = 10;   // 10 ticks × 500 ms = 5 s
    var poll = setInterval(function () {
      applyViewport();
      if (++ticks >= MAX_POLL_TICKS) clearInterval(poll);
    }, 500);
  });

  // ── 4. CSS ─────────────────────────────────────────────────────────────────
  //
  // Layer A — root font-size pin
  //   Ensures the rem baseline is correct even if flexible.js already ran
  //   before our window.innerWidth override was applied.
  //
  // Layer B — container centering
  //   Centers #app in a dark desktop surround, capped at PHONE_WIDTH px.
  //
  // Layer C — named fixed-element repositioning (Vant UI class names)
  //   CSS !important overrides inline styles set by Vant's own JS.
  //   Centres fixed elements over the phone column:
  //     left:  max(0px, calc(50vw - 195px))
  //     width: min(390px, 100vw)
  //   Works whether the viewport is 390 px (meta override succeeded) or the
  //   full desktop width (meta override failed — CSS-only fallback).

  var PHONE_HALF_WIDTH     = (PHONE_WIDTH / 2) + 'px';        // '195px'
  var COL_LEFT             = 'max(0px,calc(50vw - ' + PHONE_HALF_WIDTH + '))';
  var COL_WIDTH            = 'min(' + PHONE_WIDTH + 'px,100vw)';
  var PHONE_ROOT_FONT_SIZE = (PHONE_WIDTH / 10) + 'px';        // '39px'

  // Vant UI selectors for elements that use position:fixed and span the viewport.
  var FIXED_SELECTORS = [
    '.van-tabbar',
    '.van-nav-bar',
    '.van-sticky > .van-nav-bar',
    '.van-sticky > [class]',
    '.van-notify',
    '.van-overlay',
    '.van-popup--bottom',
    '.van-popup--top',
    '.van-popup--left',
    '.van-popup--right',
    '.van-action-sheet',
    '.van-share-sheet',
    '.van-number-keyboard'
  ].join(',\n  ');

  var CSS = [
    '/* ── root font-size + background ── */',
    'html {',
    '  font-size: ' + PHONE_ROOT_FONT_SIZE + ' !important;',
    '  background: #111 !important;',
    '}',
    'body {',
    '  display: flex !important;',
    '  justify-content: center !important;',
    '  min-height: 100vh !important;',
    '  background: #111 !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '}',
    '#app, [data-v-app] {',
    '  max-width: ' + PHONE_WIDTH + 'px !important;',
    '  width: 100% !important;',
    '  box-shadow: 0 0 60px rgba(0,0,0,.7) !important;',
    '  min-height: 100vh !important;',
    '  overflow-x: hidden !important;',
    '  position: relative !important;',
    '}',
    '',
    '/* ── Vant fixed / overlay elements ── */',
    '  ' + FIXED_SELECTORS + ' {',
    '  left:  ' + COL_LEFT  + ' !important;',
    '  width: ' + COL_WIDTH + ' !important;',
    '  right: auto !important;',
    '  max-width: ' + PHONE_WIDTH + 'px !important;',
    '}',
    '',
    '/* van-toast is centred by transform; keep its anchor in the column */',
    '.van-toast {',
    '  left: 50vw !important;',
    '}',
    '',
    '/* Bottom popups (including the app-download banner) must not use the full',
    '   desktop viewport height.  The JS scan above handles any inline !important',
    '   height set by Vant/Vue; these CSS rules are a belt-and-suspenders fallback',
    '   for heights set purely through stylesheets (which CSS !important can reach). */',
    '.van-popup--bottom,',
    '.van-action-sheet,',
    '.van-share-sheet {',
    '  height: auto !important;',
    '  max-height: ' + PHONE_HEIGHT + 'px !important;',
    '}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.id          = '__qtm_width_fix';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  // ── 5. JS fixed-element scan ───────────────────────────────────────────────
  //
  // The CSS layer above covers known Vant class names, but QTM Live sites also
  // have custom components (e.g. the home-page section tab bar, live-room
  // like/gift/follow controls) with site-specific class names not in the Vant
  // selector list.
  //
  // This scan iterates every element in the live DOM, finds those whose
  // *computed* position is "fixed", and applies phone-column constraints with
  // !important priority.  It runs:
  //   • once immediately after DOMContentLoaded (catches initial Vant setup)
  //   • every 500 ms for 6 seconds after window load (catches elements that
  //     become fixed during Vue's mounted() lifecycle or after lazy hydration)
  //
  // For performance the scan is targeted: it checks
  //   • direct children of <body>  (Vant teleports overlays/popups here)
  //   • all descendants of #app / [data-v-app]  (catches sticky navs and
  //     custom bars inside the Vue component tree)
  // rather than every element in the full DOM, which keeps each pass fast
  // even on complex pages.
  //
  // Constraint strategy (v0.10):
  //   Center-anchored elements (left ≈ 50 % of visual viewport, typically paired
  //   with transform:translate(-50%,…)) — small in-stream popups, gift dialogs
  //     → preserve natural width; re-anchor left to the phone column center so
  //       the translateX keeps the popup centered over the column.
  //   Wide elements (width ≥ 60 % of PHONE_WIDTH) — nav bars, overlays, popups
  //     → full column constraint: left=COL_LEFT, width=COL_WIDTH, right=auto
  //   Narrow elements (width < 60 % of PHONE_WIDTH) — floating action buttons,
  //     live-room like/gift/follow icons, badges
  //     → preserve width; re-anchor left/right relative to the phone column
  //       so they stay inside the column without being stretched.

  function fixAllFixedEls() {
    if (!phoneMode || !document.body) return;

    // Build a de-duplicated candidate list: body's direct children + everything
    // inside the Vue app root.
    var candidates = [];
    var bodyChildren = document.body.children;
    for (var bi = 0; bi < bodyChildren.length; bi++) {
      candidates.push(bodyChildren[bi]);
    }
    var appRoots = document.querySelectorAll('#app, [data-v-app]');
    for (var ai = 0; ai < appRoots.length; ai++) {
      var appEls = appRoots[ai].querySelectorAll('*');
      for (var ae = 0; ae < appEls.length; ae++) {
        candidates.push(appEls[ae]);
      }
    }

    // The phone column's right edge measured from the *right* side of the
    // viewport.  Used to re-anchor right-positioned narrow elements so they
    // stay inside the phone column rather than drifting off-screen.
    //   = calc(max(0px, (100vw - 390px) / 2))   (mirrors COL_LEFT by symmetry)
    var COL_RIGHT_INSET = 'max(0px,calc((100vw - ' + PHONE_WIDTH + 'px) / 2))';

    // Phone column centre as a CSS calc() for re-anchoring centred popups.
    // left=COL_CENTER_LEFT with transform:translateX(-50%) centres the popup.
    var COL_CENTER_LEFT = 'calc(' + COL_LEFT + ' + ' + (PHONE_WIDTH / 2) + 'px)';

    // Real visual viewport width.  position:fixed elements are positioned
    // relative to the visual viewport (browser window), not the layout viewport
    // set by the meta tag.  window.visualViewport.width gives this directly;
    // fall back to screen.width (captured before our innerWidth override).
    var realVW = (window.visualViewport && window.visualViewport.width)
                   ? Math.round(window.visualViewport.width)
                   : realViewportWidth;

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.id === '__qtm_btn') continue;
      var cs = window.getComputedStyle(el);
      if (cs.position !== 'fixed') continue;

      var elW    = parseFloat(cs.width) || 0;
      var csLeft  = cs.left;
      var csRight = cs.right;
      var rawLeft  = parseFloat(csLeft);
      var rawRight = parseFloat(csRight);

      // Mark the element so clearFixedElStyles() can find and clean it up.
      el.setAttribute('data-qtm-fixed', '1');

      // ── Center-anchored element (left ≈ 50 % of visual viewport) ──────────
      // These use CSS `left:50%` + `transform:translate(-50%,…)` to center
      // themselves.  If we apply COL_LEFT to them the transform shifts them
      // further left, placing them outside the column.  Instead we set left to
      // the column center; the existing translateX(-50%) then centers the
      // element over the phone column.  Width is intentionally preserved so
      // small popups (gift dialogs, join prompts) remain their natural size.
      var isCenteredX = csLeft !== 'auto' &&
                        !isNaN(rawLeft) &&
                        Math.abs(rawLeft - realVW / 2) < 5;

      if (isCenteredX) {
        el.style.setProperty('max-width', PHONE_WIDTH + 'px', 'important');
        el.style.setProperty('left',      COL_CENTER_LEFT,     'important');
        el.style.removeProperty('right');
      } else if (elW >= PHONE_WIDTH * 0.6) {
        // ── Wide element (nav bar, overlay, popup, backdrop) ────────────────
        // Constrain to the phone column exactly as before.
        el.style.setProperty('max-width', PHONE_WIDTH + 'px', 'important');
        el.style.setProperty('width',     COL_WIDTH,           'important');
        el.style.setProperty('left',      COL_LEFT,            'important');
        el.style.setProperty('right',     'auto',              'important');
        // If the element is taller than a phone screen it is almost certainly
        // a bottom-sheet or interstitial whose height was calculated from the
        // real desktop window.innerHeight (or set as 100vh inline).  Force it
        // to size itself to its content instead.  This wins over any inline
        // `!important` height that CSS-level rules cannot override.
        // Overlays that use both `top:0` and `bottom:0` are unaffected because
        // the browser ignores the `height` property when both are set.
        var elH = parseFloat(cs.height) || 0;
        if (elH > PHONE_HEIGHT) {
          el.style.setProperty('height', 'auto', 'important');
        }
      } else {
        // ── Narrow element (floating action button, badge, live-room control)
        // DON'T stretch its width.  Only re-anchor it so it stays within the
        // phone column.  Elements positioned from the right (right: Xpx) get
        // their right inset adjusted relative to the column's right edge.
        // Elements positioned from the left get their left offset adjusted
        // relative to the column's left edge.
        el.style.setProperty('max-width', PHONE_WIDTH + 'px', 'important');

        if (csRight !== 'auto' && !isNaN(rawRight)) {
          // Right-anchored: shift inset so it's relative to column right edge.
          el.style.setProperty('right',
            'calc(' + COL_RIGHT_INSET + ' + ' + rawRight + 'px)', 'important');
          el.style.removeProperty('left');
        } else if (csLeft !== 'auto' && !isNaN(rawLeft)) {
          // Left-anchored: shift offset so it's relative to column left edge.
          el.style.setProperty('left',
            'calc(' + COL_LEFT + ' + ' + rawLeft + 'px)', 'important');
          el.style.removeProperty('right');
        }
      }
    }
  }

  // Remove all inline styles that fixAllFixedEls() applied when we switch to
  // full-width mode.  Without this, the phone-column-relative calc() values
  // remain on elements and mis-position them against the full-width viewport.
  function clearFixedElStyles() {
    var tagged = document.querySelectorAll('[data-qtm-fixed]');
    for (var i = 0; i < tagged.length; i++) {
      var el = tagged[i];
      el.style.removeProperty('max-width');
      el.style.removeProperty('width');
      el.style.removeProperty('left');
      el.style.removeProperty('right');
      el.style.removeProperty('height');
      el.removeAttribute('data-qtm-fixed');
    }
  }

  document.addEventListener('DOMContentLoaded', fixAllFixedEls);

  window.addEventListener('load', function () {
    fixAllFixedEls();
    var scanTicks = 0;
    var scanMax   = 12;   // 12 × 500 ms = 6 s
    var scanPoll  = setInterval(function () {
      fixAllFixedEls();
      if (++scanTicks >= scanMax) clearInterval(scanPoll);
    }, 500);
  });

  // ── 6. SPA navigation hook ────────────────────────────────────────────────
  //
  // QTM Live sites are Vue Router SPAs (history mode).  Navigating between
  // pages (including the browser back/forward buttons) does NOT trigger a
  // page reload, so the DOMContentLoaded / load listeners above only fire
  // once — on the initial page load.
  //
  // After that, two things can undo the phone-width constraints:
  //   a) Vue Router re-creates fixed-position components (nav bars, overlays)
  //      with fresh inline styles from Vant Sticky, sized with the native
  //      (desktop) window.innerWidth.  Our window.innerWidth override is
  //      still in place, but Vant cached the value at its first init.
  //   b) Some routes reset the viewport meta via their own mounted() hook.
  //
  // Fix:
  //   • Wrap history.pushState / history.replaceState so we are notified of
  //     programmatic SPA navigations (clicking links, tabs, etc.).
  //   • Listen to the `popstate` event for back/forward button presses.
  //   • On each navigation, re-run applyViewport() and start a fresh 6-second
  //     fixAllFixedEls polling burst to constrain newly mounted components.

  var _spaNavScanPoll = null;

  function onSpaNav() {
    if (!phoneMode) return;
    applyViewport();

    // Clear any in-flight scan timer, then start a fresh burst.
    if (_spaNavScanPoll) clearInterval(_spaNavScanPoll);
    var navTicks = 0;
    var navMax   = 12;   // 12 × 500 ms = 6 s
    _spaNavScanPoll = setInterval(function () {
      fixAllFixedEls();
      if (++navTicks >= navMax) {
        clearInterval(_spaNavScanPoll);
        _spaNavScanPoll = null;
      }
    }, 500);
  }

  // Wrap pushState / replaceState.  These are the methods Vue Router calls
  // when navigating programmatically (link clicks, router.push(), etc.).
  (function () {
    var origPush    = history.pushState.bind(history);
    var origReplace = history.replaceState.bind(history);

    history.pushState = function () {
      origPush.apply(history, arguments);
      onSpaNav();
    };
    history.replaceState = function () {
      origReplace.apply(history, arguments);
      onSpaNav();
    };
  })();

  // popstate fires on back/forward button presses.
  window.addEventListener('popstate', onSpaNav);

  // ── 7. Toggle button ───────────────────────────────────────────────────────
  //
  // A small button fixed to the top-right corner.  Clicking it switches
  // between phone-width mode and full-width mode.

  function applyMode() {
    styleEl.disabled = !phoneMode;

    if (phoneMode) {
      // Re-establish the innerWidth / clientWidth overrides in case the toggle
      // was clicked while they had been deleted.  Use the same phoneMode-aware
      // getters as the initial setup so a rapid double-click can never leave
      // them in an inconsistent state.
      try {
        Object.defineProperty(window, 'innerWidth', {
          get: function () { return phoneMode ? PHONE_WIDTH : realViewportWidth; },
          configurable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(document.documentElement, 'clientWidth', {
          get: function () {
            if (phoneMode) return PHONE_WIDTH;
            return _elCWDesc ? _elCWDesc.get.call(this) : realViewportWidth;
          },
          configurable: true
        });
      } catch (e) {}
      // Restore touch emulation.
      try {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: function () { return phoneMode ? 5 : realMaxTouchPoints; },
          configurable: true
        });
      } catch (e) {}
      ensureOntouchstart();
      // Restore mobile UA / platform so the site's JS still sees a phone.
      try {
        Object.defineProperty(navigator, 'userAgent', {
          get: function () { return phoneMode ? MOBILE_UA : realUserAgent; },
          configurable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'platform', {
          get: function () { return phoneMode ? 'iPhone' : realPlatform; },
          configurable: true
        });
      } catch (e) {}
      // Restore innerHeight override so JS popup height calculations use phone size.
      try {
        Object.defineProperty(window, 'innerHeight', {
          get: function () { return phoneMode ? PHONE_HEIGHT : realViewportHeight; },
          configurable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(document.documentElement, 'clientHeight', {
          get: function () {
            if (phoneMode) return PHONE_HEIGHT;
            return _elCHDesc ? _elCHDesc.get.call(this) : realViewportHeight;
          },
          configurable: true
        });
      } catch (e) {}
      applyViewport();
      fixAllFixedEls();
      // Trigger resize so Vant / flexible.js recalculate with phone-width values.
      window.dispatchEvent(new Event('resize'));
    } else {
      // Full-width mode: remove our property overrides so native values return.
      try { delete window.innerWidth; } catch (e) {}
      try { delete document.documentElement.clientWidth; } catch (e) {}
      try { delete window.innerHeight; } catch (e) {}
      try { delete document.documentElement.clientHeight; } catch (e) {}
      try { delete navigator.maxTouchPoints; } catch (e) {}
      try { delete navigator.userAgent; } catch (e) {}
      try { delete navigator.platform; } catch (e) {}
      // Remove inline styles fixAllFixedEls() injected onto fixed elements.
      // Without this, phone-column-relative calc() values mis-position elements
      // against the full-width viewport (e.g. left:525px instead of left:0).
      clearFixedElStyles();
      disconnectVpAttrObservers();
      var vp = document.querySelector('meta[name="viewport"]');
      if (vp) vp.content = 'width=device-width,initial-scale=1';
      // Trigger resize so Vant / flexible.js recalculate with full-width values.
      window.dispatchEvent(new Event('resize'));
    }

    if (btn) {
      btn.textContent = phoneMode ? '\u229e Full width' : '\u260e Phone width';
      btn.title = phoneMode
        ? 'Click to restore full-width layout'
        : 'Click to re-enable phone-width fix';
    }
  }

  var btn = null;

  window.addEventListener('load', function () {
    btn = document.createElement('button');
    btn.id          = '__qtm_btn';
    btn.textContent = '\u229e Full width';
    btn.title       = 'Click to restore full-width layout';
    btn.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      'z-index:2147483647',
      'background:rgba(0,0,0,.55)',
      'color:#fff',
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:6px',
      'padding:4px 9px',
      'font-size:11px',
      'line-height:1.5',
      'cursor:pointer',
      'font-family:sans-serif',
      'user-select:none',
      '-webkit-user-select:none'
    ].join(';');
    btn.onclick = function () {
      phoneMode = !phoneMode;
      applyMode();
    };
    document.body.appendChild(btn);
  });
})();

// ==UserScript==
// @name         QTM Live — Desktop Width Fix
// @namespace    https://th-live.online
// @version      0.2
// @description  Constrains QTM-platform live-streaming sites to a
//               phone-width column when viewed on a wide desktop screen.
//               Overrides the viewport meta at document-start and adds
//               a CSS phone-frame background.  A toggle button lets you
//               switch between phone width and full width on the fly.
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

  var PHONE_WIDTH = 390;     // logical CSS px — matches iPhone 14 (common design baseline)
  var VIEWPORT    = 'width=' + PHONE_WIDTH + ',initial-scale=1';

  // Only activate on screens wider than PHONE_WIDTH.
  // Use window.innerWidth (CSS pixels) so the check is DPI-independent.
  // At document-start innerWidth may be 0; fall back to screen.width.
  var viewportWidth = window.innerWidth || window.screen.width;
  if (viewportWidth <= PHONE_WIDTH) return;

  // ── 1. Viewport meta override ──────────────────────────────────────────────
  //
  // Two independent observers work together:
  //
  //   vpChildObserver  — watches the whole document for a new <meta> element
  //                      being inserted (catches the static HTML meta and any
  //                      createElement + appendChild calls).
  //   vpAttrObserver   — watches the content *attribute* of the specific meta
  //                      element we found/created, so that a JS assignment
  //                      like  meta.content = '...'  is immediately reversed.
  //                      This is the most common way Vue apps reset the tag.
  //
  // After window load an interval runs for a few extra seconds as a final
  // safety net against late-initialising SPA code.

  var vpAttrObserver = null;

  function applyViewport() {
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) {
      if (vp.content !== VIEWPORT) vp.content = VIEWPORT;
      // Attach attribute observer to THIS element if not yet done
      if (!vpAttrObserver) {
        vpAttrObserver = new MutationObserver(function () {
          if (vp.content !== VIEWPORT) vp.content = VIEWPORT;
        });
        vpAttrObserver.observe(vp, { attributes: true });
      }
    } else {
      vp = document.createElement('meta');
      vp.name    = 'viewport';
      vp.content = VIEWPORT;
      (document.head || document.documentElement).appendChild(vp);
      // The childList observer will call applyViewport again after insertion,
      // at which point the element exists and the attribute observer is set up.
    }
  }

  applyViewport();

  // Watch for new <meta> elements being added anywhere in the document
  var vpChildObserver = new MutationObserver(applyViewport);
  vpChildObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', function () {
    vpChildObserver.disconnect();   // static DOM is complete; attribute observer takes over
    applyViewport();

    // Poll for ~5 s to catch any late SPA viewport reset (e.g. Vue mounted hook)
    var ticks = 0;
    var MAX_POLL_TICKS = 10;   // 10 ticks × 500 ms = 5 s
    var poll = setInterval(function () {
      applyViewport();
      if (++ticks >= MAX_POLL_TICKS) clearInterval(poll);
    }, 500);
  });

  // ── 2. CSS ─────────────────────────────────────────────────────────────────
  //
  // Two complementary layers:
  //
  //   Layer A — container centering
  //     Centers #app on a dark desktop background and caps its width at
  //     PHONE_WIDTH px.  This is the primary visual fix and works even on the
  //     rare browser that ignores the viewport meta change.
  //
  //   Layer B — fixed-element repositioning
  //     Vant UI components such as van-tabbar (bottom nav), van-nav-bar (top
  //     nav) and popups use  position:fixed; left:0; right:0  so they span the
  //     full *viewport* width, not the #app container width.  Without this
  //     layer those bars remain full-screen-wide even when the viewport meta
  //     override is working perfectly.
  //
  //     The fix:  left: max(0px, calc(50vw - 195px))
  //               width: min(390px, 100vw)
  //               right: auto
  //     …centres them over the phone column regardless of viewport width.

  var PHONE_HALF_WIDTH = (PHONE_WIDTH / 2) + 'px';          // 195px — half of phone column width
  var COL_LEFT  = 'max(0px,calc(50vw - ' + PHONE_HALF_WIDTH + '))';
  var COL_WIDTH = 'min(' + PHONE_WIDTH + 'px,100vw)';

  // Selectors for every Vant UI element that uses position:fixed / sticky
  // and spans the full viewport width.
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
    '/* ── container ── */',
    'html {',
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
    '/* ── fixed / overlay elements ── */',
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
    '}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.id          = '__qtm_width_fix';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  // ── 3. Toggle button ───────────────────────────────────────────────────────
  //
  // A small button fixed to the top-right corner.  Clicking it switches
  // between phone-width mode and full-width mode.

  var phoneMode = true;

  function applyMode() {
    styleEl.disabled = !phoneMode;
    if (phoneMode) {
      applyViewport();
    } else {
      if (vpAttrObserver) { vpAttrObserver.disconnect(); vpAttrObserver = null; }
      var vp = document.querySelector('meta[name="viewport"]');
      if (vp) vp.content = 'width=device-width,initial-scale=1';
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
    btn.textContent = '\u229e Full width';
    btn.title = 'Click to restore full-width layout';
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

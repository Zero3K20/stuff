// ==UserScript==
// @name         th-live.online — Email Registration Attempt
// @namespace    https://th-live.online
// @version      0.3
// @description  Tries to restore the removed email registration tab.
//               The backend may or may not honor the email OTP call.
// @match        https://th-live.online/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var patchTimer;

  // ── Vue3 component-instance lookup ──────────────────────────────────────────
  //
  // Vue3 VNode structure:
  //   vnode.component        — present when the vnode is a component node;
  //                            value is the component *instance* object
  //   instance.subTree       — the VNode tree that component rendered
  //   vnode.children         — child VNodes for plain element / Fragment nodes
  //
  // State location differs by API style:
  //   Options API  → instance.data        (set by data() function)
  //   Composition  → instance.setupState  (set by setup() / <script setup>)
  //
  // In both cases instance.proxy exposes all properties through one surface.

  function hasRegisterForm(ci) {
    return (ci.data      && typeof ci.data      === 'object' && 'registerForm' in ci.data) ||
           (ci.setupState && typeof ci.setupState === 'object' && 'registerForm' in ci.setupState);
  }

  function findComp(node) {
    if (!node) return null;

    // Component VNode — check instance, then recurse into its rendered subtree
    if (node.component) {
      var ci = node.component;
      if (hasRegisterForm(ci)) return ci;
      var r = findComp(ci.subTree);
      if (r) return r;
    }

    // Plain element / Fragment — recurse into child VNodes
    if (Array.isArray(node.children)) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (child && typeof child === 'object') {
          var r2 = findComp(child);
          if (r2) return r2;
        }
      }
    }

    return null;
  }

  // Try to locate the register component instance at call time.
  // Returns the component instance, or null if not yet available.
  function findRegisterComp() {
    var root = document.querySelector('#app') || document.querySelector('[data-v-app]');
    if (!root || !root.__vue_app__) return null;
    var app = root.__vue_app__;
    if (!app._instance || !app._instance.subTree) return null;
    return findComp(app._instance.subTree);
  }

  // ── Overlay ─────────────────────────────────────────────────────────────────
  //
  // The overlay is injected as soon as we are on the /register route.
  // No component scan is required to *show* the overlay — the component
  // is resolved lazily when the user actually clicks "Send OTP" or
  // "Verify & Register", by which time Vue has definitely finished mounting.

  function buildOverlay() {
    if (document.getElementById('__email_reg_overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = '__email_reg_overlay';
    overlay.style.cssText = [
      'position:fixed', 'top:80px', 'left:50%', 'transform:translateX(-50%)',
      'background:#fff', 'border:2px solid #eb457e', 'border-radius:12px',
      'padding:16px', 'z-index:9999', 'width:90vw', 'max-width:360px',
      'box-shadow:0 4px 20px rgba(0,0,0,.2)', 'font-family:sans-serif'
    ].join(';');

    overlay.innerHTML =
      '<p style="margin:0 0 8px;font-weight:bold;color:#eb457e;">Register with Email (experimental)</p>' +
      '<input id="__email_inp" type="email" placeholder="your@email.com"' +
      ' style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" />' +
      '<input id="__email_code" type="text" placeholder="OTP code"' +
      ' style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;margin-top:8px;" />' +
      '<div style="display:flex;gap:8px;margin-top:8px;">' +
      '<button id="__email_send" style="flex:1;background:#eb457e;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;">Send OTP</button>' +
      '<button id="__email_verify" style="flex:1;background:#eb457e;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;">Verify &amp; Register</button>' +
      '</div>' +
      '<p id="__email_status" style="margin:8px 0 0;font-size:12px;color:#666;"></p>' +
      '<p style="margin:4px 0 0;font-size:11px;color:#999;">Note: backend may not honor this request.</p>';

    document.body.appendChild(overlay);

    document.getElementById('__email_send').onclick = function () {
      var email = document.getElementById('__email_inp').value.trim();
      if (!email) { setStatus('Enter an email address first.'); return; }

      var ci = findRegisterComp();
      if (!ci) { setStatus('Page not ready — wait a moment and try again.'); return; }

      var proxy = ci.proxy;
      // Inject email field into registerForm if the component lacks it
      if (proxy.registerForm && !('email' in proxy.registerForm)) {
        proxy.registerForm.email = '';
      }
      proxy.registerForm.email = email;
      proxy.active = 1;             // switch to email branch
      proxy.sendVcoderegister();    // request OTP
      setStatus('OTP sent (if backend allows)\u2026');
    };

    document.getElementById('__email_verify').onclick = function () {
      var code = document.getElementById('__email_code').value.trim();
      if (!code) { setStatus('Enter the OTP code first.'); return; }

      var ci = findRegisterComp();
      if (!ci) { setStatus('Page not ready — wait a moment and try again.'); return; }

      var proxy = ci.proxy;
      proxy.registerForm.code = code;
      proxy.codeValidate();
      setStatus('Attempting verification\u2026');
    };
  }

  function setStatus(msg) {
    var el = document.getElementById('__email_status');
    if (el) el.textContent = msg;
  }

  // ── Polling ──────────────────────────────────────────────────────────────────
  //
  // Poll until the /register route is active and the DOM is ready, then inject
  // the overlay and stop.  No component scan is required here.

  function tryPatch() {
    if (location.hash !== '#/register' && !location.pathname.endsWith('/register')) {
      return;
    }
    // Wait for the Vue app root to appear
    var root = document.querySelector('#app') || document.querySelector('[data-v-app]');
    if (!root) return;

    // Inject the overlay and stop polling
    clearInterval(patchTimer);
    buildOverlay();
  }

  // Poll every 500 ms; stop automatically after 60 s
  patchTimer = setInterval(tryPatch, 500);
  setTimeout(function () { clearInterval(patchTimer); }, 60000);
})();

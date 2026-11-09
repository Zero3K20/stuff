// ==UserScript==
// @name         th-live.online — No-Login Demo
// @namespace    https://th-live.online
// @version      0.1
// @description  Demonstrates the client-side login guard bypass.
//               NOTE: live streams will NOT work (server rejects fake token).
// @match        https://th-live.online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── Step 1: Inject fake Vuex persisted state ─────────────────────────────
  // The app uses vuex-persistedstate with key "project-live".
  // We create a minimal member object that passes all client-side checks.
  const fakeMember = {
    uid: 0,
    nickname: 'Guest',
    avatar: '',
    phone: '',
    email: '',
    token: '',
    imToken: '',
    goldCoin: 0,
    badgeList: [],
    areaCode: 66,
    needCashPassword: false
  };
  const REJECTED_TOKEN = 'FAKE';  // server will reject this

  const existingState = JSON.parse(sessionStorage.getItem('project-live') || '{}');
  if (!existingState.member) {
    existingState.member = fakeMember;
    sessionStorage.setItem('project-live', JSON.stringify(existingState));
  }
  if (!sessionStorage.getItem('token')) {
    sessionStorage.setItem('token', REJECTED_TOKEN);
  }

  // ── Step 2: Silence server-side auth redirects ───────────────────────────
  // The app's Axios response interceptor calls router.replace("/login")
  // when the server returns codes 991/992/993/1040/424.
  // We intercept the Vue Router after it mounts and prevent that navigation.
  //
  // Strategy: override history.replaceState (Vue Router 4 uses the History API).
  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (state, title, url) {
    if (typeof url === 'string' && url.includes('/login')) {
      // Silently drop the server-triggered redirect to /login.
      // The page will stay put but all API-loaded content will be empty.
      console.warn('[th-live-nologin] Suppressed router.replace("/login")');
      return;
    }
    return _replaceState(state, title, url);
  };

  // ── Step 3: Notify the user ───────────────────────────────────────────────
  window.addEventListener('load', function () {
    console.info(
      '[th-live-nologin] Client-side guard bypassed.\n' +
      'The live room UI will load but streams/chat will be empty\n' +
      'because the server does not accept a fake token.'
    );
  });
})();

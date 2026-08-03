// ==UserScript==
// @name         Dokploy Production Guard
// @namespace    https://github.com/nguyenhuy158
// @version      1.0
// @description  Red warning frame + badge when the selected Dokploy environment is production, to prevent acting on prod by mistake
// @match        *://deploy-dev.techcoop.dev/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const HOST_ID = '__prod_guard_host__';
  const PROD_NAMES = new Set(['production', 'prod']);

  function onProjectPage() {
    return location.pathname.startsWith('/dashboard/project/');
  }

  // The env id in the URL is opaque; the environment's name only shows up in the
  // breadcrumb / env-switcher controls, so detect it from their exact text.
  function isProdEnv() {
    if (!onProjectPage()) return false;
    for (const el of document.querySelectorAll('button, a, [role="combobox"]')) {
      const text = el.textContent.trim().toLowerCase();
      if (PROD_NAMES.has(text)) return true;
    }
    return false;
  }

  function showOverlay() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    // pointer-events:none — pure warning layer, never blocks clicks
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;pointer-events:none;' +
      'box-shadow:inset 0 0 0 4px rgba(220,38,38,.95), inset 0 0 70px rgba(220,38,38,.18);';
    const badge = document.createElement('div');
    badge.textContent = '🚨 PRODUCTION — thao tác cẩn thận';
    badge.style.cssText =
      'position:absolute;top:0;left:50%;transform:translateX(-50%);' +
      'background:#dc2626;color:#fff;padding:3px 16px;border-radius:0 0 8px 8px;' +
      'font:700 12px/1.6 ui-sans-serif,system-ui;letter-spacing:.06em;' +
      'box-shadow:0 4px 12px rgba(220,38,38,.5);';
    host.appendChild(badge);
    document.documentElement.appendChild(host);
  }

  function hideOverlay() {
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
  }

  function update() {
    if (isProdEnv()) showOverlay();
    else hideOverlay();
  }

  // SPA: re-evaluate on every DOM change, throttled to one check per frame
  let scheduled = false;
  const observer = new MutationObserver((mutations) => {
    if (mutations.every((m) => {
      const t = m.target;
      return t.nodeType === 1 && t.id === HOST_ID;
    })) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  });

  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    update();
  }

  boot();
})();

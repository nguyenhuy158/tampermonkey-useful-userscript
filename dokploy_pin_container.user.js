// ==UserScript==
// @name         Sidekick — Dokploy Pin Log Container
// @namespace    https://github.com/nguyenhuy158
// @version      0.4.0
// @description  Remembers the compose service you pinned in Dokploy's Logs tab and re-selects its container after redeploys (matches any self-hosted Dokploy)
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  // src/sites/dokploy/pin-container.js
  (function() {
    "use strict";
    const PIN_KEY_PREFIX = "__sidekick_dokploy_pin__:";
    const BTN_ID = "__sidekick_dokploy_pin_btn__";
    const POLL_MS = 500;
    const APPLY_TIMEOUT_MS = 15e3;
    const REAPPLY_COOLDOWN_MS = 3e3;
    const REAPPLY_MAX = 5;
    let lastUrl = null;
    let appliedForUrl = null;
    let applying = false;
    let userTouchedSelect = false;
    let lastApplyAt = 0;
    let reapplyCount = 0;
    function isDokploy() {
      return document.title.includes("Dokploy") || !!document.querySelector('a[href="/dashboard/projects"]');
    }
    function isServiceLogsPage() {
      return /\/dashboard\/project\/[^/]+\/environment\/[^/]+\/services\//.test(location.pathname) && new URLSearchParams(location.search).get("tab") === "logs";
    }
    function pinKey() {
      return PIN_KEY_PREFIX + location.pathname;
    }
    function getPin() {
      try {
        return localStorage.getItem(pinKey());
      } catch {
        return null;
      }
    }
    function setPin(service) {
      try {
        if (service) localStorage.setItem(pinKey(), service);
        else localStorage.removeItem(pinKey());
      } catch {
      }
    }
    function serviceFromContainerText(text) {
      if (!text) return null;
      const head = text.trim().split(/\s+/)[0];
      const us = head.indexOf("_");
      if (us === -1) return null;
      const rest = head.slice(us + 1);
      const m = rest.match(/^(.+?)\.\d+\./);
      return m ? m[1] : null;
    }
    function findTrigger() {
      const triggers = Array.from(document.querySelectorAll('button[role="combobox"]'));
      return triggers.find((t) => serviceFromContainerText(t.textContent)) || triggers[0] || null;
    }
    function dispatchPointer(el, types) {
      for (const type of types) {
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" })
        );
      }
    }
    function openDropdown(trigger) {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          bubbles: true,
          cancelable: true
        })
      );
    }
    function closeDropdown() {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    function selectOption(option) {
      dispatchPointer(option, ["pointerdown", "pointerup", "click"]);
    }
    function waitFor(predicate, timeoutMs) {
      return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const value = predicate();
          if (value) {
            clearInterval(timer);
            resolve(value);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(null);
          }
        }, 150);
      });
    }
    async function applyPin() {
      const pinned = getPin();
      if (!pinned || applying) return;
      applying = true;
      lastApplyAt = Date.now();
      try {
        const trigger = await waitFor(() => {
          const t = findTrigger();
          return t && serviceFromContainerText(t.textContent) ? t : null;
        }, APPLY_TIMEOUT_MS);
        if (!trigger) return;
        if (serviceFromContainerText(trigger.textContent) === pinned) return;
        openDropdown(trigger);
        const option = await waitFor(() => {
          const opts = Array.from(document.querySelectorAll('[role="option"]'));
          if (!opts.length) return null;
          return opts.find((o) => serviceFromContainerText(o.textContent) === pinned) || false;
        }, 3e3);
        if (option) selectOption(option);
        else closeDropdown();
      } finally {
        applying = false;
        renderButton();
      }
    }
    function renderButton() {
      const existing = document.getElementById(BTN_ID);
      if (!isServiceLogsPage()) {
        if (existing) existing.remove();
        return;
      }
      const trigger = findTrigger();
      if (!trigger) {
        if (existing) existing.remove();
        return;
      }
      let btn = existing;
      if (!btn || btn.previousElementSibling !== trigger) {
        if (btn) btn.remove();
        btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.style.cssText = "display:block;margin:6px 0 0 auto;padding:3px 10px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;cursor:pointer;font-size:12px;line-height:1.4;white-space:nowrap;";
        btn.addEventListener("click", onPinClick);
        trigger.insertAdjacentElement("afterend", btn);
      }
      const pinned = getPin();
      const current = serviceFromContainerText(trigger.textContent);
      if (pinned && pinned === current) {
        btn.textContent = "\u{1F4CC} " + pinned;
        btn.title = "\u0110ang pin service n\xE0y \u2014 b\u1EA5m \u0111\u1EC3 b\u1ECF pin";
        btn.style.background = "rgba(16,185,129,.15)";
        btn.style.borderColor = "rgba(16,185,129,.6)";
      } else if (pinned) {
        btn.textContent = "\u{1F4CC} " + pinned + " \u21BA";
        btn.title = '\u0110ang pin "' + pinned + '" \u2014 b\u1EA5m \u0111\u1EC3 pin container \u0111ang ch\u1ECDn';
        btn.style.background = "rgba(234,179,8,.15)";
        btn.style.borderColor = "rgba(234,179,8,.6)";
      } else {
        btn.textContent = "\u{1F4CC} Pin";
        btn.title = "Pin container \u0111ang ch\u1ECDn cho tab Logs";
        btn.style.background = "transparent";
        btn.style.borderColor = "rgba(128,128,128,.4)";
      }
    }
    function onPinClick() {
      const trigger = findTrigger();
      const current = serviceFromContainerText(trigger ? trigger.textContent : "");
      const pinned = getPin();
      if (pinned && pinned === current) setPin(null);
      else if (current) setPin(current);
      renderButton();
    }
    function shouldReapply() {
      if (applying || userTouchedSelect || !isServiceLogsPage()) return false;
      if (reapplyCount >= REAPPLY_MAX) return false;
      if (Date.now() - lastApplyAt < REAPPLY_COOLDOWN_MS) return false;
      const pinned = getPin();
      if (!pinned) return false;
      const trigger = findTrigger();
      const current = trigger ? serviceFromContainerText(trigger.textContent) : null;
      return !!current && current !== pinned;
    }
    function onUrlOrDomChange() {
      if (!isDokploy()) return;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        userTouchedSelect = false;
        reapplyCount = 0;
        if (isServiceLogsPage() && appliedForUrl !== location.href) {
          appliedForUrl = location.href;
          applyPin();
        }
      } else if (shouldReapply()) {
        reapplyCount += 1;
        applyPin();
      }
      renderButton();
    }
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!e.isTrusted || !(e.target instanceof Element)) return;
        if (e.target.closest('button[role="combobox"], [role="listbox"]')) {
          userTouchedSelect = true;
        }
      },
      true
    );
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        onUrlOrDomChange();
      });
    });
    function boot() {
      if (!document.body) {
        setTimeout(boot, POLL_MS);
        return;
      }
      observer.observe(document.body, { childList: true, subtree: true });
      onUrlOrDomChange();
    }
    boot();
  })();
})();

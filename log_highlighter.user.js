// ==UserScript==
// @name         Log Highlighter
// @namespace    https://yourdomain.com/
// @version      1.2
// @description  Colorize log levels, HTTP methods and status codes in the Techcoop deploy dashboard log viewer
// @match        *://deploy-dev.techcoop.dev/*
// @match        *://deploy.techcoop.dev/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const RULES = [
    // Log levels
    { regex: /\b(CRITICAL|FATAL)\b/g, style: 'background:#7f1d1d;color:#fff;font-weight:bold;border-radius:3px;padding:0 3px;' },
    { regex: /\b(ERROR|Traceback)\b/g, style: 'background:#dc2626;color:#fff;font-weight:bold;border-radius:3px;padding:0 3px;' },
    { regex: /\b(WARNING|WARN)\b/g, style: 'background:#f59e0b;color:#000;border-radius:3px;padding:0 3px;' },
    { regex: /\b(INFO)\b/g, style: 'color:#2563eb;font-weight:bold;' },
    { regex: /\b(DEBUG)\b/g, style: 'color:#6b7280;' },
    // HTTP methods
    { regex: /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(?= \/)/g, style: 'color:#7c3aed;font-weight:bold;' },
    // HTTP status codes: after `HTTP/1.x"` in access logs
    { regex: /(?<=HTTP\/\d\.\d" )(2\d\d)\b/g, style: 'color:#16a34a;font-weight:bold;' },
    { regex: /(?<=HTTP\/\d\.\d" )(3\d\d)\b/g, style: 'color:#d97706;font-weight:bold;' },
    { regex: /(?<=HTTP\/\d\.\d" )([45]\d\d)\b/g, style: 'background:#dc2626;color:#fff;font-weight:bold;border-radius:3px;padding:0 3px;' },
    // IP addresses
    { regex: /\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, style: 'color:#0891b2;' },
  ];

  const PROCESSED = 'data-tclh';

  function highlightTextNode(node) {
    const text = node.textContent;
    if (!text || text.length < 4) return;

    let matched = false;
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(text)) { matched = true; break; }
    }
    if (!matched) return;

    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      html = html.replace(rule.regex, `<span style="${rule.style}">$1</span>`);
    }

    const span = document.createElement('span');
    span.setAttribute(PROCESSED, '1');
    span.innerHTML = html;
    node.replaceWith(span);
  }

  function walk(node) {
    if (node.nodeType === 3) {
      highlightTextNode(node);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (node.hasAttribute && node.hasAttribute(PROCESSED)) return;
    // Copy child list first: replacing text nodes mutates childNodes live
    const children = Array.from(node.childNodes);
    for (const child of children) walk(child);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const added of m.addedNodes) {
        if (added.nodeType === 1 && added.hasAttribute(PROCESSED)) continue;
        walk(added);
      }
    }
  });

  function start() {
    walk(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

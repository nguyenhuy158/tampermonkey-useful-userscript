// ==UserScript==
// @name         Auto Keyword Highlighter (Lightweight)
// @namespace    https://yourdomain.com/
// @version      1.1
// @description  Highlight keywords efficiently
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const KEYWORDS = ["Odoo", "Python", "backend", "API", "Docker"];
  const STYLE = "background: yellow; color: black; border-radius: 3px; padding:1px 2px;";
  const regex = new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "gi");

  function walk(node) {
    if (node.nodeType === 3) { // text node
      const text = node.textContent;
      if (regex.test(text)) {
        const span = document.createElement("span");
        span.innerHTML = text.replace(regex, `<span style="${STYLE}">$1</span>`);
        node.replaceWith(span);
      }
    } else if (node.nodeType === 1 && node.tagName !== "SCRIPT" && node.tagName !== "STYLE") {
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
  }

  window.addEventListener("load", () => {
    walk(document.body);
  });
})();

// ==UserScript==
// @name         Auto Keyword Highlighter
// @namespace    https://yourdomain.com/
// @version      1.0
// @description  Automatically highlight predefined keywords on any webpage
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // === 1. Define your keywords here ===
    const KEYWORDS = ["Odoo", "Python", "backend", "API", "Docker"];

    // === 2. Highlight style ===
    const HIGHLIGHT_STYLE = `
        background-color: yellow;
        color: black;
        padding: 2px 4px;
        border-radius: 3px;
    `;

    // === 3. Function to highlight ===
    function highlightKeywords() {
        const elements = document.querySelectorAll("p, span, div, li, td, a, h1, h2, h3");
        KEYWORDS.forEach((word) => {
            const regex = new RegExp(`(${word})`, "gi");
            elements.forEach((el) => {
                if (el.children.length === 0 && el.textContent.match(regex)) {
                    el.innerHTML = el.innerHTML.replace(regex, `<span style="${HIGHLIGHT_STYLE}">$1</span>`);
                }
            });
        });
    }

    // === 4. Run after page loaded ===
    window.addEventListener("load", () => {
        highlightKeywords();
        // Optional: Re-run when DOM changes
        const observer = new MutationObserver(() => highlightKeywords());
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();

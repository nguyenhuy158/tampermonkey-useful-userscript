async function loadKeywords() {
    const response = await fetch(chrome.runtime.getURL("keywords.json"));
    const data = await response.json();
    return data.keywords;
}

function highlightText(node, keyword) {
    const regex = new RegExp(`(${keyword})`, "gi");
    const newHTML = node.innerHTML.replace(regex, '<span style="background: yellow;">$1</span>');
    node.innerHTML = newHTML;
}

async function highlightKeywords() {
    const keywords = await loadKeywords();
    keywords.forEach((word) => {
        document.querySelectorAll("p, span, div, li, td").forEach((el) => {
            highlightText(el, word);
        });
    });
}

highlightKeywords();

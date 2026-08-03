// ==UserScript==
// @name         Website Health Monitor
// @namespace    https://github.com/nguyenhuy158
// @version      1.1
// @description  Poll configured websites from the browser, show a status widget on Google pages and notify on up/down transitions
// @match        *://www.google.com/*
// @match        *://google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Sites are stored in GM storage; edit them from the widget's ⚙ panel or the
  // Tampermonkey menu. interval/timeout are seconds.
  const DEFAULT_SITES = [
    { name: 'Deploy Dev', url: 'https://deploy-dev.techcoop.dev', interval: 60, timeout: 10 }
  ];

  const TAB_ID = Math.random().toString(36).slice(2);
  const LEADER_TTL_MS = 25000;
  const HEARTBEAT_MS = 10000;
  const TICK_MS = 5000;
  const HISTORY_MAX = 100;

  const getSites = () => GM_getValue('sites', DEFAULT_SITES);
  const getResults = () => GM_getValue('results', {});

  // --- leader election: exactly one tab does the polling ---------------------
  function heartbeat() {
    const leader = GM_getValue('leader', null);
    if (!leader || leader.id === TAB_ID || Date.now() - leader.t > LEADER_TTL_MS) {
      GM_setValue('leader', { id: TAB_ID, t: Date.now() });
    }
  }

  function isLeader() {
    const leader = GM_getValue('leader', null);
    return !!leader && leader.id === TAB_ID;
  }

  // --- polling ----------------------------------------------------------------
  const inFlight = new Set();

  function due(site, results) {
    const last = results[site.url];
    const interval = (site.interval || 60) * 1000;
    return !last || Date.now() - last.t >= interval;
  }

  function tick() {
    heartbeat();
    if (!isLeader()) return;
    const results = getResults();
    for (const site of getSites()) {
      if (due(site, results) && !inFlight.has(site.url)) check(site);
    }
  }

  function check(site) {
    inFlight.add(site.url);
    const started = performance.now();
    const finish = (up, code, note) =>
      record(site, { up, code, note, ms: Math.round(performance.now() - started), t: Date.now() });
    GM_xmlhttpRequest({
      method: 'GET',
      url: site.url,
      timeout: (site.timeout || 10) * 1000,
      onload: (r) => finish(r.status >= 200 && r.status < 400, r.status, ''),
      onerror: () => finish(false, 0, 'network error'),
      ontimeout: () => finish(false, 0, 'timeout')
    });
  }

  function record(site, entry) {
    inFlight.delete(site.url);
    const results = getResults();
    const prev = results[site.url];
    results[site.url] = entry;
    GM_setValue('results', results);

    const key = 'hist:' + site.url;
    const hist = GM_getValue(key, []);
    hist.push({ up: entry.up, ms: entry.ms, t: entry.t });
    GM_setValue(key, hist.slice(-HISTORY_MAX));

    if (prev && prev.up !== entry.up) {
      GM_notification({
        title: `${site.name} is ${entry.up ? 'UP ✅' : 'DOWN ❌'}`,
        text: entry.up
          ? `Recovered — HTTP ${entry.code}, ${entry.ms}ms`
          : `HTTP ${entry.code || '—'} ${entry.note || ''}`.trim(),
        timeout: 8000
      });
    }
    render();
  }

  function uptime(url) {
    const hist = GM_getValue('hist:' + url, []);
    if (!hist.length) return null;
    return Math.round((hist.filter((h) => h.up).length / hist.length) * 100);
  }

  // --- widget -------------------------------------------------------------------
  let shadow, expanded = false, editing = false;

  function build() {
    if (GM_getValue('widgetHidden', false)) return;
    const host = document.createElement('div');
    host.id = '__health_monitor_host__';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      #pill { position:fixed; bottom:14px; left:14px; z-index:2147483646;
        display:flex; align-items:center; gap:6px; padding:7px 11px;
        background:#0f172a; border:1px solid #1e293b; border-radius:999px;
        cursor:pointer; font:12px/1 ui-monospace,Menlo,monospace; color:#94a3b8;
        box-shadow:0 4px 14px rgba(0,0,0,.4); }
      .dot { width:9px; height:9px; border-radius:50%; }
      .up { background:#22c55e; } .down { background:#ef4444; } .unknown { background:#64748b; }
      #panel { position:fixed; bottom:52px; left:14px; z-index:2147483646; width:340px;
        background:#0f172a; border:1px solid #1e293b; border-radius:10px; padding:12px;
        font:12px/1.5 ui-monospace,Menlo,monospace; color:#cbd5e1;
        box-shadow:0 10px 30px rgba(0,0,0,.5); }
      .row { display:flex; align-items:center; gap:8px; padding:5px 0; }
      .row .name { flex:1; color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .meta { color:#64748b; }
      #hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
      #hdr b { color:#e2e8f0; font-size:12px; }
      #gear { cursor:pointer; }
      textarea { width:100%; height:150px; background:#020617; color:#cbd5e1;
        border:1px solid #1e293b; border-radius:6px; font:11px/1.5 ui-monospace,monospace; padding:6px; box-sizing:border-box; }
      button { margin-top:6px; background:#10b981; color:#022c22; border:0; border-radius:5px;
        padding:5px 12px; font:600 11px ui-monospace,monospace; cursor:pointer; }
      .err { color:#f87171; }
    `;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.id = 'wrap';
    shadow.appendChild(wrap);
    shadow.addEventListener('click', onClick);
    render();
  }

  function onClick(e) {
    const t = e.composedPath()[0];
    if (t.id === 'pill' || t.closest && t.closest('#pill')) { expanded = !expanded; editing = false; render(); }
    else if (t.id === 'gear') { editing = !editing; render(); }
    else if (t.id === 'save') saveConfig();
  }

  function saveConfig() {
    const ta = shadow.querySelector('textarea');
    const err = shadow.querySelector('.err');
    try {
      const sites = JSON.parse(ta.value);
      if (!Array.isArray(sites) || sites.some((s) => !s.url)) throw new Error('need [{name,url,interval}]');
      GM_setValue('sites', sites);
      editing = false;
      render();
    } catch (ex) {
      if (err) err.textContent = ex.message;
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render() {
    if (!shadow) return;
    const wrap = shadow.getElementById('wrap');
    const sites = getSites();
    const results = getResults();
    const dot = (s) => {
      const r = results[s.url];
      return `<span class="dot ${r ? (r.up ? 'up' : 'down') : 'unknown'}"></span>`;
    };
    let html = `<div id="pill">${sites.map(dot).join('')}<span>health</span></div>`;
    if (expanded) {
      html += `<div id="panel"><div id="hdr"><b>Health Monitor</b><span id="gear">⚙</span></div>`;
      if (editing) {
        html += `<textarea>${esc(JSON.stringify(sites, null, 2))}</textarea>
          <div class="err"></div><button id="save">Save</button>`;
      } else {
        for (const s of sites) {
          const r = results[s.url];
          const up = uptime(s.url);
          html += `<div class="row">${dot(s)}<span class="name" title="${esc(s.url)}">${esc(s.name || s.url)}</span>
            <span class="meta">${r ? `${r.code || '—'} · ${r.ms}ms` : 'waiting'}${up === null ? '' : ` · ${up}%`}</span></div>`;
        }
      }
      html += `</div>`;
    }
    wrap.innerHTML = html;
  }

  // --- boot ---------------------------------------------------------------------
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle health widget', () => {
      GM_setValue('widgetHidden', !GM_getValue('widgetHidden', false));
      location.reload();
    });
  }
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('results', () => render());
    GM_addValueChangeListener('sites', () => render());
  }

  build();
  heartbeat();
  tick();
  setInterval(tick, TICK_MS);
})();

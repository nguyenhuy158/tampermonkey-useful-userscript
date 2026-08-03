// ==UserScript==
// @name         Sidekick — Odoo Dev Toolkit
// @namespace    https://github.com/nguyenhuy158
// @version      0.4.1
// @description  Odoo dev panel (field detector, RPC inspector, model browser, view inspector, domain tester, ORM eval, i18n gaps, noupdate, context viewer) + fetch/XHR interceptor catching missing view fields before the client crashes
// @match        *://localhost/*
// @match        *://127.0.0.1/*
// @match        *://*.techcoop.dev/*
// @match        *://*.techcoop.vn/*
// @exclude      *://deploy-dev.techcoop.dev/*
// @exclude      *://deploy.techcoop.dev/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // interceptor — must patch fetch/XHR before Odoo's first RPC
(() => {
  // src/sites/odoo/interceptor.js
  (function() {
    "use strict";
    const RPC_MATCH = "call_kw";
    const EVENT = "__odoo_dev_toolkit__";
    const CTX_EVENT = "__odoo_dev_toolkit_ctx__";
    const RPC_EVENT = "__odoo_dev_toolkit_rpc__";
    const TRACK_METHODS = /* @__PURE__ */ new Set([
      "web_search_read",
      "web_read",
      "read",
      "read_group",
      "web_read_group"
    ]);
    let rpcSeq = 0;
    const OPERATORS = /* @__PURE__ */ new Set([
      "=",
      "!=",
      "<",
      ">",
      "<=",
      ">=",
      "in",
      "not in",
      "like",
      "not like",
      "ilike",
      "not ilike",
      "=like",
      "=ilike",
      "child_of",
      "parent_of",
      "any",
      "not any"
    ]);
    const SKIP_TOKENS = /* @__PURE__ */ new Set(["parent", "id", "uid", "active_id", "context", "self"]);
    const seen = /* @__PURE__ */ new Set();
    const allProblems = [];
    let fresh = [];
    function firstSegment(path) {
      return String(path).split(".")[0].split(":")[0].trim();
    }
    function shouldSkip(path) {
      const seg = firstSegment(path);
      return !seg || SKIP_TOKENS.has(seg) || /^[0-9]/.test(seg);
    }
    function checkField(model, path, models, viewType, category) {
      if (shouldSkip(path)) return;
      const seg = firstSegment(path);
      const modelFields = models[model];
      if (!modelFields) return;
      if (!modelFields[seg]) push({ viewType, model, field: seg, category, raw: path });
    }
    function push(p) {
      const key = `${p.model}|${p.field}|${p.category}|${p.viewType}`;
      if (seen.has(key)) return;
      seen.add(key);
      allProblems.push(p);
      fresh.push(p);
    }
    function walkModifiers(node, model, models, viewType) {
      if (Array.isArray(node)) {
        if (typeof node[0] === "string" && OPERATORS.has(node[1])) {
          checkField(model, node[0], models, viewType, "modifier");
          return;
        }
        for (const item of node) walkModifiers(item, model, models, viewType);
      } else if (node && typeof node === "object") {
        for (const value of Object.values(node)) walkModifiers(value, model, models, viewType);
      }
    }
    function domainOperands(str) {
      const out = [];
      const re = /\(\s*(['"])([\w.:]+)\1\s*,/g;
      let m;
      while (m = re.exec(str)) out.push(m[2]);
      return out;
    }
    function groupByFields(str) {
      const out = [];
      const re = /group_by['"]?\s*:\s*(\[[^\]]*\]|['"][\w.:]+['"])/g;
      let m;
      while (m = re.exec(str)) {
        const tokenRe = /['"]([\w.:]+)['"]/g;
        let t;
        while (t = tokenRe.exec(m[1])) out.push(t[1]);
      }
      return out;
    }
    function checkAttributes(el, model, models, viewType) {
      const modifiers = el.getAttribute("modifiers");
      if (modifiers) {
        try {
          walkModifiers(JSON.parse(modifiers), model, models, viewType);
        } catch (e) {
        }
      }
      const attrs = el.getAttribute("attrs");
      if (attrs)
        domainOperands(attrs).forEach((f) => checkField(model, f, models, viewType, "modifier"));
      const groupby = el.getAttribute("groupby");
      if (groupby) checkField(model, groupby, models, viewType, "groupby");
      const context = el.getAttribute("context");
      if (context)
        groupByFields(context).forEach((f) => checkField(model, f, models, viewType, "groupby"));
      if (viewType === "search") {
        for (const attr of ["domain", "filter_domain"]) {
          const val = el.getAttribute(attr);
          if (val)
            domainOperands(val).forEach(
              (f) => checkField(model, f, models, viewType, "search-domain")
            );
        }
      }
    }
    function traverse(node, model, models, viewType) {
      const modelFields = models[model];
      if (!modelFields || !node) return;
      for (const child of node.children) {
        checkAttributes(child, model, models, viewType);
        if (child.tagName === "field") {
          const fieldName = child.getAttribute("name");
          const fieldDef = modelFields[fieldName];
          if (!fieldDef) {
            push({ viewType, model, field: fieldName, category: "field", raw: fieldName });
            continue;
          }
          if (child.children.length && fieldDef.relation) {
            traverse(child, fieldDef.relation, models, viewType);
          }
        } else {
          traverse(child, model, models, viewType);
        }
      }
    }
    function checkResult(result, url) {
      if (!result || !result.views || !result.models) return;
      const models = result.models;
      fresh = [];
      for (const [viewType, view] of Object.entries(result.views)) {
        if (!view || !view.arch) continue;
        const doc = new DOMParser().parseFromString(view.arch, "application/xml");
        if (doc.querySelector("parsererror")) continue;
        traverse(doc.documentElement, view.model, models, viewType);
      }
      if (fresh.length) emit(fresh.slice(), url);
    }
    function emit(problems, url) {
      console.groupCollapsed(
        `%c[Odoo Dev Toolkit] ${problems.length} missing field reference(s)`,
        "color:#fff;background:#c0392b;padding:2px 6px;border-radius:3px;font-weight:bold"
      );
      for (const p of problems) {
        console.error(
          `[${p.category}] model "${p.model}" <${p.viewType}> -> "${p.field}"` + (p.raw !== p.field ? ` (in "${p.raw}")` : "") + " does NOT exist"
        );
      }
      console.info("RPC:", url);
      console.groupEnd();
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { problems, url } }));
    }
    function maybeEmitCtx(rawBody) {
      if (typeof rawBody !== "string") return;
      try {
        const j = JSON.parse(rawBody);
        const p = j && j.params;
        if (!p || !p.model || !TRACK_METHODS.has(p.method)) return;
        let resId = null;
        const args = p.args;
        if (Array.isArray(args) && args.length) {
          const first = args[0];
          if (typeof first === "number") resId = first;
          else if (Array.isArray(first) && typeof first[0] === "number") resId = first[0];
        }
        window.dispatchEvent(new CustomEvent(CTX_EVENT, { detail: { model: p.model, resId } }));
      } catch (e) {
      }
    }
    function parseCallKw(rawBody) {
      if (typeof rawBody !== "string") return null;
      try {
        const j = JSON.parse(rawBody);
        const p = j && j.params;
        if (!p) return null;
        return {
          model: p.model || null,
          method: p.method || null,
          args: p.args || [],
          kwargs: p.kwargs || {}
        };
      } catch (e) {
        return null;
      }
    }
    function startRpc(rawBody, url) {
      const meta = parseCallKw(rawBody);
      if (!meta) return null;
      const id = ++rpcSeq;
      const entry = {
        id,
        t: Date.now(),
        url,
        model: meta.model,
        method: meta.method,
        args: meta.args,
        kwargs: meta.kwargs,
        reqSize: rawBody.length,
        resSize: 0,
        duration: 0,
        status: "pending",
        error: null,
        result: void 0,
        _start: performance.now()
      };
      window.dispatchEvent(new CustomEvent(RPC_EVENT, { detail: { kind: "start", entry } }));
      return entry;
    }
    function finishRpc(entry, rawText, ok) {
      if (!entry) return;
      entry.duration = Math.max(0, performance.now() - entry._start);
      entry.resSize = rawText ? rawText.length : 0;
      delete entry._start;
      let parsed = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch (e) {
        }
      }
      if (parsed && parsed.error) {
        entry.status = "error";
        const e = parsed.error.data || {};
        entry.error = e.message || parsed.error.message || "RPC error";
      } else if (!ok) {
        entry.status = "error";
        entry.error = "HTTP error";
      } else {
        entry.status = "ok";
        if (parsed) entry.result = parsed.result;
      }
      window.dispatchEvent(new CustomEvent(RPC_EVENT, { detail: { kind: "end", entry } }));
    }
    function maybeCheck(rawText, url) {
      try {
        const data = JSON.parse(rawText);
        if (data && data.result) checkResult(data.result, url);
      } catch (e) {
      }
    }
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      let entry = null;
      let url = "";
      try {
        url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url || "";
        if (url.includes(RPC_MATCH)) {
          const init = args[1];
          if (init && typeof init.body === "string") {
            maybeEmitCtx(init.body);
            entry = startRpc(init.body, url);
          }
        }
      } catch (e) {
      }
      return origFetch.apply(this, args).then(
        (res) => {
          try {
            if (url.includes(RPC_MATCH)) {
              res.clone().text().then((t) => {
                maybeCheck(t, url);
                finishRpc(entry, t, res.ok);
              }).catch(() => finishRpc(entry, "", res.ok));
            }
          } catch (e) {
          }
          return res;
        },
        (err) => {
          finishRpc(entry, "", false);
          throw err;
        }
      );
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__odt_url = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (this.__odt_url && String(this.__odt_url).includes(RPC_MATCH)) {
        if (typeof body === "string") maybeEmitCtx(body);
        const entry = typeof body === "string" ? startRpc(body, this.__odt_url) : null;
        this.addEventListener("load", function() {
          if (this.responseText) maybeCheck(this.responseText, this.__odt_url);
          finishRpc(entry, this.responseText || "", this.status >= 200 && this.status < 400);
        });
        this.addEventListener("error", function() {
          finishRpc(entry, "", false);
        });
        this.addEventListener("abort", function() {
          finishRpc(entry, "", false);
        });
      }
      return origSend.apply(this, arguments);
    };
    window.__odooDevToolkit = { problems: allProblems };
    console.info("%c[Odoo Dev Toolkit] interceptor active", "color:#00b894");
  })();
})();

  // panel UI — needs the DOM; toolkit.css is inlined via a chrome.runtime shim
  var __ODT_CSS_URL__ = "data:text/css;charset=utf-8," + encodeURIComponent("*,:after,:before{--tw-border-spacing-x:0;--tw-border-spacing-y:0;--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness:proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-color:rgba(59,130,246,.5);--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }::backdrop{--tw-border-spacing-x:0;--tw-border-spacing-y:0;--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness:proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-color:rgba(59,130,246,.5);--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }/*! tailwindcss v3.4.19 | MIT License | https://tailwindcss.com*/*,:after,:before{box-sizing:border-box;border:0 solid #e5e7eb}:after,:before{--tw-content:\"\"}:host,html{line-height:1.5;-webkit-text-size-adjust:100%;-moz-tab-size:4;-o-tab-size:4;tab-size:4;font-family:ui-sans-serif,system-ui,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji;font-feature-settings:normal;font-variation-settings:normal;-webkit-tap-highlight-color:transparent}body{margin:0;line-height:inherit}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,pre,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;font-feature-settings:normal;font-variation-settings:normal;font-size:1em}small{font-size:80%}sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:baseline}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}button,input,optgroup,select,textarea{font-family:inherit;font-feature-settings:inherit;font-variation-settings:inherit;font-size:100%;font-weight:inherit;line-height:inherit;letter-spacing:inherit;color:inherit;margin:0;padding:0}button,select{text-transform:none}button,input:where([type=button]),input:where([type=reset]),input:where([type=submit]){-webkit-appearance:button;background-color:transparent;background-image:none}:-moz-focusring{outline:auto}:-moz-ui-invalid{box-shadow:none}progress{vertical-align:baseline}::-webkit-inner-spin-button,::-webkit-outer-spin-button{height:auto}[type=search]{-webkit-appearance:textfield;outline-offset:-2px}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-file-upload-button{-webkit-appearance:button;font:inherit}summary{display:list-item}blockquote,dd,dl,figure,h1,h2,h3,h4,h5,h6,hr,p,pre{margin:0}fieldset{margin:0}fieldset,legend{padding:0}menu,ol,ul{list-style:none;margin:0;padding:0}dialog{padding:0}textarea{resize:vertical}input::-moz-placeholder,textarea::-moz-placeholder{opacity:1;color:#9ca3af}input::placeholder,textarea::placeholder{opacity:1;color:#9ca3af}[role=button],button{cursor:pointer}:disabled{cursor:default}audio,canvas,embed,iframe,img,object,svg,video{display:block;vertical-align:middle}img,video{max-width:100%;height:auto}[hidden]:where(:not([hidden=until-found])){display:none}:host{all:initial;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.container{width:100%}@media (min-width:640px){.container{max-width:640px}}@media (min-width:768px){.container{max-width:768px}}@media (min-width:1024px){.container{max-width:1024px}}@media (min-width:1280px){.container{max-width:1280px}}@media (min-width:1536px){.container{max-width:1536px}}.visible{visibility:visible}.collapse{visibility:collapse}.fixed{position:fixed}.absolute{position:absolute}.relative{position:relative}.-right-1{right:-.25rem}.-top-1{top:-.25rem}.bottom-4{bottom:1rem}.right-4{right:1rem}.z-\\[2147483647\\]{z-index:2147483647}.m-0{margin:0}.mb-1{margin-bottom:.25rem}.ml-1{margin-left:.25rem}.block{display:block}.inline-block{display:inline-block}.inline{display:inline}.flex{display:flex}.grid{display:grid}.hidden{display:none}.h-1\\.5{height:.375rem}.h-11{height:2.75rem}.h-3{height:.75rem}.h-3\\.5{height:.875rem}.h-4{height:1rem}.min-h-0{min-height:0}.w-1\\.5{width:.375rem}.w-11{width:2.75rem}.w-3{width:.75rem}.w-3\\.5{width:.875rem}.w-4{width:1rem}.w-\\[320px\\]{width:320px}.w-full{width:100%}.min-w-4{min-width:1rem}.flex-1{flex:1 1 0%}.flex-shrink{flex-shrink:1}.transform{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.cursor-pointer{cursor:pointer}.resize{resize:both}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-1{gap:.25rem}.gap-1\\.5{gap:.375rem}.gap-2{gap:.5rem}.space-y-1>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.25rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.25rem*var(--tw-space-y-reverse))}.space-y-1\\.5>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.375rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.375rem*var(--tw-space-y-reverse))}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.75rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75rem*var(--tw-space-y-reverse))}.overflow-auto{overflow:auto}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.truncate{overflow:hidden;text-overflow:ellipsis}.truncate,.whitespace-nowrap{white-space:nowrap}.rounded{border-radius:.25rem}.rounded-2xl{border-radius:1rem}.rounded-full{border-radius:9999px}.rounded-md{border-radius:.375rem}.rounded-xl{border-radius:.75rem}.rounded-t-md{border-top-left-radius:.375rem;border-top-right-radius:.375rem}.border{border-width:1px}.border-b{border-bottom-width:1px}.border-b-2{border-bottom-width:2px}.border-t{border-top-width:1px}.border-emerald-400{--tw-border-opacity:1;border-color:rgb(52 211 153/var(--tw-border-opacity,1))}.border-gray-200{--tw-border-opacity:1;border-color:rgb(229 231 235/var(--tw-border-opacity,1))}.border-slate-600{--tw-border-opacity:1;border-color:rgb(71 85 105/var(--tw-border-opacity,1))}.border-slate-700{--tw-border-opacity:1;border-color:rgb(51 65 85/var(--tw-border-opacity,1))}.border-transparent{border-color:transparent}.bg-amber-300{--tw-bg-opacity:1;background-color:rgb(252 211 77/var(--tw-bg-opacity,1))}.bg-amber-500{--tw-bg-opacity:1;background-color:rgb(245 158 11/var(--tw-bg-opacity,1))}.bg-cyan-300{--tw-bg-opacity:1;background-color:rgb(103 232 249/var(--tw-bg-opacity,1))}.bg-cyan-400{--tw-bg-opacity:1;background-color:rgb(34 211 238/var(--tw-bg-opacity,1))}.bg-emerald-400{--tw-bg-opacity:1;background-color:rgb(52 211 153/var(--tw-bg-opacity,1))}.bg-emerald-500{--tw-bg-opacity:1;background-color:rgb(16 185 129/var(--tw-bg-opacity,1))}.bg-emerald-600{--tw-bg-opacity:1;background-color:rgb(5 150 105/var(--tw-bg-opacity,1))}.bg-gray-50{--tw-bg-opacity:1;background-color:rgb(249 250 251/var(--tw-bg-opacity,1))}.bg-rose-400{--tw-bg-opacity:1;background-color:rgb(251 113 133/var(--tw-bg-opacity,1))}.bg-rose-500{--tw-bg-opacity:1;background-color:rgb(244 63 94/var(--tw-bg-opacity,1))}.bg-slate-300{--tw-bg-opacity:1;background-color:rgb(203 213 225/var(--tw-bg-opacity,1))}.bg-slate-700{--tw-bg-opacity:1;background-color:rgb(51 65 85/var(--tw-bg-opacity,1))}.bg-slate-800{--tw-bg-opacity:1;background-color:rgb(30 41 59/var(--tw-bg-opacity,1))}.bg-slate-800\\/60{background-color:rgba(30,41,59,.6)}.bg-slate-800\\/70{background-color:rgba(30,41,59,.7)}.bg-slate-900{--tw-bg-opacity:1;background-color:rgb(15 23 42/var(--tw-bg-opacity,1))}.bg-violet-300{--tw-bg-opacity:1;background-color:rgb(196 181 253/var(--tw-bg-opacity,1))}.bg-white{--tw-bg-opacity:1;background-color:rgb(255 255 255/var(--tw-bg-opacity,1))}.p-1\\.5{padding:.375rem}.p-2\\.5{padding:.625rem}.px-1{padding-left:.25rem;padding-right:.25rem}.px-1\\.5{padding-left:.375rem;padding-right:.375rem}.px-2{padding-left:.5rem;padding-right:.5rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-4{padding-left:1rem;padding-right:1rem}.py-0\\.5{padding-top:.125rem;padding-bottom:.125rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}.py-1\\.5{padding-top:.375rem;padding-bottom:.375rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-2\\.5{padding-top:.625rem;padding-bottom:.625rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.pb-2{padding-bottom:.5rem}.pt-2{padding-top:.5rem}.pt-2\\.5{padding-top:.625rem}.text-center{text-align:center}.align-middle{vertical-align:middle}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace}.font-poppins{font-family:Poppins,-apple-system,Segoe UI,sans-serif}.text-\\[10px\\]{font-size:10px}.text-\\[11\\.5px\\]{font-size:11.5px}.text-\\[11px\\]{font-size:11px}.text-\\[13px\\]{font-size:13px}.text-\\[15px\\]{font-size:15px}.text-lg{font-size:1.125rem;line-height:1.75rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xs{font-size:.75rem;line-height:1rem}.font-bold{font-weight:700}.font-medium{font-weight:500}.font-semibold{font-weight:600}.uppercase{text-transform:uppercase}.italic{font-style:italic}.leading-4{line-height:1rem}.leading-relaxed{line-height:1.625}.text-amber-200{--tw-text-opacity:1;color:rgb(253 230 138/var(--tw-text-opacity,1))}.text-emerald-300{--tw-text-opacity:1;color:rgb(110 231 183/var(--tw-text-opacity,1))}.text-emerald-600{--tw-text-opacity:1;color:rgb(5 150 105/var(--tw-text-opacity,1))}.text-gray-500{--tw-text-opacity:1;color:rgb(107 114 128/var(--tw-text-opacity,1))}.text-gray-700{--tw-text-opacity:1;color:rgb(55 65 81/var(--tw-text-opacity,1))}.text-gray-800{--tw-text-opacity:1;color:rgb(31 41 55/var(--tw-text-opacity,1))}.text-purple-500{--tw-text-opacity:1;color:rgb(168 85 247/var(--tw-text-opacity,1))}.text-rose-300{--tw-text-opacity:1;color:rgb(253 164 175/var(--tw-text-opacity,1))}.text-sky-300{--tw-text-opacity:1;color:rgb(125 211 252/var(--tw-text-opacity,1))}.text-sky-500{--tw-text-opacity:1;color:rgb(14 165 233/var(--tw-text-opacity,1))}.text-slate-100{--tw-text-opacity:1;color:rgb(241 245 249/var(--tw-text-opacity,1))}.text-slate-200{--tw-text-opacity:1;color:rgb(226 232 240/var(--tw-text-opacity,1))}.text-slate-400{--tw-text-opacity:1;color:rgb(148 163 184/var(--tw-text-opacity,1))}.text-slate-500{--tw-text-opacity:1;color:rgb(100 116 139/var(--tw-text-opacity,1))}.text-slate-900{--tw-text-opacity:1;color:rgb(15 23 42/var(--tw-text-opacity,1))}.text-white{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.underline{text-decoration-line:underline}.antialiased{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.placeholder-slate-500::-moz-placeholder{--tw-placeholder-opacity:1;color:rgb(100 116 139/var(--tw-placeholder-opacity,1))}.placeholder-slate-500::placeholder{--tw-placeholder-opacity:1;color:rgb(100 116 139/var(--tw-placeholder-opacity,1))}.opacity-60{opacity:.6}.\\!shadow{--tw-shadow:0 1px 3px 0 rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1)!important;--tw-shadow-colored:0 1px 3px 0 var(--tw-shadow-color),0 1px 2px -1px var(--tw-shadow-color)!important;box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)!important}.shadow{--tw-shadow:0 1px 3px 0 rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);--tw-shadow-colored:0 1px 3px 0 var(--tw-shadow-color),0 1px 2px -1px var(--tw-shadow-color)}.shadow,.shadow-2xl{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-2xl{--tw-shadow:0 25px 50px -12px rgba(0,0,0,.25);--tw-shadow-colored:0 25px 50px -12px var(--tw-shadow-color)}.shadow-lg{--tw-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);--tw-shadow-colored:0 10px 15px -3px var(--tw-shadow-color),0 4px 6px -4px var(--tw-shadow-color)}.shadow-lg,.shadow-sm{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-sm{--tw-shadow:0 1px 2px 0 rgba(0,0,0,.05);--tw-shadow-colored:0 1px 2px 0 var(--tw-shadow-color)}.ring-1{--tw-ring-offset-shadow:var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow:var(--tw-ring-inset) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow,0 0 #0000)}.ring-rose-500\\/40{--tw-ring-color:rgba(244,63,94,.4)}.filter{filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.transition{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.ease-in-out{transition-timing-function:cubic-bezier(.4,0,.2,1)}.hover\\:bg-amber-400:hover{--tw-bg-opacity:1;background-color:rgb(251 191 36/var(--tw-bg-opacity,1))}.hover\\:bg-emerald-400:hover{--tw-bg-opacity:1;background-color:rgb(52 211 153/var(--tw-bg-opacity,1))}.hover\\:bg-emerald-500:hover{--tw-bg-opacity:1;background-color:rgb(16 185 129/var(--tw-bg-opacity,1))}.hover\\:bg-slate-600:hover{--tw-bg-opacity:1;background-color:rgb(71 85 105/var(--tw-bg-opacity,1))}.hover\\:text-slate-200:hover{--tw-text-opacity:1;color:rgb(226 232 240/var(--tw-text-opacity,1))}.focus\\:border-emerald-400:focus{--tw-border-opacity:1;border-color:rgb(52 211 153/var(--tw-border-opacity,1))}.focus\\:outline-none:focus{outline:2px solid transparent;outline-offset:2px}@media (prefers-color-scheme:dark){.dark\\:border-slate-700{--tw-border-opacity:1;border-color:rgb(51 65 85/var(--tw-border-opacity,1))}.dark\\:bg-slate-800\\/60{background-color:rgba(30,41,59,.6)}.dark\\:bg-slate-900{--tw-bg-opacity:1;background-color:rgb(15 23 42/var(--tw-bg-opacity,1))}.dark\\:text-emerald-400{--tw-text-opacity:1;color:rgb(52 211 153/var(--tw-text-opacity,1))}.dark\\:text-gray-100{--tw-text-opacity:1;color:rgb(243 244 246/var(--tw-text-opacity,1))}.dark\\:text-gray-300{--tw-text-opacity:1;color:rgb(209 213 219/var(--tw-text-opacity,1))}.dark\\:text-gray-400{--tw-text-opacity:1;color:rgb(156 163 175/var(--tw-text-opacity,1))}}");
  function __odtStartUI() {
    var chrome = { runtime: { getURL: function () { return __ODT_CSS_URL__; } } };
(() => {
  // src/sites/odoo/ui.js
  (function() {
    "use strict";
    const EVENT = "__odoo_dev_toolkit__";
    const CTX_EVENT = "__odoo_dev_toolkit_ctx__";
    const RPC_EVENT = "__odoo_dev_toolkit_rpc__";
    const RPC_MAX = 500;
    const rpcLog = [];
    const rpcById = /* @__PURE__ */ new Map();
    let rpcPaused = false;
    let rpcFilter = { q: "", method: "all", status: "all" };
    let rpcSelected = null;
    const problems = [];
    const seen = /* @__PURE__ */ new Set();
    let pageCtx = { model: null, resId: null };
    let listRows = [];
    let listFilter = { q: "", state: "all" };
    const NAME_CACHE = /* @__PURE__ */ new Map();
    const FIELDS_CACHE = /* @__PURE__ */ new Map();
    const REC_CACHE = /* @__PURE__ */ new Map();
    const BADGE = {
      field: { label: "FIELD", cls: "bg-rose-400 text-slate-900" },
      modifier: { label: "ATTRS", cls: "bg-amber-300 text-slate-900" },
      groupby: { label: "GROUPBY", cls: "bg-cyan-300 text-slate-900" },
      "search-domain": { label: "DOMAIN", cls: "bg-violet-300 text-slate-900" }
    };
    let shadow, panel, launcher, listEl, countEl, dotEl;
    let currentLang = null;
    const ARCH_CACHE = /* @__PURE__ */ new Map();
    let LANGS_CACHE = null;
    async function callKw(model, method, args, kwargs) {
      const res = await fetch("/web/dataset/call_kw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { model, method, args: args || [], kwargs: kwargs || {} }
        })
      });
      const data = await res.json();
      if (data.error) {
        const e = data.error.data || {};
        throw new Error(e.message || data.error.message || "RPC error");
      }
      return data.result;
    }
    function build() {
      const host = document.createElement("div");
      host.id = "__odoo_dev_toolkit_host__";
      document.documentElement.appendChild(host);
      shadow = host.attachShadow({ mode: "open" });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("dist/toolkit.css");
      shadow.appendChild(link);
      const style = document.createElement("style");
      style.textContent = `
      .odt-mono { font-family: "JetBrains Mono","IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace; font-feature-settings: "ss01","cv11"; }
      .odt-section {
        border-top: 1px dashed rgba(148,163,184,0.18);
        margin-top: 12px;
        padding-top: 14px;
        position: relative;
      }
      .odt-section-label {
        position: absolute;
        top: -7px;
        left: 10px;
        padding: 0 6px;
        background: #0f172a;
        font: 600 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.18em;
        color: #f59e0b;
        text-transform: uppercase;
      }
      .odt-flt-grid { display:grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; }
      .odt-field { display:flex; flex-direction:column; gap:4px; }
      .odt-field > span {
        font: 600 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.16em;
        color: #64748b;
        text-transform: uppercase;
      }
      .odt-input {
        all: unset;
        font: 12px/1.4 "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        background: transparent;
        border-bottom: 1px solid rgba(100,116,139,0.5);
        padding: 4px 2px;
        transition: border-color .15s, color .15s;
      }
      .odt-input::placeholder { color: #475569; }
      .odt-input:focus { border-bottom-color: #34d399; color: #fff; }
      .odt-btn-exec {
        all: unset;
        cursor: pointer;
        font: 600 10px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #0f172a;
        background: linear-gradient(180deg,#34d399 0%,#10b981 100%);
        padding: 8px 14px;
        border-radius: 4px;
        box-shadow: 0 0 0 1px rgba(52,211,153,0.4) inset, 0 6px 14px -6px rgba(16,185,129,0.55);
        transition: transform .12s, box-shadow .12s;
      }
      .odt-btn-exec:hover { transform: translateY(-1px); }
      .odt-btn-exec:active { transform: translateY(0); }
      .odt-btn-exec:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      .odt-list-meta {
        display:flex; align-items:center; gap:10px;
        margin-top: 10px;
        padding: 4px 0;
        font: 10px "JetBrains Mono",ui-monospace,monospace;
        color: #64748b;
        letter-spacing: 0.08em;
      }
      .odt-list-meta .sep { color: #334155; }
      .odt-list-meta .num { color: #38bdf8; }
      .odt-limit { width: 56px; }
      .odt-rows {
        margin-top: 6px;
        max-height: 260px;
        overflow: auto;
        border-radius: 6px;
        background:
          radial-gradient(rgba(148,163,184,0.06) 1px, transparent 1px) 0 0/12px 12px,
          linear-gradient(180deg, rgba(15,23,42,0.6), rgba(30,41,59,0.4));
        border: 1px solid rgba(51,65,85,0.7);
        box-shadow: inset 0 0 30px rgba(0,0,0,0.25);
      }
      .odt-rows::-webkit-scrollbar { width: 6px; }
      .odt-rows::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.4); border-radius: 3px; }
      .odt-row {
        display:grid;
        grid-template-columns: 52px 1fr auto;
        align-items:center;
        gap: 10px;
        padding: 7px 10px;
        border-bottom: 1px solid rgba(51,65,85,0.35);
        position: relative;
        font-size: 11.5px;
      }
      .odt-row::before {
        content: ""; position:absolute; left:0; top:0; bottom:0; width: 2px;
        background: transparent;
        transition: background .12s;
      }
      .odt-row:hover { background: rgba(51,65,85,0.25); }
      .odt-row:hover::before { background: #38bdf8; }
      .odt-row.is-busy { opacity: 0.55; pointer-events: none; }
      .odt-row.is-err::before { background: #f43f5e; }
      .odt-xmlid {
        display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
        font-family: "JetBrains Mono",ui-monospace,monospace;
        min-width: 0;
      }
      .odt-xmlid .mod { color: #818cf8; font-size: 10.5px; }
      .odt-xmlid .arr { color: #475569; font-size: 10px; }
      .odt-xmlid .name { color: #f1f5f9; font-weight: 600; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-target {
        font: 9.5px/1 "JetBrains Mono",ui-monospace,monospace;
        color: #64748b;
        letter-spacing: 0.04em;
        margin-top: 3px;
      }
      .odt-target .m { color: #7dd3fc; }
      .odt-target .h { color: #475569; }
      .odt-target .i { color: #94a3b8; }
      .odt-pill {
        position: relative;
        width: 48px; height: 22px;
        border-radius: 999px;
        cursor: pointer;
        background: #1e293b;
        box-shadow: inset 0 0 0 1px rgba(100,116,139,0.4);
        transition: background .18s, box-shadow .18s;
        flex-shrink: 0;
      }
      .odt-pill .knob {
        position: absolute; top: 2px; left: 2px;
        width: 18px; height: 18px;
        border-radius: 50%;
        background: #f8fafc;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        transition: transform .2s cubic-bezier(.4,.0,.2,1), background .18s;
      }
      .odt-pill .lbl {
        position: absolute; top: 0; bottom: 0;
        display: flex; align-items: center;
        font: 700 8.5px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.1em;
        color: #0f172a;
        pointer-events: none;
      }
      .odt-pill .lbl.T { left: 7px; opacity: 0; }
      .odt-pill .lbl.F { right: 7px; opacity: 1; color: #052e1a; }
      .odt-pill[data-state="true"] {
        background: linear-gradient(180deg,#fbbf24,#d97706);
        box-shadow: inset 0 0 0 1px rgba(251,191,36,0.5), 0 0 10px -2px rgba(245,158,11,0.5);
      }
      .odt-pill[data-state="true"] .knob { transform: translateX(26px); background: #fef3c7; }
      .odt-pill[data-state="true"] .lbl.T { opacity: 1; color: #451a03; }
      .odt-pill[data-state="true"] .lbl.F { opacity: 0; }
      .odt-pill[data-state="false"] {
        background: linear-gradient(180deg,#34d399,#059669);
        box-shadow: inset 0 0 0 1px rgba(52,211,153,0.5), 0 0 10px -2px rgba(16,185,129,0.45);
      }
      .odt-pill[data-state="false"] .knob { background: #ecfdf5; }
      .odt-empty, .odt-loading, .odt-err {
        padding: 22px 14px;
        text-align: center;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        color: #64748b;
      }
      .odt-err { color: #fda4af; }
      .odt-caret::after {
        content: "\u258C";
        margin-left: 4px;
        color: #34d399;
        animation: odt-blink 1s steps(2) infinite;
      }
      @keyframes odt-blink { 50% { opacity: 0; } }
      .odt-page-bar {
        display:flex; align-items:center; gap: 8px; flex-wrap: wrap;
        margin-top: 10px;
        padding: 6px 8px;
        border: 1px solid rgba(51,65,85,0.7);
        border-left: 2px solid #38bdf8;
        background: rgba(30,41,59,0.4);
        border-radius: 4px;
        font: 10.5px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-page-bar .lbl {
        font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        color: #38bdf8; font-size: 9px;
      }
      .odt-page-bar .m { color: #7dd3fc; }
      .odt-page-bar .h { color: #475569; }
      .odt-page-bar .i { color: #94a3b8; }
      .odt-page-bar .muted { color: #475569; font-style: italic; }
      .odt-page-bar .spacer { flex: 1; }
      .odt-mini-btn {
        all: unset; cursor: pointer;
        font: 600 9.5px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: #cbd5e1;
        padding: 5px 8px; border-radius: 3px;
        background: rgba(56,189,248,0.08);
        border: 1px solid rgba(56,189,248,0.3);
        transition: background .12s, color .12s;
      }
      .odt-mini-btn:hover { background: rgba(56,189,248,0.2); color: #fff; }
      .odt-mini-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .odt-filter-bar {
        display:flex; align-items:center; gap: 8px;
        margin-top: 8px;
      }
      .odt-search-wrap { position: relative; flex: 1; }
      .odt-search-wrap::before {
        content: "\u2315";
        position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
        color: #475569; font-size: 13px; pointer-events: none;
      }
      .odt-search {
        all: unset; width: 100%; box-sizing: border-box;
        padding: 6px 10px 6px 26px;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        background: rgba(15,23,42,0.55);
        border: 1px solid rgba(51,65,85,0.7);
        border-radius: 4px;
        transition: border-color .12s, box-shadow .12s;
      }
      .odt-search:focus {
        border-color: #34d399;
        box-shadow: 0 0 0 2px rgba(52,211,153,0.15);
      }
      .odt-search::placeholder { color: #475569; }
      .odt-seg {
        display:flex; background: rgba(15,23,42,0.55);
        border: 1px solid rgba(51,65,85,0.7);
        border-radius: 4px; overflow: hidden;
      }
      .odt-seg button {
        all: unset; cursor: pointer;
        padding: 5px 9px;
        font: 700 9.5px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.1em;
        color: #64748b;
        transition: background .12s, color .12s;
      }
      .odt-seg button + button { border-left: 1px solid rgba(51,65,85,0.7); }
      .odt-seg button:hover { color: #cbd5e1; }
      .odt-seg button.active[data-state="all"] { color: #0f172a; background: #cbd5e1; }
      .odt-seg button.active[data-state="true"] { color: #451a03; background: linear-gradient(180deg,#fbbf24,#d97706); }
      .odt-seg button.active[data-state="false"] { color: #052e1a; background: linear-gradient(180deg,#34d399,#059669); }
      .odt-name {
        font: 11px/1.3 "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .odt-name.muted { color: #64748b; font-style: italic; }
      .odt-target .n { color: #cbd5e1; }
      mark.odt-hit { background: rgba(251,191,36,0.35); color: #fef3c7; border-radius: 2px; padding: 0 1px; }
      .odt-row { cursor: pointer; }
      .odt-row.expanded::before { background: #a78bfa !important; }
      .odt-row .caret-x {
        display: inline-block; width: 10px; color: #64748b;
        transition: transform .15s, color .15s;
        font-size: 9px; text-align: center;
      }
      .odt-row.expanded .caret-x { transform: rotate(90deg); color: #a78bfa; }
      .odt-detail {
        background: linear-gradient(180deg, rgba(15,23,42,0.6), rgba(15,23,42,0.4));
        border-bottom: 1px solid rgba(51,65,85,0.5);
        border-left: 2px solid #a78bfa;
        padding: 8px 0 10px;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-detail.hidden { display: none; }
      .odt-tree { display: flex; flex-direction: column; }
      .odt-tnode {
        display: flex; flex-direction: column;
        padding: 1px 12px 1px 10px;
        position: relative;
      }
      .odt-tnode-head {
        display: flex; align-items: center; gap: 6px;
        min-height: 18px;
        cursor: default;
      }
      .odt-tnode-head.expandable { cursor: pointer; }
      .odt-tnode-head.expandable:hover .fname { color: #fff; }
      .odt-tchev {
        display: inline-block; width: 10px; color: #64748b;
        font-size: 9px; transition: transform .15s, color .15s;
        text-align: center;
        flex-shrink: 0;
      }
      .odt-tchev.empty { visibility: hidden; }
      .odt-tnode.open > .odt-tnode-head .odt-tchev { transform: rotate(90deg); color: #a78bfa; }
      .fname { color: #e2e8f0; }
      .fname-tech { color: #64748b; font-size: 10px; }
      .ftype {
        display: inline-block;
        font: 700 8.5px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.08em;
        padding: 2px 5px; border-radius: 3px;
        text-transform: uppercase;
        flex-shrink: 0;
      }
      .ftype.t-char, .ftype.t-text, .ftype.t-html { background: rgba(148,163,184,0.15); color: #cbd5e1; }
      .ftype.t-integer, .ftype.t-float, .ftype.t-monetary { background: rgba(56,189,248,0.15); color: #7dd3fc; }
      .ftype.t-boolean { background: rgba(245,158,11,0.15); color: #fbbf24; }
      .ftype.t-date, .ftype.t-datetime { background: rgba(167,139,250,0.18); color: #c4b5fd; }
      .ftype.t-selection { background: rgba(125,211,252,0.12); color: #38bdf8; }
      .ftype.t-many2one { background: rgba(129,140,248,0.18); color: #a5b4fc; }
      .ftype.t-one2many, .ftype.t-many2many { background: rgba(244,63,94,0.15); color: #fda4af; }
      .ftype.t-json, .ftype.t-properties { background: rgba(34,197,94,0.12); color: #86efac; }
      .ftype.t-binary { background: rgba(100,116,139,0.15); color: #94a3b8; }
      .fval {
        color: #f1f5f9;
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fval.muted { color: #475569; font-style: italic; }
      .fval.bool-t { color: #fbbf24; }
      .fval.bool-f { color: #64748b; }
      .fval .ref-id { color: #818cf8; }
      .fval .ref-name { color: #e2e8f0; }
      .fval .count {
        display: inline-block;
        padding: 1px 6px; border-radius: 9px;
        background: rgba(244,63,94,0.15); color: #fda4af;
        font-size: 9.5px; font-weight: 700;
      }
      .odt-tchildren {
        margin-left: 14px; padding-left: 8px;
        border-left: 1px dashed rgba(148,163,184,0.18);
        margin-top: 2px;
      }
      .odt-tnode:not(.open) > .odt-tchildren { display: none; }
      .odt-tloading {
        padding: 6px 10px; color: #64748b;
        font: 10px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-detail-toolbar {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 10px 8px;
        font: 9.5px "JetBrains Mono",ui-monospace,monospace;
        color: #64748b;
        letter-spacing: 0.08em;
      }
      .odt-detail-toolbar .tag {
        color: #a78bfa; text-transform: uppercase; font-weight: 700; letter-spacing: 0.15em;
      }
      .odt-detail-toolbar .spacer { flex: 1; }
      .odt-detail-toolbar .lnk {
        all: unset; cursor: pointer; color: #94a3b8;
        text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;
        padding: 3px 6px; border-radius: 3px;
      }
      .odt-detail-toolbar .lnk:hover { color: #fff; background: rgba(148,163,184,0.1); }

      .odt-pane { padding: 14px 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .odt-pane h4 {
        margin: 0; font: 700 10px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.18em; text-transform: uppercase; color: #f59e0b;
      }
      .odt-pane .hint { font: 10px "JetBrains Mono",ui-monospace,monospace; color: #64748b; }
      .odt-row-input { display:grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
      .odt-textarea {
        all: unset; box-sizing: border-box; width: 100%;
        min-height: 96px;
        padding: 8px 10px;
        font: 11.5px/1.5 "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        background: rgba(15,23,42,0.55);
        border: 1px solid rgba(51,65,85,0.7);
        border-radius: 4px;
        white-space: pre; overflow: auto;
      }
      .odt-textarea:focus { border-color: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,0.15); }
      .odt-output {
        margin-top: 6px;
        border: 1px solid rgba(51,65,85,0.7);
        border-radius: 4px;
        background:
          radial-gradient(rgba(148,163,184,0.06) 1px, transparent 1px) 0 0/12px 12px,
          linear-gradient(180deg, rgba(15,23,42,0.6), rgba(30,41,59,0.4));
        padding: 8px 10px;
        font: 11px/1.5 "JetBrains Mono",ui-monospace,monospace;
        color: #cbd5e1;
        max-height: 320px; overflow: auto;
        white-space: pre-wrap; word-break: break-word;
      }
      .odt-output.muted { color: #64748b; font-style: italic; }
      .odt-output.err { color: #fda4af; border-color: rgba(244,63,94,0.4); }
      .odt-kpi { display:flex; gap: 14px; flex-wrap: wrap; padding: 6px 0; }
      .odt-kpi .cell {
        display: flex; flex-direction: column; gap: 2px;
        padding: 4px 10px; border-left: 2px solid #38bdf8;
        background: rgba(30,41,59,0.4); border-radius: 0 4px 4px 0;
      }
      .odt-kpi .k {
        font: 700 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.16em; text-transform: uppercase; color: #64748b;
      }
      .odt-kpi .v { font: 700 14px/1 "JetBrains Mono",ui-monospace,monospace; color: #7dd3fc; }
      .odt-kpi .v.warn { color: #fbbf24; }
      .odt-kpi .v.bad { color: #fda4af; }
      .odt-kpi .v.ok { color: #34d399; }

      .arch-line { display:flex; gap: 6px; align-items: baseline; padding: 1px 0; }
      .arch-line .ln {
        flex-shrink: 0; width: 28px; text-align: right;
        color: #475569; font-size: 10px;
        user-select: none;
      }
      .arch-line.bad { background: rgba(244,63,94,0.07); border-left: 2px solid #f43f5e; padding-left: 4px; margin-left: -6px; }
      .arch-line .code { font: 11px/1.55 "JetBrains Mono",ui-monospace,monospace; color: #cbd5e1; white-space: pre; }
      .arch-line .code .tag { color: #7dd3fc; }
      .arch-line .code .attr { color: #c4b5fd; }
      .arch-line .code .str { color: #fcd34d; }
      .arch-line .code .bad-tok { background: rgba(244,63,94,0.25); color: #fecaca; border-radius: 2px; padding: 0 2px; }
      .arch-problems {
        margin-top: 8px; display: flex; flex-direction: column; gap: 4px;
        font: 10.5px "JetBrains Mono",ui-monospace,monospace;
      }
      .arch-problems .item {
        display: flex; gap: 6px; align-items: baseline;
        padding: 4px 6px; border-left: 2px solid #f43f5e;
        background: rgba(244,63,94,0.06);
      }
      .arch-problems .item .cat {
        font-weight: 700; letter-spacing: 0.1em; color: #fda4af; font-size: 9.5px;
        text-transform: uppercase;
      }
      .arch-problems .item .fld { color: #fde68a; font-weight: 600; }
      .arch-problems .item .raw { color: #94a3b8; }
      .arch-empty-ok {
        padding: 10px; border: 1px dashed rgba(52,211,153,0.4);
        background: rgba(52,211,153,0.06); color: #6ee7b7;
        border-radius: 4px; text-align: center;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
      }

      .odt-danger {
        margin-top: 4px; padding: 6px 8px;
        border: 1px solid rgba(244,63,94,0.5);
        background: rgba(244,63,94,0.08);
        color: #fecaca;
        font: 10.5px "JetBrains Mono",ui-monospace,monospace;
        border-radius: 4px;
        display: flex; align-items: center; gap: 8px;
      }
      .odt-danger input[type=checkbox] { accent-color: #f43f5e; }
      .odt-eval-result {
        display: flex; flex-direction: column; gap: 6px;
      }
      .odt-eval-result .label {
        font: 700 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.16em; text-transform: uppercase; color: #94a3b8;
      }

      .odt-i18n-row {
        display: grid; grid-template-columns: 1fr auto auto;
        gap: 8px; align-items: center;
        padding: 5px 8px;
        border-bottom: 1px solid rgba(51,65,85,0.35);
        font: 11px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-i18n-row:hover { background: rgba(51,65,85,0.2); }
      .odt-i18n-row .src { color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-i18n-row .tr { color: #6ee7b7; }
      .odt-i18n-row .tr.miss { color: #f43f5e; font-style: italic; }
      .odt-i18n-row .badge {
        font: 700 8.5px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.1em; padding: 2px 5px; border-radius: 3px;
        text-transform: uppercase;
      }
      .odt-i18n-row .badge.miss { background: rgba(244,63,94,0.18); color: #fda4af; }
      .odt-i18n-row .badge.ok { background: rgba(52,211,153,0.15); color: #6ee7b7; }
      .odt-i18n-row .meta { color: #64748b; font-size: 10px; }

      .odt-combo {
        position: relative;
        display: inline-flex;
        align-items: center;
        min-width: 140px;
      }
      .odt-combo-trigger {
        all: unset; box-sizing: border-box;
        cursor: pointer;
        display: flex; align-items: center; gap: 6px;
        width: 100%;
        padding: 5px 8px 5px 10px;
        background: rgba(15,23,42,0.55);
        border: 1px solid rgba(51,65,85,0.7);
        border-radius: 4px;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        transition: border-color .12s, box-shadow .12s;
      }
      .odt-combo-trigger:hover { border-color: rgba(100,116,139,0.9); }
      .odt-combo[data-open="true"] .odt-combo-trigger {
        border-color: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,0.15);
      }
      .odt-combo-trigger .v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-combo-trigger .v.placeholder { color: #475569; }
      .odt-combo-trigger .v .code { color: #7dd3fc; }
      .odt-combo-trigger .v .name { color: #94a3b8; font-size: 10px; margin-left: 4px; }
      .odt-combo-trigger .chev { color: #64748b; font-size: 9px; transition: transform .15s; }
      .odt-combo[data-open="true"] .odt-combo-trigger .chev { transform: rotate(180deg); color: #34d399; }
      .odt-combo-pop {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0;
        min-width: 220px;
        z-index: 9999;
        background: #0f172a;
        border: 1px solid rgba(51,65,85,0.9);
        border-radius: 6px;
        box-shadow: 0 12px 30px -8px rgba(0,0,0,0.6), 0 0 0 1px rgba(52,211,153,0.15);
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      .odt-combo[data-open="true"] .odt-combo-pop { display: flex; }
      .odt-combo-search {
        all: unset; box-sizing: border-box;
        padding: 7px 10px;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        background: rgba(15,23,42,0.7);
        border-bottom: 1px solid rgba(51,65,85,0.7);
      }
      .odt-combo-search::placeholder { color: #475569; }
      .odt-combo-list {
        max-height: 220px;
        overflow-y: auto;
        background:
          radial-gradient(rgba(148,163,184,0.04) 1px, transparent 1px) 0 0/12px 12px,
          linear-gradient(180deg, rgba(15,23,42,0.6), rgba(30,41,59,0.4));
      }
      .odt-combo-list::-webkit-scrollbar { width: 6px; }
      .odt-combo-list::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.4); border-radius: 3px; }
      .odt-combo-opt {
        padding: 6px 10px;
        cursor: pointer;
        display: flex; align-items: baseline; gap: 8px;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        border-bottom: 1px solid rgba(51,65,85,0.25);
        transition: background .1s;
      }
      .odt-combo-opt .code { color: #7dd3fc; font-weight: 600; min-width: 56px; }
      .odt-combo-opt .name { color: #cbd5e1; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-combo-opt:hover, .odt-combo-opt.active { background: rgba(52,211,153,0.12); }
      .odt-combo-opt.active .code { color: #34d399; }
      .odt-combo-opt mark { background: rgba(251,191,36,0.4); color: #fef3c7; border-radius: 2px; padding: 0 1px; }
      .odt-combo-empty {
        padding: 12px;
        text-align: center;
        font: 10.5px "JetBrains Mono",ui-monospace,monospace;
        color: #64748b;
      }
      .odt-combo-list .selected {
        background: rgba(52,211,153,0.18);
        position: relative;
      }
      .odt-combo-list .selected::before {
        content: "\u25B8"; position: absolute; left: 2px;
        color: #34d399; font-size: 9px;
      }

      .odt-rpc-toolbar {
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(51,65,85,0.5);
        background: rgba(15,23,42,0.55);
        font: 10.5px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-rpc-toolbar .spacer { flex: 1; }
      .odt-rpc-toolbar .stat { color: #64748b; }
      .odt-rpc-toolbar .stat .n { color: #38bdf8; font-weight: 700; }
      .odt-rpc-split {
        display: grid;
        grid-template-rows: 1fr 1fr;
        height: 100%;
        min-height: 0;
      }
      .odt-rpc-list {
        overflow-y: auto;
        border-bottom: 1px solid rgba(51,65,85,0.5);
        background:
          radial-gradient(rgba(148,163,184,0.04) 1px, transparent 1px) 0 0/12px 12px,
          linear-gradient(180deg, rgba(15,23,42,0.6), rgba(30,41,59,0.4));
      }
      .odt-rpc-row {
        display: grid;
        grid-template-columns: 56px 110px 110px 1fr 60px 56px;
        gap: 8px;
        padding: 5px 12px;
        align-items: center;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        border-bottom: 1px solid rgba(51,65,85,0.25);
        cursor: pointer;
        position: relative;
      }
      .odt-rpc-row:hover { background: rgba(51,65,85,0.25); }
      .odt-rpc-row.selected { background: rgba(167,139,250,0.12); }
      .odt-rpc-row.selected::before {
        content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
        background: #a78bfa;
      }
      .odt-rpc-row .t { color: #64748b; font-size: 10px; }
      .odt-rpc-row .meth {
        font-weight: 700; letter-spacing: 0.05em;
        padding: 1px 5px; border-radius: 3px;
        font-size: 10px; text-align: center;
        background: rgba(56,189,248,0.12); color: #7dd3fc;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .odt-rpc-row .meth.write, .odt-rpc-row .meth.create { background: rgba(245,158,11,0.15); color: #fbbf24; }
      .odt-rpc-row .meth.unlink { background: rgba(244,63,94,0.15); color: #fda4af; }
      .odt-rpc-row .meth.read, .odt-rpc-row .meth.search,
      .odt-rpc-row .meth.search_read, .odt-rpc-row .meth.web_search_read,
      .odt-rpc-row .meth.web_read { background: rgba(52,211,153,0.12); color: #6ee7b7; }
      .odt-rpc-row .model { color: #a5b4fc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-rpc-row .args { color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
      .odt-rpc-row .dur { text-align: right; color: #cbd5e1; }
      .odt-rpc-row .dur.slow { color: #fbbf24; }
      .odt-rpc-row .dur.veryslow { color: #f43f5e; }
      .odt-rpc-row .status {
        text-align: center;
        font-size: 10px;
        padding: 1px 4px; border-radius: 3px;
      }
      .odt-rpc-row .status.pending { color: #94a3b8; }
      .odt-rpc-row .status.ok { color: #34d399; }
      .odt-rpc-row .status.error { color: #f43f5e; background: rgba(244,63,94,0.12); }
      .odt-rpc-detail {
        overflow-y: auto;
        padding: 10px 12px;
        background: rgba(15,23,42,0.4);
        font: 11px/1.5 "JetBrains Mono",ui-monospace,monospace;
        color: #cbd5e1;
      }
      .odt-rpc-detail .head {
        display: flex; gap: 10px; align-items: baseline;
        padding-bottom: 8px; border-bottom: 1px dashed rgba(148,163,184,0.18);
        margin-bottom: 8px;
      }
      .odt-rpc-detail .head .meth { font-weight: 700; color: #7dd3fc; }
      .odt-rpc-detail .head .model { color: #a5b4fc; }
      .odt-rpc-detail .head .lnk {
        all: unset; cursor: pointer;
        font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
        color: #94a3b8; padding: 3px 6px; border-radius: 3px;
      }
      .odt-rpc-detail .head .lnk:hover { background: rgba(148,163,184,0.12); color: #fff; }
      .odt-rpc-detail .head .spacer { flex: 1; }
      .odt-rpc-detail .sec-label {
        font: 700 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.16em; text-transform: uppercase;
        color: #64748b;
        margin: 8px 0 4px;
      }
      .odt-rpc-detail pre {
        margin: 0;
        padding: 6px 8px;
        background: rgba(15,23,42,0.7);
        border: 1px solid rgba(51,65,85,0.5);
        border-radius: 3px;
        font: 11px/1.5 "JetBrains Mono",ui-monospace,monospace;
        color: #e2e8f0;
        white-space: pre-wrap; word-break: break-word;
        max-height: 240px; overflow: auto;
      }
      .odt-rpc-empty { padding: 30px; text-align: center; color: #64748b; font: 11px "JetBrains Mono",ui-monospace,monospace; }

      .odt-mb-grid { display: grid; grid-template-columns: 260px 1fr; gap: 0; height: 100%; min-height: 0; }
      .odt-mb-sidebar {
        border-right: 1px solid rgba(51,65,85,0.5);
        display: flex; flex-direction: column;
        min-height: 0;
        background: rgba(15,23,42,0.45);
      }
      .odt-mb-sidebar-head {
        padding: 8px 10px;
        border-bottom: 1px solid rgba(51,65,85,0.5);
        display: flex; flex-direction: column; gap: 6px;
      }
      .odt-mb-models {
        flex: 1; overflow-y: auto;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-mb-models::-webkit-scrollbar { width: 6px; }
      .odt-mb-models::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.4); border-radius: 3px; }
      .odt-mb-model {
        padding: 5px 10px;
        border-bottom: 1px solid rgba(51,65,85,0.25);
        color: #cbd5e1;
        cursor: pointer;
        display: flex; flex-direction: column; gap: 2px;
      }
      .odt-mb-model:hover { background: rgba(51,65,85,0.3); color: #fff; }
      .odt-mb-model.active { background: rgba(52,211,153,0.12); border-left: 2px solid #34d399; padding-left: 8px; }
      .odt-mb-model .m { color: #a5b4fc; font-weight: 600; }
      .odt-mb-model .n { color: #64748b; font-size: 9.5px; }
      .odt-mb-model mark { background: rgba(251,191,36,0.4); color: #fef3c7; border-radius: 2px; padding: 0 1px; }

      .odt-mb-content {
        overflow-y: auto;
        padding: 12px 14px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .odt-mb-empty {
        padding: 40px; text-align: center; color: #64748b;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
      }
      .odt-mb-fields {
        border: 1px solid rgba(51,65,85,0.5);
        border-radius: 4px;
        overflow: hidden;
      }
      .odt-mb-fld {
        display: grid;
        grid-template-columns: 1fr 70px 1fr 80px;
        gap: 8px;
        padding: 6px 10px;
        align-items: center;
        font: 11px "JetBrains Mono",ui-monospace,monospace;
        border-bottom: 1px solid rgba(51,65,85,0.25);
      }
      .odt-mb-fld:hover { background: rgba(51,65,85,0.2); }
      .odt-mb-fld .nm { color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-mb-fld .nm.req::after { content: " *"; color: #f43f5e; font-weight: 700; }
      .odt-mb-fld .ty {
        font-weight: 700; font-size: 9.5px;
        text-transform: uppercase; letter-spacing: 0.08em;
        padding: 2px 5px; border-radius: 3px; text-align: center;
      }
      .odt-mb-fld .rel { color: #a5b4fc; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .odt-mb-fld .rel .h { color: #475569; }
      .odt-mb-fld .flags { display:flex; gap: 4px; justify-content: flex-end; font-size: 9px; }
      .odt-mb-fld .flags .flag {
        padding: 1px 4px; border-radius: 3px;
        color: #94a3b8; background: rgba(100,116,139,0.15);
        letter-spacing: 0.06em;
      }
      .odt-mb-fld .flags .flag.store { color: #6ee7b7; background: rgba(52,211,153,0.1); }
      .odt-mb-fld .flags .flag.ro { color: #fda4af; background: rgba(244,63,94,0.1); }
      .odt-mb-fld .flags .flag.req { color: #fbbf24; background: rgba(245,158,11,0.1); }
      .odt-mb-fld .flags .flag.compute { color: #c4b5fd; background: rgba(167,139,250,0.1); }
      .odt-mb-fld mark { background: rgba(251,191,36,0.4); color: #fef3c7; border-radius: 2px; padding: 0 1px; }
      .odt-mb-section {
        font: 700 9px/1 "JetBrains Mono",ui-monospace,monospace;
        letter-spacing: 0.18em; text-transform: uppercase;
        color: #f59e0b;
        padding: 8px 10px 4px;
        background: rgba(15,23,42,0.5);
        border-top: 1px dashed rgba(148,163,184,0.18);
      }
    `;
      shadow.appendChild(style);
      const root = document.createElement("div");
      root.innerHTML = `
      <button id="odt-launcher"
        class="fixed bottom-4 right-4 z-[2147483647] h-11 w-11 rounded-full bg-emerald-500 text-white shadow-lg flex items-center justify-center cursor-pointer hover:bg-emerald-400 text-lg">
        <span class="relative">\u{1F6E0}
          <span id="odt-dot"
            class="hidden absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-4 text-center">0</span>
        </span>
      </button>

      <div id="odt-panel"
        style="width:460px;height:62vh;"
        class="hidden fixed bottom-4 right-4 z-[2147483647] flex flex-col rounded-xl bg-slate-900 text-slate-100 shadow-2xl ring-1 ring-rose-500/40 overflow-hidden">

        <div id="odt-resize" title="drag to resize"
          style="position:absolute;top:0;left:0;width:14px;height:14px;cursor:nwse-resize;z-index:10;background:linear-gradient(135deg,transparent 40%,rgba(148,163,184,0.6) 40%,rgba(148,163,184,0.6) 50%,transparent 50%,transparent 60%,rgba(148,163,184,0.6) 60%,rgba(148,163,184,0.6) 70%,transparent 70%);"></div>

        <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-700 bg-slate-800/60">
          <div class="flex flex-col">
            <span class="text-sm font-semibold text-emerald-300">\u{1F6E0} Odoo Dev Toolkit</span>
            <span class="text-[11px] text-slate-400">developer utilities</span>
          </div>
          <div class="flex items-center gap-1">
            <button id="odt-max" title="maximize"
              class="rounded-md px-2 py-1 text-[11px] font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 cursor-pointer">\u25A2</button>
            <button id="odt-min" title="minimize"
              class="rounded-md px-2 py-1 text-[11px] font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 cursor-pointer">\u2014</button>
          </div>
        </div>

        <div class="flex gap-1 px-3 pt-2 border-b border-slate-700 overflow-x-auto" style="scrollbar-width:none">
          <button data-tab="detector"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-emerald-400 text-slate-100">Field Detector</button>
          <button data-tab="noupdate"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">noupdate</button>
          <button data-tab="viewarch"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">view arch</button>
          <button data-tab="domain"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">domain</button>
          <button data-tab="ormeval"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">ORM eval</button>
          <button data-tab="i18n"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">i18n gaps</button>
          <button data-tab="rpc"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">RPC <span id="odt-rpc-dot" class="hidden inline-block ml-1 h-1.5 w-1.5 rounded-full bg-cyan-400 align-middle"></span></button>
          <button data-tab="models"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">models</button>
          <button data-tab="inspect"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">inspect</button>
          <button data-tab="ctx"
            class="odt-tab whitespace-nowrap px-3 py-1 text-xs rounded-t-md bg-slate-800 cursor-pointer border-b-2 border-transparent text-slate-400 hover:text-slate-200">context</button>
        </div>

        <div id="odt-tab-detector" class="flex-1 overflow-auto flex flex-col min-h-0">
          <div class="odt-rpc-toolbar odt-mono">
            <input id="odt-det-q" class="odt-search" type="text" placeholder="filter model / field / view" style="max-width:200px"/>
            <div class="odt-seg" id="odt-det-cat-seg">
              <button data-cat="all" class="active">ALL</button>
              <button data-cat="field">FIELD</button>
              <button data-cat="modifier">ATTRS</button>
              <button data-cat="groupby">GROUPBY</button>
              <button data-cat="search-domain">DOMAIN</button>
            </div>
            <span class="spacer"></span>
            <div class="odt-seg" id="odt-det-group-seg">
              <button data-group="flat" class="active">flat</button>
              <button data-group="model">by model</button>
              <button data-group="view">by view</button>
            </div>
          </div>
          <div id="odt-list" class="flex-1 overflow-auto px-3 py-2 space-y-1.5 text-xs font-mono">
            <div class="text-slate-500 text-center py-6">No issues detected yet. Navigate Odoo views\u2026</div>
          </div>
          <div class="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-slate-700 bg-slate-800/60">
            <span id="odt-count" class="text-[11px] text-slate-400">0 issue(s)</span>
            <div class="flex items-center gap-1.5">
              <button id="odt-export"
                class="rounded-md px-2 py-1 text-[11px] font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 cursor-pointer">Export JSON</button>
              <button id="odt-clear"
                class="rounded-md px-2 py-1 text-[11px] font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 cursor-pointer">Clear</button>
            </div>
          </div>
        </div>

        <div id="odt-tab-noupdate" class="hidden flex-1 overflow-auto space-y-3 px-3 py-3 text-xs">
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">XML ID (module.name)</label>
            <input id="odt-xmlid" type="text" placeholder="farmnet_user_role.data_role_directory"
              class="w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-400"/>
          </div>
          <div class="text-center text-[11px] text-slate-500">\u2014 or \u2014</div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">model</label>
              <input id="odt-model" type="text" placeholder="res.users.role"
                class="w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-400"/>
            </div>
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">res_id</label>
              <input id="odt-resid" type="number" placeholder="2"
                class="w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-400"/>
            </div>
          </div>
          <button id="odt-load"
            class="rounded-md px-3 py-1.5 text-xs font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 cursor-pointer">Load record</button>

          <div id="odt-nu-status" class="hidden rounded-md bg-slate-800/70 border border-slate-700 px-3 py-2 text-xs space-y-1"></div>

          <div id="odt-nu-actions" class="hidden flex items-center gap-2">
            <button id="odt-set-true"
              class="rounded-md px-3 py-1.5 text-xs font-medium bg-amber-500 text-slate-900 hover:bg-amber-400 cursor-pointer">noupdate = True</button>
            <button id="odt-set-false"
              class="rounded-md px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer">noupdate = False</button>
          </div>

          <p class="text-[11px] text-slate-500">Writes <span class="font-mono">ir.model.data.noupdate</span> with your session rights. A module upgrade can reset it from the XML definition.</p>

          <div class="odt-section">
            <span class="odt-section-label">\u258C browse</span>
            <div class="odt-flt-grid">
              <label class="odt-field">
                <span>module</span>
                <input id="odt-flt-module" type="text" placeholder="farmnet_user_role" class="odt-input"/>
              </label>
              <label class="odt-field">
                <span>model</span>
                <input id="odt-flt-model" type="text" placeholder="res.users.role" class="odt-input"/>
              </label>
              <button id="odt-list-load" class="odt-btn-exec">Query</button>
            </div>
            <div class="odt-page-bar">
              <span id="odt-page-hint"><span class="muted">// no active model detected</span></span>
              <span class="spacer"></span>
              <button id="odt-page-view" class="odt-mini-btn" title="Use current model">\u25B6 view</button>
              <button id="odt-page-record" class="odt-mini-btn" title="Use current model + res_id">\u25B6 record</button>
            </div>
            <div class="odt-list-meta">
              <span>LIMIT</span>
              <input id="odt-list-limit" type="number" value="200" min="1" max="2000" class="odt-input odt-limit"/>
              <span class="sep">\u2502</span>
              <span id="odt-list-info">awaiting input</span>
            </div>
            <div class="odt-filter-bar" id="odt-filter-bar" style="display:none">
              <div class="odt-search-wrap">
                <input id="odt-filter-q" class="odt-search" type="text" placeholder="filter by xml_id / name / model"/>
              </div>
              <div class="odt-seg" id="odt-state-seg" role="group">
                <button data-state="all" class="active">ALL</button>
                <button data-state="true">T</button>
                <button data-state="false">F</button>
              </div>
            </div>
            <div id="odt-list-rows" class="odt-rows" style="display:none"></div>
          </div>
        </div>

        <div id="odt-tab-viewarch" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C view arch inspector</h4>
            <p class="hint">Read <span style="color:#7dd3fc">ir.ui.view.arch</span>, cross-check every <code>&lt;field name="\u2026"&gt;</code> against the model's <code>fields_get</code>. Invalid refs are highlighted inline and listed below.</p>
            <div class="odt-row-input">
              <label class="odt-field">
                <span>view id or xml id</span>
                <input id="odt-va-input" class="odt-input" type="text" placeholder="123  or  module.view_xml_id"/>
              </label>
              <button id="odt-va-load" class="odt-btn-exec">Inspect</button>
            </div>
            <div class="odt-page-bar">
              <span id="odt-va-page-hint"><span class="muted">// pick from intercepted views</span></span>
              <span class="spacer"></span>
              <button id="odt-va-from-detector" class="odt-mini-btn" title="use first detected view">\u25B6 from detector</button>
            </div>
            <div id="odt-va-meta" class="odt-kpi" style="display:none"></div>
            <div id="odt-va-out" class="odt-output muted">// awaiting input</div>
            <div id="odt-va-problems" class="arch-problems"></div>
          </div>
        </div>

        <div id="odt-tab-domain" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C domain tester</h4>
            <p class="hint">Run a domain against any model: returns <code>search_count</code> + a preview of the first 10 records (<code>display_name</code>).</p>
            <div class="odt-row-input">
              <label class="odt-field">
                <span>model</span>
                <input id="odt-dt-model" class="odt-input" type="text" placeholder="res.partner"/>
              </label>
              <button id="odt-dt-run" class="odt-btn-exec">Run</button>
            </div>
            <div class="odt-page-bar">
              <span id="odt-dt-page-hint"><span class="muted">// no active model detected</span></span>
              <span class="spacer"></span>
              <button id="odt-dt-page-use" class="odt-mini-btn">\u25B6 use active</button>
            </div>
            <label class="odt-field">
              <span>domain (python-ish list of tuples)</span>
              <textarea id="odt-dt-domain" class="odt-textarea" spellcheck="false" placeholder='[["active","=",true],["customer_rank",">",0]]'>[]</textarea>
            </label>
            <div class="odt-list-meta">
              <span>LIMIT</span>
              <input id="odt-dt-limit" type="number" value="10" min="1" max="200" class="odt-input odt-limit"/>
              <span class="sep">\u2502</span>
              <span>ORDER</span>
              <input id="odt-dt-order" type="text" placeholder="id desc" class="odt-input" style="width:120px"/>
              <span class="sep">\u2502</span>
              <span id="odt-dt-info">idle</span>
            </div>
            <div id="odt-dt-kpi" class="odt-kpi" style="display:none"></div>
            <div id="odt-dt-out" class="odt-output muted">// run a query to see results</div>
          </div>
        </div>

        <div id="odt-tab-ormeval" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C ORM eval \u2014 server action runner</h4>
            <p class="hint">Creates an <code>ir.actions.server</code> with <code>state=code</code>, runs it, then unlinks it. Use <code>log(value)</code> to emit a line; assign <code>action = {...}</code> to return an action dict. Available: <code>env</code>, <code>model</code>, <code>records</code>, <code>log</code>, <code>UserError</code>, \u2026</p>
            <div class="odt-danger">
              <input id="odt-eval-ack" type="checkbox"/>
              <label for="odt-eval-ack">I understand this executes arbitrary Python on the server with my user's rights. Dev environments only.</label>
            </div>
            <div class="odt-row-input">
              <label class="odt-field">
                <span>binding model (defaults to res.partner)</span>
                <input id="odt-eval-model" class="odt-input" type="text" placeholder="res.partner"/>
              </label>
              <button id="odt-eval-run" class="odt-btn-exec" disabled>Execute</button>
            </div>
            <label class="odt-field">
              <span>python code</span>
              <textarea id="odt-eval-code" class="odt-textarea" spellcheck="false" style="min-height:160px"># env, model are available
partners = env["res.partner"].search([], limit=3)
log("count: %s" % len(partners))
for p in partners:
    log("#%s %s" % (p.id, p.display_name))</textarea>
            </label>
            <div class="odt-eval-result">
              <span class="label">stdout / log</span>
              <div id="odt-eval-log" class="odt-output muted">// idle</div>
              <span class="label">returned action</span>
              <div id="odt-eval-action" class="odt-output muted">// none</div>
            </div>
          </div>
        </div>

        <div id="odt-tab-rpc" class="hidden flex-1 flex flex-col min-h-0">
          <div class="odt-rpc-toolbar odt-mono">
            <input id="odt-rpc-q" class="odt-search" type="text" placeholder="filter model / method / args" style="max-width:200px"/>
            <div class="odt-seg" id="odt-rpc-status-seg">
              <button data-state="all" class="active">ALL</button>
              <button data-state="ok">OK</button>
              <button data-state="error">ERR</button>
              <button data-state="pending">\xB7\xB7\xB7</button>
            </div>
            <span class="spacer"></span>
            <span class="stat"><span class="n" id="odt-rpc-count">0</span> calls</span>
            <span class="stat sep" style="color:#334155">\u2502</span>
            <span class="stat"><span class="n" id="odt-rpc-bytes">0</span> B</span>
            <button id="odt-rpc-pause" class="odt-mini-btn">\u25B6 pause</button>
            <button id="odt-rpc-clear" class="odt-mini-btn">\u25B6 clear</button>
            <button id="odt-rpc-export" class="odt-mini-btn">\u25B6 export</button>
          </div>
          <div class="odt-rpc-split flex-1 min-h-0">
            <div id="odt-rpc-list" class="odt-rpc-list">
              <div class="odt-rpc-empty">// no RPCs captured yet \u2014 interact with Odoo</div>
            </div>
            <div id="odt-rpc-detail" class="odt-rpc-detail">
              <div class="odt-rpc-empty">// select a call to inspect</div>
            </div>
          </div>
        </div>

        <div id="odt-tab-inspect" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C on-page inspector</h4>
            <p class="hint">Toggle picker, click a field on the Odoo page to capture: <code>name</code>, <code>type</code>, <code>widget</code>, model, view type, and nearest record id. Press <kbd>ESC</kbd> to cancel.</p>
            <div class="odt-row-input">
              <span></span>
              <button id="odt-pk-toggle" class="odt-btn-exec">\u25B6 start picker</button>
            </div>
            <div id="odt-pk-out" class="odt-output muted">// idle</div>
            <div id="odt-pk-history-label" class="hint" style="display:none">history</div>
            <div id="odt-pk-history" class="odt-rpc-list" style="display:none; max-height:240px; border-radius:4px"></div>
          </div>
        </div>

        <div id="odt-tab-ctx" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C user / session context</h4>
            <div class="odt-row-input">
              <span></span>
              <button id="odt-ctx-refresh" class="odt-btn-exec">Refresh</button>
            </div>
            <div id="odt-ctx-grid" class="odt-kpi" style="display:none"></div>
            <div id="odt-ctx-out" class="odt-output muted">// click refresh to load</div>

            <div class="odt-section">
              <span class="odt-section-label">\u258C switch company</span>
              <div class="odt-row-input">
                <div id="odt-ctx-company-combo" class="odt-combo" data-open="false" style="min-width:220px"></div>
                <button id="odt-ctx-company-switch" class="odt-btn-exec" disabled>Switch</button>
              </div>
              <p class="hint">Writes <code>res.users.company_id</code>. Page reloads after success.</p>
            </div>

            <div class="odt-section">
              <span class="odt-section-label">\u258C groups</span>
              <div id="odt-ctx-groups" class="odt-output muted" style="max-height:200px">// idle</div>
            </div>

            <div class="odt-section">
              <span class="odt-section-label">\u258C dev tools</span>
              <div class="odt-row-input">
                <label class="odt-field"><span>action</span>
                  <div id="odt-ctx-action-combo" class="odt-combo" data-open="false"></div>
                </label>
                <button id="odt-ctx-action-run" class="odt-btn-exec">Run</button>
              </div>
              <p class="hint">Reload assets / clear caches / enter debug mode (<code>?debug=assets</code>).</p>
              <div id="odt-ctx-action-out" class="hint" style="margin-top:4px"></div>
            </div>
          </div>
        </div>

        <div id="odt-tab-models" class="hidden flex-1 flex min-h-0">
          <div class="odt-mb-grid flex-1 min-h-0">
            <div class="odt-mb-sidebar">
              <div class="odt-mb-sidebar-head">
                <div class="odt-row-input">
                  <label class="odt-field" style="grid-column: 1 / -1">
                    <span>search model</span>
                    <input id="odt-mb-q" class="odt-input" type="text" placeholder="res.partner, sale.order, \u2026"/>
                  </label>
                </div>
                <div class="odt-page-bar" style="margin-top:4px">
                  <span id="odt-mb-page-hint"><span class="muted">// no active model detected</span></span>
                  <span class="spacer"></span>
                  <button id="odt-mb-page-use" class="odt-mini-btn">\u25B6 use active</button>
                </div>
              </div>
              <div id="odt-mb-models" class="odt-mb-models">
                <div class="odt-mb-empty">// loading ir.model\u2026</div>
              </div>
            </div>
            <div id="odt-mb-content" class="odt-mb-content">
              <div class="odt-mb-empty">// pick a model from the list</div>
            </div>
          </div>
        </div>

        <div id="odt-tab-i18n" class="hidden flex-1 overflow-auto">
          <div class="odt-pane odt-mono">
            <h4>\u258C translation gaps</h4>
            <p class="hint">For a model + target lang, lists translatable fields and the first records where the translation is missing or identical to the source.</p>
            <div class="odt-row-input">
              <label class="odt-field">
                <span>model</span>
                <input id="odt-i18n-model" class="odt-input" type="text" placeholder="product.template"/>
              </label>
              <button id="odt-i18n-run" class="odt-btn-exec">Scan</button>
            </div>
            <div class="odt-page-bar">
              <span id="odt-i18n-page-hint"><span class="muted">// no active model detected</span></span>
              <span class="spacer"></span>
              <button id="odt-i18n-page-use" class="odt-mini-btn">\u25B6 use active</button>
            </div>
            <div class="odt-list-meta">
              <span>LANG</span>
              <div id="odt-i18n-lang-combo" class="odt-combo" data-open="false" style="min-width:180px"></div>
              <span class="sep">\u2502</span>
              <span>SAMPLE</span>
              <input id="odt-i18n-sample" type="number" value="50" min="1" max="500" class="odt-input odt-limit"/>
              <span class="sep">\u2502</span>
              <span id="odt-i18n-info">idle</span>
            </div>
            <div id="odt-i18n-kpi" class="odt-kpi" style="display:none"></div>
            <div id="odt-i18n-out" class="odt-output muted">// scan a model to see gaps</div>
          </div>
        </div>
      </div>
    `;
      shadow.appendChild(root);
      launcher = shadow.getElementById("odt-launcher");
      panel = shadow.getElementById("odt-panel");
      listEl = shadow.getElementById("odt-list");
      countEl = shadow.getElementById("odt-count");
      dotEl = shadow.getElementById("odt-dot");
      launcher.addEventListener("click", () => toggle(true));
      shadow.getElementById("odt-min").addEventListener("click", () => toggle(false));
      shadow.getElementById("odt-max").addEventListener("click", toggleMax);
      initResize();
      shadow.getElementById("odt-clear").addEventListener("click", clear);
      shadow.getElementById("odt-export").addEventListener("click", exportJson);
      shadow.querySelectorAll(".odt-tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
      shadow.getElementById("odt-load").addEventListener("click", loadRecord);
      shadow.getElementById("odt-set-true").addEventListener("click", () => setNoupdate(true));
      shadow.getElementById("odt-set-false").addEventListener("click", () => setNoupdate(false));
      shadow.getElementById("odt-list-load").addEventListener("click", () => loadList());
      [shadow.getElementById("odt-flt-module"), shadow.getElementById("odt-flt-model")].forEach(
        (el) => el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") loadList();
        })
      );
      shadow.getElementById("odt-page-view").addEventListener("click", () => applyPageCtx());
      shadow.getElementById("odt-page-record").addEventListener("click", () => applyPageCtx({ withResId: true }));
      shadow.getElementById("odt-filter-q").addEventListener("input", (e) => {
        listFilter.q = e.target.value.trim().toLowerCase();
        applyFilters();
      });
      shadow.getElementById("odt-state-seg").querySelectorAll("button").forEach(
        (b) => b.addEventListener("click", () => {
          listFilter.state = b.dataset.state;
          shadow.getElementById("odt-state-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.state === listFilter.state));
          applyFilters();
        })
      );
      window.addEventListener("hashchange", updatePageHint);
      shadow.getElementById("odt-va-load").addEventListener("click", loadViewArch);
      shadow.getElementById("odt-va-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") loadViewArch();
      });
      shadow.getElementById("odt-va-from-detector").addEventListener("click", () => {
        const p = problems[0];
        if (!p) return;
        shadow.getElementById("odt-va-input").value = p.model;
        loadViewArchFromProblem(p);
      });
      shadow.getElementById("odt-dt-run").addEventListener("click", runDomain);
      shadow.getElementById("odt-dt-page-use").addEventListener("click", () => {
        const ctx = getActiveCtx();
        if (!ctx.model) return;
        shadow.getElementById("odt-dt-model").value = ctx.model;
      });
      const evalAck = shadow.getElementById("odt-eval-ack");
      const evalBtn = shadow.getElementById("odt-eval-run");
      evalAck.addEventListener("change", () => {
        evalBtn.disabled = !evalAck.checked;
      });
      evalBtn.addEventListener("click", runOrmEval);
      shadow.getElementById("odt-i18n-run").addEventListener("click", scanI18n);
      shadow.getElementById("odt-i18n-page-use").addEventListener("click", () => {
        const ctx = getActiveCtx();
        if (!ctx.model) return;
        shadow.getElementById("odt-i18n-model").value = ctx.model;
      });
      initI18nLangCombo();
      shadow.getElementById("odt-rpc-q").addEventListener("input", (e) => {
        rpcFilter.q = e.target.value.trim().toLowerCase();
        renderRpcList();
      });
      shadow.getElementById("odt-rpc-status-seg").querySelectorAll("button").forEach(
        (b) => b.addEventListener("click", () => {
          rpcFilter.status = b.dataset.state;
          shadow.getElementById("odt-rpc-status-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.state === rpcFilter.status));
          renderRpcList();
        })
      );
      shadow.getElementById("odt-rpc-pause").addEventListener("click", toggleRpcPause);
      shadow.getElementById("odt-rpc-clear").addEventListener("click", clearRpc);
      shadow.getElementById("odt-rpc-export").addEventListener("click", exportRpc);
      shadow.getElementById("odt-mb-q").addEventListener("input", () => renderMbModels());
      shadow.getElementById("odt-mb-page-use").addEventListener("click", () => {
        const ctx = getActiveCtx();
        if (!ctx.model) return;
        shadow.getElementById("odt-mb-q").value = ctx.model;
        renderMbModels();
        const found = mbModels.find((m) => m.model === ctx.model);
        if (found) selectMbModel(found);
      });
      shadow.getElementById("odt-det-q").addEventListener("input", (e) => {
        detFilter.q = e.target.value.trim().toLowerCase();
        renderList();
      });
      shadow.getElementById("odt-det-cat-seg").querySelectorAll("button").forEach(
        (b) => b.addEventListener("click", () => {
          detFilter.cat = b.dataset.cat;
          shadow.getElementById("odt-det-cat-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.cat === detFilter.cat));
          renderList();
        })
      );
      shadow.getElementById("odt-det-group-seg").querySelectorAll("button").forEach(
        (b) => b.addEventListener("click", () => {
          detFilter.group = b.dataset.group;
          shadow.getElementById("odt-det-group-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.group === detFilter.group));
          renderList();
        })
      );
      shadow.getElementById("odt-pk-toggle").addEventListener("click", togglePicker);
      shadow.getElementById("odt-ctx-refresh").addEventListener("click", loadCtx);
      initCtxActionCombo();
      updatePageHint();
    }
    async function initI18nLangCombo() {
      const host = shadow.getElementById("odt-i18n-lang-combo");
      if (!host) return;
      const combo = createCombo(host, {
        placeholder: "select language\u2026",
        searchPlaceholder: "search code or name\u2026",
        loadingText: "// loading res.lang\u2026",
        emptyText: "// no match",
        render: (opt) => `<span class="code">${escapeHtml(opt.value)}</span><span class="name">${escapeHtml(opt.label)}</span>`,
        trigger: (opt) => opt ? `<span class="v"><span class="code">${escapeHtml(opt.value)}</span><span class="name">${escapeHtml(opt.label)}</span></span>` : `<span class="v placeholder">select language\u2026</span>`
      });
      host.__combo = combo;
      try {
        await detectLang();
        const langs = await fetchLangs();
        combo.setOptions(langs.map((l) => ({ value: l.code, label: l.name })));
        if (currentLang) combo.setValue(currentLang);
      } catch (e) {
        combo.setEmpty(`// error: ${e.message}`);
      }
    }
    async function fetchLangs() {
      if (LANGS_CACHE) return LANGS_CACHE;
      const rows = await callKw(
        "res.lang",
        "search_read",
        [[["active", "=", true]], ["code", "name", "iso_code"]],
        { order: "name" }
      );
      LANGS_CACHE = rows;
      return rows;
    }
    function createCombo(host, opts) {
      let options = [];
      let value = null;
      let filtered = [];
      let activeIdx = -1;
      host.innerHTML = `
      <button class="odt-combo-trigger" type="button">
        <span class="v placeholder">${escapeHtml(opts.placeholder || "select\u2026")}</span>
        <span class="chev">\u25BC</span>
      </button>
      <div class="odt-combo-pop">
        <input class="odt-combo-search" type="text" placeholder="${escapeHtml(opts.searchPlaceholder || "search\u2026")}"/>
        <div class="odt-combo-list"><div class="odt-combo-empty">${escapeHtml(opts.loadingText || "// loading\u2026")}</div></div>
      </div>`;
      const trigger = host.querySelector(".odt-combo-trigger");
      const pop = host.querySelector(".odt-combo-pop");
      const search = host.querySelector(".odt-combo-search");
      const list = host.querySelector(".odt-combo-list");
      function renderTrigger() {
        const sel = options.find((o) => o.value === value) || null;
        trigger.innerHTML = (opts.trigger ? opts.trigger(sel) : sel ? `<span class="v"><span class="code">${escapeHtml(sel.value)}</span><span class="name">${escapeHtml(sel.label)}</span></span>` : `<span class="v placeholder">${escapeHtml(opts.placeholder || "select\u2026")}</span>`) + `<span class="chev">\u25BC</span>`;
      }
      function renderList2() {
        const q = search.value.trim().toLowerCase();
        filtered = q ? options.filter(
          (o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
        ) : options.slice();
        activeIdx = filtered.findIndex((o) => o.value === value);
        if (!filtered.length) {
          list.innerHTML = `<div class="odt-combo-empty">${escapeHtml(opts.emptyText || "// no match")}</div>`;
          return;
        }
        list.innerHTML = filtered.map((o, i) => {
          const html = opts.render ? opts.render(o, q) : `<span class="code">${escapeHtml(o.value)}</span><span class="name">${escapeHtml(o.label)}</span>`;
          return `<div class="odt-combo-opt ${o.value === value ? "selected" : ""} ${i === activeIdx ? "active" : ""}" data-i="${i}">${html}</div>`;
        }).join("");
        list.querySelectorAll(".odt-combo-opt").forEach((el) => {
          el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const idx = parseInt(el.dataset.i, 10);
            select(filtered[idx]);
          });
        });
      }
      function open() {
        host.dataset.open = "true";
        search.value = "";
        renderList2();
        setTimeout(() => search.focus(), 0);
        document.addEventListener("mousedown", outside, true);
      }
      function close() {
        host.dataset.open = "false";
        document.removeEventListener("mousedown", outside, true);
      }
      function outside(e) {
        if (!host.contains(e.target) && !host.getRootNode().contains(e.target)) return close();
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(host)) close();
      }
      function select(opt) {
        if (!opt) return;
        value = opt.value;
        renderTrigger();
        close();
        host.dispatchEvent(new CustomEvent("change", { detail: { value, option: opt } }));
      }
      trigger.addEventListener("click", () => {
        host.dataset.open === "true" ? close() : open();
      });
      search.addEventListener("input", renderList2);
      search.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
          markActive();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          activeIdx = Math.max(0, activeIdx - 1);
          markActive();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (filtered[activeIdx]) select(filtered[activeIdx]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      function markActive() {
        list.querySelectorAll(".odt-combo-opt").forEach((el2, i) => el2.classList.toggle("active", i === activeIdx));
        const el = list.querySelector(`.odt-combo-opt[data-i="${activeIdx}"]`);
        if (el) el.scrollIntoView({ block: "nearest" });
      }
      return {
        setOptions(opts2) {
          options = opts2 || [];
          renderTrigger();
          if (host.dataset.open === "true") renderList2();
        },
        setValue(v) {
          value = v;
          renderTrigger();
        },
        setEmpty(msg) {
          list.innerHTML = `<div class="odt-combo-empty">${escapeHtml(msg)}</div>`;
        },
        getValue() {
          return value;
        },
        onChange(fn) {
          host.addEventListener("change", (e) => fn(e.detail.value, e.detail.option));
        }
      };
    }
    function toggle(open) {
      panel.classList.toggle("hidden", !open);
      launcher.classList.toggle("hidden", open);
    }
    let prevSize = null;
    function toggleMax() {
      const btn = shadow.getElementById("odt-max");
      if (prevSize) {
        panel.style.width = prevSize.w;
        panel.style.height = prevSize.h;
        prevSize = null;
        btn.textContent = "\u25A2";
        btn.title = "maximize";
      } else {
        prevSize = { w: panel.style.width, h: panel.style.height };
        panel.style.width = "95vw";
        panel.style.height = "95vh";
        btn.textContent = "\u2750";
        btn.title = "restore";
      }
    }
    function initResize() {
      const handle = shadow.getElementById("odt-resize");
      let startX, startY, startW, startH;
      const onMove = (e) => {
        const dx = startX - e.clientX;
        const dy = startY - e.clientY;
        const w = Math.max(320, Math.min(window.innerWidth - 16, startW + dx));
        const h = Math.max(240, Math.min(window.innerHeight - 16, startH + dy));
        panel.style.width = w + "px";
        panel.style.height = h + "px";
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startW = rect.width;
        startH = rect.height;
        if (prevSize) {
          prevSize = null;
          const btn = shadow.getElementById("odt-max");
          btn.textContent = "\u25A2";
          btn.title = "maximize";
        }
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    }
    function switchTab(tab) {
      shadow.querySelectorAll(".odt-tab").forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle("border-emerald-400", active);
        b.classList.toggle("text-slate-100", active);
        b.classList.toggle("border-transparent", !active);
        b.classList.toggle("text-slate-400", !active);
      });
      shadow.getElementById("odt-tab-detector").classList.toggle("hidden", tab !== "detector");
      shadow.getElementById("odt-tab-noupdate").classList.toggle("hidden", tab !== "noupdate");
      shadow.getElementById("odt-tab-viewarch").classList.toggle("hidden", tab !== "viewarch");
      shadow.getElementById("odt-tab-domain").classList.toggle("hidden", tab !== "domain");
      shadow.getElementById("odt-tab-ormeval").classList.toggle("hidden", tab !== "ormeval");
      shadow.getElementById("odt-tab-i18n").classList.toggle("hidden", tab !== "i18n");
      shadow.getElementById("odt-tab-rpc").classList.toggle("hidden", tab !== "rpc");
      shadow.getElementById("odt-tab-models").classList.toggle("hidden", tab !== "models");
      shadow.getElementById("odt-tab-inspect").classList.toggle("hidden", tab !== "inspect");
      shadow.getElementById("odt-tab-ctx").classList.toggle("hidden", tab !== "ctx");
      if (tab === "rpc") shadow.getElementById("odt-rpc-dot").classList.add("hidden");
      if (tab === "models" && !mbModelsLoaded) loadModelBrowser();
      if (tab === "ctx" && !ctxLoaded) loadCtx();
    }
    let mbModelsLoaded = false;
    let mbModels = [];
    let mbActiveModel = null;
    let detFilter = { q: "", cat: "all", group: "flat" };
    let ctxLoaded = false;
    let ctxData = null;
    let pickerActive = false;
    let pickerHover = null;
    let pickerOverlay = null;
    const pickerHistory = [];
    function clear() {
      problems.length = 0;
      seen.clear();
      renderList();
    }
    function exportJson() {
      const blob = new Blob([JSON.stringify(problems, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "odoo-missing-fields.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    function renderList() {
      const n = problems.length;
      countEl.textContent = `${n} issue(s)`;
      dotEl.textContent = String(n);
      dotEl.classList.toggle("hidden", n === 0);
      if (!n) {
        listEl.innerHTML = `<div class="text-slate-500 text-center py-6">No issues detected yet. Navigate Odoo views\u2026</div>`;
        return;
      }
      const q = detFilter ? detFilter.q : "";
      const cat = detFilter ? detFilter.cat : "all";
      const group = detFilter ? detFilter.group : "flat";
      const filtered = problems.filter((p) => {
        if (cat !== "all" && p.category !== cat) return false;
        if (!q) return true;
        const hay = `${p.model} ${p.field} ${p.viewType} ${p.raw || ""}`.toLowerCase();
        return hay.includes(q);
      });
      if (!filtered.length) {
        listEl.innerHTML = `<div class="text-slate-500 text-center py-6">No matches.</div>`;
        countEl.textContent = `0 / ${n}`;
        return;
      }
      countEl.textContent = filtered.length === n ? `${n} issue(s)` : `${filtered.length} / ${n}`;
      const buckets = group === "flat" ? [{ key: "", items: filtered }] : aggregate(filtered, (p) => group === "model" ? p.model : `${p.model} <${p.viewType}>`);
      listEl.innerHTML = buckets.map((bk) => {
        const head = bk.key ? `<div class="odt-mb-section" style="margin:6px 0">${escapeHtml(bk.key)} \xB7 ${bk.items.length}</div>` : "";
        const body = bk.items.map((p) => {
          const b = BADGE[p.category] || {
            label: p.category.toUpperCase(),
            cls: "bg-slate-300 text-slate-900"
          };
          const inRaw = p.raw !== p.field ? ` <span class="text-slate-500">in ${escapeHtml(p.raw)}</span>` : "";
          return `
          <div class="rounded-md bg-slate-800/70 px-3 py-2 border border-slate-700 odt-det-row" data-model="${escapeHtml(p.model)}" data-view="${escapeHtml(p.viewType)}" data-field="${escapeHtml(p.field)}">
            <div class="flex items-center gap-1 mb-1">
              <span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${b.cls}">${b.label}</span>
              <span class="text-sky-300">${highlightSimple(p.model, q)}</span>
              <span class="text-slate-500">&lt;${escapeHtml(p.viewType)}&gt;</span>
              <span class="flex-1"></span>
              <button class="odt-mini-btn" data-act="open-arch">\u25B6 arch</button>
              <button class="odt-mini-btn" data-act="open-fields">\u25B6 fields</button>
            </div>
            <div>
              <span class="text-amber-200 font-bold">${highlightSimple(p.field, q)}</span>
              <span class="text-slate-500">not in model</span>${inRaw}
            </div>
          </div>`;
        }).join("");
        return head + body;
      }).join("");
      listEl.querySelectorAll(".odt-det-row").forEach((row) => {
        row.querySelector('[data-act="open-arch"]').addEventListener("click", (e) => {
          e.stopPropagation();
          switchTab("viewarch");
          loadViewArchFromProblem({ model: row.dataset.model, viewType: row.dataset.view });
        });
        row.querySelector('[data-act="open-fields"]').addEventListener("click", (e) => {
          e.stopPropagation();
          switchTab("models");
          const ready = () => {
            const found = mbModels.find((m) => m.model === row.dataset.model);
            if (found) {
              shadow.getElementById("odt-mb-q").value = row.dataset.model;
              renderMbModels();
              selectMbModel(found);
            }
          };
          if (mbModelsLoaded) ready();
          else loadModelBrowser().then(ready);
        });
      });
    }
    function aggregate(items, keyFn) {
      const map = /* @__PURE__ */ new Map();
      for (const it of items) {
        const k = keyFn(it);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(it);
      }
      return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length).map(([key, items2]) => ({ key, items: items2 }));
    }
    let currentImd = null;
    async function loadRecord() {
      const xmlid = shadow.getElementById("odt-xmlid").value.trim();
      const model = shadow.getElementById("odt-model").value.trim();
      const resId = shadow.getElementById("odt-resid").value.trim();
      let domain;
      if (xmlid.includes(".")) {
        const idx = xmlid.indexOf(".");
        domain = [
          ["module", "=", xmlid.slice(0, idx)],
          ["name", "=", xmlid.slice(idx + 1)]
        ];
      } else if (model && resId) {
        domain = [
          ["model", "=", model],
          ["res_id", "=", parseInt(resId, 10)]
        ];
      } else {
        return showStatus(
          `<span class="text-rose-300">Enter an XML ID, or both model and res_id.</span>`,
          false
        );
      }
      try {
        const rows = await callKw(
          "ir.model.data",
          "search_read",
          [domain, ["id", "module", "name", "model", "res_id", "noupdate"]],
          { limit: 1 }
        );
        if (!rows.length) {
          currentImd = null;
          showActions(false);
          return showStatus(
            `<span class="text-rose-300">No ir.model.data record found.</span>`,
            true
          );
        }
        currentImd = rows[0];
        renderStatus();
        showActions(true);
      } catch (e) {
        currentImd = null;
        showActions(false);
        showStatus(`<span class="text-rose-300">Error: ${escapeHtml(e.message)}</span>`, true);
      }
    }
    function renderStatus() {
      const r = currentImd;
      const pill = r.noupdate ? `<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-300 text-slate-900">True</span>` : `<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-400 text-slate-900">False</span>`;
      showStatus(
        `<div><span class="text-slate-400">xml id:</span> <span class="font-mono text-emerald-300">${escapeHtml(r.module)}.${escapeHtml(r.name)}</span></div><div><span class="text-slate-400">target:</span> <span class="font-mono text-sky-300">${escapeHtml(r.model)}</span> #${r.res_id}</div><div><span class="text-slate-400">noupdate:</span> ${pill}</div>`,
        true
      );
    }
    function showStatus(html, show) {
      const el = shadow.getElementById("odt-nu-status");
      el.innerHTML = html;
      el.classList.toggle("hidden", !show);
    }
    function showActions(show) {
      shadow.getElementById("odt-nu-actions").classList.toggle("hidden", !show);
    }
    async function setNoupdate(value) {
      if (!currentImd) return;
      if (!window.confirm(`Set noupdate = ${value} on ${currentImd.module}.${currentImd.name}?`))
        return;
      try {
        await callKw("ir.model.data", "write", [[currentImd.id], { noupdate: value }]);
        currentImd.noupdate = value;
        renderStatus();
      } catch (e) {
        showStatus(`<span class="text-rose-300">Write failed: ${escapeHtml(e.message)}</span>`, true);
      }
    }
    async function loadList(overrides) {
      const o = overrides || {};
      const module = o.module !== void 0 ? o.module : shadow.getElementById("odt-flt-module").value.trim();
      const model = o.model !== void 0 ? o.model : shadow.getElementById("odt-flt-model").value.trim();
      const resId = o.resId || null;
      const limit = Math.max(
        1,
        Math.min(2e3, parseInt(shadow.getElementById("odt-list-limit").value, 10) || 200)
      );
      const info = shadow.getElementById("odt-list-info");
      const rowsEl = shadow.getElementById("odt-list-rows");
      const btn = shadow.getElementById("odt-list-load");
      if (!module && !model) {
        info.innerHTML = `<span style="color:#fda4af">enter module or model</span>`;
        rowsEl.style.display = "none";
        return;
      }
      const domain = [];
      if (module) domain.push(["module", "=", module]);
      if (model) domain.push(["model", "=", model]);
      if (resId) domain.push(["res_id", "=", resId]);
      btn.disabled = true;
      rowsEl.style.display = "block";
      rowsEl.innerHTML = `<div class="odt-loading odt-caret">querying ir.model.data</div>`;
      info.textContent = "running\u2026";
      shadow.getElementById("odt-filter-bar").style.display = "none";
      try {
        const rows = await callKw(
          "ir.model.data",
          "search_read",
          [domain, ["id", "module", "name", "model", "res_id", "noupdate"]],
          { limit, order: "module, name" }
        );
        listRows = rows;
        info.innerHTML = `<span class="num">${rows.length}</span> result${rows.length === 1 ? "" : "s"}${rows.length === limit ? ` <span class="sep">(capped)</span>` : ""}`;
        if (rows.length) {
          shadow.getElementById("odt-filter-bar").style.display = "flex";
          applyFilters();
          enrichNames(rows).then(() => applyFilters()).catch(() => {
          });
        } else {
          rowsEl.innerHTML = `<div class="odt-empty">// no records matched</div>`;
        }
      } catch (e) {
        listRows = [];
        rowsEl.innerHTML = `<div class="odt-err">// error: ${escapeHtml(e.message)}</div>`;
        info.innerHTML = `<span style="color:#fda4af">failed</span>`;
      } finally {
        btn.disabled = false;
      }
    }
    async function enrichNames(rows) {
      const byModel = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const k = `${r.model}|${r.res_id}`;
        if (NAME_CACHE.has(k)) {
          r._name = NAME_CACHE.get(k);
          continue;
        }
        if (!byModel.has(r.model)) byModel.set(r.model, /* @__PURE__ */ new Set());
        byModel.get(r.model).add(r.res_id);
      }
      await Promise.all(
        Array.from(byModel.entries()).map(async ([model, idSet]) => {
          const ids = Array.from(idSet);
          try {
            const recs = await callKw(model, "read", [ids, ["display_name"]]);
            const map = new Map(recs.map((x) => [x.id, x.display_name]));
            for (const id of ids) NAME_CACHE.set(`${model}|${id}`, map.get(id) || null);
          } catch (e) {
            for (const id of ids) NAME_CACHE.set(`${model}|${id}`, void 0);
          }
        })
      );
      for (const r of rows) {
        if (r._name === void 0 || r._name === null)
          r._name = NAME_CACHE.get(`${r.model}|${r.res_id}`);
      }
    }
    function applyFilters() {
      const q = listFilter.q;
      const st = listFilter.state;
      const filtered = listRows.filter((r) => {
        if (st === "true" && !r.noupdate) return false;
        if (st === "false" && r.noupdate) return false;
        if (!q) return true;
        const hay = `${r.module}.${r.name} ${r.model} ${r._name || ""}`.toLowerCase();
        return hay.includes(q);
      });
      renderListRows(filtered);
      const info = shadow.getElementById("odt-list-info");
      if ((q || st !== "all") && listRows.length) {
        const note = `<span class="num">${filtered.length}</span> shown <span class="sep">/</span> <span class="num">${listRows.length}</span> total`;
        info.innerHTML = note + (listRows.length === parseInt(shadow.getElementById("odt-list-limit").value, 10) ? ` <span class="sep">(capped)</span>` : "");
      }
    }
    function highlight(text, q) {
      if (!q) return escapeHtml(text || "");
      const t = String(text || "");
      const idx = t.toLowerCase().indexOf(q);
      if (idx < 0) return escapeHtml(t);
      return escapeHtml(t.slice(0, idx)) + `<mark class="odt-hit">${escapeHtml(t.slice(idx, idx + q.length))}</mark>` + escapeHtml(t.slice(idx + q.length));
    }
    function renderListRows(rows) {
      const el = shadow.getElementById("odt-list-rows");
      if (!rows.length) {
        el.innerHTML = `<div class="odt-empty">// no rows match filter</div>`;
        return;
      }
      const q = listFilter.q;
      el.innerHTML = rows.map((r) => {
        const nameHtml = r._name ? `<div class="odt-name">${highlight(r._name, q)}</div>` : r._name === void 0 ? `<div class="odt-name muted">&lt;no access&gt;</div>` : `<div class="odt-name muted">&lt;unnamed&gt;</div>`;
        return `
      <div class="odt-row-wrap">
        <div class="odt-row" data-id="${r.id}" data-model="${escapeHtml(r.model)}" data-res-id="${r.res_id}">
          <div class="odt-pill" data-state="${r.noupdate ? "true" : "false"}" role="switch" aria-checked="${!!r.noupdate}" title="toggle noupdate">
            <span class="lbl T">T</span>
            <span class="lbl F">F</span>
            <span class="knob"></span>
          </div>
          <div style="min-width:0">
            <div class="odt-xmlid">
              <span class="caret-x">\u25B8</span>
              <span class="mod">${highlight(r.module, q)}</span><span class="arr">\u203A</span><span class="name">${highlight(r.name, q)}</span>
            </div>
            ${nameHtml}
            <div class="odt-target">
              <span class="m">${highlight(r.model, q)}</span><span class="h"> \xB7 </span><span class="i">#${r.res_id}</span>
            </div>
          </div>
          <div></div>
        </div>
        <div class="odt-detail hidden" data-loaded="0"></div>
      </div>`;
      }).join("");
      el.querySelectorAll(".odt-pill").forEach((pill) => {
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          togglePill(pill);
        });
      });
      el.querySelectorAll(".odt-row").forEach((row) => {
        row.addEventListener("click", () => toggleRowDetail(row));
      });
    }
    async function toggleRowDetail(row) {
      const wrap = row.parentElement;
      const detail = wrap.querySelector(".odt-detail");
      const opening = detail.classList.contains("hidden");
      detail.classList.toggle("hidden", !opening);
      row.classList.toggle("expanded", opening);
      if (!opening) return;
      if (detail.dataset.loaded === "1") return;
      detail.dataset.loaded = "1";
      const model = row.dataset.model;
      const id = parseInt(row.dataset.resId, 10);
      detail.innerHTML = `
      <div class="odt-detail-toolbar">
        <span class="tag">\u258C inspect</span>
        <span>${escapeHtml(model)} <span style="color:#475569">\xB7</span> #${id}</span>
        <span class="spacer"></span>
        <button class="lnk" data-act="collapse-all">collapse all</button>
      </div>
      <div class="odt-tloading odt-caret">reading ${escapeHtml(model)}</div>`;
      detail.querySelector('[data-act="collapse-all"]').addEventListener("click", (e) => {
        e.stopPropagation();
        detail.querySelectorAll(".odt-tnode.open").forEach((n) => n.classList.remove("open"));
      });
      try {
        const [fields, rec] = await Promise.all([getFields(model), getRecord(model, id)]);
        const loader = detail.querySelector(".odt-tloading");
        if (loader) loader.remove();
        if (!rec) {
          const err = document.createElement("div");
          err.className = "odt-err";
          err.textContent = "// record not found";
          detail.appendChild(err);
          return;
        }
        const tree = document.createElement("div");
        tree.className = "odt-tree";
        const entries = Object.entries(rec).filter(([k]) => k !== "id");
        entries.sort(([a], [b]) => a.localeCompare(b));
        for (const [name, value] of entries) {
          tree.appendChild(buildFieldNode(model, name, value, fields[name] || {}));
        }
        detail.appendChild(tree);
      } catch (e) {
        detail.innerHTML += `<div class="odt-err">// ${escapeHtml(e.message)}</div>`;
      }
    }
    async function getFields(model) {
      if (FIELDS_CACHE.has(model)) return FIELDS_CACHE.get(model);
      const f = await callKw(model, "fields_get", [], {
        attributes: ["string", "type", "relation", "selection"]
      });
      FIELDS_CACHE.set(model, f);
      return f;
    }
    async function getRecord(model, id) {
      const k = `${model}|${id}`;
      if (REC_CACHE.has(k)) return REC_CACHE.get(k);
      const fields = await getFields(model);
      const SKIP = /* @__PURE__ */ new Set(["binary", "properties", "properties_definition", "image"]);
      const names = Object.entries(fields).filter(([n, f]) => !SKIP.has(f.type) && !n.startsWith("__")).map(([n]) => n);
      const recs = await callKw(model, "read", [[id], names]);
      const rec = recs && recs[0] ? recs[0] : null;
      REC_CACHE.set(k, rec);
      return rec;
    }
    function buildFieldNode(model, name, value, fdef) {
      const type = fdef.type || "char";
      const label = fdef.string || name;
      const node = document.createElement("div");
      node.className = "odt-tnode";
      const head = document.createElement("div");
      head.className = "odt-tnode-head";
      const expandable = isRelational(type, value);
      if (expandable) head.classList.add("expandable");
      const chev = document.createElement("span");
      chev.className = "odt-tchev" + (expandable ? "" : " empty");
      chev.textContent = "\u25B8";
      head.appendChild(chev);
      const fn = document.createElement("span");
      fn.className = "fname";
      fn.textContent = label;
      head.appendChild(fn);
      if (label !== name) {
        const ft = document.createElement("span");
        ft.className = "fname-tech";
        ft.textContent = name;
        head.appendChild(ft);
      }
      const tp = document.createElement("span");
      tp.className = `ftype t-${type}`;
      tp.textContent = type + (fdef.relation ? `\u2192${fdef.relation}` : "");
      head.appendChild(tp);
      const fv = document.createElement("span");
      fv.className = "fval";
      fv.innerHTML = formatValue(type, value, fdef);
      head.appendChild(fv);
      node.appendChild(head);
      const children = document.createElement("div");
      children.className = "odt-tchildren";
      node.appendChild(children);
      if (expandable) {
        let loaded = false;
        head.addEventListener("click", async (e) => {
          e.stopPropagation();
          const open = node.classList.toggle("open");
          if (!open || loaded) return;
          loaded = true;
          children.innerHTML = `<div class="odt-tloading odt-caret">loading</div>`;
          try {
            if (type === "many2one") {
              const refId = Array.isArray(value) ? value[0] : value;
              if (!refId || !fdef.relation) {
                children.innerHTML = "";
                return;
              }
              await renderRefSubtree(children, fdef.relation, refId);
            } else {
              const ids = Array.isArray(value) ? value : [];
              await renderX2mList(children, fdef.relation, ids);
            }
          } catch (e2) {
            children.innerHTML = `<div class="odt-err">// ${escapeHtml(e2.message)}</div>`;
          }
        });
      }
      return node;
    }
    function isRelational(type, value) {
      if (type === "many2one") return Array.isArray(value) ? !!value[0] : !!value;
      if (type === "one2many" || type === "many2many")
        return Array.isArray(value) && value.length > 0;
      return false;
    }
    async function renderRefSubtree(container, model, id) {
      container.innerHTML = "";
      const [fields, rec] = await Promise.all([getFields(model), getRecord(model, id)]);
      if (!rec) {
        container.innerHTML = `<div class="odt-err">// not found</div>`;
        return;
      }
      const entries = Object.entries(rec).filter(([k]) => k !== "id");
      entries.sort(([a], [b]) => a.localeCompare(b));
      for (const [n, v] of entries)
        container.appendChild(buildFieldNode(model, n, v, fields[n] || {}));
    }
    async function renderX2mList(container, model, ids) {
      container.innerHTML = "";
      if (!model || !ids.length) return;
      let names = /* @__PURE__ */ new Map();
      try {
        const recs = await callKw(model, "read", [ids, ["display_name"]]);
        names = new Map(recs.map((x) => [x.id, x.display_name]));
      } catch (e) {
      }
      for (const id of ids) {
        const item = document.createElement("div");
        item.className = "odt-tnode";
        const head = document.createElement("div");
        head.className = "odt-tnode-head expandable";
        head.innerHTML = `
        <span class="odt-tchev">\u25B8</span>
        <span class="fval"><span class="ref-id">#${id}</span> <span class="ref-name">${escapeHtml(names.get(id) || "")}</span></span>`;
        item.appendChild(head);
        const ch = document.createElement("div");
        ch.className = "odt-tchildren";
        item.appendChild(ch);
        let loaded = false;
        head.addEventListener("click", async (e) => {
          e.stopPropagation();
          const open = item.classList.toggle("open");
          if (!open || loaded) return;
          loaded = true;
          ch.innerHTML = `<div class="odt-tloading odt-caret">loading</div>`;
          try {
            await renderRefSubtree(ch, model, id);
          } catch (e2) {
            ch.innerHTML = `<div class="odt-err">// ${escapeHtml(e2.message)}</div>`;
          }
        });
        container.appendChild(item);
      }
    }
    function formatValue(type, v, fdef) {
      if (v === false || v === null || v === void 0) return `<span class="muted">\u2205</span>`;
      if (type === "boolean") {
        return v ? `<span class="bool-t">\u25CF true</span>` : `<span class="bool-f">\u25CB false</span>`;
      }
      if (type === "many2one") {
        if (Array.isArray(v) && v.length === 2) {
          return `<span class="ref-id">#${v[0]}</span> <span class="ref-name">${escapeHtml(v[1] || "")}</span>`;
        }
        return v ? `<span class="ref-id">#${v}</span>` : `<span class="muted">\u2205</span>`;
      }
      if (type === "one2many" || type === "many2many") {
        const n = Array.isArray(v) ? v.length : 0;
        return n ? `<span class="count">${n}</span> <span class="ref-id">[${v.slice(0, 8).join(", ")}${n > 8 ? ", \u2026" : ""}]</span>` : `<span class="muted">[]</span>`;
      }
      if (type === "selection" && Array.isArray(fdef.selection)) {
        const pair = fdef.selection.find((s2) => s2[0] === v);
        return `<span>${escapeHtml(String(v))}</span>${pair ? ` <span class="muted">(${escapeHtml(pair[1])})</span>` : ""}`;
      }
      if (type === "json" || typeof v === "object" && v !== null) {
        let s2;
        try {
          s2 = JSON.stringify(v);
        } catch (e) {
          s2 = String(v);
        }
        return escapeHtml(s2.length > 200 ? s2.slice(0, 200) + "\u2026" : s2);
      }
      const s = String(v);
      return escapeHtml(s.length > 240 ? s.slice(0, 240) + "\u2026" : s);
    }
    async function togglePill(pill) {
      const row = pill.closest(".odt-row");
      const id = parseInt(row.dataset.id, 10);
      const next = pill.dataset.state !== "true";
      row.classList.add("is-busy");
      row.classList.remove("is-err");
      try {
        await callKw("ir.model.data", "write", [[id], { noupdate: next }]);
        pill.dataset.state = String(next);
        pill.setAttribute("aria-checked", String(next));
        if (currentImd && currentImd.id === id) {
          currentImd.noupdate = next;
          renderStatus();
        }
      } catch (e) {
        row.classList.add("is-err");
        shadow.getElementById("odt-list-info").innerHTML = `<span style="color:#fda4af">write failed: ${escapeHtml(e.message)}</span>`;
      } finally {
        row.classList.remove("is-busy");
      }
    }
    function escapeHtml(s) {
      return String(s).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
      );
    }
    function ingest(list) {
      let added = false;
      for (const p of list) {
        const key = `${p.model}|${p.field}|${p.category}|${p.viewType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push(p);
        added = true;
      }
      if (added) {
        renderList();
        updatePageHint();
      }
    }
    window.addEventListener(EVENT, (e) => {
      if (e.detail && Array.isArray(e.detail.problems)) ingest(e.detail.problems);
    });
    window.addEventListener(CTX_EVENT, (e) => {
      if (!e.detail || !e.detail.model) return;
      pageCtx = { model: e.detail.model, resId: e.detail.resId || null };
      updatePageHint();
    });
    window.addEventListener(RPC_EVENT, (e) => {
      if (rpcPaused) return;
      if (!e.detail) return;
      const { kind, entry } = e.detail;
      if (!entry) return;
      if (kind === "start") {
        const skip = entry.model === "ir.model" && entry.method === "search_read" && Array.isArray(entry.kwargs && entry.kwargs.context) === false;
        rpcLog.push(entry);
        rpcById.set(entry.id, entry);
        if (rpcLog.length > RPC_MAX) {
          const dropped = rpcLog.shift();
          if (dropped) rpcById.delete(dropped.id);
        }
      } else if (kind === "end") {
        const existing = rpcById.get(entry.id);
        if (existing) Object.assign(existing, entry);
      }
      scheduleRpcRender();
    });
    let rpcRenderTimer = null;
    function scheduleRpcRender() {
      if (rpcRenderTimer) return;
      rpcRenderTimer = setTimeout(() => {
        rpcRenderTimer = null;
        const tab = shadow.querySelector("#odt-tab-rpc:not(.hidden)");
        if (tab) renderRpcList();
        else {
          const dot = shadow.getElementById("odt-rpc-dot");
          if (dot) dot.classList.remove("hidden");
        }
        const c = shadow.getElementById("odt-rpc-count");
        const b = shadow.getElementById("odt-rpc-bytes");
        if (c) c.textContent = rpcLog.length;
        if (b) b.textContent = humanBytes(rpcLog.reduce((acc, r) => acc + r.reqSize + r.resSize, 0));
      }, 80);
    }
    function readUrlCtx() {
      const h = location.hash || "";
      const params = new URLSearchParams(h.startsWith("#") ? h.slice(1) : h);
      const model = params.get("model");
      const id = params.get("id");
      return { model: model || null, resId: id ? parseInt(id, 10) : null };
    }
    function getActiveCtx() {
      const url = readUrlCtx();
      if (url.model) return url;
      return pageCtx;
    }
    function updatePageHint() {
      if (!shadow) return;
      const ctx = getActiveCtx();
      const renderHint = (id, withRes) => {
        const el = shadow.getElementById(id);
        if (!el) return;
        if (!ctx.model) {
          el.innerHTML = `<span class="muted">// no active model detected</span>`;
          return;
        }
        el.innerHTML = `<span class="lbl">active</span> <span class="m">${escapeHtml(ctx.model)}</span>` + (withRes && ctx.resId ? ` <span class="h">#</span><span class="i">${ctx.resId}</span>` : "");
      };
      renderHint("odt-page-hint", true);
      renderHint("odt-dt-page-hint", false);
      renderHint("odt-i18n-page-hint", false);
      renderHint("odt-mb-page-hint", false);
      const vaHint = shadow.getElementById("odt-va-page-hint");
      if (vaHint) {
        if (problems.length) {
          vaHint.innerHTML = `<span class="lbl">detector</span> <span class="m">${escapeHtml(problems[0].model)}</span> <span class="h">\xB7</span> <span class="i">${problems.length} flagged</span>`;
        } else {
          vaHint.innerHTML = `<span class="muted">// no detector results yet</span>`;
        }
      }
      const viewBtn = shadow.getElementById("odt-page-view");
      const recBtn = shadow.getElementById("odt-page-record");
      const dtBtn = shadow.getElementById("odt-dt-page-use");
      const i18nBtn = shadow.getElementById("odt-i18n-page-use");
      const vaDetBtn = shadow.getElementById("odt-va-from-detector");
      if (viewBtn) viewBtn.disabled = !ctx.model;
      if (recBtn) recBtn.disabled = !(ctx.model && ctx.resId);
      if (dtBtn) dtBtn.disabled = !ctx.model;
      if (i18nBtn) i18nBtn.disabled = !ctx.model;
      if (vaDetBtn) vaDetBtn.disabled = !problems.length;
      const mbBtn = shadow.getElementById("odt-mb-page-use");
      if (mbBtn) mbBtn.disabled = !ctx.model;
    }
    function applyPageCtx(opts) {
      const ctx = getActiveCtx();
      if (!ctx.model) {
        shadow.getElementById("odt-list-info").innerHTML = `<span style="color:#fda4af">no model detected \u2014 navigate an Odoo view first</span>`;
        shadow.getElementById("odt-list-rows").style.display = "none";
        return;
      }
      shadow.getElementById("odt-flt-model").value = ctx.model;
      shadow.getElementById("odt-flt-module").value = "";
      loadList({ module: "", model: ctx.model, resId: opts && opts.withResId ? ctx.resId : null });
    }
    async function detectLang() {
      try {
        const ctx = await callKw("res.users", "context_get", []);
        if (ctx && ctx.lang) currentLang = ctx.lang;
      } catch (e) {
      }
    }
    function resolveXmlId(xmlid) {
      const idx = xmlid.indexOf(".");
      if (idx < 0) return null;
      const module = xmlid.slice(0, idx);
      const name = xmlid.slice(idx + 1);
      return callKw(
        "ir.model.data",
        "search_read",
        [
          [
            ["module", "=", module],
            ["name", "=", name]
          ],
          ["res_id", "model"]
        ],
        { limit: 1 }
      );
    }
    async function loadViewArch() {
      const raw = shadow.getElementById("odt-va-input").value.trim();
      const out = shadow.getElementById("odt-va-out");
      const meta = shadow.getElementById("odt-va-meta");
      const probEl = shadow.getElementById("odt-va-problems");
      probEl.innerHTML = "";
      meta.style.display = "none";
      if (!raw) {
        out.className = "odt-output muted";
        out.textContent = "// awaiting input";
        return;
      }
      out.className = "odt-output muted";
      out.textContent = "// loading view\u2026";
      try {
        let viewId;
        if (/^\d+$/.test(raw)) {
          viewId = parseInt(raw, 10);
        } else if (raw.includes(".")) {
          const rows = await resolveXmlId(raw);
          if (!rows.length || rows[0].model !== "ir.ui.view")
            throw new Error("xml id does not resolve to ir.ui.view");
          viewId = rows[0].res_id;
        } else {
          throw new Error("enter a numeric id or module.xml_id");
        }
        const recs = await callKw("ir.ui.view", "read", [
          [viewId],
          ["id", "name", "model", "type", "arch", "inherit_id", "mode", "xml_id"]
        ]);
        if (!recs || !recs.length) throw new Error("view not found");
        renderViewArch(recs[0]);
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// error: ${e.message}`;
      }
    }
    async function loadViewArchFromProblem(p) {
      shadow.getElementById("odt-va-input").value = "";
      const out = shadow.getElementById("odt-va-out");
      out.className = "odt-output muted";
      out.textContent = `// searching ir.ui.view for model=${p.model} type=${p.viewType}\u2026`;
      try {
        const rows = await callKw(
          "ir.ui.view",
          "search_read",
          [
            [
              ["model", "=", p.model],
              ["type", "=", p.viewType]
            ],
            ["id", "name", "model", "type", "arch", "inherit_id", "mode", "xml_id"]
          ],
          { limit: 1, order: "id desc" }
        );
        if (!rows.length) throw new Error("no matching view");
        renderViewArch(rows[0]);
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// error: ${e.message}`;
      }
    }
    async function renderViewArch(view) {
      const out = shadow.getElementById("odt-va-out");
      const meta = shadow.getElementById("odt-va-meta");
      const probEl = shadow.getElementById("odt-va-problems");
      const fields = await getFields(view.model).catch(() => ({}));
      const problemsFound = scanArch(view.arch, view.model, fields, view.type);
      meta.style.display = "flex";
      meta.innerHTML = `
      <div class="cell"><span class="k">view</span><span class="v">#${view.id}</span></div>
      <div class="cell"><span class="k">type</span><span class="v">${escapeHtml(view.type || "")}</span></div>
      <div class="cell"><span class="k">model</span><span class="v" style="font-size:11px">${escapeHtml(view.model || "")}</span></div>
      <div class="cell"><span class="k">issues</span><span class="v ${problemsFound.length ? "bad" : "ok"}">${problemsFound.length}</span></div>
      ${view.xml_id ? `<div class="cell"><span class="k">xml_id</span><span class="v" style="font-size:10px">${escapeHtml(view.xml_id)}</span></div>` : ""}
    `;
      out.className = "odt-output";
      out.innerHTML = renderArchLines(view.arch, problemsFound);
      if (problemsFound.length) {
        probEl.innerHTML = problemsFound.map(
          (p) => `
        <div class="item">
          <span class="cat">${escapeHtml(p.category)}</span>
          <span class="fld">${escapeHtml(p.field)}</span>
          ${p.raw && p.raw !== p.field ? `<span class="raw">in ${escapeHtml(p.raw)}</span>` : ""}
          <span class="raw">\xB7 line ${p.line}</span>
        </div>`
        ).join("");
      } else {
        probEl.innerHTML = `<div class="arch-empty-ok">\u2713 no missing field references found</div>`;
      }
    }
    function scanArch(arch, model, fields, viewType) {
      const out = [];
      if (!arch) return out;
      const doc = new DOMParser().parseFromString(arch, "application/xml");
      if (doc.querySelector("parsererror")) return out;
      const OPERATORS = /* @__PURE__ */ new Set([
        "=",
        "!=",
        "<",
        ">",
        "<=",
        ">=",
        "in",
        "not in",
        "like",
        "not like",
        "ilike",
        "not ilike",
        "=like",
        "=ilike",
        "child_of",
        "parent_of",
        "any",
        "not any"
      ]);
      const SKIP = /* @__PURE__ */ new Set(["parent", "id", "uid", "active_id", "context", "self"]);
      const firstSeg = (p) => String(p).split(".")[0].split(":")[0].trim();
      const lineOf = (el) => {
        const txt = arch.split(/\r?\n/);
        const tag = el.tagName;
        const name = el.getAttribute && el.getAttribute("name");
        for (let i = 0; i < txt.length; i++) {
          if (name && txt[i].includes(`<${tag}`) && txt[i].includes(`name="${name}"`)) return i + 1;
          if (!name && txt[i].includes(`<${tag}`)) return i + 1;
        }
        return 1;
      };
      const check = (el, fieldsMap, path, category) => {
        const seg = firstSeg(path);
        if (!seg || SKIP.has(seg) || /^\d/.test(seg)) return;
        if (!fieldsMap[seg]) out.push({ category, field: seg, raw: path, line: lineOf(el) });
      };
      const domainOperands = (str) => {
        const arr = [];
        const re = /\(\s*(['"])([\w.:]+)\1\s*,/g;
        let m;
        while (m = re.exec(str)) arr.push(m[2]);
        return arr;
      };
      const walkModifiers = (node, el, fieldsMap) => {
        if (Array.isArray(node)) {
          if (typeof node[0] === "string" && OPERATORS.has(node[1])) {
            check(el, fieldsMap, node[0], "modifier");
            return;
          }
          node.forEach((c) => walkModifiers(c, el, fieldsMap));
        } else if (node && typeof node === "object") {
          Object.values(node).forEach((v) => walkModifiers(v, el, fieldsMap));
        }
      };
      const traverse = (node, currentModel) => {
        const fm = currentModel === model ? fields : null;
        if (currentModel !== model) return;
        for (const child of node.children) {
          const modifiers = child.getAttribute("modifiers");
          if (modifiers) {
            try {
              walkModifiers(JSON.parse(modifiers), child, fm);
            } catch (e) {
            }
          }
          const attrs = child.getAttribute("attrs");
          if (attrs) domainOperands(attrs).forEach((f) => check(child, fm, f, "modifier"));
          const groupby = child.getAttribute("groupby");
          if (groupby) check(child, fm, groupby, "groupby");
          if (viewType === "search") {
            for (const a of ["domain", "filter_domain"]) {
              const v = child.getAttribute(a);
              if (v) domainOperands(v).forEach((f) => check(child, fm, f, "search-domain"));
            }
          }
          if (child.tagName === "field") {
            const fname = child.getAttribute("name");
            const fdef = fm && fm[fname];
            if (!fdef) {
              out.push({ category: "field", field: fname, raw: fname, line: lineOf(child) });
              continue;
            }
            if (child.children.length && fdef.relation) {
            }
          } else {
            traverse(child, currentModel);
          }
        }
      };
      traverse(doc.documentElement, model);
      return out;
    }
    function renderArchLines(arch, problemsFound) {
      const lines = arch.split(/\r?\n/);
      const badByLine = /* @__PURE__ */ new Map();
      for (const p of problemsFound) {
        if (!badByLine.has(p.line)) badByLine.set(p.line, []);
        badByLine.get(p.line).push(p.field);
      }
      return lines.map((raw, i) => {
        const n = i + 1;
        const bad = badByLine.get(n);
        const hi = highlightArchLine(raw, bad);
        return `<div class="arch-line${bad ? " bad" : ""}"><span class="ln">${n}</span><span class="code">${hi}</span></div>`;
      }).join("");
    }
    function highlightArchLine(raw, badFields) {
      let s = escapeHtml(raw);
      s = s.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tag">$2</span>');
      s = s.replace(
        /([\w-]+)=(&quot;[^&]*?&quot;)/g,
        '<span class="attr">$1</span>=<span class="str">$2</span>'
      );
      if (badFields) {
        for (const f of badFields) {
          const re = new RegExp(`(&quot;)(${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(&quot;)`, "g");
          s = s.replace(re, '$1<span class="bad-tok">$2</span>$3');
        }
      }
      return s;
    }
    async function runDomain() {
      const model = shadow.getElementById("odt-dt-model").value.trim();
      const domStr = shadow.getElementById("odt-dt-domain").value.trim() || "[]";
      const limit = Math.max(
        1,
        Math.min(200, parseInt(shadow.getElementById("odt-dt-limit").value, 10) || 10)
      );
      const order = shadow.getElementById("odt-dt-order").value.trim();
      const out = shadow.getElementById("odt-dt-out");
      const kpi = shadow.getElementById("odt-dt-kpi");
      const info = shadow.getElementById("odt-dt-info");
      const btn = shadow.getElementById("odt-dt-run");
      if (!model) {
        out.className = "odt-output err";
        out.textContent = "// model required";
        return;
      }
      let domain;
      try {
        domain = parseDomain(domStr);
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// invalid domain: ${e.message}`;
        return;
      }
      btn.disabled = true;
      out.className = "odt-output muted";
      out.textContent = "// running\u2026";
      info.textContent = "running";
      kpi.style.display = "none";
      try {
        const t0 = performance.now();
        const [count, rows] = await Promise.all([
          callKw(model, "search_count", [domain]),
          callKw(model, "search_read", [domain, ["id", "display_name"]], {
            limit,
            order: order || void 0
          })
        ]);
        const elapsed = Math.round(performance.now() - t0);
        kpi.style.display = "flex";
        kpi.innerHTML = `
        <div class="cell"><span class="k">match</span><span class="v">${count}</span></div>
        <div class="cell"><span class="k">preview</span><span class="v">${rows.length}</span></div>
        <div class="cell"><span class="k">limit</span><span class="v" style="font-size:11px">${limit}</span></div>
        <div class="cell"><span class="k">time</span><span class="v" style="font-size:11px">${elapsed}ms</span></div>
      `;
        out.className = "odt-output";
        out.innerHTML = rows.length ? rows.map(
          (r) => `<div><span style="color:#818cf8">#${r.id}</span>  <span style="color:#e2e8f0">${escapeHtml(r.display_name || "")}</span></div>`
        ).join("") : `<span class="muted">// 0 rows</span>`;
        info.textContent = "ok";
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// error: ${e.message}`;
        info.textContent = "failed";
      } finally {
        btn.disabled = false;
      }
    }
    function parseDomain(str) {
      let s = str.trim();
      if (!s) return [];
      s = s.replace(/'/g, '"').replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
      s = s.replace(/\(([^()]*)\)/g, (m, inner) => `[${inner}]`);
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        throw new Error(e.message);
      }
      if (!Array.isArray(parsed)) throw new Error("must be a list");
      return parsed;
    }
    async function runOrmEval() {
      const code = shadow.getElementById("odt-eval-code").value;
      const modelInput = shadow.getElementById("odt-eval-model").value.trim() || "res.partner";
      const logEl = shadow.getElementById("odt-eval-log");
      const actEl = shadow.getElementById("odt-eval-action");
      const btn = shadow.getElementById("odt-eval-run");
      btn.disabled = true;
      logEl.className = "odt-output muted";
      logEl.textContent = "// preparing\u2026";
      actEl.className = "odt-output muted";
      actEl.textContent = "// none";
      let modelId = null, actionId = null;
      try {
        const modelRecs = await callKw(
          "ir.model",
          "search_read",
          [[["model", "=", modelInput]], ["id"]],
          { limit: 1 }
        );
        if (!modelRecs.length) throw new Error(`ir.model not found for ${modelInput}`);
        modelId = modelRecs[0].id;
        const wrapper = `# Odoo Dev Toolkit eval \u2014 captured via log()
_odt_lines = []
def log(*args):
    _odt_lines.append(" ".join(str(a) for a in args))
try:
${indent(code, "    ")}
except Exception as _odt_e:
    _odt_lines.append("EXC: %s: %s" % (type(_odt_e).__name__, _odt_e))
env["ir.config_parameter"].sudo().set_param("__odt_eval_out__", "\\n".join(_odt_lines))
try:
    if isinstance(action, dict):
        env["ir.config_parameter"].sudo().set_param("__odt_eval_action__", repr(action))
except NameError:
    pass
`;
        logEl.textContent = "// creating server action\u2026";
        actionId = await callKw("ir.actions.server", "create", [
          {
            name: "[ODT] eval " + (/* @__PURE__ */ new Date()).toISOString().slice(11, 19),
            model_id: modelId,
            state: "code",
            code: wrapper
          }
        ]);
        logEl.textContent = "// executing\u2026";
        await callKw("ir.actions.server", "run", [[actionId]], {
          context: { active_model: modelInput, active_id: 0, active_ids: [] }
        });
        const params = await callKw("ir.config_parameter", "search_read", [
          [["key", "in", ["__odt_eval_out__", "__odt_eval_action__"]]],
          ["key", "value"]
        ]);
        const byKey = Object.fromEntries(params.map((p) => [p.key, p.value]));
        logEl.className = "odt-output";
        logEl.textContent = byKey["__odt_eval_out__"] || "// (no log lines)";
        actEl.className = "odt-output";
        actEl.textContent = byKey["__odt_eval_action__"] || "// none";
        try {
          const cleanup = await callKw("ir.config_parameter", "search", [
            [["key", "in", ["__odt_eval_out__", "__odt_eval_action__"]]]
          ]);
          if (cleanup.length) await callKw("ir.config_parameter", "unlink", [cleanup]);
        } catch (e) {
        }
      } catch (e) {
        logEl.className = "odt-output err";
        logEl.textContent = `// error: ${e.message}`;
      } finally {
        if (actionId) {
          try {
            await callKw("ir.actions.server", "unlink", [[actionId]]);
          } catch (e) {
          }
        }
        btn.disabled = false;
      }
    }
    function indent(text, prefix) {
      return String(text).split("\n").map((l) => prefix + l).join("\n");
    }
    async function scanI18n() {
      const model = shadow.getElementById("odt-i18n-model").value.trim();
      const langHost = shadow.getElementById("odt-i18n-lang-combo");
      const lang = langHost && langHost.__combo && langHost.__combo.getValue() || "";
      const sample = Math.max(
        1,
        Math.min(500, parseInt(shadow.getElementById("odt-i18n-sample").value, 10) || 50)
      );
      const out = shadow.getElementById("odt-i18n-out");
      const kpi = shadow.getElementById("odt-i18n-kpi");
      const info = shadow.getElementById("odt-i18n-info");
      const btn = shadow.getElementById("odt-i18n-run");
      if (!model) {
        out.className = "odt-output err";
        out.textContent = "// model required";
        return;
      }
      if (!lang) {
        out.className = "odt-output err";
        out.textContent = "// lang required (e.g. vi_VN)";
        return;
      }
      btn.disabled = true;
      out.className = "odt-output muted";
      out.textContent = "// scanning\u2026";
      info.textContent = "running";
      kpi.style.display = "none";
      try {
        const langs = await callKw(
          "res.lang",
          "search_read",
          [
            [
              ["code", "=", lang],
              ["active", "=", true]
            ],
            ["id", "code", "name"]
          ],
          { limit: 1 }
        );
        if (!langs.length) throw new Error(`lang "${lang}" not active`);
        const fields = await getFields(model);
        const translatable = Object.entries(fields).filter(([n, f]) => ["char", "text", "html"].includes(f.type) && !n.startsWith("__")).map(([n, f]) => ({ name: n, label: f.string || n, type: f.type }));
        if (!translatable.length) throw new Error("no translatable char/text/html fields");
        const fieldNames = translatable.map((f) => f.name);
        const [srcRows, trgRows] = await Promise.all([
          callKw(model, "search_read", [[], ["id", "display_name", ...fieldNames]], {
            limit: sample,
            context: { lang: "en_US" }
          }),
          callKw(model, "search_read", [[], ["id", "display_name", ...fieldNames]], {
            limit: sample,
            context: { lang }
          })
        ]);
        const trgById = new Map(trgRows.map((r) => [r.id, r]));
        const gaps = [];
        let totalCells = 0, missing = 0;
        for (const src of srcRows) {
          const trg = trgById.get(src.id) || {};
          for (const f of translatable) {
            const srcV = src[f.name];
            if (!srcV) continue;
            totalCells++;
            const trgV = trg[f.name];
            const same = trgV === srcV;
            const empty = !trgV;
            if (empty || same) {
              missing++;
              gaps.push({
                id: src.id,
                name: src.display_name,
                field: f.name,
                label: f.label,
                type: f.type,
                src: srcV,
                trg: trgV,
                reason: empty ? "missing" : "same as source"
              });
            }
          }
        }
        kpi.style.display = "flex";
        kpi.innerHTML = `
        <div class="cell"><span class="k">fields</span><span class="v">${translatable.length}</span></div>
        <div class="cell"><span class="k">records</span><span class="v">${srcRows.length}</span></div>
        <div class="cell"><span class="k">cells</span><span class="v">${totalCells}</span></div>
        <div class="cell"><span class="k">gaps</span><span class="v ${missing ? "bad" : "ok"}">${missing}</span></div>
        <div class="cell"><span class="k">lang</span><span class="v" style="font-size:11px">${escapeHtml(lang)}</span></div>
      `;
        out.className = "odt-output";
        if (!gaps.length) {
          out.innerHTML = `<span style="color:#6ee7b7">// no gaps in sample (${srcRows.length} records \xD7 ${translatable.length} fields)</span>`;
        } else {
          out.innerHTML = gaps.slice(0, 200).map(
            (g) => `
          <div class="odt-i18n-row" title="${escapeHtml(g.reason)}">
            <div class="src"><span class="meta">#${g.id} \xB7 ${escapeHtml(g.field)}</span> \xB7 <span>${escapeHtml(truncate(g.src, 100))}</span></div>
            <div class="tr ${g.reason === "missing" ? "miss" : ""}">${g.trg ? escapeHtml(truncate(g.trg, 60)) : "\u2205"}</div>
            <span class="badge ${g.reason === "missing" ? "miss" : "ok"}">${g.reason === "missing" ? "MISS" : "SAME"}</span>
          </div>`
          ).join("") + (gaps.length > 200 ? `<div class="meta" style="padding:8px;color:#64748b">// showing 200 of ${gaps.length}</div>` : "");
        }
        info.textContent = "ok";
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// error: ${e.message}`;
        info.textContent = "failed";
      } finally {
        btn.disabled = false;
      }
    }
    function truncate(s, n) {
      s = String(s || "");
      return s.length > n ? s.slice(0, n) + "\u2026" : s;
    }
    function humanBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(2) + " MB";
    }
    function toggleRpcPause() {
      rpcPaused = !rpcPaused;
      const btn = shadow.getElementById("odt-rpc-pause");
      btn.textContent = rpcPaused ? "\u25B6 resume" : "\u25B6 pause";
      btn.style.color = rpcPaused ? "#fbbf24" : "";
    }
    function clearRpc() {
      rpcLog.length = 0;
      rpcById.clear();
      rpcSelected = null;
      renderRpcList();
      shadow.getElementById("odt-rpc-detail").innerHTML = `<div class="odt-rpc-empty">// cleared</div>`;
      shadow.getElementById("odt-rpc-count").textContent = "0";
      shadow.getElementById("odt-rpc-bytes").textContent = "0 B";
    }
    function exportRpc() {
      const visible = filterRpc();
      const blob = new Blob([JSON.stringify(visible, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "odoo-rpc-log.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    function filterRpc() {
      const q = rpcFilter.q;
      const st = rpcFilter.status;
      return rpcLog.filter((r) => {
        if (st !== "all" && r.status !== st) return false;
        if (!q) return true;
        const hay = `${r.model || ""} ${r.method || ""} ${JSON.stringify(r.args || []).slice(0, 200)}`.toLowerCase();
        return hay.includes(q);
      });
    }
    function renderRpcList() {
      const el = shadow.getElementById("odt-rpc-list");
      if (!el) return;
      const rows = filterRpc().slice().reverse();
      if (!rows.length) {
        el.innerHTML = `<div class="odt-rpc-empty">// no RPCs match filter</div>`;
        return;
      }
      el.innerHTML = rows.map((r) => {
        const ts = formatHms(r.t);
        const dur = r.status === "pending" ? "\u2026" : Math.round(r.duration) + "ms";
        const durCls = r.duration > 1500 ? "veryslow" : r.duration > 500 ? "slow" : "";
        const argsPv = r.args && r.args.length ? truncate(JSON.stringify(r.args), 80) : "[]";
        const methCls = (r.method || "").replace(/[^a-z_]/gi, "");
        return `
        <div class="odt-rpc-row ${r.id === rpcSelected ? "selected" : ""}" data-id="${r.id}">
          <span class="t">${ts}</span>
          <span class="meth ${methCls}" title="${escapeHtml(r.method || "")}">${escapeHtml(r.method || "?")}</span>
          <span class="model" title="${escapeHtml(r.model || "")}">${escapeHtml(r.model || "?")}</span>
          <span class="args" title="${escapeHtml(argsPv)}">${escapeHtml(argsPv)}</span>
          <span class="dur ${durCls}">${dur}</span>
          <span class="status ${r.status}">${r.status === "pending" ? "\xB7\xB7\xB7" : r.status === "ok" ? "\u2713" : "\u2717"}</span>
        </div>`;
      }).join("");
      el.querySelectorAll(".odt-rpc-row").forEach((row) => {
        row.addEventListener("click", () => selectRpc(parseInt(row.dataset.id, 10)));
      });
    }
    function formatHms(ts) {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    }
    function selectRpc(id) {
      rpcSelected = id;
      const r = rpcById.get(id);
      const el = shadow.getElementById("odt-rpc-detail");
      renderRpcList();
      if (!r) {
        el.innerHTML = `<div class="odt-rpc-empty">// not found</div>`;
        return;
      }
      const argsJson = JSON.stringify(r.args || [], null, 2);
      const kwargsJson = JSON.stringify(r.kwargs || {}, null, 2);
      const resultJson = r.result !== void 0 ? truncate(JSON.stringify(r.result, null, 2), 2e4) : "// (not captured)";
      el.innerHTML = `
      <div class="head">
        <span class="meth">${escapeHtml(r.method || "?")}</span>
        <span class="model">${escapeHtml(r.model || "?")}</span>
        <span class="model" style="color:#64748b">\xB7</span>
        <span style="color:#cbd5e1">${Math.round(r.duration)}ms \xB7 ${humanBytes(r.resSize)}</span>
        <span class="spacer"></span>
        <button class="lnk" data-act="copy-args">copy args</button>
        <button class="lnk" data-act="copy-curl">copy curl</button>
      </div>
      ${r.error ? `<div class="odt-err" style="margin-bottom:8px">// ${escapeHtml(r.error)}</div>` : ""}
      <div class="sec-label">args</div>
      <pre>${escapeHtml(argsJson)}</pre>
      <div class="sec-label">kwargs</div>
      <pre>${escapeHtml(kwargsJson)}</pre>
      <div class="sec-label">result</div>
      <pre>${escapeHtml(resultJson)}</pre>`;
      el.querySelector('[data-act="copy-args"]').addEventListener("click", () => copyText(argsJson));
      el.querySelector('[data-act="copy-curl"]').addEventListener(
        "click",
        () => copyText(buildCurl(r))
      );
    }
    function buildCurl(r) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { model: r.model, method: r.method, args: r.args, kwargs: r.kwargs }
      });
      const url = location.origin + (r.url.startsWith("/") ? r.url : "/" + r.url);
      return `curl '${url}' \\
  -H 'Content-Type: application/json' \\
  --cookie 'session_id=<YOUR_SESSION_ID>' \\
  --data-raw '${body.replace(/'/g, "'\\''")}'`;
    }
    function copyText(text) {
      navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (e) {
        }
        ta.remove();
      });
    }
    async function loadModelBrowser() {
      mbModelsLoaded = true;
      const el = shadow.getElementById("odt-mb-models");
      el.innerHTML = `<div class="odt-mb-empty odt-caret">loading ir.model</div>`;
      try {
        const rows = await callKw("ir.model", "search_read", [[], ["model", "name", "transient"]], {
          order: "model"
        });
        mbModels = rows;
        renderMbModels();
      } catch (e) {
        el.innerHTML = `<div class="odt-mb-empty" style="color:#fda4af">// ${escapeHtml(e.message)}</div>`;
      }
    }
    function renderMbModels() {
      const el = shadow.getElementById("odt-mb-models");
      const q = shadow.getElementById("odt-mb-q").value.trim().toLowerCase();
      const filtered = q ? mbModels.filter(
        (m) => m.model.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q)
      ) : mbModels;
      if (!filtered.length) {
        el.innerHTML = `<div class="odt-mb-empty">// no models match</div>`;
        return;
      }
      el.innerHTML = filtered.slice(0, 500).map(
        (m) => `
      <div class="odt-mb-model ${m.model === mbActiveModel ? "active" : ""}" data-model="${escapeHtml(m.model)}">
        <span class="m">${highlightSimple(m.model, q)}</span>
        <span class="n">${highlightSimple(m.name || "", q)}${m.transient ? " <span style='color:#fbbf24'>\xB7 transient</span>" : ""}</span>
      </div>`
      ).join("") + (filtered.length > 500 ? `<div class="odt-mb-empty">// showing 500 of ${filtered.length}</div>` : "");
      el.querySelectorAll(".odt-mb-model").forEach((row) => {
        row.addEventListener("click", () => {
          const found = mbModels.find((m) => m.model === row.dataset.model);
          if (found) selectMbModel(found);
        });
      });
    }
    function highlightSimple(text, q) {
      if (!q) return escapeHtml(text);
      const idx = String(text).toLowerCase().indexOf(q);
      if (idx < 0) return escapeHtml(text);
      return escapeHtml(text.slice(0, idx)) + `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>` + escapeHtml(text.slice(idx + q.length));
    }
    async function selectMbModel(m) {
      mbActiveModel = m.model;
      renderMbModels();
      const content = shadow.getElementById("odt-mb-content");
      content.innerHTML = `<div class="odt-mb-empty odt-caret">loading fields for ${escapeHtml(m.model)}</div>`;
      try {
        const fields = await callKw(m.model, "fields_get", [], {
          attributes: [
            "string",
            "type",
            "relation",
            "required",
            "readonly",
            "store",
            "compute",
            "related",
            "selection",
            "help"
          ]
        });
        renderMbFields(m, fields);
      } catch (e) {
        content.innerHTML = `<div class="odt-mb-empty" style="color:#fda4af">// ${escapeHtml(e.message)}</div>`;
      }
    }
    function renderMbFields(m, fields) {
      const content = shadow.getElementById("odt-mb-content");
      const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
      const groups = /* @__PURE__ */ new Map();
      for (const [name, f] of entries) {
        const g = groupOf(f.type);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push([name, f]);
      }
      const order = [
        "basic",
        "numeric",
        "date",
        "selection",
        "relational",
        "json",
        "binary",
        "computed",
        "other"
      ];
      const sorted = order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g)]);
      for (const [g, list] of groups) if (!order.includes(g)) sorted.push([g, list]);
      const head = `
      <div class="odt-kpi">
        <div class="cell"><span class="k">model</span><span class="v" style="font-size:11px">${escapeHtml(m.model)}</span></div>
        <div class="cell"><span class="k">name</span><span class="v" style="font-size:11px">${escapeHtml(m.name || "")}</span></div>
        <div class="cell"><span class="k">fields</span><span class="v">${entries.length}</span></div>
        ${m.transient ? `<div class="cell"><span class="k">type</span><span class="v warn">transient</span></div>` : ""}
      </div>
      <label class="odt-field"><span>filter fields</span>
        <input id="odt-mb-fld-q" class="odt-input" type="text" placeholder="name, type, relation\u2026"/>
      </label>`;
      const body = sorted.map(
        ([g, list]) => `
      <div class="odt-mb-section">${escapeHtml(g)} \xB7 ${list.length}</div>
      <div class="odt-mb-fields">
        ${list.map(([n, f]) => renderMbFieldRow(n, f)).join("")}
      </div>
    `
      ).join("");
      content.innerHTML = head + body;
      const fq = shadow.getElementById("odt-mb-fld-q");
      fq.addEventListener("input", () => {
        const q = fq.value.trim().toLowerCase();
        content.querySelectorAll(".odt-mb-fld").forEach((row) => {
          const hay = (row.dataset.search || "").toLowerCase();
          row.style.display = !q || hay.includes(q) ? "" : "none";
        });
      });
    }
    function groupOf(type) {
      if (["char", "text", "html"].includes(type)) return "basic";
      if (["integer", "float", "monetary"].includes(type)) return "numeric";
      if (["date", "datetime"].includes(type)) return "date";
      if (type === "selection") return "selection";
      if (["many2one", "one2many", "many2many", "reference", "many2one_reference"].includes(type))
        return "relational";
      if (["json", "properties", "properties_definition"].includes(type)) return "json";
      if (["binary", "image"].includes(type)) return "binary";
      if (type === "boolean") return "basic";
      return "other";
    }
    function togglePicker() {
      pickerActive ? stopPicker() : startPicker();
    }
    function startPicker() {
      pickerActive = true;
      const btn = shadow.getElementById("odt-pk-toggle");
      btn.textContent = "\u25A0 stop picker";
      btn.style.background = "linear-gradient(180deg,#f43f5e,#be123c)";
      btn.style.color = "#fff";
      shadow.getElementById("odt-pk-out").className = "odt-output muted";
      shadow.getElementById("odt-pk-out").textContent = "// hover Odoo page \xB7 click to capture \xB7 ESC to cancel";
      pickerOverlay = document.createElement("div");
      pickerOverlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #34d399;background:rgba(52,211,153,0.12);box-shadow:0 0 0 1px rgba(15,23,42,0.5),0 0 20px rgba(52,211,153,0.4);transition:all .05s;border-radius:2px";
      document.documentElement.appendChild(pickerOverlay);
      document.addEventListener("mousemove", pickerMove, true);
      document.addEventListener("click", pickerClick, true);
      document.addEventListener("keydown", pickerKey, true);
    }
    function stopPicker() {
      pickerActive = false;
      const btn = shadow.getElementById("odt-pk-toggle");
      btn.textContent = "\u25B6 start picker";
      btn.style.background = "";
      btn.style.color = "";
      if (pickerOverlay) {
        pickerOverlay.remove();
        pickerOverlay = null;
      }
      pickerHover = null;
      document.removeEventListener("mousemove", pickerMove, true);
      document.removeEventListener("click", pickerClick, true);
      document.removeEventListener("keydown", pickerKey, true);
    }
    function pickerMove(e) {
      const el = findFieldElement(e.target);
      if (el === pickerHover) return;
      pickerHover = el;
      if (!el || !pickerOverlay) {
        if (pickerOverlay) pickerOverlay.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      pickerOverlay.style.display = "block";
      pickerOverlay.style.left = r.left + "px";
      pickerOverlay.style.top = r.top + "px";
      pickerOverlay.style.width = r.width + "px";
      pickerOverlay.style.height = r.height + "px";
    }
    function pickerClick(e) {
      if (!pickerActive) return;
      const host = document.getElementById("__odoo_dev_toolkit_host__");
      if (host && host.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = findFieldElement(e.target);
      if (!el) {
        shadow.getElementById("odt-pk-out").className = "odt-output err";
        shadow.getElementById("odt-pk-out").textContent = "// no field-like element at click point";
        return;
      }
      capturePickedField(el);
    }
    function pickerKey(e) {
      if (e.key === "Escape") stopPicker();
    }
    function findFieldElement(el) {
      let n = el;
      let depth = 0;
      while (n && n !== document.body && depth < 30) {
        if (n.nodeType !== 1) {
          n = n.parentElement;
          depth++;
          continue;
        }
        const cls = n.className && typeof n.className === "string" ? n.className : n.classList ? Array.from(n.classList).join(" ") : "";
        if (n.hasAttribute && (n.hasAttribute("name") || cls.includes("o_field_widget") || cls.includes("o_field_")))
          return n;
        n = n.parentElement;
        depth++;
      }
      return null;
    }
    function capturePickedField(el) {
      const name = el.getAttribute && el.getAttribute("name");
      const cls = el.className && typeof el.className === "string" ? el.className : "";
      let widget = null;
      const wMatch = cls.match(/o_field_([a-z0-9_]+)/);
      if (wMatch) widget = wMatch[1];
      const ctx = getActiveCtx();
      let viewType = "form";
      let recordId = ctx.resId;
      let n = el;
      while (n && n !== document.body) {
        if (n.classList) {
          if (n.classList.contains("o_form_view")) {
            viewType = "form";
            break;
          }
          if (n.classList.contains("o_list_view")) {
            viewType = "list";
            break;
          }
          if (n.classList.contains("o_kanban_view")) {
            viewType = "kanban";
            break;
          }
          if (n.classList.contains("o_search_view")) {
            viewType = "search";
            break;
          }
        }
        n = n.parentElement;
      }
      let row = el;
      while (row && row !== document.body) {
        if (row.dataset && row.dataset.id) {
          recordId = parseInt(row.dataset.id, 10);
          break;
        }
        const ridAttr = row.getAttribute && row.getAttribute("data-res-id");
        if (ridAttr) {
          recordId = parseInt(ridAttr, 10);
          break;
        }
        row = row.parentElement;
      }
      const out = shadow.getElementById("odt-pk-out");
      const entry = {
        t: Date.now(),
        name: name || "(no name attr)",
        widget,
        viewType,
        model: ctx.model,
        resId: recordId,
        cls: cls.split(/\s+/).filter((c) => c.startsWith("o_")).slice(0, 8)
      };
      pickerHistory.unshift(entry);
      if (pickerHistory.length > 20) pickerHistory.length = 20;
      out.className = "odt-output";
      out.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span style="color:#fbbf24;font-weight:700">${escapeHtml(entry.name)}</span>
        <span style="color:#7dd3fc">${escapeHtml(entry.viewType)}</span>
        <span style="color:#a5b4fc">${escapeHtml(entry.model || "?")}</span>
        ${entry.resId ? `<span style="color:#94a3b8">#${entry.resId}</span>` : ""}
        ${entry.widget ? `<span class="ftype t-many2one" style="display:inline-block">${escapeHtml(entry.widget)}</span>` : ""}
      </div>
      <div style="color:#64748b;font-size:10px">${entry.cls.join(" ")}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="odt-mini-btn" data-act="pk-arch">\u25B6 inspect arch</button>
        <button class="odt-mini-btn" data-act="pk-field">\u25B6 field def</button>
        <button class="odt-mini-btn" data-act="pk-record">\u25B6 record</button>
        <button class="odt-mini-btn" data-act="pk-copy">\u25B6 copy name</button>
      </div>`;
      out.querySelector('[data-act="pk-arch"]').addEventListener("click", () => {
        if (!entry.model) return;
        switchTab("viewarch");
        loadViewArchFromProblem({ model: entry.model, viewType: entry.viewType });
      });
      out.querySelector('[data-act="pk-field"]').addEventListener("click", () => {
        if (!entry.model) return;
        switchTab("models");
        const ready = () => {
          const found = mbModels.find((m) => m.model === entry.model);
          if (found) {
            shadow.getElementById("odt-mb-q").value = entry.model;
            renderMbModels();
            selectMbModel(found).then(() => {
              setTimeout(() => {
                const fq = shadow.getElementById("odt-mb-fld-q");
                if (fq && entry.name) {
                  fq.value = entry.name;
                  fq.dispatchEvent(new Event("input"));
                }
              }, 100);
            });
          }
        };
        mbModelsLoaded ? ready() : loadModelBrowser().then(ready);
      });
      out.querySelector('[data-act="pk-record"]').addEventListener("click", () => {
        if (!entry.model || !entry.resId) return;
        switchTab("noupdate");
        shadow.getElementById("odt-model").value = entry.model;
        shadow.getElementById("odt-resid").value = entry.resId;
        shadow.getElementById("odt-xmlid").value = "";
        loadRecord();
      });
      out.querySelector('[data-act="pk-copy"]').addEventListener("click", () => copyText(entry.name));
      renderPickerHistory();
    }
    function renderPickerHistory() {
      const lbl = shadow.getElementById("odt-pk-history-label");
      const el = shadow.getElementById("odt-pk-history");
      if (!pickerHistory.length) {
        lbl.style.display = "none";
        el.style.display = "none";
        return;
      }
      lbl.style.display = "block";
      el.style.display = "block";
      el.innerHTML = pickerHistory.map(
        (p) => `
      <div class="odt-rpc-row" style="grid-template-columns:50px 1fr 100px 80px">
        <span class="t">${formatHms(p.t)}</span>
        <span class="model">${escapeHtml(p.name)}</span>
        <span class="meth">${escapeHtml(p.viewType)}</span>
        <span class="args">${escapeHtml(p.model || "")}${p.resId ? " #" + p.resId : ""}</span>
      </div>`
      ).join("");
    }
    async function loadCtx() {
      ctxLoaded = true;
      const out = shadow.getElementById("odt-ctx-out");
      const grid = shadow.getElementById("odt-ctx-grid");
      const groupsEl = shadow.getElementById("odt-ctx-groups");
      out.className = "odt-output muted";
      out.textContent = "// loading\u2026";
      try {
        const ctx = await callKw("res.users", "context_get", []);
        const uid = await callKw(
          "res.users",
          "search",
          [[["id", "=", ctx.uid || await getCurrentUid()]]],
          { limit: 1 }
        );
        const actualUid = ctx.uid || uid && uid[0] || null;
        const userRecs = await callKw("res.users", "read", [
          [actualUid],
          ["id", "login", "name", "lang", "tz", "company_id", "company_ids", "groups_id"]
        ]);
        const u = userRecs[0];
        ctxData = { ctx, user: u };
        const companies = await callKw("res.company", "read", [u.company_ids || [], ["id", "name"]]);
        const langs = await fetchLangs().catch(() => []);
        const groups = u.groups_id && u.groups_id.length ? await callKw("res.groups", "read", [
          u.groups_id,
          ["id", "name", "category_id", "full_name"]
        ]) : [];
        grid.style.display = "flex";
        grid.innerHTML = `
        <div class="cell"><span class="k">uid</span><span class="v">${u.id}</span></div>
        <div class="cell"><span class="k">login</span><span class="v" style="font-size:11px">${escapeHtml(u.login)}</span></div>
        <div class="cell"><span class="k">name</span><span class="v" style="font-size:11px">${escapeHtml(u.name)}</span></div>
        <div class="cell"><span class="k">company</span><span class="v" style="font-size:11px">${escapeHtml(Array.isArray(u.company_id) ? u.company_id[1] : "")}</span></div>
        <div class="cell"><span class="k">lang</span><span class="v" style="font-size:11px">${escapeHtml(u.lang || ctx.lang || "?")}</span></div>
        <div class="cell"><span class="k">tz</span><span class="v" style="font-size:11px">${escapeHtml(u.tz || ctx.tz || "?")}</span></div>
        <div class="cell"><span class="k">groups</span><span class="v">${groups.length}</span></div>
      `;
        out.className = "odt-output";
        out.textContent = JSON.stringify(ctx, null, 2);
        groupsEl.className = "odt-output";
        groupsEl.style.maxHeight = "200px";
        if (groups.length) {
          const byCat = /* @__PURE__ */ new Map();
          for (const g of groups) {
            const cat = Array.isArray(g.category_id) ? g.category_id[1] : "(none)";
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(g);
          }
          groupsEl.innerHTML = Array.from(byCat.entries()).sort(([a], [b]) => a.localeCompare(b)).map(
            ([cat, list]) => `
          <div style="margin-bottom:6px"><span style="color:#f59e0b;font-weight:700;font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase">${escapeHtml(cat)}</span>
            <div style="margin-left:8px;color:#cbd5e1">${list.map((g) => `<div>\xB7 ${escapeHtml(g.name)} <span style="color:#64748b">#${g.id}</span></div>`).join("")}</div>
          </div>`
          ).join("");
        } else {
          groupsEl.textContent = "// no groups";
        }
        const combo = shadow.getElementById("odt-ctx-company-combo").__combo || function() {
          const c = createCombo(shadow.getElementById("odt-ctx-company-combo"), {
            placeholder: "select company\u2026",
            searchPlaceholder: "search company\u2026"
          });
          shadow.getElementById("odt-ctx-company-combo").__combo = c;
          return c;
        }();
        combo.setOptions(companies.map((c) => ({ value: String(c.id), label: c.name })));
        const currId = Array.isArray(u.company_id) ? u.company_id[0] : u.company_id;
        if (currId) combo.setValue(String(currId));
        shadow.getElementById("odt-ctx-company-switch").disabled = companies.length < 2;
        shadow.getElementById("odt-ctx-company-switch").onclick = () => switchCompany(u.id, combo.getValue());
      } catch (e) {
        out.className = "odt-output err";
        out.textContent = `// error: ${e.message}`;
      }
    }
    async function getCurrentUid() {
      try {
        const r = await callKw("res.users", "search_read", [[], ["id"]], {
          limit: 1,
          context: { active_test: false }
        });
        return r && r[0] ? r[0].id : null;
      } catch (e) {
        return null;
      }
    }
    async function switchCompany(uid, newId) {
      if (!uid || !newId) return;
      const n = parseInt(newId, 10);
      if (!window.confirm(`Switch active company to #${n}? Page will reload.`)) return;
      try {
        await callKw("res.users", "write", [[uid], { company_id: n }]);
        location.reload();
      } catch (e) {
        const o = shadow.getElementById("odt-ctx-out");
        o.className = "odt-output err";
        o.textContent = `// switch failed: ${e.message}`;
      }
    }
    function initCtxActionCombo() {
      const host = shadow.getElementById("odt-ctx-action-combo");
      if (!host) return;
      const actions = [
        { value: "debug-on", label: "enable debug mode (?debug=1)" },
        { value: "debug-assets", label: "debug assets (?debug=assets)" },
        { value: "debug-off", label: "disable debug" },
        { value: "regen-assets", label: "regenerate assets (unlink web.assets_*)" },
        { value: "clear-caches", label: "clear ir.qweb / registry caches" },
        { value: "reload-translations", label: "reload translations" }
      ];
      const combo = createCombo(host, { placeholder: "pick action\u2026" });
      combo.setOptions(actions);
      combo.setValue("debug-on");
      host.__combo = combo;
      shadow.getElementById("odt-ctx-action-run").onclick = () => runCtxAction(combo.getValue());
    }
    async function runCtxAction(act) {
      const out = shadow.getElementById("odt-ctx-action-out");
      out.textContent = "";
      try {
        if (act === "debug-on") setDebug("1");
        else if (act === "debug-assets") setDebug("assets");
        else if (act === "debug-off") setDebug("");
        else if (act === "regen-assets") {
          if (!window.confirm("Unlink all web.assets_* attachments to force regeneration?")) return;
          const ids = await callKw("ir.attachment", "search", [[["name", "=like", "/web/assets/%"]]]);
          if (ids.length) await callKw("ir.attachment", "unlink", [ids]);
          out.textContent = `// removed ${ids.length} asset attachments \u2014 reload page to regenerate`;
          out.style.color = "#34d399";
        } else if (act === "clear-caches") {
          await callKw("ir.qweb", "clear_caches", []);
          out.textContent = "// caches cleared";
          out.style.color = "#34d399";
        } else if (act === "reload-translations") {
          await callKw("base.language.install", "do_load_translations", []).catch(async () => {
            await callKw("ir.translation", "load_module_terms", [
              ["__all__"],
              [ctxData && ctxData.user && ctxData.user.lang || "en_US"]
            ]).catch(() => {
            });
          });
          out.textContent = "// translations reload attempted";
          out.style.color = "#34d399";
        }
      } catch (e) {
        out.textContent = `// error: ${e.message}`;
        out.style.color = "#fda4af";
      }
    }
    function setDebug(val) {
      const url = new URL(location.href);
      if (val === "") url.searchParams.delete("debug");
      else url.searchParams.set("debug", val);
      location.href = url.toString();
    }
    function renderMbFieldRow(name, f) {
      const label = f.string || name;
      const type = f.type || "?";
      const rel = f.relation ? `<span class="h">\u2192</span> ${escapeHtml(f.relation)}` : f.related ? `<span class="h">via</span> ${escapeHtml(f.related)}` : "";
      const flags = [];
      if (f.required) flags.push(`<span class="flag req">REQ</span>`);
      if (f.readonly) flags.push(`<span class="flag ro">RO</span>`);
      if (f.store === false) flags.push(`<span class="flag">!store</span>`);
      else if (f.store) flags.push(`<span class="flag store">store</span>`);
      if (f.compute) flags.push(`<span class="flag compute">comp</span>`);
      const cls = `t-${type}`;
      return `
      <div class="odt-mb-fld" data-search="${escapeHtml(name + " " + label + " " + type + " " + (f.relation || "") + " " + (f.related || ""))}">
        <span class="nm ${f.required ? "req" : ""}" title="${escapeHtml(label)}">${escapeHtml(name)} <span style="color:#64748b">\xB7 ${escapeHtml(label)}</span></span>
        <span class="ftype ${cls}">${escapeHtml(type)}</span>
        <span class="rel">${rel}</span>
        <span class="flags">${flags.join(" ")}</span>
      </div>`;
    }
    build();
  })();
})();

  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", __odtStartUI);
  } else {
    __odtStartUI();
  }
})();

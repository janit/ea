// Echelon Analytics — Tracker Script Server (GET /ea.js)
//
// Serves a self-contained JavaScript tracker that auto-captures
// pageviews, bounces, session lifecycle, clicks, and scroll depth.
// Sites embed: <script async src="https://echelon.example.com/ea.js" data-site="my-site"></script>

import { generateChallenge, getWasmBase64 } from "./challenge.ts";
import { ALLOWED_ORIGINS, COOKIE_CONSENT, TRUST_PROXY } from "./config.ts";
import { isDebugEnabled } from "./debug.ts";
import { getConsentCss } from "./consent-css.ts";

const TRACKER_SOURCE = `(function(){
"use strict";

// ── Double-load guard ────────────────────────────────────────────────────────
if (window.__echelon) return;
window.__echelon = 1;

// ── Config ──────────────────────────────────────────────────────────────────
var sc = document.currentScript || document.querySelector("script[data-site][src*='ea.js']");
if (!sc) return;

// ── Prerender guard — defer until page is actually visible ──────────────────
if (document.visibilityState === "prerender") {
  document.addEventListener("visibilitychange", function wait() {
    if (document.visibilityState !== "prerender") {
      document.removeEventListener("visibilitychange", wait);
      init();
    }
  });
  return;
}
init();

function init() {
var siteId = sc.getAttribute("data-site") || "default";
var base = "__ECHELON_ORIGIN__";
var _c = "__ECHELON_CHALLENGE__";
var _w = "__ECHELON_WASM_B64__";
var wantCookie = sc.hasAttribute("data-cookie");
var cookieConsented = wantCookie ? 0 : 0;
/*CONSENT_START*/
if (wantCookie) {
  try {
    var consent = localStorage.getItem("_econsent");
    if (consent === "1") { cookieConsented = 1; }
    else if (consent !== "0") { showCookieBanner(); }
  } catch(x) {}
}
/*CONSENT_END*/
/*NOCONSENT_START*/
if (wantCookie) cookieConsented = 1;
/*NOCONSENT_END*/
var _dbg = __ECHELON_DEBUG__;
function dbg() { if (_dbg) console.log.apply(console, ["[echelon:debug]"].concat(Array.prototype.slice.call(arguments))); }
if (_dbg) dbg("hello from echelon");

var wantClicks = !sc.hasAttribute("data-no-clicks");
var wantScroll = !sc.hasAttribute("data-no-scroll");
var wantHover = !sc.hasAttribute("data-no-hover");
var wantOutbound = !sc.hasAttribute("data-no-outbound");
var wantDownloads = !sc.hasAttribute("data-no-downloads");
var wantForms = !sc.hasAttribute("data-no-forms");
var wantVitals = !sc.hasAttribute("data-no-vitals");

/*CONSENT_START*/
// ── Cookie Consent Banner (Web Component + Shadow DOM) ──────────────────────
var _cc = "__ECHELON_CONSENT_CSS__";
function showCookieBanner() {
  if (customElements.get("echelon-consent")) return;
  customElements.define("echelon-consent", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); }
    connectedCallback() {
      var s = this.shadowRoot;
      var style = document.createElement("style");
      style.textContent = ':host{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;font:14px/1.4 -apple-system,system-ui,sans-serif}' +
        '.bar{background:#1a1a1a;color:#e0e0e0;padding:12px 16px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;box-shadow:0 -2px 8px rgba(0,0,0,.3)}' +
        '.msg{flex:1;min-width:200px;max-width:600px}' +
        '.btns{display:flex;gap:8px;flex-shrink:0}' +
        'button{padding:6px 16px;border-radius:4px;cursor:pointer;font:inherit;font-size:13px}' +
        '.ok{background:#4a9eff;color:#fff;border:none}' +
        '.no{background:transparent;color:#999;border:1px solid #444}' +
        (_cc || '');
      var bar = document.createElement("div"); bar.className = "bar";
      var msg = document.createElement("span"); msg.className = "msg";
      msg.textContent = "This site uses a cookie to remember you across visits. No personal data is collected.";
      var btns = document.createElement("span"); btns.className = "btns";
      var ok = document.createElement("button"); ok.className = "ok"; ok.textContent = "Accept";
      var no = document.createElement("button"); no.className = "no"; no.textContent = "Decline";
      btns.appendChild(ok); btns.appendChild(no);
      bar.appendChild(msg); bar.appendChild(btns);
      s.appendChild(style); s.appendChild(bar);
      var el = this;
      ok.onclick = function() {
        cookieConsented = 1;
        try { localStorage.setItem("_econsent", "1"); } catch(x) {}
        el.remove();
      };
      no.onclick = function() {
        try { localStorage.setItem("_econsent", "0"); } catch(x) {}
        el.remove();
      };
    }
  });
  document.body.appendChild(document.createElement("echelon-consent"));
}
/*CONSENT_END*/

// ── Session ID (tab-scoped, sessionStorage) ─────────────────────────────────
var sid;
try {
  sid = sessionStorage.getItem("_esid");
  if (!sid) {
    sid = crypto.randomUUID ? crypto.randomUUID() :
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
      });
    sessionStorage.setItem("_esid", sid);
  }
} catch(x) {
  sid = Math.random().toString(36).slice(2);
}

// ── UTM Campaign Attribution (persisted in sessionStorage) ──────────────────
var utmC = "", utmS = "", utmM = "", utmCo = "", utmT = "";
try {
  var qp = new URLSearchParams(location.search);
  var qC = qp.get("utm_campaign") || "";
  if (qC) {
    utmC = qC; utmS = qp.get("utm_source") || ""; utmM = qp.get("utm_medium") || "";
    utmCo = qp.get("utm_content") || ""; utmT = qp.get("utm_term") || "";
    sessionStorage.setItem("_eutm", JSON.stringify({ c: utmC, s: utmS, m: utmM, co: utmCo, t: utmT }));
  } else {
    var stored = sessionStorage.getItem("_eutm");
    if (stored) {
      var u = JSON.parse(stored);
      utmC = u.c || ""; utmS = u.s || ""; utmM = u.m || ""; utmCo = u.co || ""; utmT = u.t || "";
    }
  }
} catch(x) {}

// ── PoW Challenge ───────────────────────────────────────────────────────────
var tok = "";
var tokReady = null;
try {
  var cached = sessionStorage.getItem("_etok");
  if (cached) {
    var parts = cached.split(":");
    if (parts[0] === _c && parts[1] && /^[0-9a-f]{32}$/.test(parts[1]) && Math.random() > 0.1) {
      tok = parts[1];
      dbg("PoW: using cached token", tok.slice(0, 8) + "...", "challenge match:", parts[0] === _c);
    } else {
      dbg("PoW: cached token stale", { cachedChallenge: parts[0] ? parts[0].slice(0, 8) + "..." : "(none)", currentChallenge: _c.slice(0, 8) + "..." });
    }
  }
} catch(x) {}

if (!tok && _w && _c) {
  dbg("PoW: solving fresh", { challenge: _c.slice(0, 8) + "...", sid: sid.slice(0, 8) + "...", siteId: siteId });
  try {
    var bin = atob(_w);
    var bytes = new Uint8Array(bin.length);
    for (var wi = 0; wi < bin.length; wi++) bytes[wi] = bin.charCodeAt(wi);
    tokReady = WebAssembly.instantiate(bytes).then(function(r) {
      var mem = new Uint8Array(r.instance.exports.memory.buffer);
      var inp = _c + ":" + sid + ":" + siteId;
      var enc = new TextEncoder().encode(inp);
      mem.set(enc, 0);
      r.instance.exports.solve(0, enc.length, 2048);
      var out = mem.slice(2048, 2064);
      tok = "";
      for (var hi = 0; hi < 16; hi++) tok += (out[hi] < 16 ? "0" : "") + out[hi].toString(16);
      dbg("PoW: solved", { tok: tok.slice(0, 8) + "...", input: inp.slice(0, 40) + "..." });
      try { sessionStorage.setItem("_etok", _c + ":" + tok); } catch(x) {}
    }).catch(function(e) { dbg("PoW: WASM solve failed", e); });
  } catch(x) { dbg("PoW: WASM instantiation error", x); }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function b64(s) { try { return btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, function(_, p) { return String.fromCharCode(parseInt(p, 16)); })); } catch(e) { return encodeURIComponent(s); } }
function up(el, pred) { for (var i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) { if (pred(el)) return el; } return null; }
function ecData(el, skip) { var o = {}, c = 0; if (!el.dataset) return o; for (var k in el.dataset) { if (c >= 8) break; if (k !== skip && k.indexOf("echelon") === 0) { o[k.slice(7, 8).toLowerCase() + k.slice(8)] = String(el.dataset[k]).slice(0, 256); c++; } } return o; }
function sendEvents(events) {
  if (!events.length) return;
  try {
    if (utmC) for (var ei = 0; ei < events.length; ei++) events[ei].utmCampaign = utmC;
    dbg("sendEvents", { types: events.map(function(e) { return e.type; }), tok: tok ? tok.slice(0, 8) + "..." : "(none)" });
    var j = JSON.stringify({ events: events, siteId: siteId, tok: tok });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(base + "/e", new Blob([j], { type: "application/json" }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", base + "/e", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(j);
    }
  } catch(e) {}
}

// ── 1. Pageview Beacon ──────────────────────────────────────────────────────
var t0 = Date.now(), fired = 0;
var beaconUrl = base + "/b.gif?p=" + b64(location.pathname + location.search) + "&s=" + encodeURIComponent(siteId) + (cookieConsented ? "&ck=1" : "");

// External referrer
var ref = document.referrer;
if (ref) {
  try {
    if (new URL(ref).origin !== location.origin)
      beaconUrl += "&ref=" + b64(ref);
  } catch(x) {}
}

// PWA detection
if (window.matchMedia("(display-mode:standalone)").matches || navigator.standalone)
  beaconUrl += "&pwa=1";

// UTM params on beacon (encodeURIComponent prevents + in base64 being decoded as space)
if (utmC) {
  beaconUrl += "&uc=" + encodeURIComponent(b64(utmC)) + "&us=" + encodeURIComponent(b64(utmS)) + "&um=" + encodeURIComponent(b64(utmM));
  if (utmCo) beaconUrl += "&uct=" + encodeURIComponent(b64(utmCo));
  if (utmT) beaconUrl += "&ut=" + encodeURIComponent(b64(utmT));
}

var interactionEvents = ["pointerdown", "scroll", "click", "keydown"];

function sendBeaconImg() {
  beaconUrl += "&sid=" + sid + "&_v=" + (Date.now() - t0) +
    "&sw=" + screen.width + "&sh=" + screen.height +
    (tok ? "&tok=" + tok : "");
  dbg("beacon", { url: beaconUrl.replace(base, ""), tok: tok ? tok.slice(0, 8) + "..." : "(none)", waitMs: Date.now() - t0 });
  new Image().src = beaconUrl;
  interactionEvents.forEach(function(n) { removeEventListener(n, onInteraction); });
  document.removeEventListener("visibilitychange", onVisChange);
}
function fireBeacon() {
  if (fired) return;
  fired = 1;
  if (!tok && tokReady) {
    // Wait up to 150ms for WASM to finish before sending
    Promise.race([tokReady, new Promise(function(r) { setTimeout(r, 150); })]).then(sendBeaconImg);
  } else {
    sendBeaconImg();
  }
}

function onInteraction(a) {
  if (!a.isTrusted) return;
  var d = Date.now() - t0;
  d < 800 ? setTimeout(fireBeacon, 800 - d) : fireBeacon();
}

function onVisChange() {
  if (document.hidden && Date.now() - t0 >= 4000) fireBeacon();
}

interactionEvents.forEach(function(n) { addEventListener(n, onInteraction, { passive: true }); });
document.addEventListener("visibilitychange", onVisChange);

// ── 2. Bounce Detection ────────────────────────────────────────────────────
var bounced = 0;

function cancelBounce() {
  if (bounced) return;
  bounced = 1;
  interactionEvents.forEach(function(n) { removeEventListener(n, onBounceInteraction); });
  clearTimeout(bounceTimer);
  document.removeEventListener("visibilitychange", onBounceVis);
}

function sendBounce(trigger) {
  if (bounced) return;
  cancelBounce();
  sendEvents([{
    type: "bounce",
    data: { dwell: Math.round((Date.now() - t0) / 1000), trigger: trigger || "timeout", path: location.pathname },
    sessionId: sid
  }]);
}

function onBounceInteraction(a) {
  if (!a.isTrusted) return;
  cancelBounce();
}

var bounceTimer = setTimeout(function() { sendBounce("timeout"); }, 120000);

function onBounceVis() {
  if (document.visibilityState === "hidden") sendBounce("unload");
}

interactionEvents.forEach(function(n) { addEventListener(n, onBounceInteraction, { passive: true }); });
document.addEventListener("visibilitychange", onBounceVis);

// ── 3. Session End / Resume ─────────────────────────────────────────────────
var sessionEnded = 0, lastEndTime = 0;

function sendSessionEnd() {
  if (sessionEnded) return;
  sessionEnded = 1;
  lastEndTime = Date.now();
  sendEvents([{
    type: "session_end",
    data: { dwell_s: Math.round((lastEndTime - t0) / 1000), path: location.pathname },
    sessionId: sid
  }]);
}

document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "hidden") {
    sendSessionEnd();
  } else if (sessionEnded) {
    sessionEnded = 0;
    sendEvents([{
      type: "session_resume",
      data: { away_s: Math.round((Date.now() - lastEndTime) / 1000), path: location.pathname },
      sessionId: sid
    }]);
  }
});
addEventListener("pagehide", sendSessionEnd);

// ── bfcache (back-forward cache) restore ────────────────────────────────────
addEventListener("pageshow", function(e) {
  if (e.persisted && sessionEnded) {
    sessionEnded = 0;
    sendEvents([{
      type: "session_resume",
      data: { away_s: Math.round((Date.now() - lastEndTime) / 1000), path: location.pathname, bfcache: true },
      sessionId: sid
    }]);
  }
});

// ── 4. Click Tracking (merged: clicks, outbound, downloads — on by default) ──
var dlExts = wantDownloads ? /\\.(pdf|zip|tar|gz|bz2|xz|rar|7z|dmg|exe|msi|apk|ipa|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|mov|avi|mkv|epub|iso)$/i : null;
if (wantClicks || wantOutbound || wantDownloads) document.addEventListener("click", function(e) {
  if (!e.isTrusted) return;
  // data-echelon-click
  if (wantClicks) {
    var ce = up(e.target, function(el) { return el.dataset && el.dataset.echelonClick !== undefined; });
    if (ce) {
      var d = Object.assign({ click: ce.dataset.echelonClick, tag: ce.tagName, path: location.pathname }, ecData(ce, "echelonClick"));
      sendEvents([{ type: "click", data: d, sessionId: sid }]);
      return;
    }
  }
  // Outbound + downloads (both need <a href>)
  var ae = up(e.target, function(el) { return el.tagName === "A" && el.href; });
  if (!ae) return;
  try {
    var u = new URL(ae.href, location.href);
    if (wantOutbound && u.origin !== location.origin && u.protocol.indexOf("http") === 0) {
      sendEvents([{ type: "outbound", data: { url: u.href.slice(0, 512), host: u.hostname, text: (ae.textContent || "").trim().slice(0, 128), path: location.pathname }, sessionId: sid }]);
    }
    if (dlExts) {
      var file = u.pathname.split("/").pop() || "";
      var ext = file.match(dlExts);
      if (ext) {
        sendEvents([{ type: "download", data: { url: u.href.slice(0, 512), file: file.slice(0, 256), ext: ext[1].toLowerCase(), path: location.pathname }, sessionId: sid }]);
      }
    }
  } catch(x) {}
}, { passive: true });

// ── 5. Scroll Depth (on by default, opt-out: data-no-scroll) ────────────────
var maxScroll = 0, milestones = [25, 50, 75, 90, 100], reached = {};
function checkScroll() {
  var h = document.documentElement.scrollHeight - window.innerHeight;
  if (h <= 0) return;
  var pct = Math.round(window.scrollY / h * 100);
  if (pct <= maxScroll) return;
  maxScroll = pct;
  for (var i = 0; i < milestones.length; i++) {
    var m = milestones[i];
    if (pct >= m && !reached[m]) {
      reached[m] = 1;
      sendEvents([{ type: "scroll_depth", data: { depth: m, path: location.pathname }, sessionId: sid }]);
    }
  }
}
var scrollTicking = 0;
if (wantScroll) addEventListener("scroll", function() {
  if (scrollTicking) return;
  scrollTicking = 1;
  requestAnimationFrame(function() { checkScroll(); scrollTicking = 0; });
}, { passive: true });

// ── 6. Hover Tracking (on by default, opt-out: data-no-hover) ───────────────
if (wantHover) {
  var hoverTimer = 0, hoverEl = null;
  document.addEventListener("mouseover", function(e) {
    if (!e.isTrusted) return;
    var el = up(e.target, function(n) { return n.dataset && n.dataset.echelonHover !== undefined; });
    if (!el) return;
    if (el === hoverEl) return;
    clearTimeout(hoverTimer);
    hoverEl = el;
    var capturedHover = el.dataset.echelonHover;
    var capturedTag = el.tagName;
    var capturedData = ecData(el, "echelonHover");
    hoverTimer = setTimeout(function() {
      var d = Object.assign({ hover: capturedHover, tag: capturedTag, path: location.pathname }, capturedData);
      sendEvents([{ type: "hover", data: d, sessionId: sid }]);
      hoverEl = null;
    }, 1000);
  }, { passive: true });
  document.addEventListener("mouseout", function(e) {
    if (hoverEl && !hoverEl.contains(e.relatedTarget)) {
      clearTimeout(hoverTimer);
      hoverEl = null;
    }
  }, { passive: true });
}

// ── 7. Form Submission Tracking (on by default, opt-out: data-no-forms) ─────
if (wantForms) document.addEventListener("submit", function(e) {
  if (!e.isTrusted) return;
  var form = e.target;
  if (!form || form.tagName !== "FORM") return;
  var d = {
    action: (form.action || "").slice(0, 256),
    method: (form.method || "GET").toUpperCase(),
    id: (form.id || "").slice(0, 64),
    name: (form.name || "").slice(0, 64),
    path: location.pathname
  };
  // Include data-echelon-form label if present
  if (form.dataset && form.dataset.echelonForm) {
    d.label = form.dataset.echelonForm;
  }
  sendEvents([{ type: "form_submit", data: d, sessionId: sid }]);
}, { passive: true });

// ── 8. Web Vitals (on by default, opt-out: data-no-vitals) ─────────────────
if (wantVitals && typeof PerformanceObserver !== "undefined") {
  var vitalsSent = {};

  function sendVital(name, value, rating) {
    if (vitalsSent[name]) return;
    vitalsSent[name] = 1;
    sendEvents([{ type: "web_vital", data: {
      metric: name,
      value: Math.round(name === "CLS" ? value * 1000 : value),
      rating: rating,
      path: location.pathname
    }, sessionId: sid }]);
  }

  function rateMetric(name, val) {
    if (name === "LCP") return val <= 2500 ? "good" : val <= 4000 ? "needs-improvement" : "poor";
    if (name === "CLS") return val <= 0.1 ? "good" : val <= 0.25 ? "needs-improvement" : "poor";
    if (name === "INP") return val <= 200 ? "good" : val <= 500 ? "needs-improvement" : "poor";
    return "unknown";
  }

  // LCP — Largest Contentful Paint
  try {
    var lcpVal = 0;
    var lcpObs = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      if (entries.length) lcpVal = entries[entries.length - 1].startTime;
    });
    lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
    // LCP is finalized when user interacts or page hides
    var reportLCP = function() {
      if (lcpVal > 0) {
        lcpObs.disconnect();
        sendVital("LCP", lcpVal, rateMetric("LCP", lcpVal));
      }
    };
    addEventListener("pointerdown", reportLCP, { once: true, passive: true });
    addEventListener("keydown", reportLCP, { once: true, passive: true });
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden") reportLCP();
    });
  } catch(x) {}

  // CLS — Cumulative Layout Shift
  try {
    var clsVal = 0, clsSession = 0, clsMax = 0, clsLast = 0;
    new PerformanceObserver(function(list) {
      for (var i = 0; i < list.getEntries().length; i++) {
        var e = list.getEntries()[i];
        if (e.hadRecentInput) continue;
        // Session window: gap < 1s, window < 5s
        if (e.startTime - clsLast < 1000 && e.startTime - clsSession < 5000) {
          clsVal += e.value;
        } else {
          clsSession = e.startTime;
          clsVal = e.value;
        }
        clsLast = e.startTime;
        if (clsVal > clsMax) clsMax = clsVal;
      }
    }).observe({ type: "layout-shift", buffered: true });
    // Report CLS on page hide
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden" && clsMax > 0) {
        sendVital("CLS", clsMax, rateMetric("CLS", clsMax));
      }
    });
  } catch(x) {}

  // INP — Interaction to Next Paint
  try {
    var inpVal = 0;
    new PerformanceObserver(function(list) {
      for (var i = 0; i < list.getEntries().length; i++) {
        var e = list.getEntries()[i];
        var dur = e.duration;
        if (dur > inpVal) inpVal = dur;
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    // Report INP on page hide (captures the worst interaction)
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden" && inpVal > 0) {
        sendVital("INP", inpVal, rateMetric("INP", inpVal));
      }
    });
  } catch(x) {}
}

// ── 9. SPA Navigation (pushState / replaceState / popstate) ────────────────
var lastPath = location.pathname + location.search;

function onNavigate() {
  var currentPath = location.pathname + location.search;
  if (currentPath === lastPath) return;
  lastPath = currentPath;

  // Reset state for new "page"
  t0 = Date.now();
  fired = 0;
  bounced = 0;
  sessionEnded = 0;
  maxScroll = 0;
  reached = {};
  clearTimeout(bounceTimer);
  bounceTimer = setTimeout(function() { sendBounce("timeout"); }, 120000);
  interactionEvents.forEach(function(n) { addEventListener(n, onBounceInteraction, { passive: true }); });
  document.addEventListener("visibilitychange", onBounceVis);

  // Re-read UTM: check new URL first, fall back to sessionStorage
  try {
    var spaQp = new URLSearchParams(location.search);
    var spaQc = spaQp.get("utm_campaign") || "";
    if (spaQc) {
      utmC = spaQc; utmS = spaQp.get("utm_source") || ""; utmM = spaQp.get("utm_medium") || "";
      utmCo = spaQp.get("utm_content") || ""; utmT = spaQp.get("utm_term") || "";
      sessionStorage.setItem("_eutm", JSON.stringify({ c: utmC, s: utmS, m: utmM, co: utmCo, t: utmT }));
    } else {
      var spaUtm = sessionStorage.getItem("_eutm");
      if (spaUtm) {
        var su = JSON.parse(spaUtm);
        utmC = su.c || ""; utmS = su.s || ""; utmM = su.m || ""; utmCo = su.co || ""; utmT = su.t || "";
      }
    }
  } catch(x) {}

  // New pageview beacon
  beaconUrl = base + "/b.gif?p=" + b64(location.pathname + location.search) + "&s=" + encodeURIComponent(siteId) + (cookieConsented ? "&ck=1" : "");
  if (window.matchMedia("(display-mode:standalone)").matches || navigator.standalone)
    beaconUrl += "&pwa=1";
  if (utmC) {
    beaconUrl += "&uc=" + encodeURIComponent(b64(utmC)) + "&us=" + encodeURIComponent(b64(utmS)) + "&um=" + encodeURIComponent(b64(utmM));
    if (utmCo) beaconUrl += "&uct=" + encodeURIComponent(b64(utmCo));
    if (utmT) beaconUrl += "&ut=" + encodeURIComponent(b64(utmT));
  }

  // Fire immediately — user already interacted to trigger SPA navigation
  fired = 1;
  beaconUrl += "&sid=" + sid + "&_v=spa&sw=" + screen.width + "&sh=" + screen.height +
    (tok ? "&tok=" + tok : "");
  dbg("SPA nav", { path: currentPath, tok: tok ? tok.slice(0, 8) + "..." : "(none)" });
  new Image().src = beaconUrl;
}

var origPush = history.pushState;
var origReplace = history.replaceState;
history.pushState = function() { var r = origPush.apply(this, arguments); try { onNavigate(); } catch(x) {} return r; };
history.replaceState = function() { var r = origReplace.apply(this, arguments); try { onNavigate(); } catch(x) {} return r; };
addEventListener("popstate", onNavigate);

// ── 10. Public API — window.echelon.track(name, props) ──────────────────────
window.echelon = {
  track: function(name, props) {
    var safe = { name: String(name).slice(0, 128), path: location.pathname };
    if (props && typeof props === "object") {
      var count = 0;
      for (var k in props) {
        if (count >= 16) break;
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        safe[String(k).slice(0, 64)] = String(props[k]).slice(0, 512);
        count++;
      }
    }
    sendEvents([{ type: "custom", data: safe, sessionId: sid }]);
  }
};

} // end init()
})();`;

// ── Minification (strip comments + collapse whitespace) ─────────────────────

function minifyJS(src: string): string {
  return src
    .replace(/^[ \t]*\/\/[^\n]*/gm, "") // strip line comments
    .replace(/\n{2,}/g, "\n") // collapse blank lines
    .replace(/[ \t]+$/gm, "") // trim trailing whitespace
    .replace(/^[ \t]+/gm, "") // trim leading whitespace
    .trim();
}

// Strip consent/noconsent blocks based on config, then minify
const strippedSource = COOKIE_CONSENT
  ? TRACKER_SOURCE.replace(
    /\/\*NOCONSENT_START\*\/[\s\S]*?\/\*NOCONSENT_END\*\//g,
    "",
  )
  : TRACKER_SOURCE.replace(
    /\/\*CONSENT_START\*\/[\s\S]*?\/\*CONSENT_END\*\//g,
    "",
  );
const minifiedSource = minifyJS(strippedSource);

// ── Request handler ─────────────────────────────────────────────────────────

const SCRIPT_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300",
};

export async function handleTracker(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proto = (TRUST_PROXY && req.headers.get("x-forwarded-proto")) ||
    url.protocol.replace(":", "");
  // Validate X-Forwarded-Host against ALLOWED_ORIGINS to prevent host-header
  // poisoning that could redirect tracker beacons to an attacker's domain.
  let host = req.headers.get("host") || url.host;
  if (TRUST_PROXY) {
    const fwdHost = req.headers.get("x-forwarded-host");
    if (fwdHost) {
      if (ALLOWED_ORIGINS.size === 0) {
        host = fwdHost;
      } else {
        try {
          const fwdHostname = fwdHost.replace(/:\d+$/, "").toLowerCase();
          host = ALLOWED_ORIGINS.has(fwdHostname) ? fwdHost : host;
        } catch {
          // Malformed — fall through to default host
        }
      }
    }
  }
  const origin = `${proto}://${host}`;
  const siteId = url.searchParams.get("s") ?? "default";
  const consentCss = COOKIE_CONSENT ? getConsentCss(siteId) : "";

  const [challenge, wasmB64] = await Promise.all([
    generateChallenge(),
    getWasmBase64(),
  ]);

  // Escape all values for safe embedding in JS string literals.
  // JSON.stringify handles quotes, backslashes, control chars, etc.
  // .slice(1, -1) strips the outer quotes since they're already in the template.
  // Arrow function replacers prevent $-pattern interpretation ($', $`, $&).
  const safeOrigin = JSON.stringify(origin).slice(1, -1);
  const safeChallenge = JSON.stringify(challenge).slice(1, -1);
  const safeWasm = JSON.stringify(wasmB64).slice(1, -1);
  const safeCss = JSON.stringify(consentCss).slice(1, -1);

  const script = minifiedSource
    .replace("__ECHELON_ORIGIN__", () => safeOrigin)
    .replace("__ECHELON_CHALLENGE__", () => safeChallenge)
    .replace("__ECHELON_WASM_B64__", () => safeWasm)
    .replace("__ECHELON_CONSENT_CSS__", () => safeCss)
    .replace("__ECHELON_DEBUG__", () => isDebugEnabled() ? "true" : "false");

  return new Response(script, { headers: SCRIPT_HEADERS });
}

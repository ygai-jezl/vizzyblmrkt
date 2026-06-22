/**
 * The embeddable-widget loader, served at `/embed.js`.
 *
 * A customer drops a container div + this script onto any site. The loader
 * turns each `[data-vizzybl-campaign]` div into a sandboxed cross-origin iframe
 * pointing at `/embed/<campaign>` on THIS origin, and keeps the iframe sized to
 * its content via origin-checked postMessage. Because the iframe is served from
 * our origin, tenant resolution + the signup API work exactly as on the hosted
 * page, with zero CORS or cross-origin-tenant rework — and the host page is
 * fully isolated from our CSS/JS (and vice-versa).
 *
 * Framework-free, evergreen-browser JS. The data-attribute names below MUST
 * stay in sync with EMBED_ATTR in src/lib/widget/snippet.ts.
 */

export const runtime = "nodejs";
export const dynamic = "force-static";

const LOADER = String.raw`(function () {
  "use strict";
  var MAX_H = 5000;

  // Resolve our own origin from this very script's URL, so the iframe always
  // points back at the host that served the loader (host-agnostic + CDN-cached).
  // currentScript is valid here because the IIFE runs synchronously at load.
  var self = document.currentScript;
  function loaderOrigin() {
    try {
      if (self && self.src) return new URL(self.src).origin;
    } catch (e) {}
    var tags = document.querySelectorAll('script[src]');
    for (var i = 0; i < tags.length; i++) {
      var src = tags[i].getAttribute('src') || '';
      // Match the loader path precisely (not any URL containing "/embed.js").
      if (/\/embed\.js(\?|$)/.test(src)) {
        try { return new URL(src, location.href).origin; } catch (e) {}
      }
    }
    return location.origin;
  }
  var ORIGIN = loaderOrigin();
  var MOUNTED = 'vizzyblmounted';

  // One registry + ONE delegated message listener for ALL widgets — adding a
  // listener per iframe leaks them across re-mounts/SPA churn. Each frame is
  // matched live by e.source so one widget cannot resize/spoof another.
  var frames = [];
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var data = e.data || {};
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (e.source !== f.iframe.contentWindow) continue;
      if (data.type === 'vizzybl:resize' && !f.fixed) {
        var h = parseInt(data.height, 10);
        if (h > 0 && h < MAX_H) f.iframe.style.height = h + 'px';
      } else if (data.type === 'vizzybl:signup') {
        try {
          window.dispatchEvent(
            new CustomEvent('vizzybl:signup', { detail: data.detail || {} })
          );
        } catch (err) {}
      }
      return;
    }
  });

  function buildSrc(el) {
    var campaign = el.getAttribute('data-vizzybl-campaign');
    if (!campaign) return null;
    var qs = [];
    function add(key, val) {
      if (val) qs.push(key + '=' + encodeURIComponent(val));
    }
    add('t', el.getAttribute('data-vizzybl-tenant'));
    add('type', el.getAttribute('data-vizzybl-type'));
    add('mode', el.getAttribute('data-vizzybl-mode'));
    add('ref', el.getAttribute('data-vizzybl-ref'));
    add('buttonColor', el.getAttribute('data-vizzybl-button-color'));
    add('bgColor', el.getAttribute('data-vizzybl-bg-color'));
    add('fontColor', el.getAttribute('data-vizzybl-font-color'));
    // Pass the HOST page's UTM params through to the iframe so the view beacon
    // (which runs INSIDE the same-origin frame and can't read the parent's URL)
    // can attribute impressions to the campaign that drove the visit.
    try {
      var host = new URLSearchParams(location.search);
      var utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
      for (var u = 0; u < utm.length; u++) add(utm[u], host.get(utm[u]));
    } catch (e) {}
    var query = qs.length ? ('?' + qs.join('&')) : '';
    return ORIGIN + '/embed/' + encodeURIComponent(campaign) + query;
  }

  // A fixed height is honored only when it is a positive, in-range integer;
  // anything else (incl. "0" or absurd values) falls back to auto-resize.
  function fixedHeight(el) {
    var raw = el.getAttribute('data-vizzybl-height');
    if (!raw || !/^[0-9]+$/.test(raw)) return 0;
    var n = parseInt(raw, 10);
    return n > 0 && n <= MAX_H ? n : 0;
  }

  function mount(el) {
    if (el.getAttribute('data-' + MOUNTED) === '1') return;
    var src = buildSrc(el);
    if (!src) return;
    el.setAttribute('data-' + MOUNTED, '1');

    var fixed = fixedHeight(el);
    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = 'Waitlist signup';
    iframe.loading = 'lazy';
    // 'microphone' (bare token → delegates to the iframe's own src origin)
    // lets the post-signup Gemini Live voice conversation capture audio. The
    // framed /embed doc also self-permits it (Permissions-Policy in next.config),
    // and the customer's host page must not strip the mic from subframes.
    iframe.setAttribute('allow', 'clipboard-write; microphone');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.overflow = 'hidden';
    iframe.style.colorScheme = 'normal';
    iframe.style.height = (fixed || 240) + 'px';
    iframe.scrolling = 'no';

    el.appendChild(iframe);
    frames.push({ iframe: iframe, fixed: fixed > 0 });
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll('[data-vizzybl-campaign]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  // Expose a manual hook for SPA/dynamic insertion.
  window.Vizzybl = window.Vizzybl || {};
  window.Vizzybl.mount = scan;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(); });
  } else {
    scan();
  }
})();
`;

export function GET(): Response {
  return new Response(LOADER, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // Short cache so snippet/loader changes propagate quickly; CDN-friendly.
      "Cache-Control": "public, max-age=600, s-maxage=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

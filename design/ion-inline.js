/* ion-inline.js — reliable Ionicons rendering.
   Ionicons' own web component lazy-fetches each SVG at render time, which is
   blocked in some sandboxed iframes. This helper instead fetches the same
   official Ionicons SVGs once and inlines them into every <ion-icon name="…">,
   so the exact Ionicons vocabulary renders everywhere (React kit + static cards).
   Color is inherited via currentColor; size via the element's font-size. */
(function () {
  var BASE = 'https://cdn.jsdelivr.net/npm/ionicons@7.4.0/dist/ionicons/svg/';
  var cache = {};

  // inject sizing + color rules once
  var style = document.createElement('style');
  style.textContent =
    'ion-icon{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;}' +
    'ion-icon svg{width:1em;height:1em;display:block;fill:currentColor;stroke:none;}' +
    'ion-icon .ionicon-fill-none{fill:none;stroke:currentColor;}' +
    'ion-icon .ionicon-stroke-width{stroke-width:32px;}';
  (document.head || document.documentElement).appendChild(style);

  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(BASE + name + '.svg')
      .then(function (r) { return r.ok ? r.text() : ''; })
      .catch(function () { return ''; });
    return cache[name];
  }

  function render(el) {
    var name = el.getAttribute('name');
    if (!name) return;
    el.setAttribute('data-ion-rendered', name);
    load(name).then(function (svg) {
      if (svg && el.getAttribute('name') === name) el.innerHTML = svg;
    });
  }

  function scan() {
    var els = document.querySelectorAll('ion-icon');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.getAttribute('data-ion-rendered') !== el.getAttribute('name')) render(el);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  // catch React / dynamically-added icons
  new MutationObserver(function () { scan(); })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['name'] });
})();

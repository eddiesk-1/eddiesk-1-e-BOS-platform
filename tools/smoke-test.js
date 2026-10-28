// tools/smoke-test.js — catches the bug class `node --check` CANNOT: a name
// that is used but never declared (ReferenceError). It runs a page's real
// inline <script> against a stubbed browser, then exercises init, animation
// frames, timers, and EVERY event listener the page registers.
//
// Usage (from the repo root):
//   node tools/smoke-test.js frontend/e-bos-landing.html
//   node tools/smoke-test.js frontend/e-bos-backoffice.html signed-in
//
// "signed-in" fakes an owner session + canned API responses so every
// back-office card renders. Exit code 1 = at least one ReferenceError.
//
// Why this exists: a dead Join/Create button shipped because an edit deleted
// a line range that also held shared helpers (clamp, escapeHtml, lighten,
// reducedMotion...). Syntax checks passed; this test reproduces it.
//
// What it is NOT: a browser. "Other errors" are often stub noise (e.g. a fake
// event missing dataTransfer). It proves names resolve, not that pixels look
// right or that a real click does what you want.
const SIGNED_IN = process.argv[3] === 'signed-in';
// Runs a page's inline <script> blocks against a stubbed browser, then
// exercises init, one animation frame, queued timers, and EVERY event
// listener the page registered. Reports ReferenceErrors specifically —
// the class of bug `node --check` cannot see.
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const problems = [], listeners = [], rafs = [], timers = [];
const note = (where, e) => problems.push({ where, name: e && e.name, msg: e && e.message });

function deep(label){
  const fn = function(){};
  const style = {}, cl = { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
  const nums = { width:800, height:600, clientWidth:800, clientHeight:600, offsetWidth:800, offsetHeight:600, scrollTop:0, scrollHeight:600, scrollLeft:0, length:0 };
  const p = new Proxy(fn, {
    get(t, prop){
      if (prop === Symbol.toPrimitive) return (h) => h === 'number' ? 0 : '';
      if (prop === Symbol.iterator) return function*(){};
      if (prop === 'then') return undefined;
      if (prop in nums) return nums[prop];
      if (prop === 'addEventListener') return (type, cb) => listeners.push({ label, type, cb });
      if (prop === 'getBoundingClientRect') return () => ({ left:0, top:0, right:800, bottom:600, width:800, height:600 });
      if (prop === 'classList') return cl;
      if (prop === 'style') return style;
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML' || prop === 'id') return '';
      if (prop === 'files') return [];
      if (prop === 'dataset') return {};
      if (prop === 'children' || prop === 'childNodes') return [];
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'measureText') return () => ({ width: 10 });
      return p;
    },
    set(){ return true; },
    apply(){ return p; },
  });
  return p;
}
const sandbox = {
  console: { log(){}, warn(...a){ a.forEach(x => x instanceof Error && note('console.warn', x)); }, error(...a){ a.forEach(x => x instanceof Error && note('console.error', x)); } },
  Math, JSON, Date, Array, Object, String, Number, Set, Map, Promise, Error, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent,
  setTimeout: (cb, ms) => { timers.push(cb); return timers.length; }, clearTimeout(){},
  setInterval: (cb) => { timers.push(cb); return timers.length; }, clearInterval(){},
  requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length; }, cancelAnimationFrame(){},
  performance: { now: () => 1000 },
  localStorage: { getItem: (k) => SIGNED_IN && k === 'ebos_auth' ? JSON.stringify({ token:'t', person:{ personId:'p1', holdingCompanyId:'h1', role:'owner', email:'o@x.com' } }) : null, setItem(){}, removeItem(){} },
  fetch: (url, opts) => { const u = String(url); if (!SIGNED_IN) return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [{ id:'m1', name:'Test', businessId:'b1', businessName:'Biz', category:'food', icon:'x', rating:null, sales:5, repeatCustomers:1, size:0.5, visibilityWeight:0.5, description:'d', media:{ image:null, video:null } }] }) }); const j = (b) => Promise.resolve({ ok: true, status: 200, json: async () => b });
    if (u.endsWith('/businesses')) return j([{ id:'b1', name:'Biz', holdingCompanyId:'h1' }]);
    if (u.includes('/rollup')) return j({ grandTotal:{ totalDebits:'10.00', totalCredits:'10.00' }, businesses:[] });
    if (u.includes('/allocation-rules/current')) return j({ version:1, effectiveFrom:'2026-01-01T00:00:00Z', splits:[{ personId:'p1', pct:60 },{ personId:'p2', pct:40 }] });
    if (u.endsWith('/people')) return j([{ id:'p1', name:'Owner', role:'owner', email:'o@x.com' },{ id:'p2', name:'Worker', role:'worker', email:'w@x.com' },{ id:'p3', name:'Third', role:'worker', email:'t@x.com' }]);
    if (u.includes('/conversations?')) return j([{ id:'c1', handledBy:'awaiting_human', identified:true, visitorDisplayName:'V' }]);
    if (opts && opts.method && opts.method !== 'GET') return j({});
    return j([]); },
  Image: function(){ return deep('Image'); }, URL: { createObjectURL(){ return ''; } }, FileReader: function(){ return deep('FileReader'); },
};
sandbox.window = sandbox;
sandbox.window.matchMedia = () => ({ matches: false, addEventListener(){} });
sandbox.window.addEventListener = (type, cb) => listeners.push({ label: 'window', type, cb });
sandbox.window.devicePixelRatio = 1; sandbox.window.innerWidth = 800; sandbox.window.innerHeight = 600; sandbox.window.location = { href: '' };
sandbox.document = { getElementById: (id) => deep('#' + id), querySelector: () => deep('q'), querySelectorAll: () => [], createElement: () => deep('el'), addEventListener: (type, cb) => listeners.push({ label: 'document', type, cb }), body: deep('body'), documentElement: deep('html'), hidden: false };
vm.createContext(sandbox);
process.on('unhandledRejection', e => note('unhandledRejection', e));

(async () => {
  scripts.forEach((s, i) => { try { vm.runInContext(s, sandbox, { filename: 'script' + i }); } catch (e) { note('script' + i + ' (top level)', e); } });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  [1000, 2000].forEach(ts => rafs.slice(0, 5).forEach(cb => { try { cb(ts); } catch (e) { note('animation frame', e); } }));
  timers.slice(0, 20).forEach(cb => { try { cb(); } catch (e) { note('timer', e); } });
  const ev = { preventDefault(){}, stopPropagation(){}, key: 'Enter', clientX: 10, clientY: 10, target: deep('target'), currentTarget: deep('ct'), touches: [{ clientX: 1, clientY: 1 }], pointerId: 1, deltaY: 1, isTrusted: true };
  for (const l of listeners.slice()) { try { const r = l.cb(ev); if (r && r.catch) await r.catch(e => note('listener ' + l.label + ':' + l.type, e)); } catch (e) { note('listener ' + l.label + ':' + l.type, e); } }
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const refErrs = problems.filter(p => p.name === 'ReferenceError');
  console.log('listeners exercised:', listeners.length, '| animation frames run:', Math.min(rafs.length, 5) * 2);
  console.log('ReferenceErrors:', refErrs.length);
  refErrs.forEach(p => console.log('  -', p.where, '->', p.msg));
  const other = problems.filter(p => p.name !== 'ReferenceError');
  console.log('Other errors (informational — stub-environment noise is possible):', other.length);
  other.slice(0, 8).forEach(p => console.log('  -', p.where, '->', p.name + ': ' + p.msg));
  process.exit(refErrs.length ? 1 : 0);
})();

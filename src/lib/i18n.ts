// English language mode — a DOM phrase translator, ported from the old app.
// The UI is authored in Myanmar; in English mode we rewrite visible text in
// place using the phrase dictionary (src/lib/i18nDict.ts), so pages never
// need language branches. Framework-agnostic vanilla TypeScript.
//
// Contract:
//   getLang()               → 'my' | 'en' from localStorage 'wfms-lang' (default 'my')
//   setLang(lang)           → store the preference, then applyLanguage()
//   applyLanguage()         → 'en': translate the page + observe DOM changes;
//                             'my': stop observing and restore the originals
//   startLanguageObserver() → start translating + observing (idempotent)
//   stopLanguageObserver()  → stop observing + restore original text/attrs/title
//   toEnglish(s)            → translate one string (no DOM), exported for reuse/tests
//
// Restore mechanism (ported from the old engine): every text node we rewrite
// has its original value kept in a WeakMap; on stop, nodes whose current value
// is still exactly what we set are put back. Attribute values (placeholder /
// title / aria-label) are cached the same way — the old engine did not restore
// those; this port does, so switching back to Myanmar is clean without a reload.
import { EN } from "./i18nDict";

export type Lang = "my" | "en";
export const LANGS: { value: Lang; label: string }[] = [
  { value: "my", label: "မြန်မာ" },
  { value: "en", label: "English" },
];

const STORAGE_KEY = "wfms-lang";

export function getLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "my";
  } catch {
    return "my";
  }
}

export function setLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable (private mode) — still apply for this session
  }
  applyLanguage();
}

export function applyLanguage() {
  if (typeof document === "undefined") return;
  const lang = getLang();
  document.documentElement.lang = lang;
  if (lang === "en") startLanguageObserver();
  else stopLanguageObserver();
}

// --- Phrase translation (same matching rules as the old engine) ---
const keys = Object.keys(EN).sort((a, b) => b.length - a.length);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Myanmar has no word spaces inside compounds, so a phrase only matches when it is not
// glued to other Myanmar letters (digits and ၊ ။ count as boundaries).
const L = "[\\u1000-\\u103F\\u1050-\\u109F]";
const RE = new RegExp(`(?<!${L})(?:${keys.map(esc).join("|")})(?!${L})`, "g");
const MY = /[\u1000-\u109F]/;
const DIGITS = "၀၁၂၃၄၅၆၇၈၉";

/** Translate a Myanmar string to English (phrase by phrase). */
export function toEnglish(s: string): string {
  if (!MY.test(s)) return s;
  let out = s.replace(RE, (m) => EN[m] ?? m);
  out = out.replace(/[၀-၉]/g, (d) => String(DIGITS.indexOf(d)));
  out = out.replace(/[၊]/g, ",").replace(/။/g, ".");
  return out.replace(/ {2,}/g, " ");
}

// --- DOM translator ---
const orig = new WeakMap<Node, string>();
const shown = new WeakMap<Node, string>();
const origAttr = new WeakMap<Element, Map<string, string>>();
const shownAttr = new WeakMap<Element, Map<string, string>>();
const ATTRS = ["placeholder", "title", "aria-label"];
let observer: MutationObserver | null = null;
let origTitle: string | null = null;
let shownTitle: string | null = null;

function doText(n: Text) {
  const v = n.nodeValue ?? "";
  if (shown.get(n) === v) return; // our own write — do not loop
  if (!MY.test(v)) return;
  orig.set(n, v);
  const t = toEnglish(v);
  shown.set(n, t);
  if (t !== v) n.nodeValue = t;
}

function doEl(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    if (shownAttr.get(el)?.get(a) === v) continue; // our own write
    if (!MY.test(v)) continue;
    let o = origAttr.get(el);
    if (!o) { o = new Map(); origAttr.set(el, o); }
    o.set(a, v);
    const t = toEnglish(v);
    let s = shownAttr.get(el);
    if (!s) { s = new Map(); shownAttr.set(el, s); }
    s.set(a, t);
    if (t !== v) el.setAttribute(a, t);
  }
}

function doTitle() {
  const t = document.title;
  if (t === shownTitle) return;
  if (!MY.test(t)) return;
  origTitle = t;
  const e = toEnglish(t);
  shownTitle = e;
  if (e !== t) document.title = e;
}

function walk(root: Node) {
  if (root.nodeType === 3) return doText(root as Text);
  if (root.nodeType !== 1) return;
  const el = root as Element;
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
  if (el.closest("[data-no-translate]")) return;
  doEl(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) {
      const p = (n as Text).parentElement;
      if (p && (p.tagName === "SCRIPT" || p.tagName === "STYLE" || p.closest("[data-no-translate]"))) continue;
      doText(n as Text);
    } else doEl(n as Element);
  }
}

export function startLanguageObserver() {
  if (observer || typeof document === "undefined") return;
  if (document.body) walk(document.body);
  doTitle();
  observer = new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") doText(m.target as Text);
      else if (m.type === "attributes") doEl(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
    doTitle();
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
}

export function stopLanguageObserver() {
  observer?.disconnect();
  observer = null;
  if (typeof document === "undefined" || !document.body) return;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) {
      const o = orig.get(n);
      if (o !== undefined && shown.get(n) === n.nodeValue) { n.nodeValue = o; shown.delete(n); }
    } else {
      const el = n as Element;
      const o = origAttr.get(el);
      const s = shownAttr.get(el);
      if (o && s) {
        for (const [a, ov] of o) {
          if (s.get(a) === el.getAttribute(a)) { el.setAttribute(a, ov); s.delete(a); }
        }
      }
    }
  }
  if (origTitle !== null && document.title === shownTitle) document.title = origTitle;
  origTitle = null;
  shownTitle = null;
}

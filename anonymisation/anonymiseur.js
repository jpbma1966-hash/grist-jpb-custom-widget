/* Widget Grist : anonymisation / désanonymisation de docx, md (+mermaid), html, js, txt.
   Accès requis : "Accès complet au document". */
'use strict';

const SCHEMA = {
  Anon_Mapping: [
    ['type', 'Text'], ['valeur_reelle', 'Text'], ['pseudo', 'Text'], ['dossier', 'Text'],
  ],
  Anon_Regles: [
    ['type', 'Text'], ['motif', 'Text'], ['est_regex', 'Bool'], ['actif', 'Bool'],
  ],
  Anon_Journal: [
    ['date', 'Text'], ['fichier', 'Text'], ['sens', 'Text'], ['nb_remplacements', 'Int'],
  ],
};

const DEFAULT_RULES = [
  ['EMAIL', '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', true, true],
  ['IP', '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b', true, true],
  ['TEL', '(?:\\+33|0)\\s?[1-9](?:[\\s.-]?\\d{2}){4}', true, true],
];

const $ = (id) => document.getElementById(id);
let mapping = [];   // {id, type, real, pseudo, dossier}
let rules = [];     // {type, motif, est_regex, actif}
let newRows = [];   // lignes à ajouter dans Anon_Mapping
let dirtyPseudos = []; // lignes existantes dont le pseudo vient d'être généré
let stats = { count: 0 };

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}

/* ---------- Tables ---------- */

async function ensureTables() {
  const meta = await grist.docApi.fetchTable('_grist_Tables');
  const existing = new Map(); // tableId -> rowId
  meta.tableId.forEach((t, i) => existing.set(t, meta.id[i]));
  const cols = await grist.docApi.fetchTable('_grist_Tables_column');
  const actions = [];
  let rulesCreated = false;

  for (const [table, defs] of Object.entries(SCHEMA)) {
    if (!existing.has(table)) {
      actions.push(['AddTable', table, defs.map(([id, type]) => ({ id, type }))]);
      log(`Table créée : ${table}`, 'ok');
      if (table === 'Anon_Regles') rulesCreated = true;
    } else {
      const rowId = existing.get(table);
      const have = new Set();
      cols.parentId.forEach((p, i) => { if (p === rowId) have.add(cols.colId[i]); });
      for (const [id, type] of defs) {
        if (!have.has(id)) {
          actions.push(['AddColumn', table, id, { type }]);
          log(`Colonne ajoutée : ${table}.${id}`, 'ok');
        }
      }
    }
  }
  if (actions.length) await grist.docApi.applyUserActions(actions);

  if (rulesCreated) {
    await grist.docApi.applyUserActions([[
      'BulkAddRecord', 'Anon_Regles', DEFAULT_RULES.map(() => null), {
        type: DEFAULT_RULES.map((r) => r[0]),
        motif: DEFAULT_RULES.map((r) => r[1]),
        est_regex: DEFAULT_RULES.map((r) => r[2]),
        actif: DEFAULT_RULES.map((r) => r[3]),
      },
    ]]);
    log('Règles par défaut ajoutées (email, IP, téléphone).', 'ok');
  }
}

async function loadData() {
  const m = await grist.docApi.fetchTable('Anon_Mapping');
  mapping = m.id.map((id, i) => ({
    id, type: (m.type[i] || 'DONNEE').trim().toUpperCase(),
    real: m.valeur_reelle[i] || '', pseudo: m.pseudo[i] || '', dossier: m.dossier[i] || '',
  }));
  const r = await grist.docApi.fetchTable('Anon_Regles');
  rules = r.id.map((id, i) => ({
    type: (r.type[i] || 'DONNEE').trim().toUpperCase(),
    motif: r.motif[i] || '', est_regex: !!r.est_regex[i], actif: !!r.actif[i],
  })).filter((x) => x.actif && x.motif);
  newRows = []; dirtyPseudos = [];
  log(`Chargé : ${mapping.length} correspondance(s), ${rules.length} règle(s) active(s).`);
}

function currentDossier() { return $('dossier').value.trim(); }

function scopedMapping() {
  const d = currentDossier();
  return mapping.filter((e) => !d || !e.dossier || e.dossier === d);
}

function nextPseudo(type) {
  let max = 0;
  const re = new RegExp('^' + type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d+)$');
  for (const e of mapping) { const x = re.exec(e.pseudo); if (x) max = Math.max(max, +x[1]); }
  return `${type}_${String(max + 1).padStart(3, '0')}`;
}

function fillMissingPseudos() {
  for (const e of mapping) {
    if (e.real && !e.pseudo) { e.pseudo = nextPseudo(e.type); dirtyPseudos.push(e); }
  }
}

function getPseudo(type, value) {
  const d = currentDossier();
  let e = mapping.find((x) => x.type === type && x.real === value && (!d || !x.dossier || x.dossier === d));
  if (!e) {
    e = { id: null, type, real: value, pseudo: nextPseudo(type), dossier: d };
    mapping.push(e);
    newRows.push(e);
  }
  return e.pseudo;
}

async function flush() {
  const actions = dirtyPseudos.filter((e) => e.id).map((e) => ['UpdateRecord', 'Anon_Mapping', e.id, { pseudo: e.pseudo }]);
  if (newRows.length) {
    actions.push(['BulkAddRecord', 'Anon_Mapping', newRows.map(() => null), {
      type: newRows.map((e) => e.type), valeur_reelle: newRows.map((e) => e.real),
      pseudo: newRows.map((e) => e.pseudo), dossier: newRows.map((e) => e.dossier),
    }]);
  }
  if (actions.length) await grist.docApi.applyUserActions(actions);
}

/* ---------- Cœur : recherche des correspondances dans un texte ---------- */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B1 = '(?<![\\p{L}\\p{N}_])', B2 = '(?![\\p{L}\\p{N}_])';

function boundedRegex(value) {
  const w = /[\p{L}\p{N}_]/u;
  const pre = w.test(value[0]) ? B1 : '';
  const post = w.test(value[value.length - 1]) ? B2 : '';
  return new RegExp(pre + esc(value) + post, 'gu');
}

let patterns = []; // préparés une fois par traitement

function preparePatterns(mode) {
  patterns = [];
  const maps = scopedMapping().filter((e) => e.real && e.pseudo)
    .sort((a, b) => (mode === 'anon' ? b.real.length - a.real.length : b.pseudo.length - a.pseudo.length));
  for (const e of maps) {
    patterns.push(mode === 'anon'
      ? { re: boundedRegex(e.real), fixed: e.pseudo }
      : { re: boundedRegex(e.pseudo), fixed: e.real });
  }
  if (mode === 'anon') {
    for (const r of rules) {
      try {
        patterns.push({ re: new RegExp(r.est_regex ? r.motif : esc(r.motif), 'gu'), type: r.type });
      } catch (err) { log(`Règle ignorée (${r.type}) : ${err.message}`, 'err'); }
    }
  }
}

function computeMatches(text) {
  const c = [];
  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      if (!m[0]) continue;
      c.push({ s: m.index, e: m.index + m[0].length, p, v: m[0] });
    }
  }
  c.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const out = []; let last = 0;
  for (const m of c) {
    if (m.s < last) continue;
    m.r = m.p.fixed !== undefined ? m.p.fixed : getPseudo(m.p.type, m.v);
    out.push(m); last = m.e;
  }
  stats.count += out.length;
  return out;
}

function applyMatches(text, ms) {
  let out = '', pos = 0;
  for (const m of ms) { out += text.slice(pos, m.s) + m.r; pos = m.e; }
  return out + text.slice(pos);
}

const plain = (t) => applyMatches(t, computeMatches(t));

/* ---------- Formats ---------- */

function doSegments(text, re) { return text.replace(re, (seg) => plain(seg)); }

const RE_JS = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const RE_MERMAID = /"[^"\n]*"|\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|\|[^|\n]*\||:[^\n]*/g;

function doMarkdown(text) {
  return text.split(/(```mermaid[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? doSegments(part, RE_MERMAID) : plain(part))).join('');
}

function doHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const p = walker.currentNode.parentNode.nodeName;
    if (p !== 'SCRIPT' && p !== 'STYLE') nodes.push(walker.currentNode);
  }
  nodes.forEach((n) => { n.nodeValue = plain(n.nodeValue); });
  doc.querySelectorAll('[alt],[title],[placeholder],[value],[aria-label]').forEach((el) => {
    ['alt', 'title', 'placeholder', 'value', 'aria-label'].forEach((a) => {
      if (el.hasAttribute(a)) el.setAttribute(a, plain(el.getAttribute(a)));
    });
  });
  const dt = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>\n' : '';
  return dt + doc.documentElement.outerHTML;
}

function xmlParagraphs(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return xml;
  for (const p of Array.from(doc.getElementsByTagName('w:p'))) {
    const nodes = Array.from(p.getElementsByTagName('w:t'));
    if (!nodes.length) continue;
    const texts = nodes.map((n) => n.textContent);
    const full = texts.join('');
    const ms = computeMatches(full);
    if (!ms.length) continue;
    let a = 0;
    nodes.forEach((n, i) => {
      const b = a + texts[i].length;
      let out = '', pos = a;
      for (const m of ms) {
        if (m.e <= a || m.s >= b) continue;
        if (m.s >= a) out += full.slice(pos, m.s) + m.r;
        pos = Math.min(m.e, b);
      }
      out += full.slice(pos, b);
      n.textContent = out;
      n.setAttribute('xml:space', 'preserve');
      a = b;
    });
  }
  return new XMLSerializer().serializeToString(doc);
}

async function doDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const re = /^word\/(document|header\d*|footer\d*|comments|footnotes|endnotes)\.xml$/;
  for (const name of Object.keys(zip.files).filter((n) => re.test(n))) {
    zip.file(name, xmlParagraphs(await zip.file(name).async('string')));
  }
  return zip.generateAsync({
    type: 'blob', compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/* ---------- Traitement ---------- */

async function run() {
  const f = $('file').files[0];
  if (!f) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  $('run').disabled = true; $('dl').textContent = '';
  try {
    await loadData();
    fillMissingPseudos();
    preparePatterns(mode);
    stats.count = 0;
    let blob;
    if (ext === 'docx') {
      blob = await doDocx(await f.arrayBuffer());
    } else {
      const text = await f.text();
      let res;
      if (ext === 'md' || ext === 'markdown') res = doMarkdown(text);
      else if (ext === 'html' || ext === 'htm') res = doHtml(text);
      else if (ext === 'js') res = doSegments(text, RE_JS);
      else res = plain(text);
      blob = new Blob([res], { type: 'text/plain;charset=utf-8' });
    }
    if (mode === 'anon') await flush();
    const base = f.name.replace(/\.[^.]+$/, '');
    const outName = `${base}.${mode === 'anon' ? 'anon' : 'deanon'}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = outName; a.textContent = `Télécharger ${outName}`;
    $('dl').appendChild(a);
    await grist.docApi.applyUserActions([['AddRecord', 'Anon_Journal', null, {
      date: new Date().toISOString(), fichier: f.name,
      sens: mode === 'anon' ? 'anonymisation' : 'désanonymisation', nb_remplacements: stats.count,
    }]]);
    log(`${stats.count} remplacement(s) effectué(s).`, 'ok');
  } catch (err) {
    log('Erreur : ' + (err && err.message ? err.message : err), 'err');
    console.error(err);
  } finally {
    $('run').disabled = !$('file').files.length;
  }
}

/* ---------- Démarrage ---------- */

grist.ready({ requiredAccess: 'full' });

(async () => {
  try {
    $('log').textContent = '';
    await ensureTables();
    await loadData();
    log('Prêt.', 'ok');
  } catch (err) {
    log('Initialisation impossible : ' + (err && err.message ? err.message : err)
      + ' (vérifie l\'accès complet au document).', 'err');
  }
})();

$('file').addEventListener('change', () => { $('run').disabled = !$('file').files.length; $('dl').textContent = ''; });
$('run').addEventListener('click', run);
$('reload').addEventListener('click', async () => {
  try { await ensureTables(); await loadData(); } catch (e) { log('Erreur : ' + e.message, 'err'); }
});

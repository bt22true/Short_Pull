#!/usr/bin/env node
// Inject data/classified.json into the board template → dist/board.html
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync('data/classified.json', 'utf8'));

// Keep the single-file board phone-friendly: trim long narrative fields and
// drop null/empty baggage. Full detail remains in data/classified.json.
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
for (const c of data.lics) {
  c.description = clip(c.description, 110);
  c.synopsis = clip(c.synopsis, 900);
  c.evidence = c.evidence.slice(0, 6).map((e) => clip(e, 220));
  c.incidents = c.incidents.slice(-10).map((i) => ({ ...i,
    context: undefined,
    shipment: { ...i.shipment, title: undefined } }));
  c.adjustments = c.adjustments.slice(0, 6).map((a) => ({ ...a, note: clip(a.note, 110) }));
  c.inventory.bins = c.inventory.bins.slice(0, 8);
  c.supply.recent = c.supply.recent.slice(0, 5);
  for (const k of Object.keys(c)) if (c[k] === null) delete c[k];
}
const tpl = readFileSync(join(here, 'lib', 'template.html'), 'utf8');
// JSON inside a <script> block: escape anything that could break out of it.
// FileMaker data carries encoding damage (lone surrogates, U+FFFD) that
// breaks strict deploy validation — normalize it away first.
const payload = JSON.stringify(data)
  .toWellFormed()
  .replace(new RegExp('\\uFFFD', 'g'), '')
  .replace(/</g, '\\u003c')
  .replace(new RegExp('\\u2028', 'g'), '\\\\u2028')
  .replace(new RegExp('\\u2029', 'g'), '\\\\u2029');
const html = tpl.replace('/*__DATA__*/null', payload);
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });
writeFileSync('dist/board.html', html);
console.log(`dist/board.html — ${data.totals.lics} LICs, run ${data.run_id}, ${(html.length / 1024).toFixed(0)} KB`);

#!/usr/bin/env node
// Build the board outputs from data/classified.json:
//   dist/board-data.json — the slimmed payload the live site fetches from
//     /api/board (a daily refresh is ONE PUT of this file — no redeploy)
//   dist/board.html      — self-contained preview with the data inlined
//     (artifact / local file:// use; NOT what gets deployed)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync('data/classified.json', 'utf8'));

// Keep the single-file board phone-friendly: trim long narrative fields and
// drop null/empty baggage. Full detail remains in data/classified.json.
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
for (const c of data.lics) {
  c.description = clip(c.description, 110);
  c.synopsis = clip(c.synopsis, 900);
  c.recommended = clip(c.recommended, 300);
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
writeFileSync('dist/board-data.json', payload);

// A single bad escape in the template kills the whole inline script and the
// board renders blank — syntax-check the built script before shipping it.
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const tmp = 'dist/.board-script-check.js';
writeFileSync(tmp, js);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('BOARD SCRIPT SYNTAX ERROR — not writing dist/board.html');
  console.error(String(e.stderr));
  process.exit(1);
} finally {
  rmSync(tmp, { force: true });
}

writeFileSync('dist/board.html', html);
console.log(`dist/board-data.json — ${data.totals.lics} LICs, run ${data.run_id}, ${(payload.length / 1024).toFixed(0)} KB (PUT this to /api/board)`);
console.log(`dist/board.html — inlined preview, ${(html.length / 1024).toFixed(0)} KB`);

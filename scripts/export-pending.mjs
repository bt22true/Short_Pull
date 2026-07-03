#!/usr/bin/env node
// Rebuild the board's decisions store from state, keeping only still-pending
// work. Run in the daily cycle AFTER merge-actions + verify-actions:
//   GET /api/decisions → merge-actions → verify-actions → this → PUT the output
// Verified and resolved items are omitted — that's how completed work drops
// off the "Do the work" list. Writes dist/pending-decisions.json.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadJSON } from './lib/util.mjs';

const state = loadJSON('state/audit-state.json', { lics: {} });
const classified = loadJSON('data/classified.json', null);
const runId = classified?.run_id || new Date().toISOString().slice(0, 10);

const decisions = [];
const completed = {};
for (const [licId, s] of Object.entries(state.lics || {})) {
  if (s.status !== 'action_pending' || !s.actions) continue;
  const pending = (s.actions.items || []).filter((i) => !i.verified);
  if (!pending.length) continue;
  decisions.push({ lic_rec_id: licId, li_code: s.li_code, action: 'plan',
    items: pending.map(({ verified, done, ...i }) => i) });
  const done = pending.filter((i) => i.done).map((i) => i.label);
  if (done.length) completed[licId] = done;
}

const payload = { run_id: runId, exported_at: new Date().toISOString(), decisions, completed };
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });
writeFileSync('dist/pending-decisions.json', JSON.stringify(payload));
console.log(`dist/pending-decisions.json — ${decisions.length} pending decision(s) to PUT back to /api/decisions`);

#!/usr/bin/env node
// Apply a board action-plan export to state/audit-state.json and print the
// physical work queue. Usage: node scripts/merge-actions.mjs <action-plan.json>
// Idempotent per LIC: a later decision for the same LIC replaces the earlier one.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadJSON } from './lib/util.mjs';

const planPath = process.argv[2];
if (!planPath) { console.error('usage: merge-actions.mjs <action-plan.json>'); process.exit(1); }
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const statePath = 'state/audit-state.json';
const state = loadJSON(statePath, { schema_version: 1, lics: {} });
const classified = loadJSON('data/classified.json', null);
const byId = new Map((classified?.lics || []).map((c) => [c.id, c]));

if (classified && plan.run_id !== classified.run_id)
  console.error(`WARNING: plan run_id ${plan.run_id} != current data run_id ${classified.run_id} — data may have moved; re-check decided LICs before executing.`);

const today = new Date().toISOString().slice(0, 10);
const queue = { relook: [], count: [], reverse_adjustment: [], verify_receiving: [], track_order: [], other: [], resolved: [], snoozed: [], skipped: [] };
const doneLabels = plan.completed || {};

for (const d of plan.decisions || []) {
  const c = byId.get(d.lic_rec_id);
  if (!c) { console.error(`WARNING: unknown lic_rec_id ${d.lic_rec_id} — skipped`); continue; }
  const s = state.lics[d.lic_rec_id] || { li_code: c.li_code, history: [] };
  s.li_code = c.li_code;
  s.fingerprint = c.fingerprint;
  s.last_bucket = c.bucket;
  // Triaging a LIC acknowledges every incident currently on its card —
  // daily runs only resurface it when NEW incidents appear.
  s.incidents_seen = [...new Set([...(s.incidents_seen || []), ...c.incidents.map((i) => i.rec_id)])];
  const ev = { at: today, run: plan.run_id, event: d.action, note: d.note || undefined };

  switch (d.action) {
    case 'plan': {
      const done = new Set(doneLabels[d.lic_rec_id] || []);
      s.status = 'action_pending';
      s.actions = {
        issued_run: plan.run_id, issued_at: today,
        items: (d.items || []).map((i) => ({ ...i, verified: false, done: done.has(i.label) || undefined })),
      };
      for (const i of d.items || []) {
        const bucket = queue[i.kind] ? i.kind : 'other';
        queue[bucket].push({ li_code: c.li_code, rec_id: c.id, label: i.label,
          done: done.has(i.label) || undefined, note: d.note || undefined, evidence: c.evidence[0] });
      }
      break;
    }
    case 'resolve':
      s.status = 'resolved';
      queue.resolved.push({ li_code: c.li_code, note: d.note || '' });
      break;
    case 'snooze':
      s.status = 'snoozed'; s.snooze_until = d.snooze_until; ev.until = d.snooze_until;
      queue.snoozed.push({ li_code: c.li_code, until: d.snooze_until });
      break;
    default:
      s.status = 'skipped';
      queue.skipped.push({ li_code: c.li_code });
  }
  s.history = [...(s.history || []), ev];
  state.lics[d.lic_rec_id] = s;
}

state.last_merged_plan = { run_id: plan.run_id, at: new Date().toISOString(), decisions: (plan.decisions || []).length };
writeFileSync(statePath, JSON.stringify(state, null, 2));
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });
const qPath = `dist/work-queue-${plan.run_id}.json`;
writeFileSync(qPath, JSON.stringify(queue, null, 2));
console.log(`merged ${(plan.decisions || []).length} decisions into ${statePath}`);
for (const [k, v] of Object.entries(queue)) if (v.length) console.log(`  ${k.padEnd(20)} ${v.length}`);
console.log(`work queue: ${qPath}`);
console.log('Items checked off on the board arrive in `completed` — skip re-listing those.');
console.log('aAce work (counts, adjustment reversals, re-ships) auto-verifies on the next run.');

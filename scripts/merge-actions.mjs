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
const queue = { fix_stuck_transfer: [], relook: [], count: [], reverse_adjustment: [], verify_receiving: [], track_order: [], reorder_review: [], other: [], resolved: [], snoozed: [], skipped: [] };
const doneLabels = plan.completed || {};

for (const d of plan.decisions || []) {
  const c = byId.get(d.lic_rec_id) || null;
  // A decision can outlive its board card (LIC aged out of the window between
  // triage and merge). The stored decision carries everything needed — merge
  // it into state anyway so nothing is lost; verify-actions handles the rest.
  if (!c) console.error(`note: ${d.lic_rec_id} (${d.li_code || '?'}) not on the current board — merged from the stored decision`);
  const s = state.lics[d.lic_rec_id] || { li_code: c?.li_code || d.li_code || d.lic_rec_id, history: [] };
  if (c) {
    s.li_code = c.li_code;
    s.fingerprint = c.fingerprint;
    s.last_bucket = c.bucket;
    // Triaging a LIC acknowledges every incident currently on its card —
    // daily runs only resurface it when NEW incidents appear.
    s.incidents_seen = [...new Set([...(s.incidents_seen || []), ...c.incidents.map((i) => i.rec_id)])];
  }
  const ev = { at: today, run: plan.run_id, event: d.action, note: d.note || undefined };

  switch (d.action) {
    case 'plan': {
      const done = new Set(doneLabels[d.lic_rec_id] || []);
      // Preserve the ORIGINAL issue stamp (and per-item verified flags) when a
      // still-pending decision is re-merged unchanged on a later daily run. The
      // verification loop measures aAce activity AFTER the issue date, so
      // re-stamping issued_at=today every morning would move the window past any
      // count/re-ship Brett did since — nothing would ever auto-verify. Only a
      // new LIC or a changed item set (re-triage) resets the clock.
      const prior = (s.status === 'action_pending' && s.actions) ? s.actions : null;
      const priorLabels = prior ? prior.items.map((i) => i.label).sort() : null;
      const newLabels = (d.items || []).map((i) => i.label).sort();
      const unchanged = prior
        && priorLabels.length === newLabels.length
        && priorLabels.every((l, idx) => l === newLabels[idx]);
      const priorVerified = new Map((prior?.items || []).map((i) => [i.label, i.verified]));
      s.status = 'action_pending';
      s.actions = {
        issued_run: unchanged ? prior.issued_run : plan.run_id,
        issued_at: unchanged ? prior.issued_at : today,
        items: (d.items || []).map((i) => ({ ...i,
          verified: (unchanged && priorVerified.get(i.label)) || false,
          done: done.has(i.label) || undefined })),
      };
      for (const i of d.items || []) {
        const bucket = queue[i.kind] ? i.kind : 'other';
        queue[bucket].push({ li_code: s.li_code, rec_id: d.lic_rec_id, label: i.label,
          done: done.has(i.label) || undefined, note: d.note || undefined, evidence: c?.evidence[0] });
      }
      break;
    }
    case 'resolve':
      s.status = 'resolved';
      queue.resolved.push({ li_code: s.li_code, note: d.note || '' });
      break;
    case 'snooze':
      s.status = 'snoozed'; s.snooze_until = d.snooze_until; ev.until = d.snooze_until;
      queue.snoozed.push({ li_code: s.li_code, until: d.snooze_until });
      break;
    default:
      s.status = 'skipped';
      queue.skipped.push({ li_code: s.li_code });
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

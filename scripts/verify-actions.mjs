#!/usr/bin/env node
// Compare action_pending expectations in state against a FRESH pull
// (data/classified.json must be rebuilt first). Auto-verifies satisfied
// expectations, quiet-resolves stale ones, wakes changed snoozes.
// Run AFTER classify.mjs, BEFORE build-board.mjs.
import { writeFileSync } from 'node:fs';
import { loadJSON, daysBetween, parseDate } from './lib/util.mjs';
import { CONFIG } from './classify.mjs';

const state = loadJSON('state/audit-state.json', { lics: {} });
const classified = loadJSON('data/classified.json');
const byId = new Map(classified.lics.map((c) => [c.id, c]));
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const report = { verified: [], still_pending: [], quiet_resolved: [], woken: [], new_incidents: [] };

function predicateHolds(item, c, issuedAt) {
  const exp = item.expected_after || {};
  if (exp.manual) return false; // verified only by checking it off on the board
  if (!c) return false;
  const after = (d) => d && parseDate(d) && parseDate(d) > issuedAt;
  if (exp.new_adjustment_after) return after(c.last_adjustment_at);
  if (exp.activity_after) return after(c.last_adjustment_at) || after(c.movement.last_shipped_at);
  if (exp.order_item_shipped) return c.movement.order_items_shipped.includes(exp.order_item_shipped);
  return false;
}

for (const [licId, s] of Object.entries(state.lics || {})) {
  const c = byId.get(licId);
  const newIncident = c && c.new_incidents.length > 0;
  if (newIncident && ['resolved', 'skipped', 'snoozed'].includes(s.status)) {
    report.new_incidents.push(s.li_code); // classify already resurfaces these on the board
  }
  if (s.status === 'action_pending' && s.actions) {
    const issuedAt = parseDate(s.actions.issued_at) || new Date(0);
    let all = true;
    for (const item of s.actions.items) {
      if (!item.verified && (item.done || predicateHolds(item, c, issuedAt))) item.verified = true;
      if (!item.verified) all = false;
    }
    if (all) {
      s.status = 'resolved';
      s.history = [...(s.history || []), { at: todayStr, event: 'actions_verified' }];
      report.verified.push(s.li_code);
    } else if (daysBetween(issuedAt, today) > CONFIG.QUIET_RESOLVE_DAYS
        && !(c && c.new_incidents.length)) {
      // No new short pulls since the action was issued for a long time —
      // whatever happened, the bleeding stopped. Close it out, note it.
      s.status = 'resolved';
      s.history = [...(s.history || []), { at: todayStr, event: 'quiet_resolved' }];
      report.quiet_resolved.push(s.li_code);
    } else report.still_pending.push(s.li_code);
  }
  if (s.status === 'snoozed' && c && s.fingerprint && c.fingerprint !== s.fingerprint) {
    report.woken.push(s.li_code); // surfaced via the changed flag on the board
  }
}

writeFileSync('state/audit-state.json', JSON.stringify(state, null, 2));
console.log(JSON.stringify(report, null, 2));

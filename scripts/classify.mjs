#!/usr/bin/env node
// Short-pull audit — per-LIC hypothesis engine.
// Reads data/*.json (live pull), data/synopsis.json (Claude's research, optional),
// state/audit-state.json. Writes data/classified.json + data/research_targets.json
// and prints a run summary.
import { writeFileSync } from 'node:fs';
import { loadJSON, num, money, daysBetween, parseDate, sha1, groupBy } from './lib/util.mjs';

export const CONFIG = {
  BOARD_WINDOW_DAYS: 14,     // incidents newer than this put a LIC on the board
  ADJ_SUSPECT_DAYS: 45,      // manual +adjustment within N days before a short pull → suspect
  RECEIPT_SUSPECT_DAYS: 30,  // PO receipt within N days before a "couldn't find" → suspect
  REPEAT_THRESHOLD: 3,       // short pulls in 180d that flag a repeat offender
  HIGH_VALUE: 100,           // unit cost that flags high_value
  QUIET_RESOLVE_DAYS: 45,    // pending actions auto-resolve after this much silence (verify-actions.mjs)
};

// ---- note parsing --------------------------------------------------------
// aAce appends one line per short-pull event: "SHORT PULL: <reason>".
// Repeated lines = the picker tried (and failed) more than once.
// Other lines: "Bike Tag: X152834" and free-text context.
export function parseNotes(notes) {
  const out = { reasons: {}, attempts: 0, bike_tag: null, context: [] };
  for (const raw of String(notes || '').split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = /^SHORT PULL:\s*(.*)$/i.exec(line);
    if (sp) {
      out.attempts++;
      const r = sp[1].trim();
      const key = /couldn.?t find/i.test(r) ? 'couldnt_find'
        : /not enough/i.test(r) ? 'not_enough'
        : /manual/i.test(r) ? 'manual'
        : r === '' ? 'unspecified' : 'other';
      out.reasons[key] = (out.reasons[key] || 0) + 1;
      if (key === 'other') out.context.push(r);
      continue;
    }
    const bt = /^Bike Tag:\s*(\S+)/i.exec(line);
    if (bt) { out.bike_tag = bt[1]; continue; }
    out.context.push(line);
  }
  if (out.attempts === 0) { out.reasons.unspecified = 1; out.attempts = 1; }
  return out;
}

const REASON_LABEL = {
  couldnt_find: "couldn't find", not_enough: 'not enough on hand',
  manual: 'manual/no barcode', other: 'other', unspecified: 'unspecified',
};
const shippedOK = (m) => !m.is_short_pull
  && ['SHIPPED', 'RECEIVED'].includes(m.shipment_item_rec_status)
  && num(m.shipment_item_quantity) > 0;

// ---- per-LIC classification ----------------------------------------------
export function classifyLIC(licId, ctx) {
  const { incidentsByLic, licById, binsByLic, adjByLic, poByLic, movByLic,
          synopsis, state, today } = ctx;
  const lic = licById.get(licId) || {};
  const raw = (incidentsByLic.get(licId) || [])
    .slice().sort((a, b) => new Date(a.incident_at) - new Date(b.incident_at));
  const movements = movByLic.get(licId) || [];
  const okShips = movements.filter(shippedOK);
  const shippedOrderItems = new Map(); // order_item_rec_id -> latest ship date
  for (const m of okShips) if (m.order_item_rec_id) {
    const prev = shippedOrderItems.get(m.order_item_rec_id);
    if (!prev || new Date(m.created_at) > new Date(prev)) shippedOrderItems.set(m.order_item_rec_id, m.created_at);
  }

  const incidents = raw.map((i) => {
    const n = parseNotes(i.shipment_item_notes);
    const shipAfter = i.order_item_rec_id && shippedOrderItems.get(i.order_item_rec_id);
    return {
      rec_id: i.shipment_item_rec_id,
      at: i.incident_at,
      reasons: n.reasons, attempts: n.attempts, context: n.context.slice(0, 3),
      bike_tag: i.bike_tag || n.bike_tag,
      qty: num(i.order_item_quantity) || num(i.shipment_item_quantity) || 1,
      item_status: i.shipment_item_rec_status,
      shipment: { id: i.shipment_id, type: i.shipment_rec_type, tnw_type: i.tnw_shipment_type,
        status: i.shipment_rec_status, title: i.shipment_title },
      order: i.order_rec_id ? { id: i.order_id, status: i.order_rec_status,
        item_rec_id: i.order_item_rec_id, item_status: i.order_item_rec_status } : null,
      office: i.office_abbr || i.office_rec_id,
      office_rec_id: i.office_rec_id,
      bin: i.office_bin_name ? `${i.office_bin_abbr || ''} ${i.office_bin_name}`.trim() : null,
      resolved_by_ship: !!(shipAfter && new Date(shipAfter) > new Date(i.incident_at)),
      shipped_at: shipAfter || null,
    };
  });

  const lastAt = parseDate(incidents.at(-1)?.at);
  const boardIncidents = incidents.filter((i) => daysBetween(parseDate(i.at), today) <= CONFIG.BOARD_WINDOW_DAYS);
  const reasons = {};
  for (const i of incidents) for (const [k, v] of Object.entries(i.reasons)) reasons[k] = (reasons[k] || 0) + v;

  // ---- inventory picture
  const bins = (binsByLic.get(licId) || []).map((b) => ({
    office: b.office_abbr || b.office_rec_id, office_rec_id: b.office_rec_id,
    bin: b.office_bin_name ? `${b.office_bin_abbr || ''} ${b.office_bin_name}`.trim() : (b.office_bin_rec_id || '?'),
    qty: num(b.quantity), available: num(b.available_quantity), demand: num(b.demand_quantity),
    is_transit: !!b.is_transit, is_clearing: !!b.is_clearing,
    updated: b.balance_updated,
  })).filter((b) => b.qty !== 0 || b.available !== 0 || b.demand !== 0);
  const onHand = bins.reduce((s, b) => s + b.qty, 0);
  const incidentOffices = [...new Set(incidents.map((i) => i.office_rec_id).filter(Boolean))];
  const onHandAtIncidentOffices = bins.filter((b) => incidentOffices.includes(b.office_rec_id))
    .reduce((s, b) => s + b.qty, 0);

  // ---- adjustments (already sorted desc by date in the pull)
  const adjustments = (adjByLic.get(licId) || []).map((a) => ({
    at: a.inventory_adj_date, type: a.inventory_adj_type, rec_type: a.inventory_adj_rec_type,
    status: a.inventory_adj_rec_status, title: a.adj_title, entered_by: a.entered_by,
    qty: num(a.quantity), count: num(a.quantity_count), balance_before: num(a.quantity_balance),
    note: a.item_notes || a.adj_notes || null, office_rec_id: a.office_rec_id,
    is_count: /count/i.test(`${a.inventory_adj_type} ${a.inventory_adj_rec_type}`),
  })).sort((a, b) => new Date(b.at) - new Date(a.at));
  const lastAdjustmentAt = adjustments[0]?.at || null;
  const suspectAdj = lastAt && adjustments.find((a) => {
    const d = parseDate(a.at);
    return d && a.qty > 0 && !a.is_count && !/beg balance/i.test(a.rec_type || '')
      && d <= lastAt && daysBetween(d, lastAt) <= CONFIG.ADJ_SUSPECT_DAYS;
  });

  // ---- supply
  const poLines = (poByLic.get(licId) || []);
  const openSupply = poLines.filter((l) => num(l.quantity_remaining) > 0
    && ['OPEN', 'PENDING'].includes(l.purchase_order_rec_status));
  const suspectReceipt = lastAt && poLines.find((l) => {
    const d = parseDate(l.line_updated);
    return d && num(l.received_quantity) > 0 && d <= lastAt
      && daysBetween(d, lastAt) <= CONFIG.RECEIPT_SUSPECT_DAYS;
  });

  // ---- movement after
  const shipsAfterLast = lastAt ? okShips.filter((m) => parseDate(m.created_at) > lastAt) : [];
  const lastShippedAt = okShips.length
    ? okShips.map((m) => m.created_at).sort().at(-1) : null;
  const shortHistory180 = movements.filter((m) => m.is_short_pull).length;

  // ---- waiting demand
  const waitingOrders = incidents.filter((i) => i.order && !i.resolved_by_ship
    && !['CLOSED', 'VOID'].includes(i.order.item_status || '')
    && !['CLOSED', 'VOID'].includes(i.order.status || ''));
  const orderIncidents = incidents.filter((i) => i.order);
  const allResolvedByShip = orderIncidents.length > 0
    && orderIncidents.every((i) => i.resolved_by_ship)
    && orderIncidents.length === incidents.length;

  // ---- bucket + evidence
  const cf = reasons.couldnt_find || 0, ne = reasons.not_enough || 0;
  const ev = [];
  let bucket;
  if (allResolvedByShip) {
    bucket = 'self_resolved';
    ev.push(`Every short-pulled order line later shipped successfully (last ${String(incidents.at(-1)?.shipped_at || '').slice(0, 10)}) — the part turned up.`);
  } else if (suspectAdj) {
    bucket = 'manual_add_suspect';
    ev.push(`Manual +${suspectAdj.qty} adjustment ${String(suspectAdj.at).slice(0, 10)} ("${suspectAdj.title || suspectAdj.type}"${suspectAdj.entered_by ? `, by ${suspectAdj.entered_by}` : ''}) within ${CONFIG.ADJ_SUSPECT_DAYS}d before the short pull — stock may have been added on paper only.`);
  } else if (suspectReceipt && cf > 0) {
    bucket = 'receiving_error_suspect';
    ev.push(`PO ${suspectReceipt.purchase_order_id} (${suspectReceipt.vendor || 'unknown vendor'}) shows ${num(suspectReceipt.received_quantity)} received with line activity ${String(suspectReceipt.line_updated).slice(0, 10)}, shortly before a "couldn't find" — receipt may not have physically arrived or was shelved wrong.`);
  } else if (onHandAtIncidentOffices > 0 && cf >= ne) {
    bucket = 'phantom_inventory';
    ev.push(`System still shows ${onHandAtIncidentOffices} on hand at the short-pull office but the picker couldn't find it — likely misplaced or the record is wrong.`);
  } else if (onHand <= 0 && !openSupply.length && waitingOrders.length) {
    bucket = 'no_supply';
    ev.push(`Nothing on hand anywhere, nothing on order, and ${waitingOrders.length} order line(s) still waiting — needs a reorder or a customer decision.`);
  } else if (ne > 0 || onHand <= 0) {
    bucket = 'record_shortfall';
    ev.push(ne > 0
      ? `Picker hit "not enough on hand" — the record already disagrees with the shelf; a count will pin down the real quantity.`
      : `No stock on the books after the short pull — verify the balance and demand.`);
  } else {
    bucket = 'needs_research';
    ev.push('No single hypothesis stands out from the data — needs a human/Claude look.');
  }

  // shared evidence
  const reasonBits = Object.entries(reasons).map(([k, v]) => `${v}× ${REASON_LABEL[k] || k}`).join(', ');
  ev.push(`${incidents.length} short pull(s) in 60d (${reasonBits}); ${shortHistory180 ? `${shortHistory180} in 180d` : 'first in 180d'}.`);
  if (onHand > 0) ev.push(`On hand now: ${onHand} across ${bins.length} bin(s) (${bins.slice(0, 4).map((b) => `${b.office} ${b.bin}: ${b.qty}`).join('; ')}).`);
  else ev.push('On hand now: 0.');
  if (openSupply.length) ev.push(`On order: ${openSupply.map((l) => `${num(l.quantity_remaining)} on PO ${l.purchase_order_id} (${l.vendor || '?'}${l.item_eta_date ? `, ETA ${String(l.item_eta_date).slice(0, 10)}` : ''})`).join('; ')}.`);
  if (shipsAfterLast.length) ev.push(`${shipsAfterLast.length} successful shipment(s) of this LIC since the last short pull.`);
  if (waitingOrders.length) ev.push(`Waiting: ${waitingOrders.map((i) => `order ${i.order.id}${i.bike_tag ? ` (tag ${i.bike_tag})` : ''}`).join(', ')}.`);

  // ---- flags
  const flags = [];
  if (shortHistory180 >= CONFIG.REPEAT_THRESHOLD) flags.push('repeat_offender');
  if (num(lic.unit_cost) >= CONFIG.HIGH_VALUE) flags.push('high_value');
  if (waitingOrders.length) flags.push('order_waiting');
  if (incidents.some((i) => i.shipment.type === 'TRANSFER')) flags.push('transfer');
  if (incidentOffices.length > 1) flags.push('multi_office');
  if (lic.is_discontinued) flags.push('discontinued');
  if (lic.is_special_order) flags.push('special_order');
  if (incidents.some((i) => i.resolved_by_ship) && !allResolvedByShip) flags.push('partially_resolved');

  const shortQty = incidents.filter((i) => !i.resolved_by_ship).reduce((s, i) => s + i.qty, 0);
  const exposure = +(shortQty * num(lic.unit_cost)).toFixed(2);

  const fingerprint = sha1(JSON.stringify([
    incidents.map((i) => [i.rec_id, i.attempts, i.resolved_by_ship]),
    onHand, adjustments[0]?.at || null,
  ]));

  // ---- state merge
  const prior = state.lics?.[licId] || null;
  const seen = new Set(prior?.incidents_seen || []);
  const newIncidents = incidents.filter((i) => !seen.has(i.rec_id)).map((i) => i.rec_id);
  const changed = prior ? prior.fingerprint !== fingerprint : false;
  const snoozed = prior?.status === 'snoozed' && prior.snooze_until
    && new Date(prior.snooze_until) > today && !newIncidents.length;
  const stateView = prior ? {
    status: prior.status, snooze_until: prior.snooze_until || null,
    issued_run: prior.actions?.issued_run || null, changed,
    pending_items: (prior.actions?.items || []).filter((it) => !it.verified).length,
  } : null;

  const c = {
    id: licId,
    li_code: lic.li_code || raw[0]?.li_code || licId,
    description: lic.description || raw[0]?.description || '',
    type: lic.li_code_type || raw[0]?.li_code_type || '',
    sub_type: lic.li_code_sub_type || raw[0]?.li_code_sub_type || null,
    manufacturer: lic.tnw_manufacturer || null,
    unit_cost: num(lic.unit_cost), price: num(lic.price),
    incidents, incident_count: incidents.length,
    board_incident_count: boardIncidents.length,
    last_incident_at: incidents.at(-1)?.at || null,
    age_days: lastAt ? daysBetween(lastAt, today) : null,
    reasons,
    inventory: { on_hand: onHand, at_incident_offices: onHandAtIncidentOffices, bins },
    adjustments: adjustments.slice(0, 10),
    last_adjustment_at: lastAdjustmentAt,
    supply: {
      open: openSupply.map((l) => ({ po_id: l.purchase_order_id, vendor: l.vendor,
        remaining: num(l.quantity_remaining), eta: l.item_eta_date, status: l.purchase_order_rec_status })),
      recent: poLines.slice(0, 6).map((l) => ({ po_id: l.purchase_order_id, vendor: l.vendor,
        qty: num(l.quantity), received: num(l.received_quantity), date: l.purchase_order_date,
        updated: l.line_updated, status: l.rec_status })),
    },
    movement: { ok_ships_180d: okShips.length, ships_after_last: shipsAfterLast.length,
      last_shipped_at: lastShippedAt, short_pulls_180d: shortHistory180,
      order_items_shipped: [...shippedOrderItems.keys()] },
    exposure: { short_qty: shortQty, value: exposure },
    bucket, flags, evidence: ev.slice(0, 8),
    synopsis: synopsis[licId]?.synopsis || null,
    on_board: boardIncidents.length > 0
      || ['action_pending', 'snoozed'].includes(prior?.status || '') || newIncidents.length > 0,
    state: stateView, snoozed, new_incidents: newIncidents,
    fingerprint,
  };
  c.suggestion = suggest(c, synopsis[licId]);
  return c;
}

// ---- proposed action plan --------------------------------------------------
export function suggest(c, syn) {
  const firstWaiting = c.incidents.find((i) => i.order && !i.resolved_by_ship);
  const binHint = c.incidents.at(-1)?.bin || c.inventory.bins[0]?.bin || 'its bin';
  const office = c.incidents.at(-1)?.office || '';
  const items = [];
  const relook = { kind: 'relook', label: `Relook: search for ${c.li_code} around ${binHint} (${office}) — check transit/clearing bins and recent builds`, expected_after: { activity_after: true } };
  const count = { kind: 'count', label: `Cycle count ${c.li_code} at ${office || 'the short-pull office'} and post the correction`, expected_after: { new_adjustment_after: true } };
  const track = firstWaiting ? { kind: 'track_order', label: `Track down order ${firstWaiting.order.id}${firstWaiting.bike_tag ? ` (tag ${firstWaiting.bike_tag})` : ''} — reorder ${c.li_code} or substitute`, expected_after: { order_item_shipped: firstWaiting.order.item_rec_id } } : null;

  const s = { action: 'plan', reason: '', items: [] };
  switch (c.bucket) {
    case 'manual_add_suspect': {
      const a = c.adjustments.find((x) => x.qty > 0 && !x.is_count);
      s.reason = 'A manual inventory add preceded the short pull — verify it was real before trusting the balance.';
      s.items = [
        { kind: 'reverse_adjustment', label: `Review adjustment "${a?.title || 'manual add'}" (${String(a?.at || '').slice(0, 10)}, +${a?.qty}${a?.entered_by ? `, ${a.entered_by}` : ''}) — reverse it if the stock was never really there`, expected_after: { new_adjustment_after: true } },
        count,
      ];
      break;
    }
    case 'receiving_error_suspect':
      s.reason = 'A recent PO receipt may not have physically landed — verify receiving before counting.';
      s.items = [
        { kind: 'verify_receiving', label: `Verify PO ${c.supply.recent[0]?.po_id || ''} receipt of ${c.li_code} physically arrived and was shelved (check packing slip / receiver)`, expected_after: { manual: true } },
        relook, count,
      ];
      break;
    case 'phantom_inventory':
      s.reason = 'System says it\'s on the shelf; the picker says it isn\'t. Relook first, count if the relook fails.';
      s.items = [relook, count];
      break;
    case 'no_supply':
      s.reason = 'No stock, no inbound PO, and a customer is waiting — this is a purchasing problem now.';
      s.items = [track, count].filter(Boolean);
      break;
    case 'record_shortfall':
      s.reason = 'The record already disagrees with the shelf — count to true it up, then deal with the waiting demand.';
      s.items = [count, ...(track ? [track] : [])];
      break;
    case 'self_resolved':
      s.action = 'resolve';
      s.reason = 'Every affected order line subsequently shipped — nothing left to do unless the balance still looks off.';
      s.items = [];
      break;
    default:
      s.action = 'review';
      s.reason = 'Evidence is ambiguous — read the synopsis and decide.';
      s.items = [relook, count];
  }
  if (syn?.recommended && s.action === 'plan') s.reason += ` Claude: ${syn.recommended}`;
  if (c.flags.includes('order_waiting') && !s.items.some((i) => i.kind === 'track_order') && track) s.items.push(track);
  return s;
}

// ------------------------------------------------------------------ main
export function run(root = '.', todayStr = null) {
  const D = (f) => `${root}/data/${f}`;
  const today = todayStr ? new Date(todayStr) : new Date();
  const shortPulls = loadJSON(D('short_pulls.json'));
  const lics = loadJSON(D('lics.json'), []);
  const bins = loadJSON(D('bin_balances.json'), []);
  const adjustments = loadJSON(D('adjustments.json'), []);
  const poActivity = loadJSON(D('po_activity.json'), []);
  const movements = loadJSON(D('movements.json'), []);
  const synopsis = loadJSON(D('synopsis.json'), {});
  const state = loadJSON(`${root}/state/audit-state.json`, { lics: {} });

  const ctx = {
    incidentsByLic: groupBy(shortPulls, 'li_code_rec_id'),
    licById: new Map(lics.map((l) => [l.li_code_rec_id, l])),
    binsByLic: groupBy(bins, 'li_code_rec_id'),
    adjByLic: groupBy(adjustments, 'li_code_rec_id'),
    poByLic: groupBy(poActivity, 'li_code_rec_id'),
    movByLic: groupBy(movements, 'li_code_rec_id'),
    synopsis, state, today,
  };

  const all = [...ctx.incidentsByLic.keys()].map((id) => classifyLIC(id, ctx));
  const board = all.filter((c) => c.on_board)
    .map((c) => ({ ...c, prio: c.board_incident_count * 2 + c.incident_count
      + (c.exposure.value / 50) + (c.flags.includes('order_waiting') ? 3 : 0)
      + (c.flags.includes('repeat_offender') ? 2 : 0) }))
    .sort((a, b) => b.prio - a.prio);

  const summary = {};
  for (const c of board) summary[c.bucket] = (summary[c.bucket] || 0) + 1;
  const out = {
    run_id: today.toISOString().slice(0, 10),
    pulled_at: new Date().toISOString(),
    config: CONFIG,
    summary,
    totals: {
      lics: board.length,
      incidents: board.reduce((s, c) => s + c.board_incident_count, 0),
      actionable: board.filter((c) => !c.snoozed && c.bucket !== 'self_resolved').length,
      exposure: +board.reduce((s, c) => s + c.exposure.value, 0).toFixed(2),
      repeat_offenders: board.filter((c) => c.flags.includes('repeat_offender')).length,
      with_synopsis: board.filter((c) => c.synopsis).length,
    },
    lics: board,
    off_board_pending: all.filter((c) => !c.on_board).length,
  };
  writeFileSync(D('classified.json'), JSON.stringify(out));

  // Research worklist for the synopsis step — Claude researches EVERY board LIC
  // (Brett's call: everything in window) and writes data/synopsis.json.
  const targets = board.filter((c) => !c.snoozed).map((c) => ({
    id: c.id, li_code: c.li_code, description: c.description, bucket: c.bucket,
    has_synopsis: !!c.synopsis, evidence: c.evidence,
  }));
  writeFileSync(D('research_targets.json'), JSON.stringify(targets, null, 1));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('classify.mjs')) {
  const out = run(process.cwd(), process.env.AUDIT_TODAY || null);
  console.log(`run ${out.run_id}: ${out.totals.lics} LICs on board (${out.totals.incidents} incidents ≤${CONFIG.BOARD_WINDOW_DAYS}d) | actionable ${out.totals.actionable} | exposure ${money(out.totals.exposure)} | synopses ${out.totals.with_synopsis}/${out.totals.lics}`);
  for (const [b, n] of Object.entries(out.summary).sort((a, b2) => b2[1] - a[1])) console.log(`  ${b.padEnd(24)} ${n}`);
  console.log(`research targets → data/research_targets.json`);
}

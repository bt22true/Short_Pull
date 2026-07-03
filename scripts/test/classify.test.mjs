import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotes, classifyLIC, suggest, CONFIG } from '../classify.mjs';

// ---------- parseNotes ----------
test('parseNotes: reason variants and repeats', () => {
  const n = parseNotes("Bike Tag: X152692\rSHORT PULL: Not Enough On Hand\rSHORT PULL: Not Enough On Hand\rSHORT PULL: Couldn't Find Item");
  assert.equal(n.bike_tag, 'X152692');
  assert.equal(n.attempts, 3);
  assert.equal(n.reasons.not_enough, 2);
  assert.equal(n.reasons.couldnt_find, 1);
});

test('parseNotes: other / manual / empty', () => {
  assert.equal(parseNotes('SHORT PULL: MANUAL: No Barcode').reasons.manual, 1);
  assert.equal(parseNotes('SHORT PULL: Other').reasons.other, 1);
  assert.equal(parseNotes('SHORT PULL: ').reasons.unspecified, 1);
  assert.equal(parseNotes('short pull mentioned in passing').reasons.unspecified, 1);
});

// ---------- classification harness ----------
const TODAY = new Date('2026-07-02');
function ctxWith({ incidents = [], lic = {}, bins = [], adj = [], po = [], mov = [] } = {}) {
  return {
    incidentsByLic: new Map([['CODE1', incidents]]),
    licById: new Map([['CODE1', { li_code_rec_id: 'CODE1', li_code: 'ABC-1', description: 'Test Part', unit_cost: '10', price: '20', ...lic }]]),
    binsByLic: new Map([['CODE1', bins]]),
    adjByLic: new Map([['CODE1', adj]]),
    poByLic: new Map([['CODE1', po]]),
    movByLic: new Map([['CODE1', mov]]),
    synopsis: {}, state: { lics: {} }, today: TODAY,
  };
}
const inc = (over = {}) => ({
  shipment_item_rec_id: over.rec_id || 'SHIPLI1', shipment_rec_id: 'SHIP1',
  shipment_item_notes: "SHORT PULL: Couldn't Find Item",
  shipment_item_rec_status: 'VOID', shipment_item_quantity: '0',
  li_code_rec_id: 'CODE1', li_code: 'ABC-1',
  office_rec_id: 'OFF50000', office_abbr: 'SF', office_bin_rec_id: 'OFFBIN1',
  office_bin_name: 'Wall A', office_bin_abbr: 'SF-A',
  shipment_id: 1, shipment_rec_type: 'SHIPMENT', tnw_shipment_type: 'Order',
  shipment_rec_status: 'SHIPPED', shipment_title: 't',
  order_rec_id: 'ORD1', order_id: 'X100', order_rec_status: 'OPEN',
  order_item_rec_id: 'ORDLI1', order_item_quantity: '1', order_item_rec_status: 'OPEN',
  incident_at: '2026-06-28T10:00:00.000Z',
  ...over,
});
const bin = (qty, over = {}) => ({ li_code_rec_id: 'CODE1', office_rec_id: 'OFF50000', office_abbr: 'SF',
  office_bin_rec_id: 'OFFBIN1', office_bin_name: 'Wall A', office_bin_abbr: 'SF-A',
  quantity: String(qty), available_quantity: String(qty), demand_quantity: '0', ...over });

test('phantom_inventory: on hand at office but could not find', () => {
  const c = classifyLIC('CODE1', ctxWith({ incidents: [inc()], bins: [bin(3)] }));
  assert.equal(c.bucket, 'phantom_inventory');
  assert.equal(c.inventory.on_hand, 3);
  assert.deepEqual(c.suggestion.items.map((i) => i.kind), ['relook', 'count', 'track_order']);
});

test('manual_add_suspect: recent manual +adjustment wins over phantom', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc()], bins: [bin(3)],
    adj: [{ li_code_rec_id: 'CODE1', inventory_adj_date: '2026-06-20T00:00:00.000Z',
      inventory_adj_type: 'Adjustment', inventory_adj_rec_type: 'ADJUSTMENT',
      adj_title: 'manual add', entered_by: 'Pat', quantity: '2', quantity_count: '0', quantity_balance: '0' }],
  }));
  assert.equal(c.bucket, 'manual_add_suspect');
  assert.equal(c.suggestion.items[0].kind, 'reverse_adjustment');
});

test('count adjustments and beg balance do NOT trigger manual_add_suspect', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc()], bins: [bin(3)],
    adj: [
      { li_code_rec_id: 'CODE1', inventory_adj_date: '2026-06-20T00:00:00.000Z',
        inventory_adj_type: 'Count', inventory_adj_rec_type: 'COUNT', quantity: '2', quantity_count: '5', quantity_balance: '3' },
      { li_code_rec_id: 'CODE1', inventory_adj_date: '2026-06-21T00:00:00.000Z',
        inventory_adj_type: 'Beg Balance', inventory_adj_rec_type: 'BEG BALANCE', quantity: '4', quantity_count: '4', quantity_balance: '0' },
    ],
  }));
  assert.equal(c.bucket, 'phantom_inventory');
});

test('no_supply: nothing anywhere, nothing inbound, customer waiting', () => {
  const c = classifyLIC('CODE1', ctxWith({ incidents: [inc()], bins: [] }));
  assert.equal(c.bucket, 'no_supply');
  assert.equal(c.suggestion.items[0].kind, 'track_order');
  assert.equal(c.suggestion.items[0].expected_after.order_item_shipped, 'ORDLI1');
});

test('record_shortfall: not-enough-on-hand reason', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc({ shipment_item_notes: 'SHORT PULL: Not Enough On Hand' })],
    bins: [bin(0)],
    po: [{ li_code_rec_id: 'CODE1', purchase_order_id: 9, purchase_order_rec_status: 'OPEN',
      purchase_order_date: '2026-06-01', vendor: 'QBP', quantity: '5', received_quantity: '0',
      quantity_remaining: '5', rec_status: 'OPEN', line_updated: '2026-06-01' }],
  }));
  assert.equal(c.bucket, 'record_shortfall');
  assert.equal(c.supply.open.length, 1);
});

test('self_resolved: order line shipped after the short pull', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc()],
    mov: [{ li_code_rec_id: 'CODE1', shipment_item_rec_id: 'SHIPLI9', is_short_pull: false,
      shipment_item_rec_status: 'SHIPPED', shipment_item_quantity: '1',
      order_item_rec_id: 'ORDLI1', created_at: '2026-06-30T10:00:00.000Z',
      shipment_rec_type: 'SHIPMENT', shipment_rec_status: 'SHIPPED' }],
  }));
  assert.equal(c.bucket, 'self_resolved');
  assert.equal(c.suggestion.action, 'resolve');
  assert.ok(c.incidents[0].resolved_by_ship);
});

test('receiving_error_suspect: receipt just before a couldnt-find', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc()], bins: [],
    po: [{ li_code_rec_id: 'CODE1', purchase_order_id: 7, purchase_order_rec_status: 'CLOSED',
      purchase_order_date: '2026-06-10', vendor: 'QBP', quantity: '2', received_quantity: '2',
      quantity_remaining: '0', rec_status: 'CLOSED', line_updated: '2026-06-25T00:00:00.000Z' }],
  }));
  assert.equal(c.bucket, 'receiving_error_suspect');
});

test('repeat offender flag + board window', () => {
  const old = inc({ rec_id: 'SHIPLI0', incident_at: '2026-05-10T00:00:00.000Z', order_item_rec_id: 'ORDLI0' });
  const mov = ['a', 'b', 'c'].map((x, i) => ({ li_code_rec_id: 'CODE1', shipment_item_rec_id: 'M' + i,
    is_short_pull: true, shipment_item_rec_status: 'VOID', shipment_item_quantity: '0',
    created_at: '2026-04-0' + (i + 1), shipment_rec_type: 'SHIPMENT', shipment_rec_status: 'SHIPPED' }));
  const c = classifyLIC('CODE1', ctxWith({ incidents: [old, inc()], bins: [bin(1)], mov }));
  assert.ok(c.flags.includes('repeat_offender'));
  assert.equal(c.incident_count, 2);
  assert.equal(c.board_incident_count, 1); // the May one is outside the 14d board window
});

test('state: new incidents vs incidents_seen, snooze holds', () => {
  const ctx = ctxWith({ incidents: [inc(), inc({ rec_id: 'SHIPLI2', order_item_rec_id: 'ORDLI2' })], bins: [bin(1)] });
  ctx.state = { lics: { CODE1: { status: 'snoozed', snooze_until: '2026-08-01', incidents_seen: ['SHIPLI1', 'SHIPLI2'], fingerprint: 'x' } } };
  const c = classifyLIC('CODE1', ctx);
  assert.equal(c.new_incidents.length, 0);
  assert.equal(c.snoozed, true);
  // a NEW incident breaks the snooze
  ctx.state.lics.CODE1.incidents_seen = ['SHIPLI1'];
  const c2 = classifyLIC('CODE1', ctx);
  assert.equal(c2.new_incidents.length, 1);
  assert.equal(c2.snoozed, false);
});

test('on_board: window + state interplay', () => {
  // fresh LIC with only an old incident → off board
  const oldOnly = ctxWith({ incidents: [inc({ incident_at: '2026-05-10T00:00:00.000Z' })], bins: [bin(1)] });
  assert.equal(classifyLIC('CODE1', oldOnly).on_board, false);
  // recent incident, no state → on board
  assert.equal(classifyLIC('CODE1', ctxWith({ incidents: [inc()], bins: [bin(1)] })).on_board, true);
  // triaged-resolved with all incidents seen → hidden even inside the window
  const triaged = ctxWith({ incidents: [inc()], bins: [bin(1)] });
  triaged.state = { lics: { CODE1: { status: 'resolved', incidents_seen: ['SHIPLI1'], fingerprint: 'x' } } };
  assert.equal(classifyLIC('CODE1', triaged).on_board, false);
  // …but a NEW incident resurrects it
  triaged.state.lics.CODE1.incidents_seen = [];
  assert.equal(classifyLIC('CODE1', triaged).on_board, true);
  // action_pending stays visible even with old incidents only
  const pending = ctxWith({ incidents: [inc({ incident_at: '2026-05-10T00:00:00.000Z' })], bins: [bin(1)] });
  pending.state = { lics: { CODE1: { status: 'action_pending', incidents_seen: ['SHIPLI1'], fingerprint: 'x', actions: { issued_run: '2026-06-01', items: [] } } } };
  assert.equal(classifyLIC('CODE1', pending).on_board, true);
});

test('exposure counts only unresolved short qty', () => {
  const c = classifyLIC('CODE1', ctxWith({
    incidents: [inc(), inc({ rec_id: 'SHIPLI2', order_item_rec_id: 'ORDLI2', order_item_quantity: '2' })],
    mov: [{ li_code_rec_id: 'CODE1', shipment_item_rec_id: 'SHIPLI9', is_short_pull: false,
      shipment_item_rec_status: 'SHIPPED', shipment_item_quantity: '1',
      order_item_rec_id: 'ORDLI1', created_at: '2026-06-30', shipment_rec_type: 'SHIPMENT', shipment_rec_status: 'SHIPPED' }],
  }));
  assert.equal(c.exposure.short_qty, 2); // ORDLI1 resolved, ORDLI2 (qty 2) not
  assert.equal(c.exposure.value, 20);
  assert.ok(c.flags.includes('partially_resolved'));
});

# Short-Pull Audit — Runbook

The authoritative procedure for auditing The New Wheel's shipment short pulls.
Run it by typing `/short-pull-audit` in a Claude Code session in this repo.

## Golden rules (never violated)

1. **Re-pull live every run.** Short pulls resolve themselves constantly (the
   part turns up, the line re-ships). Any worklist is a photograph; never act
   from a stale one.
2. **This audit only READS aAce.** Counts, adjustment reversals, reorders, and
   re-ships are done by humans in aAce. The audit's job is diagnosis + a work
   list; the next run verifies the work from fresh data.
3. **Never commit `data/` or `dist/`.** Raw rows reference customer orders.

## What a short pull is (data model)

When a picker can't fulfill a shipment line, aAce appends a note to
`fm.shipping_log_items.shipment_item_notes`:

```
Bike Tag: X152834
SHORT PULL: Couldn't Find Item
```

- One `SHORT PULL:` line per failed attempt (repeats = tried multiple times).
- Reasons seen in the wild: `Couldn't Find Item` (~80%), `Not Enough On Hand`
  (~15%), `Other`, `MANUAL: No Barcode`, blank.
- The shipment line is usually then **VOID** (qty 0) and sometimes re-keyed
  later when the part turns up — that re-keyed line SHIPPED is what
  "self-resolved" means.
- Short pulls happen on customer-order shipments AND on store transfers
  (`shipment_rec_type = 'TRANSFER'`, e.g. SF↔Larkspur rebalances).

## Data model cheat sheet (`fm` schema, read-only Postgres MCP)

| Thing | Where | How to read it |
|---|---|---|
| The incident | `shipping_log_items` + `shipping_log` header | notes ILIKE '%short pull%'; join order/order_item/bin |
| What the system thinks is on the shelf | `inventory_bin_balances` per LIC×bin | `quantity` on hand, `available_quantity`, `demand_quantity` |
| Manual adds / counts | `inventory_adjustment_items` + `inventory_adjustments` | `quantity` is the DELTA; `is_count` when type mentions Count; `Beg Balance` is noise |
| What we received / have inbound | `purchase_order_items` + `purchase_orders` | received when `received_quantity > 0`; NO per-line receive date — `updated_at` is the proxy |
| What happened next | `shipping_log_items` history for the LIC | a later non-short SHIPPED line for the same `order_item_rec_id` = resolved |
| The part | `line_item_codes` | unit_cost drives exposure; discontinued/special-order flags matter for reorders |

## Buckets (see `scripts/classify.mjs` for exact rules)

`manual_add_suspect` · `receiving_error_suspect` · `phantom_inventory` ·
`no_supply` · `record_shortfall` · `needs_research` · `self_resolved`.
Precedence: self-resolved wins (nothing to do), then suspicion of a specific
cause (manual add, receiving), then the state of the record (phantom / no
supply / shortfall). Cross-cutting flags: `repeat_offender`, `order_waiting`,
`high_value`, `transfer`, `multi_office`, `discontinued`, `partially_resolved`.

Thresholds live in `CONFIG` at the top of `scripts/classify.mjs`
(board window 14d; adjustment-suspect window 45d; receipt-suspect 30d;
repeat threshold 3 in 180d; quiet-resolve 45d).

## The run, step by step

1. **Preflight** — `git pull`; run `sql/99_sanity_checks.sql`; numbers wildly
   outside the expected band (see header comment) → stop, check
   `hub_sync_health`, report.
2. **Pull** — run `sql/01`–`06` via the Postgres MCP, save to `data/*.json`
   (headers in each file say which output file; chunk if results truncate).
   Best done by a subagent so row data stays out of the main conversation.
3. **Classify** — `node scripts/classify.mjs`, then
   `node scripts/verify-actions.mjs` (auto-verifies work Brett did in aAce
   since last run: new counts, adjustment reversals, re-shipped order lines;
   quiet-resolves anything silent for 45d). Report the diff vs last run.
4. **Research + synopsis — the heart of this audit.** Claude reads every
   research target (`data/research_targets.json`, i.e. every non-snoozed LIC
   on the board — Brett wants full coverage, not a sample) and writes
   `data/synopsis.json`: 2–5 plain-language sentences per LIC on what likely
   happened, citing the specific evidence (the adjustment, the receipt, the
   bin balance, the later ship). Targeted follow-up SQL per LIC is encouraged.
   Disagree with the deterministic bucket when the evidence says so — the
   synopsis is what Brett reads first. Re-run classify so the board embeds it.
5. **Board** — `node scripts/build-board.mjs` → `dist/board.html` → publish as
   an Artifact (favicon 📦, stable title "Short Pull Audit Board"). Two-step:
   - **Step 1 · Triage** (keyboard: j/k, a accept plan, p edit plan, v resolved,
     s snooze, x skip). Every card shows the synopsis + proposed action plan;
     accept it, edit it, or override. Decisions persist in the browser
     (localStorage, per run).
   - **Step 2 · Do the work** — the physical work list grouped by
     relook / count / reverse adjustment / verify receiving / track order,
     with check-off and a print view. Counts, reversals, and re-ships need NO
     handoff — the next run's fresh pull auto-verifies them. **Copy for
     Claude** hands decisions + progress back to chat for state recording.
6. **Execute (only when Brett pastes the handoff)** — save the paste to
   `dist/action-plan-<run>.json`; `node scripts/merge-actions.mjs <file>` →
   work queue. Generate per-LIC checklists from
   `templates/action-checklist.md` into `dist/run-<run>/checklists/`.
7. **Commit** — `state/audit-state.json` + archived action plan; push.
   Debrief: the shop to-do list, what auto-verifies vs needs a manual tick,
   and any systemic pattern (chronic bin, brand, receiving habit).
8. **Learn** — when a run reveals a recurring root cause (a bin that always
   miscounts, a receiving shortcut that keeps biting), propose adding it to
   this runbook's "Known patterns" section below.

## Verification loop

Plan items issued in run N carry machine-checkable `expected_after` predicates
in state. Run N+1's `verify-actions.mjs` confirms them against fresh data:

- `new_adjustment_after` — a count/reversal posted after the issue date
- `activity_after` — any adjustment OR successful ship after the issue date
- `order_item_shipped` — that specific order line went out
- `manual` — no aAce signal exists (e.g. "verify receiving"); tick it off on
  the board and the tick arrives via the `completed` map in the handoff

A pending LIC with no new short pulls for 45 days quiet-resolves automatically.
A triaged LIC only returns to the board when a NEW incident lands on it —
that's what makes the daily cadence cheap.

## Daily mode

The SQL is a rolling window (60d pulled, 14d boarded) — never needs editing.
A morning run after a normal day surfaces ~3–8 LICs: yesterday's new short
pulls plus anything verified overnight. Everything else stays hidden as
already-triaged. Full procedure is identical to a fresh run.

## Known data quirks

- `shipment_item_notes` uses `\r` separators and repeats the SHORT PULL line
  per attempt; `parseNotes()` in classify.mjs is the only parser — fix it
  there, not inline.
- Some short-pull lines end `RECEIVED` (transfer legs) rather than VOID.
- There is no per-line receive DATE on `purchase_order_items`; receiving-error
  suspicion uses `updated_at` as a proxy and says so in the evidence.
- `inventory_adjustment_items.quantity` is the delta; `quantity_count` is the
  counted total; `Beg Balance` rec_type is opening-balance noise — ignore it.
- Office abbreviations come from `office_bins.office_abbr`; incidents with no
  bin fall back to the office rec_id.

## Known patterns

(Recurring root causes get recorded here as runs reveal them — the flywheel.)

---
name: short-pull-audit
description: Run the short-pull audit — pull live aAce shipment short-pull flags, research every affected LIC (manual adds, phantom stock, receiving errors), build the interactive triage board with per-LIC synopses and proposed action plans, then execute Brett's decisions. Use when Brett says "run the short pull audit", "/short-pull-audit", or pastes an action-plan JSON from the board.
---

# Short-pull audit run

Follow RUNBOOK.md (authoritative). Compressed procedure:

## Resume check (do this first)
- If Brett's message contains an action-plan JSON (`{"run_id":..., "decisions":[...]}`),
  skip to **Execute** below.
- Else start a fresh run.

## Fresh run
1. `git pull` (state freshness). Abort politely if the remote is ahead and can't fast-forward.
2. Sanity: run `sql/99_sanity_checks.sql` on the Postgres MCP
   (tool `mcp__…__query`, load via ToolSearch). 14-day incidents way outside
   40–120, parse rate < 95%, or latest incident more than ~3 days stale →
   stop, check `hub_sync_health`, report to Brett.
3. **Pull via a background subagent** (keeps row data out of this conversation):
   have it run `sql/01`–`06` per the header comment in each file, saving to
   `data/short_pulls.json`, `data/lics.json`, `data/bin_balances.json`,
   `data/adjustments.json`, `data/po_activity.json`, `data/movements.json`
   (chunk on truncation; verbatim rows; report row counts only).
4. `node scripts/classify.mjs` → deterministic buckets + `data/research_targets.json`.
5. `node scripts/verify-actions.mjs` → note verified/quiet-resolved actions for the debrief.
6. **Research + synopsis (the heart of this audit).** For EVERY target in
   `data/research_targets.json` (Brett's call: everything in window), read the
   LIC's card in `data/classified.json` and write a 2–5 sentence synopsis:
   what probably happened, in plain language, citing the specific adjustment /
   receipt / balance / movement that convinced you. Where the deterministic
   bucket looks wrong, say so and recommend a different action. Targeted
   follow-up SQL per LIC is encouraged (e.g. pull the exact adjustment items,
   check the order's other lines, look for the same part under a sibling LIC).
   Write `data/synopsis.json` keyed by lic_rec_id:
   `{ "<lic_rec_id>": {"synopsis": "...", "recommended": "count first — the relook already failed twice"} }`
   Then re-run step 4 so the board picks the synopses up.
7. `node scripts/build-board.mjs` → publish `dist/board.html` with the Artifact
   tool (favicon 📦, stable title "Short Pull Audit Board"). Tell Brett the
   headline numbers and anything that smells systemic (one bin, one brand, one
   day of the week). The board is two-step: triage (a/p/v/s/x keys), then an
   in-board "Do the work" list grouped by relook / count / reverse adjustment /
   verify receiving / track order.

## Execute (action plan pasted back)
1. Save the JSON to `dist/action-plan-<run_id>.json`;
   run `node scripts/merge-actions.mjs <that file>`.
2. Write per-LIC checklists for planned items to
   `dist/run-<run_id>/checklists/` using `templates/action-checklist.md`,
   plus a combined `worklist-all.md`. Send to Brett (SendUserFile).
3. Commit `state/audit-state.json` + the action-plan archive
   (`short-pull run <run_id>: N triaged, X actions`); push.
4. Debrief: the physical work list (what to do in the shop), what auto-verifies
   next run vs what needs a manual tick, snoozes, and any systemic pattern
   worth fixing upstream (receiving procedure, bin naming, a chronic bin).

## Daily mode
Designed to run every morning on yesterday's data: same steps, unchanged SQL
(rolling 60d pull / 14d board). State dedupes — a LIC Brett already triaged
only resurfaces when a NEW short pull lands on it, so a daily board is
normally just the previous day's handful of LICs.

## Invariants
- Live re-pull every run; boards are snapshots, stamped with `pulled_at`.
- This audit only READS aAce. All corrections (counts, adjustment reversals,
  reorders) are done by humans in aAce; the next run verifies them from fresh data.
- Never commit `data/` or `dist/` (raw rows reference customer orders).

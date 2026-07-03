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
   have it run `sql/01`–`07` per the header comment in each file, saving to
   `data/short_pulls.json`, `data/lics.json`, `data/bin_balances.json`,
   `data/adjustments.json`, `data/po_activity.json`, `data/movements.json`,
   `data/sales_history.json` (chunk on truncation; verbatim rows; report row
   counts only).
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
   `{ "<lic_rec_id>": {"synopsis": "...", "recommended": "...",
      "action": "resolve"|"skip"|"plan" (optional),
      "items": [{"kind": "...", "label": "...", "expected_after": {...}}] (optional)} }`
   `recommended` is REQUIRED and must be ONE crisp imperative action, or 2–3
   lettered options when it's genuinely a judgment call — the board renders it
   as the bold "→ Recommended:" line Brett acts on.
   **The buttons must match the words (Brett, 2026-07-03):** whenever your
   conclusion differs from the deterministic plan, OVERRIDE it — set
   `action: "resolve"` for "nothing to do / already handled" verdicts, or
   supply replacement `items` when the right steps differ from the
   classifier's. The board's "Accept" follows YOUR action, and every card
   previews exactly what accepting queues. For shortfall LICs consult the
   sales-velocity fields (`sales.qty_90d`, `cover_days`) before recommending a
   reorder-point change (see RUNBOOK "Reorder-point review" — the threshold is
   provisional). Then re-run step 4 so the board picks the synopses up.
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

## Daily mode (the scheduled 6am run — this is the normal mode)

The board lives at **https://tnw-short-pull.netlify.app** (Netlify site id
`89d2ca43-15ab-4949-a6c1-cf006c89e381`, basic-auth password in the site's
`BOARD_PASSWORD` env var — read it via the Netlify MCP `manage-env-vars`
getAllEnvVars, never print it). Brett triages there; decisions + check-offs
persist in the site's `/api/decisions` store. The daily cycle:

1. Preflight + pull + classify as in a fresh run (SQL unchanged — rolling
   60d pull / 14d board; state dedupes already-triaged LICs).
2. **Consume Brett's board decisions**: fetch the store with
   `curl -su "audit:$BOARD_PASSWORD" https://tnw-short-pull.netlify.app/api/decisions`
   → save to `dist/action-plan-<run_id>.json` → `node scripts/merge-actions.mjs <file>`.
3. `node scripts/verify-actions.mjs` — counts/reversals/re-ships verify from
   fresh aAce data; checked-off manual items count as done; completed work
   resolves and DROPS off the board.
4. Research + synopses for NEW/changed LICs only (targets with
   `has_synopsis: false` or a changed bucket); carry forward the rest.
5. **Publish fresh data — a PUT, NOT a redeploy** (Brett: redeploys cost more
   on Netlify). Re-run classify, `node scripts/build-board.mjs`, then:
   `curl -su "audit:$BOARD_PASSWORD" -X PUT -H "content-type: application/json" --data @dist/board-data.json https://tnw-short-pull.netlify.app/api/board`
   Redeploy ONLY when the board code changed this run (scripts/lib/template.html
   or netlify/** in the git diff): `node scripts/deploy-prep.mjs`, then the
   Netlify MCP `deploy-site` (siteId above, run its command from the repo root
   with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`).
6. **Write back pending work**: `node scripts/export-pending.mjs` →
   `curl -su "audit:$BOARD_PASSWORD" -X PUT -H "content-type: application/json" --data @dist/pending-decisions.json https://tnw-short-pull.netlify.app/api/decisions`
   — still-open items stay on Brett's "Do the work" list; consumed/verified
   ones disappear.
7. Commit `state/audit-state.json` + the action-plan archive; push. Message
   Brett ONLY if something needs his eyes (big new exposure, systemic pattern,
   verification failures) — a quiet morning needs no message.

## Invariants
- Live re-pull every run; boards are snapshots, stamped with `pulled_at`.
- This audit only READS aAce. All corrections (counts, adjustment reversals,
  reorders) are done by humans in aAce; the next run verifies them from fresh data.
- Never commit `data/` or `dist/` (raw rows reference customer orders).

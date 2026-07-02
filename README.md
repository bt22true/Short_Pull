# Short_Pull

Tooling for auditing The New Wheel's **short pulls** — shipment items flagged
in aAce when a picker couldn't fulfill a line ("SHORT PULL: Couldn't Find
Item" / "Not Enough On Hand" notes on `shipping_log_items`). Each flag means
the inventory record and the shelf disagreed at the worst possible moment:
while packing a customer order or a store transfer.

The audit groups incidents **per LIC**, researches what likely happened
(a manual inventory add that was never real? a PO receipt that never physically
landed? stock misplaced in another bin? a count that's simply wrong?), presents
a synopsis per part on an interactive board, and proposes an action plan:
relook for the part, cycle count the bin, reverse a prior adjustment, verify a
receipt, or track down the waiting order.

**Start here:** type `/short-pull-audit` in a Claude Code session on this repo.
The full procedure lives in [RUNBOOK.md](RUNBOOK.md).

```
sql/        the pull contract (read-only queries against the aAce→Postgres sync)
scripts/    zero-dependency Node: classify → board → merge decisions → verify
templates/  action-checklist conventions
state/      audit-state.json — the only cross-run persistence (committed)
data/       raw pulls + Claude's synopsis.json (gitignored)
dist/       generated board + work queues (gitignored)
```

Pipeline: `sql/*.sql → data/*.json → classify.mjs → (Claude researches every
LIC → data/synopsis.json → classify again) → build-board.mjs → dist/board.html
(Artifact) → triage → action-plan JSON → merge-actions.mjs → work queue +
checklists → verify-actions.mjs (next run auto-confirms counts, reversals,
and re-ships against fresh data)`.

Tests: `node --test scripts/test/classify.test.mjs`

Built to run **daily** on yesterday's short pulls: the pull window rolls
(60d pulled, 14d on the board) and state dedupes anything already triaged, so
a morning run only surfaces new incidents. This audit only ever READS aAce —
all corrections happen by hand in aAce and are verified on the next run.

Design lineage: structure, board, and verification loop adapted from the
[Warranty](https://github.com/bt22true/Warranty) audit project.

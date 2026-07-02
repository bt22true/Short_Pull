-- Preflight sanity checks. Run FIRST every audit. Expected bands as of 2026-07:
--   window_14d incidents 40–120 (73 at project setup); distinct LICs roughly half
--   the incident count; parse_rate >= 95%; voided share is normally high (short
--   pulls usually void the line). If any number is wildly off, STOP and report —
--   the sync may be unhealthy (cross-check with the hub_sync_health MCP tool).
SELECT
  (SELECT COUNT(*) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%'
       AND record_created_on_host >= now() - interval '14 days')  AS window_14d_incidents,
  (SELECT COUNT(DISTINCT li_code_rec_id) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%'
       AND record_created_on_host >= now() - interval '14 days')  AS window_14d_lics,
  (SELECT COUNT(*) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%'
       AND record_created_on_host >= now() - interval '60 days')  AS window_60d_incidents,
  (SELECT COUNT(*) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%'
       AND shipment_item_notes ILIKE '%SHORT PULL:%'
       AND record_created_on_host >= now() - interval '60 days')  AS window_60d_parseable,
  (SELECT COUNT(*) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%'
       AND shipment_item_rec_status = 'VOID'
       AND record_created_on_host >= now() - interval '60 days')  AS window_60d_voided,
  (SELECT MAX(record_created_on_host) FROM fm.shipping_log_items
     WHERE shipment_item_notes ILIKE '%short pull%')               AS latest_incident;

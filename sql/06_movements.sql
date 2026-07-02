-- Six months of shipment-item movement for audit-universe LICs — the
-- "what happened next" evidence: did the part ship successfully after the
-- short pull (self-resolved)? Did the same order line eventually go out?
-- How often has this LIC short-pulled before (repeat offender)?
-- CHUNKING: same pattern as 01 — filter sli.shipment_item_rec_id > '<last seen>' LIMIT 400.
-- Save to data/movements.json
SELECT
  sli.li_code_rec_id,
  sli.shipment_item_rec_id,
  sli.shipment_rec_id,
  sli.shipment_item_rec_status,
  sli.shipment_item_quantity,
  sli.order_rec_id,
  sli.order_item_rec_id,
  sli.office_rec_id,
  sli.office_bin_rec_id,
  (sli.shipment_item_notes ILIKE '%short pull%') AS is_short_pull,
  s.shipment_rec_type,
  s.tnw_shipment_type,
  s.shipment_rec_status,
  s.shipment_date,
  sli.record_created_on_host                     AS created_at
FROM fm.shipping_log_items sli
JOIN fm.shipping_log s ON s.shipment_rec_id = sli.shipment_rec_id
WHERE sli.li_code_rec_id IN (
    SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
    WHERE shipment_item_notes ILIKE '%short pull%'
      AND record_created_on_host >= now() - interval '60 days')
  AND sli.record_created_on_host >= now() - interval '180 days'
ORDER BY sli.shipment_item_rec_id;

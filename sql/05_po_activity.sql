-- Purchase-order activity for audit-universe LICs: what's on order (reorder in
-- flight?) and what was recently received (receiving-error suspect window).
-- NOTE: aAce does not expose a per-line received DATE; updated_at is the best
-- proxy for when receiving last touched the line — treat it as approximate.
-- Save to data/po_activity.json
SELECT
  poi.li_code_rec_id,
  poi.purchase_order_item_rec_id,
  poi.purchase_order_rec_id,
  po.purchase_order_id,
  po.purchase_order_rec_status,
  po.purchase_order_date,
  c.company_name              AS vendor,
  poi.quantity,
  poi.received_quantity,
  poi.quantity_remaining,
  poi.rec_status,
  poi.item_eta_date,
  poi.updated_at              AS line_updated
FROM fm.purchase_order_items poi
JOIN fm.purchase_orders po ON po.purchase_order_rec_id = poi.purchase_order_rec_id
LEFT JOIN fm.companies c   ON c.company_rec_id = po.vendor_company_rec_id
WHERE poi.li_code_rec_id IN (
    SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
    WHERE shipment_item_notes ILIKE '%short pull%'
      AND record_created_on_host >= now() - interval '60 days')
  AND poi.rec_status <> 'VOID'
  AND (po.purchase_order_rec_status IN ('OPEN','PENDING')
       OR po.purchase_order_date >= now() - interval '365 days')
ORDER BY poi.li_code_rec_id, po.purchase_order_date DESC;

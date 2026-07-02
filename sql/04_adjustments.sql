-- Inventory adjustments touching audit-universe LICs in the past 12 months.
-- This is the "did we add it to inventory manually?" evidence: a positive
-- non-count adjustment shortly before a short pull is the classic phantom-stock
-- origin story. quantity is the DELTA applied; quantity_count is the counted qty.
-- Save to data/adjustments.json
SELECT
  ai.li_code_rec_id,
  ai.inventory_adj_item_rec_id,
  ai.inventory_adj_rec_id,
  a.inventory_adj_id,
  LEFT(a.inventory_adj_title, 90)        AS adj_title,
  a.inventory_adj_type,
  a.inventory_adj_rec_type,
  a.inventory_adj_rec_status,
  a.inventory_adj_date,
  LEFT(a.inventory_adj_notes, 200)       AS adj_notes,
  tm.team_member_name_full               AS entered_by,
  ai.inventory_adj_item_quantity         AS quantity,
  ai.inventory_adj_item_quantity_count   AS quantity_count,
  ai.inventory_adj_item_quantity_balance AS quantity_balance,
  LEFT(ai.inventory_adj_item_notes, 140) AS item_notes,
  ai.office_rec_id,
  ai.office_bin_rec_id
FROM fm.inventory_adjustment_items ai
JOIN fm.inventory_adjustments a ON a.inventory_adj_rec_id = ai.inventory_adj_rec_id
LEFT JOIN fm.team_members tm    ON tm.team_member_rec_id = a.entered_by_team_member_rec_id
WHERE ai.li_code_rec_id IN (
    SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
    WHERE shipment_item_notes ILIKE '%short pull%'
      AND record_created_on_host >= now() - interval '60 days')
  AND a.inventory_adj_date >= now() - interval '365 days'
ORDER BY ai.li_code_rec_id, a.inventory_adj_date DESC;

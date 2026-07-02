-- Current bin-level balances for every LIC in the audit universe (all bins,
-- including zero rows — a zero in the pull bin next to stock in transit IS the story).
-- Save to data/bin_balances.json
SELECT
  b.li_code_rec_id,
  b.office_rec_id,
  b.office_bin_rec_id,
  ob.office_bin_name,
  ob.office_bin_abbr,
  ob.office_abbr,
  ob.is_transit,
  ob.is_clearing,
  b.quantity,
  b.available_quantity,
  b.demand_quantity,
  b.record_last_updated_on_host  AS balance_updated
FROM fm.inventory_bin_balances b
LEFT JOIN fm.office_bins ob ON ob.office_bin_rec_id = b.office_bin_rec_id
WHERE b.li_code_rec_id IN (
  SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
  WHERE shipment_item_notes ILIKE '%short pull%'
    AND record_created_on_host >= now() - interval '60 days')
ORDER BY b.li_code_rec_id, b.office_rec_id;

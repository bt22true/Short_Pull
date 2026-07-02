-- Catalog detail + global balances for every LIC in the audit universe.
-- Save to data/lics.json
SELECT
  lic.li_code_rec_id,
  lic.li_code,
  LEFT(lic.li_code_description, 140)  AS description,
  lic.li_code_type,
  lic.li_code_sub_type,
  lic.li_code_rec_status,
  lic.is_discontinued,
  lic.is_special_order,
  lic.tnw_manufacturer,
  lic.unit_cost,
  lic.li_code_rate                    AS price,
  lic.inventory_balance_on_hand,
  lic.inventory_balance_available,
  lic.upc_ean,
  lic.li_code_sku,
  lic.days_ship_std
FROM fm.line_item_codes lic
WHERE lic.li_code_rec_id IN (
  SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
  WHERE shipment_item_notes ILIKE '%short pull%'
    AND record_created_on_host >= now() - interval '60 days')
ORDER BY lic.li_code_rec_id;

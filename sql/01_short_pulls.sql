-- Audit universe: every shipment item flagged SHORT PULL in the pull window,
-- with shipment header, order line, and bin context inline.
-- Golden rule: re-pull live every run. Never reuse a prior snapshot.
--
-- WINDOW: 60 days. The BOARD only surfaces the last 14 days (classify.mjs
-- CONFIG.BOARD_WINDOW_DAYS); the extra history feeds evidence and lets
-- verify-actions.mjs confirm work on LICs that have left the board window.
-- Daily runs keep this interval unchanged — state dedupes triaged incidents.
--
-- CHUNKING: if the MCP result truncates, append
--   AND sli.shipment_item_rec_id > '<last rec_id seen>'  ... LIMIT 200
-- and iterate (results are ordered by shipment_item_rec_id).
-- Save rows (verbatim JSON array, concatenated across chunks) to data/short_pulls.json
SELECT
  sli.shipment_item_rec_id,
  sli.shipment_rec_id,
  sli.shipment_item_notes,
  sli.shipment_item_rec_status,
  sli.shipment_item_quantity,
  sli.shipment_item_quantity_backordered,
  sli.li_code_rec_id,
  sli.li_code,
  LEFT(sli.shipment_item_description, 140)  AS description,
  sli.li_code_type,
  sli.li_code_sub_type,
  sli.order_rec_id,
  sli.order_item_rec_id,
  sli.job_rec_id,
  sli.purchase_order_rec_id,
  sli.bike_tag,
  sli.office_rec_id,
  sli.office_bin_rec_id,
  ob.office_bin_name,
  ob.office_bin_abbr,
  ob.office_abbr,
  s.shipment_id,
  s.shipment_rec_type,
  s.tnw_shipment_type,
  s.shipment_rec_status,
  LEFT(s.shipment_title, 90)                AS shipment_title,
  s.transfer_to_office_rec_id,
  tm.team_member_name_full                  AS picked_by,
  o.order_id,
  o.order_rec_status,
  oi.order_item_quantity,
  oi.order_item_rec_status,
  sli.record_created_on_host                AS incident_at
FROM fm.shipping_log_items sli
JOIN fm.shipping_log s        ON s.shipment_rec_id = sli.shipment_rec_id
LEFT JOIN fm.office_bins ob   ON ob.office_bin_rec_id = sli.office_bin_rec_id
LEFT JOIN fm.team_members tm  ON tm.team_member_rec_id = s.shipment_picked_by_team_member_rec_id
LEFT JOIN fm.orders o         ON o.order_rec_id = sli.order_rec_id
LEFT JOIN fm.order_items oi   ON oi.order_item_rec_id = sli.order_item_rec_id
WHERE sli.shipment_item_notes ILIKE '%short pull%'
  AND sli.record_created_on_host >= now() - interval '60 days'
ORDER BY sli.shipment_item_rec_id;

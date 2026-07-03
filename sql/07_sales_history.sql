-- 12 months of sales/usage per audit-universe LIC, by month. Feeds the
-- reorder-point review: for "not enough on hand" short pulls (especially on
-- rebalance transfers) the question is whether we simply don't stock enough.
-- Includes all non-VOID order lines (SALES, PRODUCTION, service) — usage is
-- usage. Save to data/sales_history.json
SELECT
  oi.li_code_rec_id,
  date_trunc('month', o.order_date)::date  AS month,
  SUM(oi.order_item_quantity::numeric)     AS qty,
  COUNT(*)                                 AS lines
FROM fm.order_items oi
JOIN fm.orders o ON o.order_rec_id = oi.order_rec_id
WHERE oi.li_code_rec_id IN (
    SELECT DISTINCT li_code_rec_id FROM fm.shipping_log_items
    WHERE shipment_item_notes ILIKE '%short pull%'
      AND record_created_on_host >= now() - interval '60 days')
  AND oi.order_item_rec_status <> 'VOID'
  AND o.order_rec_status <> 'VOID'
  AND o.order_date >= now() - interval '365 days'
GROUP BY oi.li_code_rec_id, date_trunc('month', o.order_date)
ORDER BY oi.li_code_rec_id, month;

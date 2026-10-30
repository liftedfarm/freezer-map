-- 129: Club Green SO-26101501 (app order 14), Newport Punch #28 line: 20 lb on tag ...7137 (from Roshi) > 40 lb on tag ...7143,
-- per METRC manifest 0011728167 (10/20): ...7143 "Newport Punch #28 - OCAL Fresh Frozen", 40 lb shipped and received.
-- Tag ...7137 isn't a package in our METRC data. Per Aziz: change the app's order line only. INV-26101501 (paid, $44,100) is not touched.
update order_lines set lbs = 40, package_tag = '1A4060300030F35000007143', updated_at = now()
 where id = 94 and order_id = 14 and strain = 'Newport Punch #28';
select id, strain, lbs, right(package_tag, 6) tag, price_per_lb from order_lines where id = 94;

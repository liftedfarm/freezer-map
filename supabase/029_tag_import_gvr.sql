-- Migration 029: METRC tags available at GVR (exports from METRC, 2026-10-22), loaded as tag ranges per license.
-- Run after 028. Safe to re-run: it replaces the ranges it loaded before (notes start with 'METRC export').
--  * Each run of consecutive available tags is one range, so tags already used in METRC (the gaps) are never suggested.
--  * Plant tags (1A40602...) vs package tags (1A40603...): read from the 7th character of the tag.
--  * CCL25-0000175 (GVR cultivation): package tags = 'harvest' (fresh frozen pallets made at harvest), plant tags = 'plant'.
--  * CCL21-0000679 (GVR processor / hub): package tags = 'mixed' (mixed pallets, repacks at the GVR freezers).
--  * The app still skips any tag already on a pallet, order line, mother or batch.
set client_min_messages = warning;

delete from tag_ranges where license in ('CCL25-0000175','CCL21-0000679') and notes like 'METRC export%';
insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, notes, license) values
  ('GVR', 'mixed', '1A4060300030F35', 1769, 1769, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 1999, 2000, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2103, 2103, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2153, 2153, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2198, 2200, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2202, 2203, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2241, 2241, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2605, 2605, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2612, 2612, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2614, 2616, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2618, 2618, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2731, 2731, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 2771, 2771, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3155, 3156, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3218, 3218, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3337, 3337, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3392, 3392, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3397, 3397, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3408, 3408, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3516, 3516, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3576, 3576, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3592, 3592, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 3728, 3728, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4023, 4023, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4356, 4356, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4401, 4401, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4463, 4463, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4592, 4592, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 4717, 4717, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5167, 5167, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5254, 5254, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5288, 5288, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5352, 5352, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5866, 5866, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5868, 5869, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 5895, 5895, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6049, 6049, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6302, 6302, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6337, 6338, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6367, 6368, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6506, 6506, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6630, 6633, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6751, 6751, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6762, 6762, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 6765, 6765, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 7137, 7137, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 7155, 7987, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 8001, 8002, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 8004, 8022, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 8024, 8038, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'mixed', '1A4060300030F35', 8040, 10000, 9, 'METRC export 2026-10-22 (package tags)', 'CCL21-0000679'),
  ('GVR', 'plant', '1A406020007C3E5', 80667, 80868, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 89762, 90000, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90002, 90003, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90005, 90007, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90011, 90012, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90022, 90022, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90027, 90028, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90030, 90032, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90034, 90034, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90036, 90036, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90038, 90038, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90041, 90041, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90043, 90043, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 90045, 90045, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 97723, 97922, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 104323, 104420, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 127550, 127561, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 127619, 128000, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 128101, 128300, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 128401, 128700, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 129001, 129200, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 130101, 130200, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 130601, 130800, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 130901, 131200, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 131301, 131400, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 131501, 131600, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 131701, 131800, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 132001, 132100, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 132201, 132300, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 132401, 135000, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 135301, 135400, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 135601, 135700, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 143245, 145000, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 154598, 159800, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'plant', '1A406020007C3E5', 159952, 160000, 9, 'METRC export 2026-10-22 (plant tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A40603000319C1', 149, 1114, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A40603000319C1', 1116, 1696, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 118, 118, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 254, 254, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 360, 998, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1000, 1000, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1006, 1836, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1841, 1841, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1865, 1927, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1938, 1938, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1952, 1952, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1982, 1982, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1984, 1984, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 1994, 1994, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175'),
  ('GVR', 'harvest', '1A406030007C3E5', 2001, 9999, 9, 'METRC export 2026-10-22 (package tags)', 'CCL25-0000175');

-- next unused tags for a site and use: tags from the active ranges (oldest range first) not on any pallet or Roshi order line.
-- (Rewritten to look up used tags once, so big ranges stay fast.)
create or replace function next_tags(p_site text, p_purpose text default 'mixed', p_count int default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[];
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  with used as (
    select package_tag t from pallets where package_tag is not null
    union select unnest(regexp_split_to_array(upper(package_tag), '[^0-9A-Z]+')) from order_lines where package_tag is not null
  ), cand as (
    select r.prefix || lpad(g::text, r.digits, '0') t, r.id rid, g
      from tag_ranges r cross join lateral generate_series(r.first_n, r.last_n) g
     where r.site = p_site and r.purpose = p_purpose and r.active
  )
  select array_agg(t order by rid, g) into out from (
    select c.t, c.rid, c.g from cand c where not exists (select 1 from used u where u.t = c.t)
     order by c.rid, c.g limit greatest(least(p_count, 200), 1)) x;
  return coalesce(out, '{}');
end $$;

-- check: available tags loaded per license and use
select license, purpose, count(*) as ranges, sum(last_n - first_n + 1) as tags from tag_ranges where notes like 'METRC export%' group by 1, 2 order by 1, 2;

-- Migration 050: wet weights for the FL25 dry harvests (Farm Data OHR 2025 > Dry Harvest Data), so forecasts know wet -> bucked
-- per strain, and package numbers on Processing activity lines. Run once in Supabase after 049. Safe to re-run.
--   FL25 wet (raw) lbs: Jelly Cake 3,351 · Crush Mintz 5,361 · Cereal Milk 4,918 · Gurple 3,092 · Strawnana Mac 3,787 · Modified Mintz 2,267
--   (White Mango 7,782 was dried and bucked at Strong Ag; no bucked weight in the workbook, so it isn't used.)
--   That's bucked flower 7.7% to 13.6% of wet; the default with no history drops from 20% to 12%.
set client_min_messages = warning;

update proc_yield_history h set wet_lbs = v.wet
  from (values ('Jelly Cake', 3351), ('Crush Mintz', 5361), ('Cereal Milk', 4918), ('Gurple', 3092), ('Strawnana Mac', 3787), ('Modified Mintz', 2267)) v(s, wet)
 where lower(h.strain) = lower(coalesce(canonical_strain(v.s), v.s)) and h.crop_year = 2025 and h.source = 'FL25 workbook';

create or replace function proc_rates() returns jsonb
language sql stable security definer set search_path = public as $$
  with buck as (   -- finished bucking runs
    select lower(r.strain) k, sum(r.input_lbs) wet,
           sum((select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'bucked')) bucked,
           sum((select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'trim')) bt, count(*) n
      from proc_runs r where r.status = 'done' and r.kind = 'buck' group by 1),
  bhist as (select lower(strain) k, sum(bucked) bucked, sum(buck_trim) bt, sum(wet_lbs) wet, count(wet_lbs) n from proc_yield_history where bucked > 0 group by 1),
  bdry as (   -- bucked / wet from runs and from history rows that have a wet weight
    select k, sum(bucked) bucked, sum(wet) wet from (
      select k, bucked, wet from buck
      union all select lower(strain), bucked, wet_lbs from proc_yield_history where bucked > 0 and wet_lbs > 0) z group by 1),
  trim_ as (       -- finished trimming runs + workbook history
    select k, sum(inp) inp, sum(std) std, sum(sml) sml, sum(trm) trm, sum(mold) mold, sum(n) n, sum(h) h from (
      select lower(r.strain) k, r.input_lbs inp,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'standards') std,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'smalls') sml,
             (select coalesce(sum(p.og_weight), 0) from pallets p where p.run_id = r.id and p.product = 'trim') trm, coalesce(r.mold_lbs, 0) mold, 1 n, 0 h
        from proc_runs r where r.status = 'done' and r.kind = 'trim'
      union all
      select lower(strain), standards + smalls + trim_lbs + trim_mold, standards, smalls, trim_lbs, trim_mold, 0, 1 from proc_yield_history where standards > 0) x
     group by 1),
  conv as (select nullif(value, '')::numeric c from app_settings where key = 'proc.dry_default')
  select jsonb_build_object(
    'default_dry', coalesce((select c from conv), 0.12),
    'all', jsonb_build_object(
      'dry', (select case when sum(wet) > 0 then sum(bucked) / sum(wet) end from bdry),
      'bt', (select case when sum(b) > 0 then sum(t) / sum(b) end from (select bucked b, bt t from buck union all select bucked, bt from bhist) z),
      'std', (select sum(std) / nullif(sum(inp), 0) from trim_), 'sml', (select sum(sml) / nullif(sum(inp), 0) from trim_),
      'trm', (select sum(trm) / nullif(sum(inp), 0) from trim_), 'mold', (select sum(mold) / nullif(sum(inp), 0) from trim_)),
    'strains', coalesce((select jsonb_object_agg(k, v) from (
      select coalesce(b.k, t.k, bh.k) k, jsonb_build_object(
        'dry', (select case when x.wet > 0 then x.bucked / x.wet end from bdry x where x.k = coalesce(b.k, t.k, bh.k)), 'buck_runs', coalesce(b.n, 0),
        'bt', case when coalesce(b.bucked, 0) + coalesce(bh.bucked, 0) > 0 then (coalesce(b.bt, 0) + coalesce(bh.bt, 0)) / (coalesce(b.bucked, 0) + coalesce(bh.bucked, 0)) end,
        'std', t.std / nullif(t.inp, 0), 'sml', t.sml / nullif(t.inp, 0), 'trm', t.trm / nullif(t.inp, 0), 'mold', t.mold / nullif(t.inp, 0),
        'trim_runs', coalesce(t.n, 0), 'history', coalesce(t.h, 0) > 0 or bh.k is not null) v
        from buck b full join trim_ t on t.k = b.k full join bhist bh on bh.k = coalesce(b.k, t.k)) z), '{}'));
$$;

-- activity lines show the package number even after it's used up
create or replace function _proc_event(p_type text, p_pallet bigint, p_lbs numeric, p_details jsonb, p_note text default null) returns void
language sql security definer set search_path = public as $$
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (current_email(), p_type, p_pallet, p_lbs, p_note, coalesce(p_details, '{}') || jsonb_build_object('code', (select code from pallets where id = p_pallet)))
$$;

select strain, wet_lbs, bucked, round(bucked / nullif(wet_lbs, 0) * 100, 1) as bucked_pct_of_wet from proc_yield_history where crop_year = 2025 order by 1;

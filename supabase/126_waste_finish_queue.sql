-- 126: queue harvest waste + finish for the 3 harvests caught up in METRC on 10/29 (approved by Aziz).
-- Waste = what METRC has left on each harvest (wet - packaged). Due 48 hours from now, so the METRC to-do list shows the
-- countdown; each finish waits for its waste step (same harvest, lower to-do number).
--   Strawberry Chelada OHR-StrawberryChelada-Frozen-102026: 5,545.51 wet - 4,164.1 packaged = 1,381.41
--   Funk Mintz         OHR-FunkMintz-Frozen-100826:        6,077.2 wet - 4,137.52 packaged = 1,939.68
--   Swampwater Fumez   OHR-SwampwaterFumez-Frozen-100326:  4,724.8 wet - 3,349.5 packaged  = 1,375.3
begin;
with h(hid, strain, batch, waste) as (values
  (123, 'Strawberry Chelada', 'OHR-StrawberryChelada-Frozen-102026', 1381.41),
  (104, 'Funk Mintz',         'OHR-FunkMintz-Frozen-100826',         1939.68),
  (19,  'Swampwater Fumez',   'OHR-SwampwaterFumez-Frozen-100326',   1375.3)
)
insert into comp_metrc_actions (at, license, kind, action, harvest_id, lbs, summary, status, due_at, details)
select now(), 'CCL25-0000017', k.kind, k.action, h.hid, case when k.kind = 'harvest_waste' then h.waste end,
       h.strain || ' · ' || h.batch, 'todo', now() + interval '48 hours',
       jsonb_build_object('type', k.kind, 'harvest_id', h.hid, 'batch', h.batch, 'strain', h.strain, 'site', 'OHR',
                          'due', now() + interval '48 hours', 'by', 'aziz@lifted-organics.com',
                          'note', case when k.kind = 'harvest_waste' then h.waste || ' lb waste (wet minus packaged in METRC)' else 'Finish after the waste' end)
  from h cross join (values (1, 'harvest_waste', 'Record harvest waste'), (2, 'harvest_finish', 'Finish harvest')) as k(ord, kind, action)
 where not exists (select 1 from comp_metrc_actions a where a.harvest_id = h.hid and a.kind = k.kind and a.status in ('todo','error'))
 order by h.hid, k.ord;
select id, kind, summary, lbs, due_at from comp_metrc_actions where at = now() order by id;
commit;

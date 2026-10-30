-- 128: queue waste + finish for Chiquita Diesel 10/29 (app harvest 129), approved by Aziz.
-- METRC: 3,097 plants, 10,228.64 wet (Jordan's 10,219 + 9.64 placeholder for the last 964 plants), 7,554.68 packaged
-- (P901-P912) = 2,673.96 waste. Due 48 hours from now (Oct 31 PT); the finish waits for the waste.
insert into comp_metrc_actions (at, license, kind, action, harvest_id, lbs, summary, status, due_at, details)
select now(), 'CCL25-0000017', k.kind, k.action, 129, case when k.kind = 'harvest_waste' then 2673.96 end,
       'Chiquita Diesel · Chiquita Diesel 10/29', 'todo', now() + interval '48 hours',
       jsonb_build_object('type', k.kind, 'harvest_id', 129, 'batch', 'Chiquita Diesel 10/29', 'strain', 'Chiquita Diesel', 'site', 'OHR',
                          'due', now() + interval '48 hours', 'by', 'aziz@lifted-organics.com',
                          'note', case when k.kind = 'harvest_waste' then '2,673.96 lb waste (10,228.64 wet - 7,554.68 packaged)' else 'Finish after the waste' end)
  from (values (1, 'harvest_waste', 'Record harvest waste'), (2, 'harvest_finish', 'Finish harvest')) as k(ord, kind, action)
 where not exists (select 1 from comp_metrc_actions a where a.harvest_id = 129 and a.kind = k.kind and a.status in ('todo','error'))
 order by k.ord
returning id, kind, lbs, due_at;

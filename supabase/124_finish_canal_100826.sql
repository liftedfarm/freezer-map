-- 124: finish Canal St Runtz OHR-CanalStRuntz-Frozen-100826 in METRC (0 lb left after P525/P526, approved by Aziz 10/29).
-- Queued as to-do #577; the app sent it (done).
insert into comp_metrc_actions (at, license, kind, action, harvest_id, summary, status, details)
select now(), 'CCL25-0000017', 'harvest_finish', 'Finish harvest', 55, 'Canal St Runtz · OHR-CanalStRuntz-Frozen-100826', 'todo',
       jsonb_build_object('type','harvest_finish','harvest_id',55,'batch','OHR-CanalStRuntz-Frozen-100826','by','aziz@lifted-organics.com','note','0 lb left, no waste (approved 10/29)')
 where not exists (select 1 from comp_metrc_actions where kind = 'harvest_finish' and harvest_id = 55 and status in ('todo','error'))
returning id;

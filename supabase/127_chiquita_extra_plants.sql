-- 127: Chiquita Diesel 10/29 (app harvest 129). METRC had 3,097 plants in Field 2; Jordan harvested 2,133 in the app with
-- 10,219 lb wet (his weight is the whole field). Per Aziz (plan A): add the other 964 plants to the same METRC harvest at the
-- minimum 0.01 lb each (9.64 lb), since METRC won't take plants without weight. The 9.64 lb goes out as waste at finish.
insert into comp_metrc_actions (at, license, kind, action, harvest_id, lbs, summary, status, details)
select now(), 'CCL25-0000017', 'harvest_plants', 'Harvest plants', 129, 9.64, 'Chiquita Diesel · Chiquita Diesel 10/29 · 964 plants (0.01 lb each)', 'todo',
       jsonb_build_object('type','harvest_plants','harvest_id',129,'batch','Chiquita Diesel 10/29','plants',964,'metrc_location','Field 2',
                          'strain','Chiquita Diesel','site','OHR','by','aziz@lifted-organics.com',
                          'note','Rest of Field 2 per Aziz; Jordan''s 10,219 lb covers the whole field, 0.01 lb/plant placeholder')
 where not exists (select 1 from comp_metrc_actions where harvest_id = 129 and kind = 'harvest_plants' and status in ('todo','error'))
returning id;

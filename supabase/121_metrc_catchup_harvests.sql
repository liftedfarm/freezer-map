-- 121: METRC catch-up for the 10/20 pallets (approved by Aziz 10/29). Queues METRC to-dos; the app sends them.
-- Weights are the Farm Data OHR 2026 "Harvest METRC" raw weights, minus what METRC already has (read live 10/29 night).
--   Swampwater Fumez  OHR-SwampwaterFumez-Frozen-100326: METRC 699 plants / 2,065.4052 lb wet. Sheet 1,599 / 4,724.8.
--     + 900 plants (Field 1-C) / 2,659.3948 lb. Then package P182 650, P183 650, P186 99.5.
--   Funk Mintz        OHR-FunkMintz-Frozen-100826: METRC 470 / 2,084.873. Sheet raw 6,077.2. All 1,000 plants left in 1-B.
--     + 1,000 plants / 3,992.327 lb. Then package P330, P332-P336 (3,864.48). App harvest goes to 1,470 plants.
--   Canal St Runtz    P525/P526 (10/14) packaged from OHR-CanalStRuntz-Frozen-100826 (304.94 lb left):
--     P526 182.98, P525 121.96, then adjust P525 +528.04 to 650 (Scale Variance).
--   Strawberry Chelada OHR-StrawberryChelada-Frozen-102026 (new in METRC): all 1,531 plants in Field 1-C, sheet raw 5,545.51 lb.
--     Then package P701-P707 (4,164.1). P701-P707 move from duplicate app harvest 189 to harvest 123.
begin;

-- app: Strawberry Chelada pallets onto harvest 123, duplicate 189 removed; plant counts
update pallets set harvest_id = 123, updated_at = now() where harvest_id = 189;
delete from cult_harvests where id = 189 and not exists (select 1 from pallets where harvest_id = 189);
update cult_harvests set plants_harvested = 1531, ff_lbs = 4164.1, updated_at = now() where id = 123;
update cult_harvests set plants_harvested = 1470, metrc_plants = 1470, updated_at = now() where id = 104;

-- harvest plants
insert into comp_metrc_actions (at, license, kind, action, harvest_id, lbs, summary, status, details)
values
 (now(), 'CCL25-0000017', 'harvest_plants', 'Harvest plants', 19, 2659.3948, 'Swampwater Fumez · OHR-SwampwaterFumez-Frozen-100326 · 900 plants', 'todo',
  jsonb_build_object('type','harvest_plants','harvest_id',19,'batch','OHR-SwampwaterFumez-Frozen-100326','plants',900,'metrc_location','Field 1-C','strain','Swampwater Fumez','site','OHR','by','aziz@lifted-organics.com','note','Catch-up 10/29: sheet 1,599 plants / 4,724.8 lb raw')),
 (now(), 'CCL25-0000017', 'harvest_plants', 'Harvest plants', 104, 3992.327, 'Funk Mintz · OHR-FunkMintz-Frozen-100826 · 1,000 plants', 'todo',
  jsonb_build_object('type','harvest_plants','harvest_id',104,'batch','OHR-FunkMintz-Frozen-100826','plants',1000,'metrc_location','Field 1-B','strain','Funk Mintz','site','OHR','by','aziz@lifted-organics.com','note','Catch-up 10/29: sheet raw 6,077.2 lb; all plants left')),
 (now(), 'CCL25-0000017', 'harvest_plants', 'Harvest plants', 123, 5545.51, 'Strawberry Chelada · OHR-StrawberryChelada-Frozen-102026 · 1,531 plants', 'todo',
  jsonb_build_object('type','harvest_plants','harvest_id',123,'batch','OHR-StrawberryChelada-Frozen-102026','plants',1531,'metrc_location','Field 1-C','strain','Strawberry Chelada','site','OHR','by','aziz@lifted-organics.com','note','Catch-up 10/29: sheet raw 5,545.51 lb; all plants'));

-- packages from harvests (each waits for its harvest's plants step)
insert into comp_metrc_actions (at, license, kind, action, harvest_id, pallet_id, code, tag, lbs, summary, status, touch_tags, details)
select now(), 'CCL25-0000017', 'harvest_package', 'Create package from harvest', x.hid, p.id, p.code, p.package_tag, coalesce(x.qty, p.og_weight),
       p.code || ' · ' || p.strain || ' · ' || x.batch, 'todo', array[upper(p.package_tag)],
       jsonb_build_object('harvest_id', x.hid, 'batch', x.batch, 'by', 'aziz@lifted-organics.com', 'note', 'Catch-up 10/29')
       || case when x.qty is not null then jsonb_build_object('type', 'proc_wet') else '{}'::jsonb end
  from (values
    ('P182', 19, 'OHR-SwampwaterFumez-Frozen-100326', null::numeric), ('P183', 19, 'OHR-SwampwaterFumez-Frozen-100326', null), ('P186', 19, 'OHR-SwampwaterFumez-Frozen-100326', null),
    ('P330', 104, 'OHR-FunkMintz-Frozen-100826', null), ('P332', 104, 'OHR-FunkMintz-Frozen-100826', null), ('P333', 104, 'OHR-FunkMintz-Frozen-100826', null),
    ('P334', 104, 'OHR-FunkMintz-Frozen-100826', null), ('P335', 104, 'OHR-FunkMintz-Frozen-100826', null), ('P336', 104, 'OHR-FunkMintz-Frozen-100826', null),
    ('P526', 55, 'OHR-CanalStRuntz-Frozen-100826', null), ('P525', 55, 'OHR-CanalStRuntz-Frozen-100826', 121.96),
    ('P701', 123, 'OHR-StrawberryChelada-Frozen-102026', null), ('P702', 123, 'OHR-StrawberryChelada-Frozen-102026', null), ('P703', 123, 'OHR-StrawberryChelada-Frozen-102026', null),
    ('P704', 123, 'OHR-StrawberryChelada-Frozen-102026', null), ('P705', 123, 'OHR-StrawberryChelada-Frozen-102026', null), ('P706', 123, 'OHR-StrawberryChelada-Frozen-102026', null),
    ('P707', 123, 'OHR-StrawberryChelada-Frozen-102026', null)
  ) as x(code, hid, batch, qty)
  join pallets p on p.code = x.code and p.status = 'in_freezer'
 order by x.hid, x.code;

-- P525 up to 650 after it's packaged
insert into comp_metrc_actions (at, license, kind, action, pallet_id, code, tag, lbs, summary, status, touch_tags, details)
select now(), 'CCL25-0000017', 'adjust', 'Adjust package weight (Scale variance)', p.id, p.code, p.package_tag, 650,
       'P525 · Canal St Runtz · 121.96 > 650', 'todo', array[upper(p.package_tag)],
       jsonb_build_object('reason', 'scale', 'to', 650, 'by', 'aziz@lifted-organics.com',
                          'note', 'Packaged from the 10/08 harvest (only 304.94 lb left); brought up to the Farm Data weight')
  from pallets p where p.code = 'P525' and p.status = 'in_freezer';

select id, kind, code, lbs, summary from comp_metrc_actions where at = now() order by id;
commit;

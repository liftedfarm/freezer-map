-- Trial (T) pallets: strain names and weights from Farm Data OHR 2026.xlsx, "Trials Frozen Harvest" sheet.
-- Only updates T pallets already in the app. Safe to re-run. Pallet numbers T005-T028 are blank on the sheet and
-- were taken from row order (they sit between T004 and T029).
begin;

create temp table trials (code text, strain text, zone text, weight numeric, harvest_date date, planting_date date, uid text, note text) on commit drop;
insert into trials values
('T001','Strawberry Chocolate #30','Block 3',127.84,'2026-10-02','2026-07-21','ABC06030007AD3D000000801',null),
('T002','SBC26 x Permanent Marker #31','Block 3',53.7,'2026-10-02','2026-07-21','ABC06030007AD3D000000802',null),
('T003','Garlic Grapes x Pack Mule #26','Block 3',146.74,'2026-10-02','2026-07-21','ABC06030007AD3D000000803',null),
('T004','Canal St Runtz x Oreoz #41','Block 3',110.54,'2026-10-02','2026-07-21','ABC06030007AD3D000000804',null),
('T006','Country Rose','Block 3',137.9,'2026-10-17','2026-07-21','ABC06030007AD3D000000806',null),
('T007','Runtz','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000807','Runtz UID 806, Pallet # 007 KeyLime BBM'),
('T008','Key Lime Blueberry Muffin','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000808',null),
('T009','SFV OG x Lemon Kush','Block 3',202.76,'2026-10-17','2026-07-21','ABC06030007AD3D000000809',null),
('T010','Local Skunk Hashplant','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000810',null),
('T011','Lime Belts x Hashburger #19','Block 3',231.26,'2026-10-17','2026-07-21','ABC06030007AD3D000000811','found both 811 and 810 uid for #19'),
('T012','Lime Belts x Hashburger #19','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000812','found both 811 and 810 uid for #19'),
('T013','Strawberry Chocolate #18','Block 3',166.54,'2026-10-17','2026-07-21','ABC06030007AD3D000000813',null),
('T014','Blackberry Maple #10','Block 3',132.7,'2026-10-17','2026-07-21','ABC06030007AD3D000000814',null),
('T015','Blackberry Maple #11','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000815','uid 827 and 814'),
('T016','Mule Fuel x Hashburger #14','Block 3',151.42,'2026-10-16','2026-07-21','ABC06030007AD3D000000816',null),
('T017','Mule Fuel x Hashburger #20','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000817',null),
('T018','Honey Banana x Pomelo Punch #9','Block 3',197.92,'2026-10-16','2026-07-21','ABC06030007AD3D000000818',null),
('T019','Pressure x Nam Wah #3','Block 3',362.46,'2026-10-16','2026-07-21','ABC06030007AD3D000000819',null),
('T020','Garlic Juice x Pressure #9','Block 3',null,'2026-10-16','2026-07-21','ABC06030007AD3D000000820',null),
('T021','Honey Banana x Nam Wah #27','Block 3',296.28,'2026-10-16','2026-07-21','ABC06030007AD3D000000821','different pallet number from uid'),
('T022','Moroccan Peaches x Donny Burger #74','Block 3',80.27,'2026-10-17','2026-07-21','ABC06030007AD3D000000822',null),
('T023','Moroccan Peaches x Donny Burger #79','Block 3',269.58,'2026-10-17','2026-07-21','ABC06030007AD3D000000823',null),
('T024','Darryl Strawberry','Block 3',171.34,'2026-10-17','2026-07-21','ABC06030007AD3D000000824','30.38 more 10/19/2026'),
('T025','SBC26 x Permanent Marker #34','Block 3',86.18,'2026-10-17','2026-07-21','ABC06030007AD3D000000825','Not Sure'),
('T026','Black Truffle x Pack Mule #6','Block 3',65.02,'2026-10-17','2026-07-21','ABC06030007AD3D000000826','the real number 6'),
('T027','Garlic Grapes x Pack Mule #17','Block 3',30.08,'2026-10-17','2026-07-21','ABC06030007AD3D000000827','Don’t think this is the correct strain'),
('T028','Blackberry Maple #11','Block 3',null,'2026-10-17','2026-07-21','ABC06030007AD3D000000828','uid 827 and 814'),
('T029','Governmint Oasis x Pack Mule #9','Block 3',73.8,'2026-10-19','2026-07-21','ABC06030007AD3D000000828',null),
('T030','Garlic Juice x Pressure #33','Block 3',477.6,'2026-10-19','2026-07-21','ABC06030007AD3D000000827',null),
('T031','Donny Burger x Pressure #33','Block 3',163.36,'2026-10-19','2026-07-21','ABC06030007AD3D000000829',null),
('T032','Governmint Oasis x Pack Mule #15','Block 3',165.1,'2026-10-19','2026-07-21','ABC06030007AD3D000000830',null),
('T033','Pressure x Nam Wah #2','Block 3',322.98,'2026-10-19','2026-07-21','ABC06030007AD3D000000831',null),
('T034','GMO x Mule Fuel #21','Block 3',186.64,'2026-10-19','2026-07-21','ABC06030007AD3D000000832',null),
('T035','Garlic Grapes x Pack Mule #17','Block 3',253.48,'2026-10-19','2026-07-21','ABC06030007AD3D000000833',null),
('T036','Black Trufle x Pack Mule #6','Block 3',114.04,'2026-10-19','2026-07-21','ABC06030007AD3D000000834','mixed strain (more green)'),
('T037','Perle Di Sole x Rainbow Guava #8','Block 3',243.38,'2026-10-19','2026-07-21','ABC06030007AD3D000000835',null),
('T038','Honey Banana x Pomelo Punch #7','Block 3',334.34,'2026-10-19','2026-07-21','ABC06030007AD3D000000836',null),
('T039','Black Truffle x Pack Mule #37','Block 3',163.34,'2026-10-19','2026-07-21','ABC06030007AD3D000000837',null),
('T040','Sour Diesel x Donny Burger #55','Block 3',139.16,'2026-10-19','2026-07-21','ABC06030007AD3D000000838',null),
('T041','Sour Diesel x Donny Burger #75','Block 3',196.86,'2026-10-19','2026-07-21','ABC06030007AD3D000000839',null),
('T042','Grape Grape','Block 3',104.58,'2026-10-19','2026-07-21','ABC06030007AD3D000000840',null),
('T043','Donny Burger x Pressure #65','Block 3',177.14,'2026-10-19','2026-07-21','ABC06030007AD3D000000841',null),
('T044','Donny Burger x Pressure #96','Block 3',182.34,'2026-10-19','2026-07-21','ABC06030007AD3D000000842',null),
('T045','Lemon Tree x Trop Cherry #28','Block 3',192.24,'2026-10-19','2026-07-21','ABC06030007AD3D000000843',null),
('T046','Honey Banana x Nam Wah #32','Block 3',429.76,'2026-10-19','2026-07-21','ABC06030007AD3D000000844',null),
('T047','Moroccan Peaches x Donny Burger #54','Block 3',189.0,'2026-10-19','2026-07-21','ABC06030007AD3D000000845',null),
('T048','Moroccan Peaches x Donny Burger #73','Block 3',154.8,'2026-10-19','2026-07-21','ABC06030007AD3D000000846',null),
('T049','Toad Venom','Block 3',97.74,'2026-10-19','2026-07-21','ABC06030007AD3D000000847',null);

create temp table hit on commit drop as
  select p.id, p.strain as old_strain, p.current_weight as old_w, t.*
    from pallets p join trials t on t.code = upper(p.code)
   where p.status in ('in_freezer','unslotted','in_transit')
     and (p.strain is distinct from t.strain or (t.weight is not null and p.current_weight is distinct from t.weight));

update pallets p set
    strain = coalesce(t.strain, p.strain),
    zone = coalesce(t.zone, p.zone),
    harvest_date = coalesce(t.harvest_date, p.harvest_date),
    planting_date = coalesce(t.planting_date, p.planting_date),
    current_weight = coalesce(t.weight, p.current_weight),
    og_weight = coalesce(p.og_weight, t.weight),
    -- the sheet's UID only when its row has no note questioning it, and nobody else has that tag
    package_tag = case when p.package_tag is null and t.note is null and tag_in_use(t.uid, p.id) is null then t.uid else p.package_tag end,
    notes = case when t.note is null then p.notes else concat_ws(' | ', p.notes, 'Trials sheet: ' || t.note) end,
    needs_review = nullif(concat_ws('; ',
        nullif(regexp_replace(coalesce(p.needs_review, ''), '(^|; )?Not in pallet list(; )?', '', 'g'), ''),
        case when t.weight is null then 'No weight on the trials sheet yet' end,
        case when t.note is not null then 'Check trials sheet note: ' || t.note end), ''),
    updated_at = now()
  from trials t where t.code = upper(p.code) and p.id in (select id from hit);

insert into events (user_email, type, pallet_id, lbs, note, details)
select 'sheet sync', 'sheet_sync', h.id, h.weight, 'Trials Frozen Harvest (Farm Data OHR 2026)',
       jsonb_build_object('strain', h.strain, 'weight', h.weight, 'was_strain', h.old_strain, 'was_weight', h.old_w)
  from hit h;

do $$
begin
  if to_regclass('public.strains') is not null then
    insert into strains (name, notes)
    select distinct on (lower(t.strain)) t.strain, 'Trial strain'
      from trials t join pallets p on upper(p.code) = t.code
     where t.strain is not null
       and not exists (select 1 from strains s where lower(s.name) = lower(t.strain) or lower(t.strain) = any(select lower(a) from unnest(s.aliases) a));
  end if;
end $$;

select h.code, h.strain, h.weight, coalesce(h.note, '') as sheet_note from hit h order by h.code;
select string_agg(t.code, ', ' order by t.code) as on_sheet_but_not_in_app
  from trials t where not exists (select 1 from pallets p where upper(p.code) = t.code);
commit;

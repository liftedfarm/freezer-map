-- 147_stale_harvests.sql  (Msg TAG-16, 2026-10-30, run live by Claude after Aziz's go)
-- Leftover schedule rows that were already harvested under another app harvest / METRC harvest (nothing logged on them):
--   133 Nam Wah GVR (done as 132; METRC GVR-NamWah-Frozen-093026), 121 Madd Fruit (METRC OHR-200-Frozen-102126),
--   70 Garlic Cocktail 1B (METRC OHR-0098-Frozen-102026 with 1C), 99 MB x BP x P #9 + 119 MBxBP x Pressure #5
--   (METRC OHR-0196-Frozen-101526, packaged as Molten Grapes / Turbo Snax).
-- Strawberry Chelada 123: METRC has all 1,531 plants harvested; the app's METRC plant count (484) was stale.
begin;
update cult_harvests set status = 'cancelled', stage = null, notes = concat_ws(' ', notes, '| Cancelled 10/30 (Msg TAG-16): already harvested under another app harvest / METRC harvest.'),
       updated_by = 'aziz@lifted-organics.com', updated_at = now()
 where id in (133, 121, 70, 99, 119) and status = 'planned' and stage is null
   and not exists (select 1 from pallets p where p.harvest_id = cult_harvests.id)
   and not exists (select 1 from cult_weights w where w.harvest_id = cult_harvests.id);
update cult_harvests set metrc_plants = 1531, updated_at = now() where id = 123 and metrc_plants = 484;
insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'harvest_fix', '147 stale harvests cancelled, Strawberry Chelada METRC plants 1531',
        jsonb_build_object('cancelled', jsonb_build_array(133, 121, 70, 99, 119), 'harvest_123_metrc_plants', 1531));
commit;
-- Also 10/30: Claude pushed harvests 233, 234, 181, 182 (cult_push as Aziz, Plan A). METRC to-dos #671-#678 all done.

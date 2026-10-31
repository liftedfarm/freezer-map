-- 144_cancel_t049_metrc.sql  (Msg TAG-12, 2026-10-30)
-- Aziz: cancel the METRC to-dos for T049 (Frozen Banana x Pressure #18, harvest 219).
-- #656 (harvest plants) failed: METRC has no flowering Frozen Banana x Pressure #18 plants in Field 2 (or anywhere on OHR).
-- #657 (package on 849) was waiting on it. Nothing reached METRC, so the harvest goes back to "not sent":
-- pallet T049 not pushed, raw bins not pushed, METRC plants / wet back to 0, and the saved METRC name cleared
-- (it gets the new-format name when it's pushed again).
begin;
update comp_metrc_actions set status = 'skipped', note = 'Cancelled (Aziz, Msg TAG-12): no Frozen Banana x Pressure #18 plants in METRC',
       done_by = 'aziz@lifted-organics.com', done_at = now()
 where id in (656, 657) and status in ('todo', 'error');
update pallets set pushed = false, updated_at = now() where id = 2048 and code = 'T049';
update cult_weights set pushed = false where harvest_id = 219 and kind = 'raw';
update cult_harvests set metrc_plants = 0, metrc_wet_lbs = 0, metrc_name = null, updated_by = 'aziz@lifted-organics.com', updated_at = now() where id = 219;
insert into events (user_email, type, pallet_id, lbs, note, details)
values ('aziz@lifted-organics.com', 'harvest_fix', 2048, 393.4, '144: METRC to-dos #656/#657 cancelled, T049 back to not pushed',
        jsonb_build_object('harvest_id', 219, 'todos', jsonb_build_array(656, 657)));
commit;

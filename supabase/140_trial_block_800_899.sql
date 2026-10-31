-- 140_trial_block_800_899.sql  (Msg TAG-6, 2026-10-30)
-- Aziz: 100 trial tags per year. 2026 trial pallets = ABC06030007AD3D 800-899 (T000-T099).
-- After harvest, shrink to what was used; next year gets a new range.
begin;
update tag_ranges set last_n = 899, notes = 'Trial pallet tags 2026, T000-T099 (tag rule, 139/140)'
 where reserved and license = 'CCL25-0000017' and purpose = 'harvest' and prefix = 'ABC06030007AD3D' and first_n = 800;
insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'tag_rule', 'OHR T block 800-899 (140)', jsonb_build_object('prefix', 'ABC06030007AD3D', 'block', '800-899'));
commit;
-- Undo: update tag_ranges set last_n = 999 where reserved and license = 'CCL25-0000017' and prefix = 'ABC06030007AD3D' and first_n = 800;

-- 139_trial_tag_rule.sql  (Msg TAG-3, 2026-10-30)
-- Trial pallets get their own tag rule on OHR, like P and G pallets:
--   T048 -> ABC06030007AD3D000000848  (prefix ABC06030007AD3D, offset 800, 9 digits)
-- and the trial tags ABC...800-999 are blocked off for harvest pallets, so the Harvest screen's
-- tag box offers them (it only offered the P block 1A4...10001-19999 before) and stops showing
-- the false "not on METRC's available list" warning.
-- Side effect: ABC...800-999 are no longer suggested for splits, combines or new packages.
-- Re-runnable.
begin;

insert into tag_rules (site, letter, prefix, "offset", digits, license, active, notes, updated_by, updated_at)
values ('OHR', 'T', 'ABC06030007AD3D', 800, 9, 'CCL25-0000017', true,
        'Trial pallets: T048 = ABC...848 (139, Msg TAG-3)', 'aziz@lifted-organics.com', now())
on conflict (site, letter) do update set prefix = excluded.prefix, "offset" = excluded."offset", digits = excluded.digits,
       license = excluded.license, active = true, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now();

insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, active, notes, license, reserved)
select 'OHR', 'harvest', 'ABC06030007AD3D', 800, 999, 9, true, 'Trial pallet tags T000-T199 (tag rule, 139)', 'CCL25-0000017', true
 where not exists (select 1 from tag_ranges where reserved and license = 'CCL25-0000017' and purpose = 'harvest'
                     and prefix = 'ABC06030007AD3D' and first_n = 800 and last_n = 999);

insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'tag_rule', 'OHR T (139)',
        jsonb_build_object('site', 'OHR', 'letter', 'T', 'prefix', 'ABC06030007AD3D', 'offset', 800, 'block', '800-999'));

commit;

-- Undo:
-- delete from tag_rules where site = 'OHR' and letter = 'T';
-- delete from tag_ranges where reserved and license = 'CCL25-0000017' and prefix = 'ABC06030007AD3D' and first_n = 800 and last_n = 999;

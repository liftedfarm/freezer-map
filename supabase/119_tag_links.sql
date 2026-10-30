-- 119: app-only tag links from the 10/29 audit. No METRC writes.
-- DN3 (Super Buff Cherry bucked 513 lb) = METRC 1A4...7150 on 679 (513 lb, made 10/21 from the ...0316 unbucked lot).
-- P404 (NamBuster 650 lb) had a mistyped tag. METRC has it on 017 as ...0001404 (650 lb, packaged 10/11).
-- G43-1 (Soulberry 18 lb) was split off G43 in the app only. METRC still has one package, ...0043 on 679 at 18.48 lb.
--   G43-1 takes G43's tag and the full 18.48 lb, and the 0.48 lb G43 stub is archived.
-- Run once in Supabase. Safe to re-run.
begin;

update pallets p set package_tag = m.label, tag_pending = false, updated_at = now()
  from metrc_packages m
 where p.code = 'DN3' and p.package_tag is null
   and m.license = 'CCL21-0000679' and m.state = 'active' and m.label like '%00007150' and m.item ilike '%Super Buff Cherry%Bucked%';

update pallets p set package_tag = m.label, updated_at = now()
  from metrc_packages m
 where p.code = 'P404' and p.status = 'in_freezer' and p.package_tag not like '%0001404'
   and m.license = 'CCL25-0000017' and m.state = 'active' and m.label like '%0001404' and m.item ilike '%NamBuster%';

with g as (select id, package_tag from pallets where code = 'G43' and status = 'in_freezer')
update pallets p set package_tag = g.package_tag, tag_pending = false, current_weight = 18.48, updated_at = now()
  from g where p.code = 'G43-1' and p.status = 'in_freezer' and p.package_tag is null;
update pallets set status = 'archived', slot_id = null, needs_review = 'Merged back into G43-1 (split was app-only)', updated_at = now()
 where code = 'G43' and status = 'in_freezer' and current_weight < 1
   and exists (select 1 from pallets where code = 'G43-1' and package_tag is not null);

insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, 'Tag linked to METRC (inventory audit 10/29)', jsonb_build_object('tag', package_tag)
  from pallets where code in ('DN3', 'P404', 'G43-1');

-- the G43-1 split to-do is moot now
update comp_metrc_actions set status = 'done', done_by = 'aziz@lifted-organics.com', done_at = now(),
       note = 'Split was app-only; merged back (inventory audit 10/29). Nothing to send.'
 where status = 'todo' and code in ('G43-1', 'G43') and kind in ('split', 'tag');

select code, status, package_tag, current_weight from pallets where code in ('DN3', 'P404', 'G43', 'G43-1') order by code;
commit;

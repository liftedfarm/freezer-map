-- 118: app-only inventory fixes from the 10/29 audit. No METRC writes.
-- 1. DN5 (#1 Wilson Zero wet lot, run B-261023-2) gets its METRC tag. METRC has it active on GVR 679 as
--    ABC06030007AD3D000010000, 5,603.85 lb (harvest OHR-#1 Wilson Zero-Dry-100626). The run's open to-dos
--    (#161 D7169, #162 DN8, #163 use DN5) stay open for the METRC plan.
-- 2. 21 pallets the freezer map still shows at GVR are already finished in METRC (19 transferred 017/175 > 679
--    and finished there, W25 and W41 finished on 017) and aren't in Roshi. Closed as used (depleted, 0 lb).
--    Their auto "finish package" to-dos are marked done in the same transaction so nothing gets sent.
-- Run once in Supabase. Safe to re-run (skips anything already closed).
begin;

update pallets set package_tag = 'ABC06030007AD3D000010000', tag_pending = false, updated_at = now()
 where code = 'DN5' and package_tag is null;
insert into events (user_email, type, pallet_id, note, details)
select 'aziz@lifted-organics.com', 'tag_audit', id, 'Linked to METRC wet package on GVR 679 (inventory audit 10/29)',
       jsonb_build_object('tag', 'ABC06030007AD3D000010000', 'metrc_lbs', 5603.85)
  from pallets where code = 'DN5';

with gone as (
  select p.* from pallets p
   where p.code in ('W202','W448','G1','W162','W605','W608','W476','W491','W452','W443','W274','W25','W170','W41',
                    'G39','W283','G35','W469','W470','G185','G20')
     and p.status in ('in_freezer','unslotted')
), ev as (
  insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
  select 'aziz@lifted-organics.com', 'removed', g.id, g.slot_id, g.current_weight,
         'Already finished in METRC, not in Roshi (inventory audit 10/29). App-only close.',
         jsonb_build_object('reason', 'used', 'weight', g.current_weight, 'tag', g.package_tag, 'audit', '2026-10-29')
    from gone g
  returning pallet_id
)
update pallets set status = 'depleted', current_weight = 0, slot_id = null, container_id = null, updated_at = now()
 where id in (select pallet_id from ev);

delete from load_items i using loads l, pallets p
 where l.id = i.load_id and p.id = i.pallet_id and l.status in ('planning','loading')
   and p.code in ('W202','W448','G1','W162','W605','W608','W476','W491','W452','W443','W274','W25','W170','W41',
                  'G39','W283','G35','W469','W470','G185','G20') and p.status = 'depleted';

update comp_metrc_actions set status = 'done', done_by = 'aziz@lifted-organics.com', done_at = now(),
       note = 'Already finished in METRC (inventory audit 10/29). Nothing to send.'
 where status = 'todo' and event_id in (select id from events where type = 'removed' and details ->> 'audit' = '2026-10-29');

select (select count(*) from pallets where status = 'depleted' and code in ('W202','W448','G1','W162','W605','W608','W476','W491',
         'W452','W443','W274','W25','W170','W41','G39','W283','G35','W469','W470','G185','G20')) as closed,
       (select package_tag from pallets where code = 'DN5') as dn5_tag,
       (select count(*) from comp_metrc_actions where event_id in (select id from events where type = 'removed' and details ->> 'audit' = '2026-10-29')) as todos_marked_done;
commit;

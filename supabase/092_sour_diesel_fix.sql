-- 092: Sour Diesel (East Coast) OHR fix, 10/28. One-time data fix, run once in Supabase.
-- METRC batch OHR-0047-Frozen-102126 (#215) holds all 1,183 plants and 3,947.2 lb wet. 794.9 lb of that isn't packaged yet.
-- The 325 plants harvested today (#112) can't go into METRC (no plants left), so their weight rides on #215:
--   * today's 11 raw bins move to #215, marked as already in METRC (so Push won't send them)
--   * P850 (650 lb) and P851 move to #215, keeping their 10/28 harvest date
--   * P851 drops to 144.9 lb (what's left in the batch after P850) and is flagged: the real weight is 536.92 lb, adjust +392.02 later
--   * #112 (today) and #111 (duplicate) are cancelled
-- Afterward, in the app: Reopen #215, Push (P850 and P851), Finish. Waste comes out to 0.
begin;

do $$
declare left_ numeric;
begin
  if (select status from cult_harvests where id = 112) = 'cancelled' then raise exception 'Already run'; end if;
  select h.metrc_wet_lbs - coalesce(sum(p.og_weight) filter (where p.pushed and p.status <> 'archived'), 0) into left_
    from cult_harvests h left join pallets p on p.harvest_id = h.id where h.id = 215 group by h.metrc_wet_lbs;
  if round(left_, 2) <> 794.90 then raise exception 'Expected 794.9 lb left in #215, found %', left_; end if;
end $$;

update cult_weights set harvest_id = 215, pushed = true,
       note = concat_ws(' · ', note, 'Logged 10/28 on #112 (last 325 plants). Not sent to METRC: all plants were already in OHR-0047-Frozen-102126')
 where harvest_id = 112 and kind = 'raw';

update pallets set harvest_id = 215, harvest_date = '2026-10-28', updated_at = now() where id in (1926, 1927);

insert into events (user_email, type, pallet_id, lbs, note, details)
values ('aziz@lifted-organics.com', 'weight_adjust', 1927, 144.9, 'Sour Diesel fix: packaged at what was left in OHR-0047-Frozen-102126',
        jsonb_build_object('from', 536.92, 'to', 144.9, 'real_lbs', 536.92));
update pallets set og_weight = 144.9, current_weight = 144.9, updated_at = now(),
       needs_review = 'Needs METRC adjustment: real weight 536.92 lb. Packaged at 144.9 lb so the packages match the harvest wet weight. Adjust +392.02 lb in METRC and in the app.'
 where id = 1927;
insert into events (user_email, type, pallet_id, note, details)
values ('aziz@lifted-organics.com', 'review_flagged', 1927,
        'Needs METRC adjustment: real weight 536.92 lb. Packaged at 144.9 lb so the packages match the harvest wet weight. Adjust +392.02 lb in METRC and in the app.',
        jsonb_build_object('was', null));

update cult_harvests set status = 'cancelled', stage = null, updated_by = 'aziz@lifted-organics.com', updated_at = now(),
       notes = concat_ws(E'\n', notes, '10/28: cancelled. Bins and pallets P850, P851 moved to #215 (OHR-0047-Frozen-102126).')
 where id = 112;
update cult_harvests set status = 'cancelled', stage = null, updated_by = 'aziz@lifted-organics.com', updated_at = now(),
       notes = concat_ws(E'\n', notes, '10/28: cancelled, duplicate of #215.')
 where id = 111;
update cult_harvests set notes = concat_ws(E'\n', notes, '10/28: last 325 plants harvested (was #112). Their 1,402 lb raw weight and P850, P851 added here; METRC plants and wet weight unchanged.')
 where id = 215;

select h.id, h.status, h.metrc_wet_lbs,
       (select round(sum(lbs), 1) from cult_weights where harvest_id = h.id and kind = 'raw') as raw_lbs,
       (select string_agg(code || ' ' || og_weight || case when pushed then '' else ' (to push)' end, ', ' order by id) from pallets where harvest_id = h.id) as pallets
  from cult_harvests h where h.id in (111, 112, 215) order by h.id;

commit;

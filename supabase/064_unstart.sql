-- 064: "Didn't start" in the Harvest log: a harvest opened by mistake goes back on the schedule (same planned date).
-- Only while nothing is logged on it (no bins/weights, no pallets, nothing sent to METRC).
-- A harvest that won't happen at all is taken off the Schedule instead. Safe to run twice.

set client_min_messages = warning;

create or replace function cult_unstart(p_harvest bigint) returns cult_harvests
language plpgsql security definer set search_path = public as $$
declare h cult_harvests;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.status <> 'planned' or h.stage is distinct from 'harvesting' then raise exception 'This harvest isn''t in progress'; end if;
  if exists (select 1 from cult_weights where harvest_id = h.id) then raise exception 'Bins are logged on this harvest. Remove them first.'; end if;
  if exists (select 1 from pallets where (harvest_id = h.id or from_harvest = h.id) and status <> 'archived') then raise exception 'Pallets are logged on this harvest. Remove them first.'; end if;
  if h.metrc_plants > 0 or h.metrc_wet_lbs > 0 then raise exception 'This harvest already has METRC steps. Ask a Production Admin.'; end if;
  update cult_harvests set stage = null, harvested_on = null, plants_harvested = null,
         updated_by = current_email(), updated_at = now()
   where id = h.id returning * into h;
  insert into events (user_email, type, note, details)
  values (current_email(), 'harvest_unstarted', h.strain || ': didn''t start, back on the schedule',
          jsonb_build_object('harvest_id', h.id, 'strain', h.strain, 'site', h.site, 'planned_on', h.planned_on));
  return h;
end $$;

revoke execute on function cult_unstart(bigint) from public, anon;
grant execute on function cult_unstart(bigint) to authenticated;

select 'ok' as unstart_064;

-- Migration 042: a finished harvest is changed in its Harvest log, and only by a Production Admin.
-- Bins, pallets, totals and reopening a finished harvest: Production Admins only (the crew logs live, leads fix after).
-- Run after 040. Safe to re-run.
set client_min_messages = warning;

create or replace function cult_guard_done(p_harvest bigint) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from cult_harvests where id = p_harvest and status = 'done') and not is_mod_admin('cultivation') then
    raise exception 'This harvest is finished. Only a Production Admin can change it.';
  end if;
end $$;
revoke execute on function cult_guard_done(bigint) from public, anon;
grant execute on function cult_guard_done(bigint) to authenticated;

-- direct edits to a finished harvest row (totals, dates, delete): Production Admins only. Migrations (no signed-in user) pass.
create or replace function cult_done_lock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if jwt_email() is null or is_mod_admin('cultivation') then return coalesce(new, old); end if;
  if old.status = 'done' then raise exception 'This harvest is finished. Only a Production Admin can change it.'; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists cult_harvests_done_lock on cult_harvests;
create trigger cult_harvests_done_lock before update or delete on cult_harvests for each row execute function cult_done_lock();

-- the logging functions check it too
do $$
declare d text;
begin
  select pg_get_functiondef('cult_log_weight(bigint,text,numeric,text,text)'::regprocedure) into d;
  if d not like '%cult_guard_done%' then
    execute replace(d, '  h := cult_start(p_harvest);', '  perform cult_guard_done(p_harvest);
  h := cult_start(p_harvest);');
  end if;
  select pg_get_functiondef('cult_remove_weight(bigint)'::regprocedure) into d;
  if d not like '%cult_guard_done%' then
    execute replace(d, '  perform require_module(''cultivation'');', '  perform require_module(''cultivation'');
  perform cult_guard_done((select harvest_id from cult_weights where id = p_id));');
  end if;
  select pg_get_functiondef('cult_remove_pallet(bigint)'::regprocedure) into d;
  if d not like '%cult_guard_done%' then
    execute replace(d, '  if p.id is null or p.harvest_id is null then raise exception ''Not a harvest pallet''; end if;',
      '  if p.id is null or p.harvest_id is null then raise exception ''Not a harvest pallet''; end if;
  perform cult_guard_done(p.harvest_id);');
  end if;
  select pg_get_functiondef('cult_add_pallets(bigint,jsonb)'::regprocedure) into d;
  if d not like '%cult_guard_done%' then
    execute replace(d, '  perform require_staff();', '  perform require_staff();
  perform cult_guard_done(p_harvest);');
  end if;
end $$;

-- reopen a finished harvest (back to Harvesting) so more can be logged
create or replace function cult_reopen(p_harvest bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  if not is_mod_admin('cultivation') then raise exception 'Only a Production Admin can reopen a finished harvest'; end if;
  update cult_harvests set status = 'planned', stage = 'harvesting', updated_by = current_email(), updated_at = now() where id = p_harvest and status = 'done';
  if not found then raise exception 'That harvest isn''t finished'; end if;
end $$;
revoke execute on function cult_reopen(bigint) from public, anon;
grant execute on function cult_reopen(bigint) to authenticated;

select (select count(*) from pg_proc where proname in ('cult_log_weight','cult_remove_weight','cult_remove_pallet','cult_add_pallets')
          and pg_get_functiondef(oid) like '%cult_guard_done%') as guarded_functions;

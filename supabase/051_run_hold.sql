-- Migration 051: a package in an open processing run is set aside everywhere, not just in Processing.
-- Distribution (orders, loads, splits, merges, weight changes, shipping) can't touch it until the run is finished or cancelled,
-- or the package is taken out of the run. Moving it to another spot is still fine.
-- Run after 050. Safe to run twice.

create or replace function proc_open_run_of(p_pallet bigint) returns text
language sql stable security definer set search_path = public as $$
  select r.code from proc_run_inputs i join proc_runs r on r.id = i.run_id
   where i.pallet_id = p_pallet and r.status = 'open' limit 1
$$;
grant execute on function proc_open_run_of(bigint) to authenticated;

create or replace function _proc_run_hold_msg(p_pallet bigint, c text) returns text
language sql stable set search_path = public as $$
  select format('%s is in processing run %s. Finish the run or take it out of the run first.',
                coalesce((select code from pallets where id = p_pallet), '#' || p_pallet), c)
$$;

-- holding it for an order, or putting it on a load
create or replace function proc_run_hold_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  c := proc_open_run_of(new.pallet_id);
  if c is not null then raise exception '%', _proc_run_hold_msg(new.pallet_id, c); end if;
  return new;
end $$;
drop trigger if exists proc_run_hold on order_picks;
create trigger proc_run_hold before insert or update of pallet_id on order_picks for each row execute function proc_run_hold_link();
drop trigger if exists proc_run_hold on load_items;
create trigger proc_run_hold before insert or update of pallet_id on load_items for each row execute function proc_run_hold_link();

-- changing the package itself (weight, split, merge, ship, archive, onto a mixed pallet). Finishing the run is allowed.
create or replace function proc_run_hold_pallet() returns trigger
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if coalesce(current_setting('lifted.proc_finish', true), '') = 'on' then return new; end if;
  if new.current_weight is not distinct from old.current_weight
     and (new.status is not distinct from old.status or (old.status in ('in_freezer','unslotted') and new.status in ('in_freezer','unslotted')))
     and (new.container_id is null or new.container_id is not distinct from old.container_id)
  then return new; end if;
  c := proc_open_run_of(old.id);
  if c is not null then raise exception '%', _proc_run_hold_msg(old.id, c); end if;
  return new;
end $$;
drop trigger if exists proc_run_hold on pallets;
create trigger proc_run_hold before update on pallets for each row execute function proc_run_hold_pallet();

-- finishing a run uses up its inputs: let it through
do $$
declare d text;
begin
  select pg_get_functiondef('proc_finish_run(bigint,jsonb,numeric,text,date)'::regprocedure) into d;
  if position('lifted.proc_finish' in d) = 0 then
    if position('perform proc_require();' in d) = 0 then raise exception 'proc_finish_run: patch point not found'; end if;
    d := regexp_replace(d, 'perform proc_require\(\);', 'perform proc_require(); perform set_config(''lifted.proc_finish'', ''on'', true);');
    execute d;
  end if;
end $$;

notify pgrst, 'reload schema';

-- 099: Depart with a departure time (load the night before, driver leaves early).
--  * loads.depart_planned: the time picked in the Depart window (default now). The METRC manifest's estimated departure,
--    the load's departed time and the orders' shipped date use it.
--  * Invoices from the load go to QuickBooks 30 minutes after that departure time (Accounting's hold setting), not 30
--    minutes after Depart was pressed. Editing an invoice still restarts its 30 minutes, never earlier than that.
-- Run once in Supabase after 098_crop_years.sql. Safe to re-run.
begin;

alter table loads add column if not exists depart_planned timestamptz;

create or replace function set_depart_time(p_load int, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare l loads;
begin
  perform require_staff();
  perform no_view_as();
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning', 'loading', 'departing') then raise exception 'Load % has already left', l.code; end if;
  if p_at is null then raise exception 'Pick a departure time'; end if;
  if p_at < now() - interval '12 hours' or p_at > now() + interval '3 days' then
    raise exception 'Departure has to be between 12 hours ago and 3 days from now';
  end if;
  update loads set depart_planned = p_at where id = l.id;
end $$;
revoke execute on function set_depart_time(int, timestamptz) from public, anon;
grant execute on function set_depart_time(int, timestamptz) to authenticated;

-- depart_finish: departed at the picked time, shipped that day, invoices held until 30 minutes after it
do $$
declare d text; a1 text; a2 text;
begin
  select pg_get_functiondef('depart_finish(int)'::regprocedure) into d;
  if position('depart_planned' in d) > 0 then raise notice 'depart_finish already uses the departure time'; return; end if;
  a1 := 'update loads set status = ''in_transit'', departed_at = now(), depart_error = null where id = l.id;';
  a2 := '  -- a pickup is delivered the moment it leaves our dock';
  if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'depart_finish has changed: tell Claude (nothing was changed)'; end if;
  d := replace(d, a1, 'd := coalesce((l.depart_planned at time zone ''America/Los_Angeles'')::date, d);
  update loads set status = ''in_transit'', departed_at = coalesce(l.depart_planned, now()), depart_error = null where id = l.id;');
  d := replace(d, a2, '  -- QuickBooks: 30 minutes after the departure time
  update invoices i set acct_push_after = greatest(i.acct_push_after, coalesce(l.depart_planned, now()) + make_interval(mins => acct_hold_minutes()))
   where i.order_id in (select o.id from orders o join load_stops st on st.id = o.stop_id where st.load_id = l.id)
     and i.acct_push_after is not null and i.acct_status is distinct from ''sent'';
' || a2);
  execute d;
  raise notice 'depart_finish now uses the departure time';
end $$;

commit;

select (select count(*) from information_schema.columns where table_name = 'loads' and column_name = 'depart_planned') as column_added,
       position('depart_planned' in pg_get_functiondef('depart_finish(int)'::regprocedure)) > 0 as depart_finish_updated;

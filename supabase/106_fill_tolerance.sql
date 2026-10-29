-- 106: a line counts as filled when what's assigned is within a few lbs of what was ordered (default 5 lbs), so it doesn't
-- wait on Sales to OK the amount. Beyond that it still needs Sales' OK. The invoice bills what was actually assigned, as before.
-- Setting: Sales > Settings > Fulfillment (Sales or Distribution admins). Stored as app_settings 'sales.fill_tolerance_lbs'.
-- Run once in Supabase after 105. Safe to re-run. If it says "tell Claude", nothing was changed.
begin;

create or replace function fill_tolerance() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select value from app_settings where key = 'sales.fill_tolerance_lbs'), '')::numeric, 5)
$$;
grant execute on function fill_tolerance() to authenticated;

create or replace function set_fill_tolerance(p_lbs numeric) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  perform no_view_as();
  if not (is_sales_admin() or coalesce(mod_level('distribution') = 'admin', false) or is_admin()) then
    raise exception 'Only a Sales or Distribution admin can change this';
  end if;
  if p_lbs is null or p_lbs < 0 or p_lbs > 100 then raise exception 'Enter 0 to 100 lbs'; end if;
  select value into was from app_settings where key = 'sales.fill_tolerance_lbs';
  insert into app_settings values ('sales.fill_tolerance_lbs', p_lbs::text) on conflict (key) do update set value = excluded.value;
  insert into events (user_email, type, note, details)
  values (current_email(), 'app_setting', 'sales.fill_tolerance_lbs', jsonb_build_object('key', 'sales.fill_tolerance_lbs', 'value', p_lbs, 'was', was));
end $$;
revoke execute on function set_fill_tolerance(numeric) from public, anon;
grant execute on function set_fill_tolerance(numeric) to authenticated;

do $$
declare d text; f text; n int := 0;
  a1 text := 'when exists (select 1 from l where got <> lbs) then ''needs_ok''';
  a2 text := 'when exists (select 1 from l where abs(got - lbs) > fill_tolerance()) then ''needs_ok''';
begin
  foreach f in array array['order_state(int)', 'order_fill(int)'] loop
    select pg_get_functiondef(f::regprocedure) into d;
    if position(a2 in d) > 0 then continue; end if;
    if position(a1 in d) = 0 then raise exception '% has changed: tell Claude (nothing was changed)', f; end if;
    execute replace(d, a1, a2); n := n + 1;
  end loop;
  raise notice '% functions updated', n;
end $$;

commit;

select fill_tolerance() as tolerance_lbs,
       position('fill_tolerance()' in pg_get_functiondef('order_state(int)'::regprocedure)) > 0 as order_state,
       position('fill_tolerance()' in pg_get_functiondef('order_fill(int)'::regprocedure)) > 0 as order_fill,
       order_state(29) as washed_la_order;

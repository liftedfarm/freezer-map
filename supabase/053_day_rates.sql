-- Migration 053: the piece rate can be set for each day logged on a run. Left blank, the day uses the standing rate
-- (Bucking $3/lb at 2 lbs/hr, Trimming $10/lb at 0.75 lbs/hr, from the FL25 workbook, or whatever Piece rates says for that date).
-- Run after 052. Safe to run twice.

alter table piece_entries add column if not exists day_rate numeric check (day_rate >= 0);
alter table piece_entries add column if not exists day_target numeric check (day_target >= 0);

-- the pay rule, per entry: the day's own rate when it has one, else the standing rate
drop view if exists piece_pay;
create view piece_pay with (security_invoker = true) as
select e.*, em.name as employee, em.payroll_id,
       coalesce(e.day_rate, r.rate) as rate, coalesce(e.day_target, r.target) as target,
       r.rate as std_rate, r.target as std_target,
       case when e.hours > 0 then e.lbs / e.hours end as lbs_hr,
       coalesce(e.hours > 0 and e.lbs / e.hours >= coalesce(e.day_target, r.target), false) as hit,
       case when e.hours > 0 and e.lbs / e.hours >= coalesce(e.day_target, r.target) then round(e.lbs * coalesce(e.day_rate, r.rate), 2) else 0 end as pay,
       pay_period_start(e.work_date) as period_start
  from piece_entries e
  join employees em on em.id = e.employee_id
  left join lateral (select x.rate, x.target from piece_rates x where x.task = e.task and x.effective_from <= e.work_date
                      order by x.effective_from desc limit 1) r on true;
grant select on piece_pay to authenticated;

drop function if exists piece_save_day(date, text, bigint, text, text, jsonb);
create or replace function piece_save_day(p_date date, p_task text, p_run bigint, p_strain text, p_farm text, p_rows jsonb,
                                          p_rate numeric default null, p_target numeric default null) returns int
language plpgsql security definer set search_path = public as $$
declare r proc_runs; x jsonb; n int := 0; st text; yr int; fm text; v_id bigint;
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('accounting')) then raise exception 'Only Processing or Accounting can log piece work'; end if;
  if p_task not in ('buck','trim') then raise exception 'Bucking or trimming?'; end if;
  if p_date is null or p_date > current_date then raise exception 'Pick the day worked'; end if;
  if p_rate < 0 or p_target < 0 then raise exception 'The rate and target can''t be negative'; end if;
  -- needs_run (052): new work is logged inside a run; old strain-only days can still be fixed
  if p_run is null and exists (select 1 from jsonb_array_elements(coalesce(p_rows, '[]')) jr
                                where nullif(jr ->> 'id', '') is null and not coalesce((jr ->> 'delete')::boolean, false)
                                  and nullif(jr ->> 'employee_id', '') is not null) then
    raise exception 'Log the day inside a run. Start a bucking or trimming run first.';
  end if;
  if p_run is not null then
    select * into r from proc_runs where id = p_run;
    if r.id is null then raise exception 'Run not found'; end if;
    if r.status = 'cancelled' then raise exception '% was cancelled', r.code; end if;
    if r.kind <> p_task then raise exception '% is a % run', r.code, case r.kind when 'buck' then 'bucking' else 'trimming' end; end if;
    st := r.strain; yr := r.crop_year;
    select case when count(distinct p.origin_site) = 1 then min(p.origin_site) end into fm
      from proc_run_inputs i join pallets p on p.id = i.pallet_id where i.run_id = r.id and p.origin_site in ('OHR','GVR');
  end if;
  st := coalesce(st, coalesce(canonical_strain(p_strain), nullif(trim(p_strain), '')));
  fm := coalesce(nullif(p_farm, ''), fm);
  if st is null then raise exception 'Pick the run or the strain'; end if;
  perform pay_period_for(p_date);
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_id := nullif(x ->> 'id', '')::bigint;
    if coalesce((x ->> 'delete')::boolean, false) then
      if v_id is not null then delete from piece_entries where id = v_id; n := n + 1; end if;
      continue;
    end if;
    if nullif(x ->> 'employee_id', '') is null then continue; end if;
    if coalesce(nullif(x ->> 'hours', '')::numeric, 0) <= 0 then
      raise exception '% needs hours', (select name from employees where id = (x ->> 'employee_id')::int);
    end if;
    if v_id is null then
      insert into piece_entries (work_date, employee_id, task, run_id, strain, crop_year, farm, lbs, mold, smalls, trim, hours, note, entered_by, day_rate, day_target)
      values (p_date, (x ->> 'employee_id')::int, p_task, p_run, st, yr, fm, coalesce(nullif(x ->> 'lbs', '')::numeric, 0),
              coalesce(nullif(x ->> 'mold', '')::numeric, 0), coalesce(nullif(x ->> 'smalls', '')::numeric, 0), coalesce(nullif(x ->> 'trim', '')::numeric, 0),
              (x ->> 'hours')::numeric, nullif(trim(x ->> 'note'), ''), current_email(), p_rate, p_target);
    else
      update piece_entries set work_date = p_date, employee_id = (x ->> 'employee_id')::int, task = p_task, run_id = p_run, strain = st, crop_year = yr, farm = fm,
             lbs = coalesce(nullif(x ->> 'lbs', '')::numeric, 0), mold = coalesce(nullif(x ->> 'mold', '')::numeric, 0),
             smalls = coalesce(nullif(x ->> 'smalls', '')::numeric, 0), trim = coalesce(nullif(x ->> 'trim', '')::numeric, 0),
             hours = (x ->> 'hours')::numeric, note = nullif(trim(x ->> 'note'), ''), day_rate = p_rate, day_target = p_target,
             updated_by = current_email(), updated_at = now()
       where id = v_id;
    end if;
    n := n + 1;
  end loop;
  -- one rate for the whole day on this run
  if p_run is not null then
    update piece_entries set day_rate = p_rate, day_target = p_target
     where run_id = p_run and work_date = p_date and (day_rate is distinct from p_rate or day_target is distinct from p_target);
  end if;
  insert into events (user_email, type, details)
  values (current_email(), 'pay_day', jsonb_build_object('date', p_date, 'task', p_task, 'run', r.code, 'strain', st, 'rows', n,
                                                         'rate', p_rate, 'target', p_target));
  return n;
end $$;
revoke all on function piece_save_day(date, text, bigint, text, text, jsonb, numeric, numeric) from public, anon;
grant execute on function piece_save_day(date, text, bigint, text, text, jsonb, numeric, numeric) to authenticated;

notify pgrst, 'reload schema';

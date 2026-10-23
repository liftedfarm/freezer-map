-- Migration 048: piece rate pay for bucking and trimming (Processing logs it, Accounting pays it).
-- Run once in Supabase after 047_processing.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Crew list (employees) with payroll ID. Processing adds crew; Accounting keeps the payroll IDs.
--  * Rates with start dates, as in the FL25 Bucking & Trimming Piece Rate workbook:
--      Bucking $3.00/lb, target 2 lb/hr. Trimming $10.00/lb, target 0.75 lb/hr.
--      Rule (per person, per day, per lot): if flower lbs / hours >= target, pay every flower lb x rate; under target = $0 piece pay.
--      Only flower lbs are paid (mold, smalls and trim are tracked, not paid).
--  * The crew lead logs each person's day from a phone (Processing > Crew), tied to a bucking or trimming run when there is one.
--  * Bi-weekly pay periods (starting 12/22/2025). Accounting closes a period: the pay lines are locked and that's what goes
--    to payroll (CSV). Accounting can add adjustments with a reason; an Accounting Admin can reopen a period.
set client_min_messages = warning;

-- ---------- tables ----------
create table if not exists employees (
  id         serial primary key,
  name       text not null,
  payroll_id text,
  active     boolean not null default true,
  notes      text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists employees_name_key on employees (lower(name));

create table if not exists piece_rates (
  id             serial primary key,
  task           text not null check (task in ('buck','trim')),
  rate           numeric not null check (rate >= 0),       -- $ per flower lb
  target         numeric not null check (target >= 0),     -- lbs per hour to earn the piece rate
  effective_from date not null,
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  unique (task, effective_from)
);
insert into piece_rates (task, rate, target, effective_from, notes) values
  ('buck', 3, 2, '2025-01-01', 'FL25 workbook'), ('trim', 10, 0.75, '2025-01-01', 'FL25 workbook')
on conflict (task, effective_from) do nothing;

create table if not exists pay_periods (
  id          serial primary key,
  starts      date not null unique,
  ends        date not null,
  status      text not null default 'open' check (status in ('open','closed')),
  closed_by   text,
  closed_at   timestamptz,
  exported_by text,
  exported_at timestamptz,
  notes       text
);

create table if not exists piece_entries (
  id          bigserial primary key,
  work_date   date not null,
  employee_id int not null references employees(id),
  task        text not null check (task in ('buck','trim')),
  run_id      bigint references proc_runs(id) on delete set null,
  strain      text,
  crop_year   int,
  farm        text check (farm in ('OHR','GVR')),          -- cost center: where the product was grown
  lbs         numeric not null default 0 check (lbs >= 0), -- flower (bucked flower, or trimmed standards)
  mold        numeric not null default 0 check (mold >= 0),
  smalls      numeric not null default 0 check (smalls >= 0),
  trim        numeric not null default 0 check (trim >= 0),
  hours       numeric not null check (hours > 0),
  note        text,
  source      text not null default 'app',
  entered_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);
create index if not exists piece_entries_date_idx on piece_entries (work_date);
create index if not exists piece_entries_emp_idx on piece_entries (employee_id);
create index if not exists piece_entries_run_idx on piece_entries (run_id);

-- what was paid when a period closed (one row per person, task and farm)
create table if not exists pay_lines (
  id          bigserial primary key,
  period_id   int not null references pay_periods(id) on delete cascade,
  employee_id int not null references employees(id),
  task        text not null,
  farm        text,
  entries     int not null,
  hours       numeric not null,
  lbs         numeric not null,
  paid_lbs    numeric not null,
  amount      numeric not null
);
create table if not exists pay_adjustments (
  id          bigserial primary key,
  period_id   int not null references pay_periods(id) on delete cascade,
  employee_id int not null references employees(id),
  amount      numeric not null,
  reason      text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);

-- ---------- who can see it ----------
create or replace function can_see_pay() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_module('processing'), false) or coalesce(has_module('accounting'), false)
$$;
alter table employees enable row level security;
alter table piece_rates enable row level security;
alter table pay_periods enable row level security;
alter table piece_entries enable row level security;
alter table pay_lines enable row level security;
alter table pay_adjustments enable row level security;
do $$
declare t text;
begin
  foreach t in array array['employees','piece_rates','pay_periods','piece_entries','pay_lines','pay_adjustments'] loop
    execute format('drop policy if exists read_pay on %I', t);
    execute format('create policy read_pay on %I for select to authenticated using (can_see_pay())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------- pay periods ----------
insert into app_settings (key, value) select 'payroll.anchor', '2025-12-22' where not exists (select 1 from app_settings where key = 'payroll.anchor');

create or replace function pay_period_start(p_date date) returns date
language sql stable security definer set search_path = public as $$
  with a as (select coalesce((select value::date from app_settings where key = 'payroll.anchor'), date '2025-12-22') d)
  select a.d + (floor((p_date - a.d)::numeric / 14) * 14)::int from a
$$;

create or replace function pay_period_for(p_date date) returns pay_periods
language plpgsql security definer set search_path = public as $$
declare s date := pay_period_start(p_date); p pay_periods;
begin
  select * into p from pay_periods where starts = s;
  if p.id is null then
    insert into pay_periods (starts, ends) values (s, s + 13) on conflict (starts) do nothing;
    select * into p from pay_periods where starts = s;
  end if;
  return p;
end $$;

-- ---------- the pay rule, per entry ----------
create or replace view piece_pay with (security_invoker = true) as
select e.*, em.name as employee, em.payroll_id,
       r.rate, r.target,
       case when e.hours > 0 then e.lbs / e.hours end as lbs_hr,
       coalesce(e.hours > 0 and e.lbs / e.hours >= r.target, false) as hit,
       case when e.hours > 0 and e.lbs / e.hours >= r.target then round(e.lbs * r.rate, 2) else 0 end as pay,
       pay_period_start(e.work_date) as period_start
  from piece_entries e
  join employees em on em.id = e.employee_id
  left join lateral (select x.rate, x.target from piece_rates x where x.task = e.task and x.effective_from <= e.work_date
                      order by x.effective_from desc limit 1) r on true;
grant select on piece_pay to authenticated;

-- entries in a closed period are locked
create or replace function piece_entry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare d date;
begin
  foreach d in array array[case when tg_op <> 'INSERT' then old.work_date end, case when tg_op <> 'DELETE' then new.work_date end] loop
    if d is not null and exists (select 1 from pay_periods where starts = pay_period_start(d) and status = 'closed') then
      raise exception 'The pay period with % is closed. Ask Accounting to reopen it.', to_char(d, 'Mon DD');
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists piece_entry_guard on piece_entries;
create trigger piece_entry_guard before insert or update or delete on piece_entries for each row execute function piece_entry_guard();

-- ---------- crew ----------
create or replace function employee_save(p jsonb) returns employees
language plpgsql security definer set search_path = public as $$
declare x employees; nm text := initcap(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'));
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('accounting')) then raise exception 'Only Processing or Accounting can change the crew list'; end if;
  if nm = '' then raise exception 'Name?'; end if;
  if nullif(p ->> 'id', '') is null then
    select * into x from employees where lower(name) = lower(nm);
    if x.id is not null then
      if not x.active then update employees set active = true, updated_at = now() where id = x.id returning * into x; end if;
      return x;
    end if;
    insert into employees (name, payroll_id, notes, created_by) values (nm, nullif(trim(p ->> 'payroll_id'), ''), nullif(trim(p ->> 'notes'), ''), current_email())
    returning * into x;
  else
    update employees set name = nm,
           payroll_id = case when p ? 'payroll_id' then nullif(trim(p ->> 'payroll_id'), '') else payroll_id end,
           active = coalesce((p ->> 'active')::boolean, active), notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end, updated_at = now()
     where id = (p ->> 'id')::int returning * into x;
    if x.id is null then raise exception 'Not found'; end if;
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'pay_employee', x.name, jsonb_build_object('id', x.id, 'active', x.active));
  return x;
end $$;

create or replace function piece_rate_save(p_task text, p_rate numeric, p_target numeric, p_from date, p_notes text default null) returns piece_rates
language plpgsql security definer set search_path = public as $$
declare x piece_rates;
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_mod_admin('processing') or is_owner()) then raise exception 'Only an Accounting or Processing Admin can change piece rates'; end if;
  if exists (select 1 from pay_periods where status = 'closed' and ends >= p_from) then raise exception 'A closed pay period is on or after %; start the new rate later', p_from; end if;
  insert into piece_rates (task, rate, target, effective_from, notes, created_by) values (p_task, p_rate, p_target, p_from, nullif(trim(p_notes), ''), current_email())
  on conflict (task, effective_from) do update set rate = excluded.rate, target = excluded.target, notes = excluded.notes
  returning * into x;
  insert into events (user_email, type, details) values (current_email(), 'pay_rate', to_jsonb(x));
  return x;
end $$;

-- ---------- the crew lead's day sheet ----------
-- p_rows: [{"id": null, "employee_id": 3, "lbs": 4.2, "mold": 0.3, "smalls": 0, "trim": 0.9, "hours": 6.5, "note": "", "delete": false}]
create or replace function piece_save_day(p_date date, p_task text, p_run bigint, p_strain text, p_farm text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r proc_runs; x jsonb; n int := 0; st text; yr int; fm text; v_id bigint;
begin
  perform no_view_as();
  if not (can_edit('processing') or can_edit('accounting')) then raise exception 'Only Processing or Accounting can log piece work'; end if;
  if p_task not in ('buck','trim') then raise exception 'Bucking or trimming?'; end if;
  if p_date is null or p_date > current_date then raise exception 'Pick the day worked'; end if;
  if p_run is not null then
    select * into r from proc_runs where id = p_run;
    if r.id is null then raise exception 'Run not found'; end if;
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
      insert into piece_entries (work_date, employee_id, task, run_id, strain, crop_year, farm, lbs, mold, smalls, trim, hours, note, entered_by)
      values (p_date, (x ->> 'employee_id')::int, p_task, p_run, st, yr, fm, coalesce(nullif(x ->> 'lbs', '')::numeric, 0),
              coalesce(nullif(x ->> 'mold', '')::numeric, 0), coalesce(nullif(x ->> 'smalls', '')::numeric, 0), coalesce(nullif(x ->> 'trim', '')::numeric, 0),
              (x ->> 'hours')::numeric, nullif(trim(x ->> 'note'), ''), current_email());
    else
      update piece_entries set work_date = p_date, employee_id = (x ->> 'employee_id')::int, task = p_task, run_id = p_run, strain = st, crop_year = yr, farm = fm,
             lbs = coalesce(nullif(x ->> 'lbs', '')::numeric, 0), mold = coalesce(nullif(x ->> 'mold', '')::numeric, 0),
             smalls = coalesce(nullif(x ->> 'smalls', '')::numeric, 0), trim = coalesce(nullif(x ->> 'trim', '')::numeric, 0),
             hours = (x ->> 'hours')::numeric, note = nullif(trim(x ->> 'note'), ''), updated_by = current_email(), updated_at = now()
       where id = v_id;
    end if;
    n := n + 1;
  end loop;
  insert into events (user_email, type, details)
  values (current_email(), 'pay_day', jsonb_build_object('date', p_date, 'task', p_task, 'run', r.code, 'strain', st, 'rows', n));
  return n;
end $$;

-- ---------- Accounting: summary, close, adjust, export ----------
create or replace function _pay_snapshot(p pay_periods) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from pay_lines where period_id = p.id;
  insert into pay_lines (period_id, employee_id, task, farm, entries, hours, lbs, paid_lbs, amount)
  select p.id, x.employee_id, x.task, x.farm, count(*), sum(x.hours), sum(x.lbs), sum(case when x.hit then x.lbs else 0 end), sum(x.pay)
    from piece_pay x where x.work_date between p.starts and p.ends
   group by x.employee_id, x.task, x.farm;
end $$;

-- one period: per person, bucking / trimming by farm, adjustments, total. Closed periods come from the locked pay lines.
create or replace function pay_summary(p_start date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pay_periods; s date := pay_period_start(p_start);
begin
  if not can_see_pay() then raise exception 'Not allowed'; end if;
  select * into p from pay_periods where starts = s;
  return jsonb_build_object(
    'starts', s, 'ends', s + 13, 'status', coalesce(p.status, 'open'), 'closed_by', p.closed_by, 'closed_at', p.closed_at,
    'exported_by', p.exported_by, 'exported_at', p.exported_at, 'notes', p.notes,
    'lines', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.name, l.task, l.farm) from (
        select em.id as employee_id, em.name, em.payroll_id, x.task, x.farm, x.entries, x.hours, x.lbs, x.paid_lbs, x.amount
          from (select employee_id, task, farm, entries, hours, lbs, paid_lbs, amount from pay_lines where p.status = 'closed' and period_id = p.id
                union all
                select employee_id, task, farm, count(*)::int, sum(hours), sum(lbs), sum(case when hit then lbs else 0 end), sum(pay)
                  from piece_pay where coalesce(p.status, 'open') = 'open' and work_date between s and s + 13 group by 1, 2, 3) x
          join employees em on em.id = x.employee_id) l), '[]'),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'employee_id', a.employee_id, 'name', em.name, 'amount', a.amount, 'reason', a.reason,
                                                                 'by', a.created_by, 'at', a.created_at) order by a.id)
                              from pay_adjustments a join employees em on em.id = a.employee_id where a.period_id = p.id), '[]'),
    'days', coalesce((select count(distinct work_date) from piece_entries where work_date between s and s + 13), 0));
end $$;

create or replace function pay_close(p_start date, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p pay_periods;
begin
  perform no_view_as();
  if not can_edit('accounting') then raise exception 'Only Accounting can close a pay period'; end if;
  p := pay_period_for(p_start);
  if p.status = 'closed' then raise exception 'Already closed'; end if;
  if p.ends >= current_date then raise exception 'This period isn''t over yet (ends %)', to_char(p.ends, 'Mon DD'); end if;
  perform _pay_snapshot(p);
  update pay_periods set status = 'closed', closed_by = current_email(), closed_at = now(), notes = coalesce(nullif(trim(p_notes), ''), notes) where id = p.id;
  insert into events (user_email, type, details) values (current_email(), 'pay_closed', jsonb_build_object('starts', p.starts, 'ends', p.ends,
          'total', (select coalesce(sum(amount), 0) from pay_lines where period_id = p.id) + (select coalesce(sum(amount), 0) from pay_adjustments where period_id = p.id)));
end $$;

create or replace function pay_reopen(p_start date) returns void
language plpgsql security definer set search_path = public as $$
declare p pay_periods;
begin
  perform no_view_as();
  if not (is_mod_admin('accounting') or is_owner()) then raise exception 'Only an Accounting Admin can reopen a pay period'; end if;
  select * into p from pay_periods where starts = pay_period_start(p_start);
  if p.status <> 'closed' then raise exception 'It isn''t closed'; end if;
  delete from pay_lines where period_id = p.id;
  update pay_periods set status = 'open', closed_by = null, closed_at = null, exported_by = null, exported_at = null where id = p.id;
  insert into events (user_email, type, details) values (current_email(), 'pay_reopened', jsonb_build_object('starts', p.starts));
end $$;

create or replace function pay_adjust(p_start date, p_employee int, p_amount numeric, p_reason text) returns pay_adjustments
language plpgsql security definer set search_path = public as $$
declare p pay_periods; a pay_adjustments;
begin
  perform no_view_as();
  if not can_edit('accounting') then raise exception 'Only Accounting can adjust pay'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'Amount?'; end if;
  p := pay_period_for(p_start);
  if p.exported_at is not null then raise exception 'This period already went to payroll. Reopen it first.'; end if;
  insert into pay_adjustments (period_id, employee_id, amount, reason, created_by) values (p.id, p_employee, p_amount, trim(p_reason), current_email()) returning * into a;
  insert into events (user_email, type, details) values (current_email(), 'pay_adjusted', jsonb_build_object('starts', p.starts, 'employee', (select name from employees where id = p_employee), 'amount', p_amount, 'reason', p_reason));
  return a;
end $$;

create or replace function pay_adjust_remove(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare p pay_periods;
begin
  perform no_view_as();
  if not can_edit('accounting') then raise exception 'Only Accounting can adjust pay'; end if;
  select pp.* into p from pay_adjustments a join pay_periods pp on pp.id = a.period_id where a.id = p_id;
  if p.exported_at is not null then raise exception 'This period already went to payroll. Reopen it first.'; end if;
  delete from pay_adjustments where id = p_id;
  insert into events (user_email, type, details) values (current_email(), 'pay_adjusted', jsonb_build_object('starts', p.starts, 'removed', p_id));
end $$;

create or replace function pay_mark_exported(p_start date) returns void
language plpgsql security definer set search_path = public as $$
declare p pay_periods;
begin
  perform no_view_as();
  if not can_edit('accounting') then raise exception 'Only Accounting'; end if;
  select * into p from pay_periods where starts = pay_period_start(p_start);
  if p.status <> 'closed' then raise exception 'Close the period first'; end if;
  update pay_periods set exported_by = current_email(), exported_at = now() where id = p.id;
  insert into events (user_email, type, details) values (current_email(), 'pay_exported', jsonb_build_object('starts', p.starts));
end $$;

do $$
declare f text;
begin
  foreach f in array array['employee_save(jsonb)','piece_rate_save(text,numeric,numeric,date,text)','piece_save_day(date,text,bigint,text,text,jsonb)',
    'pay_summary(date)','pay_close(date,text)','pay_reopen(date)','pay_adjust(date,integer,numeric,text)','pay_adjust_remove(bigint)','pay_mark_exported(date)',
    'pay_period_for(date)','pay_period_start(date)','can_see_pay()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke all on function _pay_snapshot(pay_periods) from public, anon, authenticated;
end $$;

select 'rates' as what, count(*) from piece_rates union all select 'employees', count(*) from employees;

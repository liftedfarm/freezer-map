-- 070_metrc_push.sql: send METRC to-dos to METRC through T3 (Track & Trace Tools API).
-- Phase 0: connection test, per-kind switch (Off / Approve / Auto), Dry run vs Live, job state on every to-do.
-- Phase 1 starts with package weight adjustments (the only kind the server can send so far).
-- Re-runnable. Run after 069.

-- ---------- what kind of METRC work each to-do is ----------
create or replace function metrc_kind(p_type text) returns text
language sql immutable as $$
  select case p_type
    when 'weight_adjust' then 'adjust'
    when 'split_from' then 'split'
    when 'merge' then 'combine'
    when 'removed' then 'finish'
    when 'tag_set' then 'tag'
    when 'created' then 'new_package'
    when 'move' then 'transfer'
    when 'received' then 'transfer'
    when 'shipped' then 'manifest'
    when 'proc_sent' then 'transfer'
    when 'proc_received' then 'receive'
    when 'harvest_plants' then 'harvest_plants'
    when 'harvested' then 'harvest_package'
    when 'pushed' then 'harvest_package'
    when 'proc_wet' then 'harvest_package'
    when 'proc_output' then 'proc_output'
    when 'proc_used' then 'proc_used'
    when 'proc_run_done' then 'run_waste'
    when 'harvest_waste' then 'harvest_waste'
    when 'harvest_finish' then 'harvest_finish'
    else 'other' end
$$;

alter table comp_metrc_actions add column if not exists kind text;
alter table comp_metrc_actions add column if not exists push_state text;      -- null = by hand; checked / sending / sent / failed / waiting
alter table comp_metrc_actions add column if not exists push_attempts int not null default 0;
alter table comp_metrc_actions add column if not exists push_at timestamptz;
alter table comp_metrc_actions add column if not exists push_by text;
alter table comp_metrc_actions add column if not exists push_error text;
alter table comp_metrc_actions add column if not exists push_request jsonb;
alter table comp_metrc_actions add column if not exists push_response jsonb;
alter table comp_metrc_actions drop constraint if exists comp_metrc_actions_push_state_check;
alter table comp_metrc_actions add constraint comp_metrc_actions_push_state_check
  check (push_state is null or push_state in ('checked', 'sending', 'sent', 'failed', 'waiting'));

create or replace function _metrc_set_kind() returns trigger
language plpgsql as $$
begin
  new.kind := coalesce(new.kind, metrc_kind(new.details ->> 'type'));
  return new;
end $$;
drop trigger if exists metrc_set_kind on comp_metrc_actions;
create trigger metrc_set_kind before insert on comp_metrc_actions for each row execute function _metrc_set_kind();
update comp_metrc_actions set kind = metrc_kind(details ->> 'type') where kind is null;
create index if not exists comp_metrc_actions_push on comp_metrc_actions (kind, status, id);
create index if not exists comp_metrc_actions_tag on comp_metrc_actions (tag) where status in ('todo', 'error');

-- ---------- per kind: Off / Approve / Auto ----------
create table if not exists metrc_push_kinds (
  kind        text primary key,
  label       text not null,
  phase       int not null,
  sort        int not null default 50,
  ready       boolean not null default false,   -- the server knows how to send this kind
  mode        text not null default 'off' check (mode in ('off', 'approve', 'auto')),
  updated_by  text,
  updated_at  timestamptz not null default now()
);
insert into metrc_push_kinds (kind, label, phase, sort, ready) values
  ('adjust',          'Package weight adjustments',           1, 10, true),
  ('split',           'Splits (new package from a package)',  1, 20, false),
  ('combine',         'Combines / merges',                    1, 30, false),
  ('finish',          'Remove: used up (adjust to 0, finish)', 1, 40, false),
  ('tag',             'Tag fixes',                            1, 50, false),
  ('new_package',     'New package entered by hand',          1, 55, false),
  ('transfer',        'Transfers between licenses / to processors', 1, 60, false),
  ('manifest',        'Customer manifests',                   1, 70, false),
  ('receive',         'Receiving',                            1, 80, false),
  ('harvest_plants',  'Harvest plants (count + wet weight)',  3, 110, false),
  ('harvest_package', 'Packages from harvest',                4, 120, false),
  ('proc_output',     'Processing outputs',                   4, 130, false),
  ('proc_used',       'Processing inputs used',               4, 140, false),
  ('harvest_waste',   'Harvest waste',                        5, 150, false),
  ('run_waste',       'Run waste / moisture loss',            5, 160, false),
  ('harvest_finish',  'Finish harvest',                       5, 170, false),
  ('other',           'Other',                                9, 999, false)
on conflict (kind) do update set label = excluded.label, phase = excluded.phase, sort = excluded.sort, ready = excluded.ready;

alter table metrc_push_kinds enable row level security;
drop policy if exists read_push_kinds on metrc_push_kinds;
create policy read_push_kinds on metrc_push_kinds for select to authenticated using (comp_can_read());
grant select on metrc_push_kinds to authenticated;

-- ---------- last T3 connection test (written by the server only) ----------
create table if not exists metrc_connection (
  id          int primary key default 1 check (id = 1),
  ok          boolean,
  tested_at   timestamptz,
  tested_by   text,
  who         jsonb,       -- T3 whoami
  licenses    jsonb,       -- [{ license, name, in_app, permissions: [...] }]
  reasons     jsonb,       -- { license: [{ id, name, requiresNote }] } package adjustment reasons
  error       text
);
insert into metrc_connection (id) values (1) on conflict do nothing;
alter table metrc_connection enable row level security;
drop policy if exists read_metrc_conn on metrc_connection;
create policy read_metrc_conn on metrc_connection for select to authenticated using (comp_can_read());
grant select on metrc_connection to authenticated;

-- ---------- settings ----------
insert into app_settings (key, value) values
  ('comp.metrc_live', 'false'),
  ('comp.metrc_reason_drying', 'Drying'),
  ('comp.metrc_reason_scale', 'Scale Variance'),
  ('comp.metrc_reason_waste', 'Waste'),
  ('comp.metrc_reason_entry', 'Entry Error')
on conflict (key) do nothing;

create or replace function comp_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change Compliance settings'; end if;
  if p_key not in ('comp.weight_tol', 'comp.stale_days', 'comp.sp_site', 'comp.sp_root',
                   'comp.metrc_live', 'comp.metrc_reason_drying', 'comp.metrc_reason_scale', 'comp.metrc_reason_waste', 'comp.metrc_reason_entry')
  then raise exception 'Unknown setting'; end if;
  if p_key = 'comp.metrc_live' and coalesce(trim(p_value), '') not in ('true', 'false') then raise exception 'Live is true or false'; end if;
  insert into app_settings (key, value) values (p_key, coalesce(trim(p_value), '')) on conflict (key) do update set value = excluded.value;
  if p_key in ('comp.sp_site', 'comp.sp_root') then update comp_docs set backed_up_at = null, sp_item_id = null, sp_path = null where backed_up_at is not null; end if;
  perform _comp_event('comp_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value));
end $$;
revoke all on function comp_set_setting(text, text) from public, anon;
grant execute on function comp_set_setting(text, text) to authenticated;

-- ---------- who can do what (for the server) ----------
create or replace function metrc_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', current_email(),
    'admin', coalesce(comp_is_admin(), false),
    'can_send', coalesce((comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_owner()) and not impersonating(), false))
$$;
revoke all on function metrc_me() from public, anon;
grant execute on function metrc_me() to authenticated;

create or replace function metrc_set_mode(p_kind text, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare k metrc_push_kinds;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change how the app sends to METRC'; end if;
  select * into k from metrc_push_kinds where kind = p_kind for update;
  if not found then raise exception 'Unknown kind'; end if;
  if p_mode not in ('off', 'approve', 'auto') then raise exception 'Off, Approve or Auto'; end if;
  if p_mode <> 'off' and not k.ready then raise exception 'The app can''t send "%" yet (phase %)', k.label, k.phase; end if;
  update metrc_push_kinds set mode = p_mode, updated_by = current_email(), updated_at = now() where kind = p_kind;
  perform _comp_event('metrc_mode', p_kind, jsonb_build_object('kind', p_kind, 'mode', p_mode, 'was', k.mode));
end $$;
revoke all on function metrc_set_mode(text, text) from public, anon;
grant execute on function metrc_set_mode(text, text) to authenticated;

-- ---------- server only: claim jobs, record results ----------
/** Mark jobs as sending so two runs never send the same one. p_ids null = the worker's pick (Auto kinds, live only). */
create or replace function metrc_claim(p_ids bigint[], p_limit int default 40) returns setof comp_metrc_actions
language plpgsql security definer set search_path = public as $$
begin
  -- a run that died mid-send leaves 'sending'; let it be picked again after 10 minutes
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '10 minutes';
  return query
  update comp_metrc_actions a set push_state = 'sending', push_attempts = a.push_attempts + 1, push_at = now()
   where a.id in (
     select x.id from comp_metrc_actions x join metrc_push_kinds k on k.kind = x.kind
      where x.status in ('todo', 'error') and k.ready
        and coalesce(x.push_state, '') <> 'sending'
        and (case when p_ids is not null then x.id = any(p_ids) and k.mode <> 'off'
                  else k.mode = 'auto' and (x.due_at is null or x.due_at <= now())
                       and (x.push_state is null or x.push_state in ('checked', 'waiting')
                            or (x.push_state = 'failed' and x.push_attempts < 3 and x.push_at < now() - interval '15 minutes')) end)
      order by x.id
      limit greatest(1, least(coalesce(p_limit, 40), 200))
      for update of x skip locked)
  returning a.*;
end $$;

create or replace function metrc_result(p_id bigint, p_state text, p_by text, p_request jsonb, p_response jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_state not in ('checked', 'sent', 'failed', 'waiting') then raise exception 'Bad state'; end if;
  update comp_metrc_actions set
    push_state = p_state, push_by = p_by, push_at = now(),
    push_request = coalesce(p_request, push_request), push_response = p_response,
    push_error = case when p_state in ('failed', 'waiting') then left(p_error, 1000) end,
    push_attempts = case when p_state in ('checked', 'waiting') then greatest(push_attempts - 1, 0) else push_attempts end,
    status = case when p_state = 'sent' then 'done' else status end,
    note = case when p_state = 'sent' then coalesce(left(p_error, 500), note) else note end,
    done_by = case when p_state = 'sent' then 'Lifted App via T3 (' || coalesce(p_by, '?') || ')' else done_by end,
    done_at = case when p_state = 'sent' then now() else done_at end
   where id = p_id;
  if p_state in ('sent', 'failed') then
    insert into events (user_email, type, note, details)
    values (coalesce(p_by, 'metrc worker'), 'metrc_push', p_error,
            jsonb_build_object('id', p_id, 'state', p_state, 'error', left(p_error, 300)));
  end if;
end $$;

revoke all on function metrc_claim(bigint[], int) from public, anon, authenticated;
revoke all on function metrc_result(bigint, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function metrc_claim(bigint[], int) to service_role;
grant execute on function metrc_result(bigint, text, text, jsonb, jsonb, text) to service_role;

select '070 metrc push' as ok, (select count(*) from metrc_push_kinds) as kinds,
       (select count(*) from comp_metrc_actions where kind is not null) as todos_with_kind;

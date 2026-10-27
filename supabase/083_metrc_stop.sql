-- 083: one Stop button on METRC to-dos. What it does depends on where the to-do is:
--   waste / finish still waiting  -> cancels both and reopens the harvest in the app (same as Reopen on the Harvest screen)
--   a long send in progress       -> stops after the batch it's on (harvest plants, flip); what's in METRC stays; Release carries on
--   queued, not started           -> holds it; nothing goes (and nothing that depends on it) until Release
-- Reopen on the Harvest screen now also cancels the waiting waste / finish, so a second Finish can't double the waste.
-- Run after 082. Re-runnable.
set client_min_messages = warning;

alter table comp_metrc_actions add column if not exists stop_requested boolean not null default false;
alter table comp_metrc_actions drop constraint if exists comp_metrc_actions_push_state_check;
alter table comp_metrc_actions add constraint comp_metrc_actions_push_state_check
  check (push_state is null or push_state in ('checked', 'sending', 'sent', 'failed', 'waiting', 'held'));

-- the sender reports 'held' when it stops on a Stop
create or replace function metrc_result(p_id bigint, p_state text, p_by text, p_request jsonb, p_response jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_state not in ('checked', 'sent', 'failed', 'waiting', 'held') then raise exception 'Bad state'; end if;
  update comp_metrc_actions set
    push_state = p_state, push_by = p_by, push_at = now(),
    push_request = coalesce(p_request, push_request), push_response = coalesce(p_response, push_response),
    push_error = case when p_state in ('failed', 'waiting', 'held') then left(p_error, 1000) end,
    push_attempts = case when p_state in ('checked', 'waiting', 'held') then greatest(push_attempts - 1, 0) else push_attempts end,
    stop_requested = false,
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
revoke all on function metrc_result(bigint, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function metrc_result(bigint, text, text, jsonb, jsonb, text) to service_role;

-- claiming skips held to-dos (Send too: Release first)
create or replace function metrc_claim(p_ids bigint[], p_limit int default 40) returns setof comp_metrc_actions
language plpgsql security definer set search_path = public as $$
begin
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '10 minutes' and kind <> 'flower';
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '30 minutes' and kind = 'flower';
  return query
  update comp_metrc_actions a set push_state = 'sending', push_attempts = a.push_attempts + 1, push_at = now()
   where a.id in (
     select x.id from comp_metrc_actions x join metrc_push_kinds k on k.kind = x.kind
      where x.status in ('todo', 'error') and k.ready
        and coalesce(x.push_state, '') not in ('sending', 'held')
        and metrc_past_cutover(x.kind, x.license, x.at)
        and (case when p_ids is not null then x.id = any(p_ids) and k.mode <> 'off'
                  else k.mode = 'auto' and (x.due_at is null or x.due_at <= now())
                       and (x.push_state is null or x.push_state in ('checked', 'waiting')
                            or (x.push_state = 'failed' and x.push_attempts < 3 and x.push_at < now() - interval '15 minutes')) end)
      order by x.id
      limit greatest(1, least(coalesce(p_limit, 40), 200))
      for update of x skip locked)
  returning a.*;
end $$;
revoke all on function metrc_claim(bigint[], int) from public, anon, authenticated;
grant execute on function metrc_claim(bigint[], int) to service_role;

create or replace function metrc_claim_next(p_ids bigint[], p_skip bigint[] default '{}') returns setof comp_metrc_actions
language plpgsql security definer set search_path = public as $$
begin
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '10 minutes' and kind <> 'flower';
  update comp_metrc_actions set push_state = 'failed', push_error = coalesce(push_error, 'Stopped mid-send; will retry')
   where push_state = 'sending' and push_at < now() - interval '30 minutes' and kind = 'flower';
  return query
  update comp_metrc_actions a set push_state = 'sending', push_attempts = a.push_attempts + 1, push_at = now()
   where a.id in (
     select x.id from comp_metrc_actions x join metrc_push_kinds k on k.kind = x.kind
      where x.status in ('todo', 'error') and k.ready
        and coalesce(x.push_state, '') not in ('sending', 'held')
        and x.id <> all(coalesce(p_skip, '{}'))
        and metrc_past_cutover(x.kind, x.license, x.at)
        and (case when p_ids is not null then x.id = any(p_ids) and k.mode <> 'off'
                  else k.mode = 'auto' and (x.due_at is null or x.due_at <= now())
                       and (x.push_state is null or x.push_state in ('checked', 'waiting')
                            or (x.push_state = 'failed' and x.push_attempts < 3 and x.push_at < now() - interval '15 minutes')) end)
      order by x.id
      limit 1
      for update of x skip locked)
  returning a.*;
end $$;
revoke all on function metrc_claim_next(bigint[], bigint[]) from public, anon, authenticated;
grant execute on function metrc_claim_next(bigint[], bigint[]) to service_role;

-- reopen a finished harvest: cancel its waiting waste / finish, put it back to harvesting. Returns a warning (or null).
create or replace function _cult_reopen(p_harvest bigint, p_why text) returns text
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; warn text; n int;
begin
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if exists (select 1 from comp_metrc_actions where details ->> 'harvest_id' = h.id::text and kind in ('harvest_waste', 'harvest_finish')
              and status in ('todo', 'error') and push_state = 'sending') then
    raise exception 'The waste or finish for this harvest is going to METRC right now. Try again in a minute.';
  end if;
  update comp_metrc_actions set status = 'skipped', stop_requested = false, done_by = current_email(), done_at = now(),
         note = coalesce(nullif(trim(p_why), ''), 'Harvest reopened before this went to METRC')
   where details ->> 'harvest_id' = h.id::text and kind in ('harvest_waste', 'harvest_finish') and status in ('todo', 'error');
  get diagnostics n = row_count;
  if exists (select 1 from comp_metrc_actions where details ->> 'harvest_id' = h.id::text and kind = 'harvest_finish' and status = 'done') then
    warn := 'METRC already shows this harvest as finished. Unfinish it in METRC before pressing Finish here again.';
  elsif exists (select 1 from comp_metrc_actions where details ->> 'harvest_id' = h.id::text and kind = 'harvest_waste' and status = 'done') then
    warn := 'METRC already has waste recorded for this harvest. Finishing again will record more waste: fix it in METRC if that''s wrong.';
  end if;
  if h.status = 'done' then
    update cult_harvests set status = 'planned', stage = 'harvesting', updated_by = current_email(), updated_at = now() where id = h.id;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'harvest_reopened', p_why, jsonb_build_object('harvest_id', h.id, 'cancelled', n, 'warning', warn));
  return warn;
end $$;
revoke all on function _cult_reopen(bigint, text) from public, anon, authenticated;

-- Reopen on the Harvest screen (now returns a warning, or null)
drop function if exists cult_reopen(bigint);
create function cult_reopen(p_harvest bigint) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  if not is_mod_admin('cultivation') then raise exception 'Only a Production Admin can reopen a finished harvest'; end if;
  if not exists (select 1 from cult_harvests where id = p_harvest and status = 'done') then raise exception 'That harvest isn''t finished'; end if;
  return _cult_reopen(p_harvest, 'Harvest reopened before this went to METRC');
end $$;
revoke execute on function cult_reopen(bigint) from public, anon;
grant execute on function cult_reopen(bigint) to authenticated;

-- Stop on a to-do. Returns what it did, for the screen.
create or replace function metrc_stop(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare a comp_metrc_actions; warn text;
begin
  if not (comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_mod_admin('cultivation') or is_owner()) or impersonating() then
    raise exception 'Only Compliance (or a module Admin) can stop METRC work';
  end if;
  select * into a from comp_metrc_actions where id = p_id for update;
  if a.id is null then raise exception 'To-do not found'; end if;
  if a.status not in ('todo', 'error') then raise exception 'This one isn''t waiting to go to METRC'; end if;
  if a.kind in ('harvest_waste', 'harvest_finish') and a.details ? 'harvest_id' then
    warn := _cult_reopen((a.details ->> 'harvest_id')::bigint, 'Stopped from the METRC to-do list; harvest reopened');
    return 'reopened' || coalesce(': ' || warn, '');
  end if;
  if a.push_state = 'sending' then
    if a.kind not in ('harvest_plants', 'flower') then raise exception 'This one is already on its way to METRC and can''t be stopped part way'; end if;
    update comp_metrc_actions set stop_requested = true where id = a.id;
    perform _comp_event('metrc_stop', a.kind, jsonb_build_object('id', a.id, 'while', 'sending'));
    return 'stopping';
  end if;
  update comp_metrc_actions set push_state = 'held', stop_requested = false, push_error = 'Held by ' || split_part(current_email(), '@', 1) where id = a.id;
  perform _comp_event('metrc_stop', a.kind, jsonb_build_object('id', a.id, 'while', coalesce(a.push_state, 'queued')));
  return 'held';
end $$;
revoke all on function metrc_stop(bigint) from public, anon;
grant execute on function metrc_stop(bigint) to authenticated;

-- Release a held to-do: back in line (Auto ones go on the next run; others wait for Send)
create or replace function metrc_release(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_mod_admin('cultivation') or is_owner()) or impersonating() then
    raise exception 'Only Compliance (or a module Admin) can release METRC work';
  end if;
  update comp_metrc_actions set push_state = 'waiting', push_attempts = 0, push_error = 'Released', stop_requested = false
   where id = p_id and push_state = 'held' and status in ('todo', 'error');
  if not found then raise exception 'That to-do isn''t held'; end if;
  perform _comp_event('metrc_release', null, jsonb_build_object('id', p_id));
end $$;
revoke all on function metrc_release(bigint) from public, anon;
grant execute on function metrc_release(bigint) to authenticated;

select '083 metrc stop' as ok;

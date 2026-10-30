-- 116: a failed send no longer wipes a to-do's progress.
-- 10/29 Honey Banana (#491): the first send harvested 200 plants, then T3 failed ("Redirected back to login page").
-- metrc_result saved T3's error body as push_response, which replaced {"progress": ...}. The retry measured the
-- 200 plants already in METRC as "there before", so it stopped 200 short of a harvest that was really complete.
-- Fix: whatever metrc_result saves, the progress the sender recorded is kept.
-- Run once in Supabase after 115. Safe to re-run.
create or replace function metrc_result(p_id bigint, p_state text, p_by text, p_request jsonb, p_response jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_state not in ('checked', 'sent', 'failed', 'waiting', 'held') then raise exception 'Bad state'; end if;
  update comp_metrc_actions set
    push_state = p_state, push_by = p_by, push_at = now(),
    push_request = coalesce(p_request, push_request),
    push_response = case
      when p_response is null then push_response
      when push_response ? 'progress' and not (case when jsonb_typeof(p_response) = 'object' then p_response ? 'progress' else false end)
        then (case when jsonb_typeof(p_response) = 'object' then p_response else jsonb_build_object('body', p_response) end)
             || jsonb_build_object('progress', push_response -> 'progress')
      else p_response end,
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
select 'metrc_result keeps progress' as ok;

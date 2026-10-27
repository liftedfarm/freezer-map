-- 081_metrc_send_now.sql: flips to flowering go through the normal queue like everything else (sent right after the button,
-- continued by the 1-minute timer until every plant is tagged), instead of waiting for the overnight run.
-- Run after 080. Re-runnable.
set client_min_messages = warning;

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
        and coalesce(x.push_state, '') <> 'sending'
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

select '081 send now' as ok;

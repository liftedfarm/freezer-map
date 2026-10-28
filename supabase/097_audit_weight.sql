-- 097: Adjust weight "in the app only" for audits: fixes the app's number without making a METRC to-do
-- (for when METRC is already right, or the METRC side is handled by hand). Logged as its own event type so the
-- history shows it was app-only. Permission: Distribution "audit_weight" (Admins by default; Admin > Permissions).
-- Run once in Supabase after 096_rls_speed.sql. Safe to re-run.
begin;

insert into perm_rules (module, action, label, min_level, sort)
values ('distribution', 'audit_weight', 'Adjust weight in the app only (no METRC)', 'admin', 62)
on conflict (module, action) do nothing;

create or replace function adjust_weight_app_only(p_pallet_id bigint, p_weight numeric, p_note text) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; why text := nullif(trim(p_note), '');
begin
  perform require_staff();
  if not can_do('distribution', 'audit_weight') then raise exception 'Only a Distribution Admin can change weight in the app only'; end if;
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p_weight is null or p_weight < 0 then raise exception 'Enter a weight of 0 or more'; end if;
  if why is null then raise exception 'Say why (it goes in the history)'; end if;
  -- 'weight_audit' isn't a METRC event type, so no to-do is made
  insert into events(user_email, type, pallet_id, lbs, note, details)
  values (current_email(), 'weight_audit', p.id, p_weight, why,
          jsonb_strip_nulls(jsonb_build_object('from', p.current_weight, 'to', p_weight,
                                               'diff', case when p.current_weight is not null then p_weight - p.current_weight end, 'metrc', false)));
  update pallets set current_weight = p_weight, og_weight = coalesce(og_weight, p_weight), updated_at = now()
   where id = p.id returning * into p;
  return p;
end $$;

revoke execute on function adjust_weight_app_only(bigint, numeric, text) from public, anon;
grant execute on function adjust_weight_app_only(bigint, numeric, text) to authenticated;

commit;

select (select count(*) from perm_rules where action = 'audit_weight') as perm_rule,
       (select count(*) from pg_proc where proname = 'adjust_weight_app_only') as fn;

-- Migration 036: language per person (English / Español).
-- People pick it in My settings (⚙); Admins and Owners can set it for anyone in Admin > Settings > Users and access,
-- so the crew opens the app in Spanish without hunting for the setting in English.
-- Stored in app_users.prefs.lang. Run after 024. Safe to re-run.
set client_min_messages = warning;

create or replace function set_my_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; out jsonb;
begin
  perform no_view_as();
  for k in select jsonb_object_keys(coalesce(p, '{}')) loop
    if k not in ('theme','start_module','start_site','notify','lang') then raise exception 'Unknown setting %', k; end if;
  end loop;
  if p ? 'lang' and coalesce(p ->> 'lang', '') not in ('en','es') then raise exception 'Language must be en or es'; end if;
  update app_users set prefs = prefs || coalesce(p, '{}'), updated_at = now() where email = jwt_email() returning prefs into out;
  return out;
end $$;

-- an Admin (any module) or Owner sets someone's language
create or replace function set_user_lang(p_email text, p_lang text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not (is_owner() or is_any_admin()) then raise exception 'Only Admins and Owners can set someone else''s language'; end if;
  if p_lang not in ('en','es') then raise exception 'Language must be en or es'; end if;
  update app_users set prefs = prefs || jsonb_build_object('lang', p_lang), updated_at = now() where email = lower(trim(p_email));
  if not found then raise exception 'No one with that email'; end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'user_lang', lower(trim(p_email)) || ' → ' || p_lang, jsonb_build_object('email', lower(trim(p_email)), 'lang', p_lang));
end $$;

revoke execute on function set_user_lang(text, text) from public, anon;
grant execute on function set_my_prefs(jsonb), set_user_lang(text, text) to authenticated;

select 'ok' as language;

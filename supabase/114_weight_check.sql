-- 114: METRC weight on the pallet card, and "METRC only" weight adjustments.
-- TEMPORARY (catch-up while the app and METRC get in sync); listed in "Remove before full production".
--   pallet_metrc_weight(pallet)      what METRC had for the pallet's tag at the last pull (metrc_packages)
--   adjust_weight_metrc_only(...)   queues a METRC weight adjustment to the number given; the app's weight doesn't change.
--                                    The sender (api/metrc/_pkg.js sendAdjust) uses details.metrc_only to adjust METRC to
--                                    exactly details.to instead of the app's weight.
-- Same permission as "app only" (097): Distribution "audit_weight" (Admins by default).
-- Run once in Supabase after 113. Safe to re-run.
begin;

create or replace function pallet_metrc_weight(p_pallet_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pallets; lic text; m metrc_packages; open_n int;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id;
  if not found then raise exception 'Pallet not found'; end if;
  if p.package_tag is null then return jsonb_build_object('tag', null); end if;
  lic := comp_pallet_license(p.id);
  -- the license's own row first (active, then in transit, then anything), newest pull first
  select * into m from metrc_packages
   where upper(label) = upper(p.package_tag)
   order by (license = lic) desc, case state when 'active' then 0 when 'intransit' then 1 else 2 end, seen_at desc nulls last
   limit 1;
  select count(*) into open_n from comp_metrc_actions
   where status in ('todo', 'error') and upper(p.package_tag) = any(touch_tags);
  return jsonb_build_object('tag', p.package_tag, 'license', coalesce(m.license, lic), 'found', m.label is not null,
                            'lbs', m.lbs, 'qty', m.qty, 'uom', m.uom, 'state', m.state, 'item', m.item,
                            'seen_at', m.seen_at, 'open_todos', open_n);
end $$;
revoke execute on function pallet_metrc_weight(bigint) from public, anon;
grant execute on function pallet_metrc_weight(bigint) to authenticated;

create or replace function adjust_weight_metrc_only(p_pallet_id bigint, p_weight numeric, p_reason text, p_note text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare p pallets; lic text; known numeric; why text := nullif(trim(p_note), ''); rid bigint;
begin
  perform require_staff();
  if not can_do('distribution', 'audit_weight') then raise exception 'Only a Distribution Admin can change weight in METRC only'; end if;
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p.package_tag is null then raise exception '% has no METRC tag', p.code; end if;
  if p_weight is null or p_weight < 0 then raise exception 'Enter a weight of 0 or more'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Pick a METRC reason'; end if;
  lic := comp_pallet_license(p.id);
  if lic is null then raise exception 'Can''t tell which license % is on', p.code; end if;
  select lbs into known from metrc_packages where upper(label) = upper(p.package_tag) and license = lic
   order by (state = 'active') desc, seen_at desc nulls last limit 1;
  insert into comp_metrc_actions (license, action, pallet_id, code, tag, lbs, summary, details, kind)
  values (lic, 'Adjust package weight (METRC only)', p.id, p.code, upper(p.package_tag), p_weight,
          concat_ws(' · ', p.code, p.strain, 'METRC to ' || p_weight || ' lb, app stays ' || coalesce(p.current_weight::text, '?') || ' lb'),
          jsonb_strip_nulls(jsonb_build_object('type', 'weight_adjust', 'metrc_only', true, 'to', p_weight, 'from', known,
                                               'app_lbs', p.current_weight, 'reason', p_reason, 'by', current_email(), 'note', why)),
          'adjust')
  returning id into rid;
  return rid;
end $$;
revoke execute on function adjust_weight_metrc_only(bigint, numeric, text, text) from public, anon;
grant execute on function adjust_weight_metrc_only(bigint, numeric, text, text) to authenticated;

commit;

select (select count(*) from pg_proc where proname in ('pallet_metrc_weight', 'adjust_weight_metrc_only')) as fns;

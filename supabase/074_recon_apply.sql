-- 074_recon_apply.sql: apply the filled-in mismatch Excel (Compliance > METRC > Reconcile) in bulk.
--   Use METRC  change the app to match METRC (logged as metrc_match events, which never create METRC to-dos)
--   Keep app   METRC needs fixing: a METRC to-do is queued where the app can describe it (weight, finish), else noted
--   Ignore     hidden from the report while the numbers stay the same
-- Re-runnable. Run after 073.

create table if not exists comp_recon_ignores (
  id         bigserial primary key,
  issue      text not null,
  tag        text,
  pallet_id  bigint,
  app_lbs    numeric,
  metrc_lbs  numeric,
  reason     text,
  by_email   text,
  at         timestamptz not null default now()
);
create index if not exists comp_recon_ignores_tag on comp_recon_ignores (issue, tag);
alter table comp_recon_ignores enable row level security;
drop policy if exists read_comp_recon_ignores on comp_recon_ignores;
create policy read_comp_recon_ignores on comp_recon_ignores for select to authenticated using (comp_can_read());
grant select on comp_recon_ignores to authenticated;

/** the report as Reconcile shows it: ignored rows hidden while their numbers stay the same */
create or replace function comp_reconcile_view(p_license text) returns table (
  issue text, tag text, pallet_id bigint, code text, strain text, app_lbs numeric, metrc_lbs numeric, app_item text, metrc_item text,
  app_license text, metrc_location text, app_spot text, metrc_changed timestamptz, explain text, trail jsonb, note text)
language sql stable security definer set search_path = public as $$
  select r.* from comp_reconcile_live(p_license) r
   where not exists (select 1 from comp_recon_ignores g
                      where g.issue = r.issue and coalesce(g.tag, '') = coalesce(r.tag, '') and coalesce(g.pallet_id, -1) = coalesce(r.pallet_id, -1)
                        and g.app_lbs is not distinct from r.app_lbs and g.metrc_lbs is not distinct from r.metrc_lbs)
$$;
revoke all on function comp_reconcile_view(text) from public, anon;
grant execute on function comp_reconcile_view(text) to authenticated;

create or replace function _recon_match_event(p_pallet bigint, p_what text, p_reason text, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into events (user_email, type, pallet_id, note, details)
  values (current_email(), 'metrc_match', p_pallet, nullif(trim(p_reason), ''), jsonb_build_object('what', p_what) || coalesce(p_details, '{}'))
$$;

/** p_rows: [{ key: "issue|tag|pallet_id", action: "Use METRC" | "Keep app" | "Ignore", reason }]. p_dry = true: say what would happen, change nothing. */
create or replace function comp_recon_apply(p_rows jsonb, p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  x jsonb; k text[]; iss text; tg text; pid bigint; act text; why text; r jsonb; p pallets; res jsonb := '[]'; msg text; ok boolean;
  n_done int := 0; n_skip int := 0; site_ text; code_ text; i int; busy text; st text;
begin
  if not (comp_can_edit() or is_mod_admin('distribution') or is_owner()) or impersonating() then
    raise exception 'Only Compliance (or a Distribution Admin) can apply reconcile changes';
  end if;
  -- the live report once, for every license (so a stale Excel can't do the wrong thing)
  drop table if exists _rr;
  create temp table _rr on commit drop as
    select to_jsonb(lr) || jsonb_build_object('license', l.license_no, 'site', l.site) as rj, lr.issue as ri, coalesce(lr.tag, '') as rt, coalesce(lr.pallet_id, -1) as rp
      from licenses l, lateral comp_reconcile_live(l.license_no) lr
     where l.active and l.site is not null and l.kind <> 'transport';
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    k := string_to_array(coalesce(x ->> 'key', ''), '|');
    iss := k[1]; tg := nullif(k[2], ''); pid := nullif(k[3], '')::bigint;
    act := lower(trim(coalesce(x ->> 'action', ''))); why := nullif(trim(coalesce(x ->> 'reason', '')), '');
    if act = '' then continue; end if;
    ok := false; msg := null;
    select rj into r from _rr where ri = iss and rt = coalesce(upper(tg), '') and rp = coalesce(pid, -1) limit 1;
    if r is null then
      msg := 'No longer a mismatch (fixed since the export, or pull again)';
    elsif act not in ('use metrc', 'keep app', 'ignore') then
      msg := 'Action must be Use METRC, Keep app or Ignore';
    elsif act <> 'ignore' and why is null then
      msg := 'Give a reason';
    else
      if pid is not null then select * into p from pallets where id = pid; end if;
      -- a pallet on an order or a load: fix it in Fulfillment / the load first
      busy := null;
      if pid is not null and act = 'use metrc' and iss in ('not_in_metrc', 'other_license') then
        select 'held for ' || coalesce(o.so_number, 'order #' || o.id) into busy from order_picks op join orders o on o.id = op.order_id
         where op.pallet_id = pid and o.status not in ('shipped', 'cancelled') limit 1;
        if busy is null then
          select 'on load ' || coalesce(l.code, '#' || l.id) into busy from load_items li join loads l on l.id = li.load_id
           where li.pallet_id = pid and l.status not in ('delivered', 'cancelled') limit 1;
        end if;
      end if;
      if busy is not null then
        msg := 'Skipped: ' || busy || '. Take it off there first.';
      elsif act = 'ignore' then
        ok := true; msg := 'Hidden while the numbers stay the same';
        if not p_dry then
          insert into comp_recon_ignores (issue, tag, pallet_id, app_lbs, metrc_lbs, reason, by_email)
          values (iss, upper(tg), pid, (r ->> 'app_lbs')::numeric, (r ->> 'metrc_lbs')::numeric, why, current_email());
        end if;
      elsif act = 'keep app' then
        ok := true;
        if iss = 'weight' and pid is not null then
          msg := 'METRC to-do: adjust to ' || (r ->> 'app_lbs') || ' lb';
          if not p_dry then
            insert into comp_metrc_actions (license, action, pallet_id, code, tag, lbs, summary, details, kind)
            values (r ->> 'license', 'Adjust package weight (Entry error)', pid, p.code, upper(tg), (r ->> 'app_lbs')::numeric, 'From reconcile: ' || why,
                    jsonb_build_object('type', 'weight_adjust', 'to', (r ->> 'app_lbs')::numeric, 'from', (r ->> 'metrc_lbs')::numeric, 'reason', 'entry', 'by', current_email(), 'note', why), 'adjust');
          end if;
        elsif iss = 'closed_in_app' then
          msg := 'METRC to-do: adjust to 0 and finish';
          if not p_dry then
            insert into comp_metrc_actions (license, action, pallet_id, code, tag, lbs, summary, details, kind)
            values (r ->> 'license', 'Adjust to 0 and finish package', pid, p.code, upper(tg), 0, 'From reconcile: ' || why,
                    jsonb_build_object('type', 'removed', 'reason', 'used', 'by', current_email(), 'note', why), 'finish');
          end if;
        else
          msg := 'Noted. Fix it in METRC by hand';
          if not p_dry then perform _recon_match_event(pid, 'keep_app:' || iss, why, jsonb_build_object('tag', tg, 'license', r ->> 'license')); end if;
        end if;
      else  -- use metrc
        site_ := r ->> 'site';
        if iss = 'weight' then
          ok := true; msg := p.code || ': ' || (r ->> 'app_lbs') || ' > ' || (r ->> 'metrc_lbs') || ' lb';
          if not p_dry then
            update pallets set current_weight = (r ->> 'metrc_lbs')::numeric, updated_at = now() where id = pid;
            perform _recon_match_event(pid, 'weight', why, jsonb_build_object('from', r -> 'app_lbs', 'to', r -> 'metrc_lbs', 'tag', tg, 'trail', r ->> 'explain'));
          end if;
        elsif iss = 'not_in_metrc' then
          st := case when r -> 'trail' -> 'ship' is not null and r -> 'trail' -> 'ship' <> 'null'::jsonb then 'shipped'
                     when r -> 'trail' -> 'self' is not null and r -> 'trail' -> 'self' <> 'null'::jsonb then 'depleted'
                     else 'archived' end;
          ok := true; msg := p.code || ': ' || case st when 'shipped' then 'shipped (' || (r -> 'trail' -> 'ship' ->> 'manifest') || ')'
                                                   when 'depleted' then 'used up / finished' else 'archived (never in METRC)' end;
          if not p_dry then
            update pallets set status = st, slot_id = null, received_site = null, updated_at = now() where id = pid;
            perform _recon_match_event(pid, 'closed', why, jsonb_build_object('status', st, 'tag', tg, 'trail', r ->> 'explain', 'manifest', r -> 'trail' -> 'ship' ->> 'manifest'));
          end if;
        elsif iss = 'closed_in_app' then
          ok := true; msg := p.code || ': back in inventory at ' || site_ || ' (Needs a spot), ' || coalesce(r ->> 'metrc_lbs', '?') || ' lb';
          if not p_dry then
            update pallets set status = 'unslotted', slot_id = null, received_site = site_, current_weight = coalesce((r ->> 'metrc_lbs')::numeric, current_weight),
                   merged_into = null, updated_at = now() where id = pid;
            perform _recon_match_event(pid, 'reopened', why, jsonb_build_object('tag', tg, 'lbs', r -> 'metrc_lbs', 'site', site_));
          end if;
        elsif iss = 'other_license' then
          ok := true; msg := p.code || ': moved to ' || site_ || ' (Needs a spot)';
          if not p_dry then
            update pallets set status = 'unslotted', slot_id = null, received_site = site_, updated_at = now() where id = pid;
            perform _recon_match_event(pid, 'site', why, jsonb_build_object('tag', tg, 'to_site', site_, 'license', r ->> 'license'));
          end if;
        elsif iss = 'not_in_app' then
          code_ := (case when site_ = 'GVR' then 'G' else 'P' end) || right(upper(tg), 4);
          i := 1;
          while exists (select 1 from pallets where code = code_) loop
            code_ := (case when site_ = 'GVR' then 'G' else 'P' end) || right(upper(tg), 4) || '-M' || i; i := i + 1;
          end loop;
          ok := true; msg := 'New ' || code_ || ' at ' || site_ || ' (Needs a spot), ' || coalesce(r ->> 'metrc_lbs', '?') || ' lb, ' || coalesce(r ->> 'metrc_item', '');
          if not p_dry then
            insert into pallets (code, strain, current_weight, og_weight, package_tag, status, received_site, product, needs_review, notes)
            values (code_, nullif(trim(split_part(coalesce(r ->> 'metrc_item', ''), ' - ', 2)), ''), (r ->> 'metrc_lbs')::numeric, (r ->> 'metrc_lbs')::numeric,
                    upper(tg), 'unslotted', site_,
                    case when (r ->> 'metrc_item') ~* 'standard' then 'standards' when (r ->> 'metrc_item') ~* 'small' then 'smalls'
                         when (r ->> 'metrc_item') ~* 'trim' then 'trim' when (r ->> 'metrc_item') ~* 'unbucked' then 'unbucked'
                         when (r ->> 'metrc_item') ~* 'bucked' then 'bucked' when (r ->> 'metrc_item') ~* 'wet' then 'wet' else 'fresh_frozen' end,
                    'Added from METRC: check strain and product', 'METRC item: ' || coalesce(r ->> 'metrc_item', '?') || coalesce('. ' || why, ''))
            returning id into pid;
            perform _recon_match_event(pid, 'added', why, jsonb_build_object('tag', tg, 'item', r ->> 'metrc_item', 'lbs', r -> 'metrc_lbs', 'site', site_));
          end if;
        else
          ok := true; msg := 'Noted (the app can''t change this one automatically)';
          if not p_dry then perform _recon_match_event(pid, 'note:' || iss, why, jsonb_build_object('tag', tg, 'license', r ->> 'license')); end if;
        end if;
      end if;
    end if;
    if ok then n_done := n_done + 1; else n_skip := n_skip + 1; end if;
    res := res || jsonb_build_object('key', x ->> 'key', 'action', x ->> 'action', 'ok', ok, 'msg', msg, 'code', coalesce(p.code, null), 'issue', iss);
    p := null;
  end loop;
  if not p_dry then
    insert into events (user_email, type, note, details) values (current_email(), 'recon_apply', n_done || ' applied, ' || n_skip || ' skipped', jsonb_build_object('done', n_done, 'skipped', n_skip));
  end if;
  return jsonb_build_object('dry', p_dry, 'done', n_done, 'skipped', n_skip, 'rows', res);
end $$;
revoke all on function comp_recon_apply(jsonb, boolean) from public, anon;
grant execute on function comp_recon_apply(jsonb, boolean) to authenticated;
revoke all on function _recon_match_event(bigint, text, text, jsonb) from public, anon, authenticated;

select '074 recon apply' as ok;

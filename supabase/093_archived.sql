-- 093: Distribution > Archived. Find archived pallets, see which are still active in METRC, bring them back or delete them.
-- Run once in Supabase (SQL Editor > New query > paste > Run) after 091_flag_review.sql (092 was a one-off data fix). Safe to re-run.
--
--  * archived_overview(): every archived pallet with its METRC package (from the nightly pull), the site it belongs at,
--    the last thing that happened to it (none = archived at the sheet import), and whether you can restore / delete.
--  * restore_pallet(id, note, slot, site, staging, weight): brings one back. Goes to the spot picked on the map,
--    or that site's Staging, or Needs a spot at that site. Weight can be set (Archived uses METRC's weight when active).
--    Permission: Distribution "restore_pallet" (Admins by default). Its tag can't be on any other pallet.
--  * restore_pallets(ids, note, staging, use_metrc): many at once, each to its own site (from its METRC license).
--  * delete_archived_pallet(id, note): removes it and its history for good. New permission "delete_pallet" (Admins).
--    Refused while METRC still has the package active, or when a load, run, order, METRC to-do or another pallet points at it.
--    The pallet's last state is kept in the activity log (event 'pallet_deleted').
--  No METRC actions are queued: archiving never changed METRC, so restoring or deleting doesn't either.
begin;

insert into perm_rules (module, action, label, min_level, sort)
values ('distribution', 'restore_pallet', 'Restore an archived pallet', 'admin', 60),
       ('distribution', 'delete_pallet', 'Delete an archived pallet for good', 'admin', 61)
on conflict (module, action) do nothing;

-- which site an archived pallet belongs at: METRC license > where it was received > where it was grown > its code letter
drop function if exists archived_site(pallets, text);
create or replace function archived_site(p_code text, p_received text, p_origin text, p_license text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.site from licenses l where l.license_no = p_license and l.site in (select code from sites)),
    nullif(p_received, ''),
    case when p_origin in (select code from sites) then p_origin end,
    (select s.code from sites s where s.pallet_prefix is not null and p_code like s.pallet_prefix || '%' order by length(s.pallet_prefix) desc limit 1))
$$;

create or replace function archived_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rows jsonb; pulled timestamptz;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select max(seen_at) into pulled from metrc_packages;
  with m as (
    select distinct on (upper(trim(label))) upper(trim(label)) as tag, license, state, lbs, qty, uom, item
      from metrc_packages where state in ('active', 'intransit')
     order by upper(trim(label)), (state = 'active') desc, seen_at desc
  ), a as (
    select p.*, m.license as m_license, m.state as m_state, coalesce(m.lbs, case when m.uom ilike 'pound%' or m.uom ilike 'lb%' then m.qty end) as m_lbs, m.item as m_item
      from pallets p left join m on m.tag = upper(trim(p.package_tag))
     where p.status = 'archived'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'code', a.code, 'strain', a.strain, 'label', a.label, 'product', a.product, 'crop_year', a.crop_year,
           'harvest_date', a.harvest_date, 'lbs', a.current_weight, 'og_lbs', a.og_weight, 'tag', a.package_tag, 'kind', a.kind,
           'notes', a.notes, 'needs_review', a.needs_review, 'updated_at', a.updated_at, 'harvest_id', a.harvest_id,
           'site', archived_site(a.code, a.received_site, a.origin_site, a.m_license),
           'metrc_license', a.m_license, 'metrc_state', a.m_state, 'metrc_lbs', a.m_lbs, 'metrc_item', a.m_item,
           'tag_on', (select o.code || ' (' || o.status || ')' from pallets o
                       where a.package_tag is not null and upper(trim(o.package_tag)) = upper(trim(a.package_tag)) and o.id <> a.id limit 1),
           'last', (select jsonb_build_object('at', e.at, 'by', e.user_email, 'type', e.type, 'note', e.note, 'reason', e.details ->> 'reason')
                      from events e where e.pallet_id = a.id order by e.id desc limit 1)
         ) order by (a.m_state is not null) desc, a.code), '[]') into rows
    from a;
  return jsonb_build_object('rows', rows, 'pulled', pulled,
    'can_restore', can_do('distribution', 'restore_pallet') and coalesce(mod_level('distribution'), '') <> 'view',
    'can_delete', can_do('distribution', 'delete_pallet') and coalesce(mod_level('distribution'), '') <> 'view');
end $$;

drop function if exists restore_pallet(bigint, text, int);
create or replace function restore_pallet(p_pallet_id bigint, p_note text default null, p_slot int default null, p_site text default null,
                                          p_staging boolean default false, p_weight numeric default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; other pallets; dest int; site_ text; was numeric; note text := coalesce(nullif(trim(p_note), ''), 'Restored from Archived');
begin
  perform require_staff();
  if not can_do('distribution', 'restore_pallet') then raise exception 'You don''t have permission to restore pallets. Ask a Distribution Admin.'; end if;
  select * into p from pallets where id = p_pallet_id for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.status <> 'archived' then raise exception '% isn''t archived', p.code; end if;
  if p_weight is not null and p_weight <= 0 then raise exception 'Weight has to be more than 0'; end if;
  if nullif(trim(p.package_tag), '') is not null then
    select * into other from pallets
     where upper(trim(package_tag)) = upper(trim(p.package_tag)) and id <> p.id
     order by (status in ('in_freezer','unslotted')) desc, id desc limit 1;
    if other.id is not null then
      raise exception 'Can''t restore %: its tag % is also on % (%). A tag can only ever be on one pallet.', p.code, p.package_tag, other.code, other.status;
    end if;
  end if;
  if p.harvest_id is not null and not coalesce(p.pushed, true) then perform cult_guard_done(p.harvest_id); end if;

  if p_slot is not null then
    dest := check_destination(p_slot, array[p.id]);
    select f.site into site_ from slots s join freezers f on f.id = s.freezer_id where s.id = dest;
  else
    site_ := coalesce(nullif(trim(p_site), ''), archived_site(p.code, p.received_site, p.origin_site, (select license from metrc_packages where upper(trim(label)) = upper(trim(p.package_tag)) and state in ('active','intransit') limit 1)));
    if site_ is null or not exists (select 1 from sites where code = site_) then raise exception 'Pick which site % goes back to', p.code; end if;
    if p_staging then
      dest := harvest_slot(site_);
      if dest is null then raise exception '% has no Staging area', site_; end if;
    end if;
  end if;

  was := p.current_weight;
  update pallets set
    status = case when dest is null then 'unslotted' else 'in_freezer' end,
    slot_id = dest, span_to_slot = null, container_id = null,
    received_site = case when dest is null then site_ else null end,
    current_weight = coalesce(p_weight, current_weight),
    notes = nullif(trim(replace(coalesce(notes, ''), '(logged by mistake)', '')), ''),
    needs_review = case when needs_review like 'Entered by mistake%' then null else needs_review end,
    updated_at = now()
   where id = p.id returning * into p;

  insert into events (user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'restored', p.id, dest, p.current_weight, note,
          jsonb_build_object('tag', p.package_tag, 'site', site_, 'staging', p_staging and p_slot is null,
                             'weight_was', case when p_weight is not null and p_weight is distinct from was then was end));
  return p;
end $$;

-- many at once: each to its own site (Staging or Needs a spot), METRC weight when asked and active
create or replace function restore_pallets(p_ids bigint[], p_note text default null, p_staging boolean default false, p_use_metrc boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i bigint; w numeric; done int := 0; errs jsonb := '[]'; c text;
begin
  perform require_staff();
  if not can_do('distribution', 'restore_pallet') then raise exception 'You don''t have permission to restore pallets. Ask a Distribution Admin.'; end if;
  foreach i in array coalesce(p_ids, '{}') loop
    begin
      select code into c from pallets where id = i;
      w := null;
      if p_use_metrc then
        select coalesce(m.lbs, case when m.uom ilike 'pound%' or m.uom ilike 'lb%' then m.qty end) into w
          from pallets p join metrc_packages m on upper(trim(m.label)) = upper(trim(p.package_tag)) and m.state in ('active','intransit')
         where p.id = i limit 1;
        if w is not null and w <= 0 then w := null; end if;
      end if;
      perform restore_pallet(i, p_note, null, null, p_staging, w);
      done := done + 1;
    exception when others then
      errs := errs || jsonb_build_object('id', i, 'code', c, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('done', done, 'errors', errs);
end $$;

create or replace function delete_archived_pallet(p_pallet_id bigint, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets; why text := nullif(trim(p_note), ''); hit text;
begin
  perform require_staff();
  if not can_do('distribution', 'delete_pallet') then raise exception 'You don''t have permission to delete pallets. Ask a Distribution Admin.'; end if;
  select * into p from pallets where id = p_pallet_id for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.status <> 'archived' then raise exception 'Only archived pallets can be deleted. Archive % first (Remove > Entered by mistake).', p.code; end if;
  if why is null then raise exception 'Say why it''s being deleted'; end if;
  if nullif(trim(p.package_tag), '') is not null and exists (select 1 from metrc_packages m where upper(trim(m.label)) = upper(trim(p.package_tag)) and m.state in ('active','intransit')) then
    raise exception '% is still an active package in METRC. Restore it, or finish it in METRC first.', p.code;
  end if;
  hit := case
    when exists (select 1 from load_items where pallet_id = p.id) then 'it was on a load'
    when exists (select 1 from proc_run_inputs where pallet_id = p.id) or exists (select 1 from proc_commitments where pallet_id = p.id) then 'it''s in a processing run'
    when exists (select 1 from pallets where parent_id = p.id or merged_into = p.id or container_id = p.id) then 'other pallets were split from, merged into or packed on it'
    when exists (select 1 from comp_metrc_actions where pallet_id = p.id) then 'it has METRC to-dos'
    when exists (select 1 from order_picks k join orders o on o.id = k.order_id where k.pallet_id = p.id and o.status <> 'pending') then 'it was picked for an order'
    when exists (select 1 from invoice_packages where pallet_code = p.code) then 'it''s on an invoice'
  end;
  if hit is not null then raise exception 'Can''t delete %: %. Leave it archived so that record stays complete.', p.code, hit; end if;

  insert into events (user_email, type, lbs, note, details)
  values (current_email(), 'pallet_deleted', p.current_weight, why, jsonb_build_object('code', p.code, 'pallet', to_jsonb(p)));
  delete from order_picks where pallet_id = p.id;
  delete from comp_recon_ignores where pallet_id = p.id;
  delete from events where pallet_id = p.id;
  delete from pallets where id = p.id;
end $$;

revoke execute on function archived_site(text, text, text, text) from public, anon, authenticated;
revoke execute on function archived_overview(), restore_pallet(bigint, text, int, text, boolean, numeric),
  restore_pallets(bigint[], text, boolean, boolean), delete_archived_pallet(bigint, text) from public, anon;
grant execute on function archived_overview(), restore_pallet(bigint, text, int, text, boolean, numeric),
  restore_pallets(bigint[], text, boolean, boolean), delete_archived_pallet(bigint, text) to authenticated;

commit;

select (select count(*) from perm_rules where action in ('restore_pallet', 'delete_pallet')) as perm_rules,
       (select count(*) from pg_proc where proname in ('archived_overview', 'restore_pallet', 'restore_pallets', 'delete_archived_pallet')) as functions;

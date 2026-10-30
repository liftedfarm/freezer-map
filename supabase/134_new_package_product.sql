-- 134: New package button: picking another item also sets the product to match it (Aziz 10/30: D999-1 got the trim item
--   but stayed "bucked"). Same function as 132 otherwise. Safe to re-run.
begin;

-- ---------- the button ----------
create or replace function new_package(
  p_pallet_id bigint, p_lbs numeric, p_tag text, p_tag_pending boolean default false, p_dest_slot int default null,
  p_item_id bigint default null, p_note text default null, p_keep_on_load boolean default false
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; child pallets; tag text := upper(nullif(trim(p_tag), '')); used text; old text; lic text;
        it items; eid bigint; d jsonb; whole boolean; prod text;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p.current_weight is null then raise exception 'Pallet % has no weight. Adjust its weight first.', p.code; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter how many lbs go in the new package'; end if;
  if p_lbs > p.current_weight + 0.0001 then raise exception '% only has % lbs', p.code, p.current_weight; end if;
  if p_item_id is not null then
    select * into it from items where id = p_item_id;
    if it.id is null then raise exception 'Item not found'; end if;
    -- the product follows the item (133/134: a trim item makes it trim)
    prod := case it.finish when 'FF' then 'fresh_frozen' when 'UF' then 'unbucked' when 'BF' then 'bucked' when 'BS' then 'bucked_standards'
                           when 'ST' then 'standards' when 'SM' then 'smalls' when 'TR' then 'trim' end;
  end if;
  whole := p_lbs >= p.current_weight - 0.0001;

  if not whole then
    -- part of it: the split, then the new piece gets the item
    child := split_pallet(p_pallet_id, p_lbs, tag, p_tag_pending, p_dest_slot, p_note, true, p_keep_on_load);
    if it.id is not null and it.id is distinct from child.item_id then
      update pallets set item_id = it.id, product = coalesce(prod, product), updated_at = now() where id = child.id returning * into child;
      update comp_metrc_actions set details = details || jsonb_build_object('item_id', it.id, 'item_name', it.metrc_name)
       where pallet_id = child.id and kind = 'split' and status in ('todo', 'error');
    end if;
    return child;
  end if;

  -- all of it: same pallet, new tag
  perform assert_loose(p, 'repackaged');
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Repackage one of the packages on it instead.', p.code; end if;
  if p.status not in ('in_freezer', 'unslotted') then raise exception '% is %. Only a package in a freezer or unslotted can be repackaged.', p.code, replace(p.status, '_', ' '); end if;
  if p.package_tag is null then raise exception '% has no METRC tag yet, so there''s nothing to repackage. Enter its tag instead.', p.code; end if;
  if coalesce(p.their_tag, false) then raise exception '% is still on the processor''s tag. Use Processing > Needs our tag.', p.code; end if;
  if tag is null then raise exception 'Enter the new METRC tag'; end if;
  if tag = upper(p.package_tag) then raise exception '% is already on %', p.code, tag; end if;
  used := tag_in_use(tag, p.id);
  if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  if tag_available(tag) is false then raise exception 'Tag % isn''t on METRC''s available list. It''s used, voided or never issued.', tag; end if;
  if exists (select 1 from comp_metrc_actions a where a.pallet_id = p.id and a.kind = 'repackage' and a.status in ('todo', 'error')) then
    raise exception '% already has a repackage waiting in the METRC to-do list. Send or clear that one first.', p.code;
  end if;

  old := upper(p.package_tag);
  lic := comp_pallet_license(p.id);
  d := jsonb_strip_nulls(jsonb_build_object('type', 'repackage', 'from', old, 'to', tag, 'code', p.code, 'strain', p.strain, 'product', p.product,
         'lbs', p.current_weight, 'item_id', it.id, 'item_name', it.metrc_name,
         'item_from', (select metrc_name from items where id = p.item_id), 'by', current_email()));
  update pallets set package_tag = tag, tag_pending = false, item_id = coalesce(it.id, item_id), product = coalesce(prod, product), updated_at = now()
   where id = p.id returning * into p;
  insert into events (user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, details)
  values (current_email(), 'repackage', p.id, p.slot_id, p.slot_id, p.current_weight,
          coalesce(nullif(trim(p_note), ''), 'New package ' || tag || ' (was ' || old || ')'), d)
  returning id into eid;
  insert into comp_metrc_actions (event_id, at, license, kind, action, pallet_id, code, tag, lbs, summary, details)
  values (eid, now(), lic, 'repackage', 'New package (whole package onto a new tag)', p.id, p.code, tag, p.current_weight,
          concat_ws(' · ', p.code, p.strain, 'from ' || old), d || jsonb_build_object('note', p_note))
  on conflict (event_id) do nothing;
  return p;
end $$;
revoke all on function new_package(bigint, numeric, text, boolean, int, bigint, text, boolean) from public, anon;
grant execute on function new_package(bigint, numeric, text, boolean, int, bigint, text, boolean) to authenticated;

select proname from pg_proc where proname = 'new_package';
commit;

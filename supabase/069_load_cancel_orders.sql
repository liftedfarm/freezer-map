-- 069: orders come off a cancelled load; same-farm checks for combining and mixed pallets
--  1. Cancelling a load takes its orders off (back to Ready in Fulfillment). Orders already stuck on a
--     cancelled load are freed now.
--  2. order_off_load also works when the load was cancelled.
--  3. Combine into one tag and order mixed pallets need everything at one farm (one license in METRC).
--     Product at the other farm goes over first with Send to GVR/OHR.
-- Safe to run more than once. Run after 068.

create or replace function cancel_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; o record;
begin
  perform require_staff();
  select * into l from loads where id = p_load for update;
  if l.status not in ('planning','loading') then raise exception 'Load % is %', l.code, l.status; end if;
  if exists (select 1 from load_items where load_id = l.id and loaded) then raise exception 'Some pallets are already on the truck. Put them back first.'; end if;
  delete from load_items where load_id = l.id;
  for o in select x.id, x.so_number from orders x join load_stops s on s.id = x.stop_id where s.load_id = l.id loop
    update orders set stop_id = null, updated_at = now() where id = o.id;
    insert into events (user_email, type, load_id, details)
    values (current_email(), 'fulfill_unloaded', l.id, jsonb_build_object('load', l.code, 'order_id', o.id, 'so', o.so_number, 'why', 'load cancelled'));
  end loop;
  update loads set status = 'cancelled', closed_at = now() where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_cancelled', l.id, jsonb_build_object('load', l.code));
end $$;

-- orders left on loads that were already cancelled
update orders o set stop_id = null, updated_at = now()
  from load_stops s join loads l on l.id = s.load_id
 where o.stop_id = s.id and l.status = 'cancelled' and o.status = 'pending';

create or replace function order_off_load(p_order int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; s load_stops; l loads; grp int[]; gid int;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  if o.stop_id is null then return; end if;
  select * into s from load_stops where id = o.stop_id;
  select * into l from loads where id = s.load_id;
  if l.status = 'cancelled' then
    update orders set stop_id = null, updated_at = now() where id = o.id;
    return;
  end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  grp := (select array_agg(id) from orders where id = any(order_group(o.id)) and stop_id = s.id);
  if exists (select 1 from load_items i where i.stop_id = s.id and i.loaded and i.pallet_id in (
               select coalesce(p.container_id, p.id) from order_picks x join pallets p on p.id = x.pallet_id where x.order_id = any(grp))) then
    raise exception 'Some of its pallets are already on the truck. Put them back first.';
  end if;
  delete from load_items i where i.stop_id = s.id and i.pallet_id in (
    select coalesce(p.container_id, p.id) from order_picks x join pallets p on p.id = x.pallet_id where x.order_id = any(grp));
  update orders set stop_id = null, updated_at = now() where id = any(grp);
  if not exists (select 1 from load_items where stop_id = s.id) and not exists (select 1 from orders where stop_id = s.id)
     and (select count(*) from load_stops where load_id = l.id) > 1 then
    delete from load_stops where id = s.id;
  end if;
  foreach gid in array grp loop
    insert into events (user_email, type, load_id, details)
    values (current_email(), 'fulfill_unloaded', l.id, jsonb_build_object('load', l.code, 'order_id', gid, 'so', (select so_number from orders where id = gid)));
  end loop;
end $$;

-- ---------- one farm per combined package / mixed pallet ----------
create or replace function same_site_check(p_ids bigint[], p_what text) returns text
language plpgsql stable security definer set search_path = public as $$
declare sites text[];
begin
  select array_agg(distinct coalesce(pallet_site(p), '?')) into sites from pallets p where p.id = any(p_ids);
  if coalesce(array_length(sites, 1), 0) > 1 then
    raise exception '% has to be at one farm (these are at %). Send one side over first with Send to GVR/OHR on the order.', p_what, array_to_string(sites, ' and ');
  end if;
  return sites[1];
end $$;

-- wrap 068's functions with the farm check (keeps their logic in one place)
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'combine_for_line_068') then
    alter function combine_for_line(int, jsonb, text, boolean, int) rename to combine_for_line_068;
  end if;
  if not exists (select 1 from pg_proc where proname = 'order_mixed_pallet_068') then
    alter function order_mixed_pallet(int, bigint[], bigint, int) rename to order_mixed_pallet_068;
  end if;
end $$;
revoke execute on function combine_for_line_068(int, jsonb, text, boolean, int) from public, anon, authenticated;
revoke execute on function order_mixed_pallet_068(int, bigint[], bigint, int) from public, anon, authenticated;

create or replace function combine_for_line(p_line int, p_sources jsonb, p_tag text default null, p_tag_pending boolean default false, p_slot int default null)
returns order_picks
language plpgsql security definer set search_path = public as $$
declare site text; dest text;
begin
  perform require_distribution();
  site := same_site_check(array(select (e->>'pallet_id')::bigint from jsonb_array_elements(coalesce(p_sources, '[]')) e), 'Everything combined into one tag');
  if p_slot is not null then
    select f.site into dest from slots s join freezers f on f.id = s.freezer_id where s.id = p_slot;
    if dest is distinct from site then raise exception 'Put the new package at % (where the pallets are)', site; end if;
  end if;
  return combine_for_line_068(p_line, p_sources, p_tag, p_tag_pending, p_slot);
end $$;

create or replace function order_mixed_pallet(p_order int, p_pallets bigint[], p_into bigint default null, p_slot int default null)
returns pallets
language plpgsql security definer set search_path = public as $$
declare site text; dest text;
begin
  perform require_distribution();
  site := same_site_check(case when p_into is null then p_pallets else p_pallets || p_into end, 'A mixed pallet');
  if p_slot is not null then
    select f.site into dest from slots s join freezers f on f.id = s.freezer_id where s.id = p_slot;
    if dest is distinct from site then raise exception 'Build the mixed pallet at % (where the packages are)', site; end if;
  end if;
  return order_mixed_pallet_068(p_order, p_pallets, p_into, p_slot);
end $$;

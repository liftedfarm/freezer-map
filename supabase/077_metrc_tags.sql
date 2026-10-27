-- 077_metrc_tags.sql: available METRC tags per license (pulled through T3), next-tag suggestions from them,
-- tag ranges kept as blocks reserved for a purpose, the autofill switch, and the METRC manifest each package left on.
-- Run after 076. Re-runnable.
set client_min_messages = warning;

-- ---------- available tags, per license (written by the server: nightly pull, or Pull tags) ----------
create table if not exists metrc_tags (
  license   text not null,
  label     text not null,
  tag_type  text not null check (tag_type in ('package', 'plant')),
  type_name text,
  seen_at   timestamptz not null default now(),
  primary key (license, label));
create index if not exists metrc_tags_pick on metrc_tags (license, tag_type, label);
alter table metrc_tags enable row level security;
drop policy if exists read_metrc_tags on metrc_tags;
create policy read_metrc_tags on metrc_tags for select to authenticated using (is_staff());
grant select on metrc_tags to authenticated;
grant all on metrc_tags to service_role;

alter table nursery_batches add column if not exists package_tag text;

-- the manifest a package went out on (in transit packages carry it before the shipped list does)
alter table metrc_packages add column if not exists out_manifest text;

-- ---------- which tags the app already has on something ----------
create index if not exists pallets_tag_upper on pallets (upper(package_tag));
create index if not exists nursery_mothers_tag_upper on nursery_mothers (upper(plant_tag));
create or replace function tag_used_in_app(p_tag text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pallets where upper(package_tag) = upper(p_tag))
      or exists (select 1 from nursery_batches where upper(p_tag) = any(select upper(t) from unnest(tags) t))
      or exists (select 1 from nursery_mothers where upper(plant_tag) = upper(p_tag))
      or exists (select 1 from nursery_batches where upper(package_tag) = upper(p_tag))
$$;

-- ranges come in two kinds now: the old imported lists of issued tags (ignored once METRC's list is pulled), and blocks
-- reserved for a purpose (reserved = true), e.g. the pallet-number tags. Only reserved ranges hold tags back.
alter table tag_ranges add column if not exists reserved boolean not null default false;
-- seed: the pallet-number tags (tag rules) are blocked off for harvest pallets
insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, active, notes, license, reserved)
select r.site, 'harvest', r.prefix, r."offset" + 1, r."offset" + case when r.letter = 'T' then 999 else 9999 end, r.digits, true,
       'Pallet numbers ' || r.letter || '1-' || r.letter || case when r.letter = 'T' then '999' else '9999' end || ' (tag rule)', coalesce(r.license, site_license(r.site)), true
  from tag_rules r
 where r.active and not exists (select 1 from tag_ranges x where x.reserved and x.license = coalesce(r.license, site_license(r.site)) and x.prefix = r.prefix);

-- a tag inside a reserved range (block) of a license: that block's purpose, else null
create or replace function tag_block_purpose(p_license text, p_tag text) returns text
language sql stable security definer set search_path = public as $$
  select r.purpose from tag_ranges r
   where r.active and r.reserved and r.license = p_license and left(p_tag, length(r.prefix)) = r.prefix and length(p_tag) = length(r.prefix) + r.digits
     and substring(p_tag from length(r.prefix) + 1) ~ '^[0-9]+$'
     and substring(p_tag from length(r.prefix) + 1)::bigint between r.first_n and r.last_n
   order by r.id limit 1
$$;

/** next available METRC tags of a type on a license, not on anything in the app.
 *  A purpose with blocks of its own takes tags from those blocks; anything else takes tags outside every block. */
create or replace function metrc_next_tags(p_license text, p_type text, p_purpose text default null, p_count int default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[]; own boolean;
begin
  own := p_purpose is not null and exists (select 1 from tag_ranges r where r.active and r.reserved and r.license = p_license and r.purpose = p_purpose);
  select array_agg(label order by label) into out from (
    select t.label from metrc_tags t
     where t.license = p_license and t.tag_type = p_type
       and case when own then tag_block_purpose(p_license, t.label) = p_purpose else tag_block_purpose(p_license, t.label) is null end
       and not tag_used_in_app(t.label)
     order by t.label limit greatest(least(coalesce(p_count, 10), 500), 1)) x;
  return coalesce(out, '{}');
end $$;

-- the license a site's tags come from, by purpose
create or replace function tag_license(p_site text, p_purpose text) returns text
language sql stable security definer set search_path = public as $$
  select case when p_purpose = 'harvest' then coalesce(comp_site_cult_license(p_site), site_license(p_site))
              when upper(p_site) in (select upper(code) from nursery_sites) then (select license from nursery_sites where upper(code) = upper(p_site))
              else site_license(p_site) end
$$;

-- next_tags: METRC's available list when it's been pulled for that license, else the tag ranges as before
create or replace function next_tags(p_site text, p_purpose text default 'mixed', p_count integer default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[]; lic text := tag_license(p_site, p_purpose);
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  if lic is not null and exists (select 1 from metrc_tags where license = lic and tag_type = 'package') then
    return metrc_next_tags(lic, 'package', p_purpose, p_count);
  end if;
  with used as (
    select package_tag t from pallets where package_tag is not null
    union select unnest(regexp_split_to_array(upper(package_tag), '[^0-9A-Z]+')) from order_lines where package_tag is not null
  ), cand as (
    select r.prefix || lpad(g::text, r.digits, '0') t, r.id rid, g
      from tag_ranges r cross join lateral generate_series(r.first_n, r.last_n) g
     where r.site = p_site and r.purpose = p_purpose and r.active
  )
  select array_agg(t order by rid, g) into out from (
    select c.t, c.rid, c.g from cand c where not exists (select 1 from used u where u.t = c.t)
     order by c.rid, c.g limit greatest(least(p_count, 200), 1)) x;
  return coalesce(out, '{}');
end $$;

-- nursery: plant tags (mothers) or package tags (clone packages)
drop function if exists nursery_next_tags(text, integer);
create or replace function nursery_next_tags(p_site text, p_count integer default 10, p_type text default 'plant') returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[]; lic text := (select license from nursery_sites where code = p_site);
begin
  if not has_module('nursery') then raise exception 'Not allowed'; end if;
  if lic is not null and exists (select 1 from metrc_tags where license = lic and tag_type = p_type) then
    return metrc_next_tags(lic, p_type, case when p_type = 'plant' then 'plant' else 'package' end, p_count);
  end if;
  select array_agg(t order by r_id, n) into out from (
    select r.prefix || lpad(g::text, r.digits, '0') as t, g as n, r.id r_id
      from tag_ranges r join nursery_sites s on s.code = p_site and r.license = s.license
     cross join lateral generate_series(r.first_n, r.last_n) g
     where r.active and r.purpose = case when p_type = 'plant' then 'plant' else 'package' end
       and not exists (select 1 from nursery_mothers m where m.plant_tag = r.prefix || lpad(g::text, r.digits, '0'))
       and not exists (select 1 from nursery_batches b where (r.prefix || lpad(g::text, r.digits, '0')) = any(b.tags))
     order by r.id, g limit greatest(least(p_count, 500), 1)) x;
  return coalesce(out, '{}');
end $$;
revoke all on function nursery_next_tags(text, integer, text) from public, anon;
grant execute on function nursery_next_tags(text, integer, text) to authenticated;

-- is a tag on METRC's available list? (null = METRC's list for that tag's license isn't pulled: fall back to the ranges)
create or replace function tag_available(p_tag text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from metrc_tags where label = upper(p_tag)) then true
    when exists (select 1 from metrc_tags where left(label, 15) = left(upper(p_tag), 15) limit 1) then false
    when not exists (select 1 from tag_ranges r where r.active and left(p_tag, length(r.prefix)) = r.prefix and length(p_tag) = length(r.prefix) + r.digits)
      then null
    else exists (select 1 from tag_ranges r where r.active and left(p_tag, length(r.prefix)) = r.prefix and length(p_tag) = length(r.prefix) + r.digits
                    and substring(p_tag from length(r.prefix) + 1) ~ '^[0-9]+$'
                    and substring(p_tag from length(r.prefix) + 1)::bigint between r.first_n and r.last_n) end
$$;

/** suggestions for a tag box anywhere in the app: next available tags for a site (package tags unless asked for plant) */
create or replace function tag_suggest(p_site text, p_purpose text default 'mixed', p_count int default 40, p_type text default 'package') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lic text := tag_license(p_site, p_purpose); tags text[];
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  if lic is not null and exists (select 1 from metrc_tags where license = lic and tag_type = p_type) then
    tags := metrc_next_tags(lic, p_type, p_purpose, p_count);
  elsif p_type = 'package' then
    tags := next_tags(p_site, p_purpose, p_count);
  else
    tags := '{}';
  end if;
  return jsonb_build_object('license', lic, 'tags', to_jsonb(coalesce(tags, '{}')), 'from_metrc', lic is not null and exists (select 1 from metrc_tags where license = lic),
    'autofill', coalesce((select value from app_settings where key = 'comp.tag_autofill'), 'true') = 'true',
    'pulled', (select max(seen_at) from metrc_tags where license = lic));
end $$;
revoke all on function tag_suggest(text, text, int, text) from public, anon;
grant execute on function tag_suggest(text, text, int, text) to authenticated;

-- counts for the Licenses screen
create or replace function metrc_tag_counts() returns table (license text, tag_type text, available int, free int, pulled timestamptz)
language sql stable security definer set search_path = public as $$
  select t.license, t.tag_type, count(*)::int, count(*) filter (where not tag_used_in_app(t.label))::int, max(t.seen_at)
    from metrc_tags t where is_staff() group by 1, 2
$$;
revoke all on function metrc_tag_counts() from public, anon;
grant execute on function metrc_tag_counts() to authenticated;

-- the METRC manifest each package went out on (most recent), for a "METRC manifest" button per line
create or replace function pallet_manifests(p_ids bigint[]) returns table (pallet_id bigint, tag text, license text, manifest text, departed timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, upper(p.package_tag), coalesce(x.license, m.license), coalesce(x.manifest, m.out_manifest), x.departed
    from pallets p
    left join lateral (select t.license, t.manifest, coalesce(t.departed_at, t.created_at) as departed
                         from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
                        where tp.label = upper(p.package_tag) and not t.voided
                        order by coalesce(t.departed_at, t.created_at) desc nulls last limit 1) x on true
    left join lateral (select k.license, k.out_manifest from metrc_packages k where k.label = upper(p.package_tag) and k.out_manifest is not null
                        order by k.seen_at desc limit 1) m on true
   where p.id = any(p_ids) and p.package_tag is not null and is_staff() and coalesce(x.manifest, m.out_manifest) is not null
$$;
revoke all on function pallet_manifests(bigint[]) from public, anon;
grant execute on function pallet_manifests(bigint[]) to authenticated;

-- ---------- nursery: the clone package tag (one package per cutting event) ----------
-- Cutting batches keep their plant tags (one per 100) in tags[]; the METRC clone package is its own package tag.
alter table nursery_batches add column if not exists package_tag text;
create index if not exists nursery_batches_pkg_tag on nursery_batches (upper(package_tag));

create or replace function _metrc_nursery_batch() returns trigger
language plpgsql security definer set search_path = public as $$
declare m nursery_mothers;
begin
  if new.mother_id is not null then select * into m from nursery_mothers where id = new.mother_id; end if;
  if coalesce(new.cuttings, 0) > 0 and (tg_op = 'INSERT' or coalesce(old.cuttings, 0) = 0) then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_cut', new.strain,
            jsonb_strip_nulls(jsonb_build_object('batch_id', new.id, 'site', new.site, 'strain', new.strain, 'cuttings', new.cuttings, 'cut_on', new.cut_on,
                               'mother_id', new.mother_id, 'mother_tag', m.plant_tag, 'tag', new.package_tag, 'gen', new.gen, 'name', new.name)));
  elsif tg_op = 'UPDATE' and coalesce(new.lost, 0) > coalesce(old.lost, 0) and coalesce(old.cuttings, 0) > 0 then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_loss', new.strain,
            jsonb_strip_nulls(jsonb_build_object('what', 'clones', 'batch_id', new.id, 'site', new.site, 'strain', new.strain,
                               'lost', new.lost - coalesce(old.lost, 0), 'tag', new.package_tag, 'name', new.name)));
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists metrc_nursery_batch on nursery_batches;
create trigger metrc_nursery_batch after insert or update of cuttings, lost on nursery_batches for each row execute function _metrc_nursery_batch();

create or replace function _metrc_nursery_mother() returns trigger
language plpgsql security definer set search_path = public as $$
declare b nursery_batches;
begin
  if tg_op = 'INSERT' and new.batch_id is not null and coalesce(new.qty, 0) > 0 then
    select * into b from nursery_batches where id = new.batch_id;
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_mother_lot', new.strain,
            jsonb_strip_nulls(jsonb_build_object('mother_id', new.id, 'batch_id', new.batch_id, 'site', new.site, 'strain', new.strain, 'qty', new.qty,
                               'lot_tag', new.plant_tag, 'source_tag', b.package_tag, 'room_id', new.room_id, 'room', (select name from nursery_rooms where id = new.room_id),
                               'on', new.started_on)));
  elsif tg_op = 'UPDATE' and coalesce(new.lost, 0) > coalesce(old.lost, 0) then
    insert into events (user_email, type, note, details)
    values (current_email(), 'nursery_loss', new.strain,
            jsonb_strip_nulls(jsonb_build_object('what', 'mothers', 'mother_id', new.id, 'site', new.site, 'strain', new.strain,
                               'lost', new.lost - coalesce(old.lost, 0), 'lot_tag', new.plant_tag)));
  end if;
  return new;
exception when others then return new;
end $$;

create or replace function _metrc_nursery_shipped() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select x.ref, min(x.order_id) as order_id, sum(x.plants) as plants, min(x.manifest) as manifest, min(x.delivered_on) as delivered_on,
                  array_agg(distinct x.batch_id) filter (where x.batch_id is not null) as batches,
                  jsonb_object_agg(coalesce(x.batch_id, 0)::text, x.plants) as per_batch
             from nd x group by x.ref loop
    insert into events (user_email, type, note, details)
    select current_email(), 'nursery_shipped', o.strain,
           jsonb_strip_nulls(jsonb_build_object('ref', r.ref, 'order_id', o.id, 'site', o.nursery_site, 'to_site', o.site, 'strain', o.strain, 'plants', r.plants,
             'to', coalesce(o.site, c.name), 'to_license', coalesce(comp_site_cult_license(o.site), c.license), 'manifest', r.manifest, 'on', r.delivered_on,
             'per_batch', r.per_batch,
             'tags', (select coalesce(jsonb_agg(upper(b.package_tag)) filter (where b.package_tag is not null), '[]'::jsonb) from nursery_batches b where b.id = any(r.batches))))
      from cult_nursery_orders o left join customers c on c.id = o.customer_id where o.id = r.order_id;
  end loop;
  return null;
exception when others then return null;
end $$;

create or replace function comp_reconcile_nursery() returns table (
  kind text, issue text, tag text, strain text, name text, app_n int, metrc_n numeric, metrc_item text, metrc_location text,
  metrc_state text, ref_id bigint, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not comp_can_read() then raise exception 'Only Compliance can see this'; end if;
  return query
  with lic as (select license from nursery_sites where license is not null),
  -- cutting batches: what should still be in each clone package
  b as (
    select x.id, upper(x.package_tag) as tg, x.strain, coalesce(x.name, 'Batch ' || x.id) as nm, x.stage,
           greatest(0, coalesce(x.cuttings, 0) - coalesce(x.lost, 0)
                       - coalesce((select sum(d.plants) from nursery_deliveries d where d.batch_id = x.id), 0)
                       - coalesce((select sum(m.qty + m.lost) from nursery_mothers m where m.batch_id = x.id), 0))::int as left_n
      from nursery_batches x where coalesce(x.cuttings, 0) > 0),
  -- METRC packages counted in each (clones, seeds) on the nursery licenses
  p as (
    select upper(k.label) as tg, k.qty, k.item, k.location, k.state from metrc_packages k
     where k.license in (select license from lic) and (k.uom ~* '^(ea|each)' or (k.lbs is null and k.qty is not null))),
  pa as (select * from p where state in ('active', 'intransit')),
  -- mother lots
  m as (select x.id, upper(x.plant_tag) as tg, x.strain, x.status, greatest(0, x.qty - x.lost)::int as live_n,
               (select r.name from nursery_rooms r where r.id = x.room_id) as room
          from nursery_mothers x),
  mb as (select upper(coalesce(y.name, '')) as tg, y.untracked, y.strain, y.location, y.type from metrc_plant_batches y
          where y.license in (select license from lic) and y.state = 'active')
  -- clones
  select 'clones', 'count', b.tg, b.strain, b.nm, b.left_n, pa.qty, pa.item, pa.location, pa.state, b.id,
         case when b.left_n = 0 then 'Nothing left in the app (delivered, planted or lost); still in METRC' end
    from b join pa on pa.tg = b.tg where round(pa.qty) <> b.left_n
  union all
  select 'clones', 'not_in_metrc', b.tg, b.strain, b.nm, b.left_n, null, null, null,
         (select p.state from p where p.tg = b.tg limit 1), b.id,
         case when exists (select 1 from p where p.tg = b.tg) then 'METRC has it ' || (select p.state from p where p.tg = b.tg limit 1)
              else 'Never made in METRC (or not pulled yet)' end
    from b where b.tg is not null and b.left_n > 0 and not exists (select 1 from pa where pa.tg = b.tg)
  union all
  select 'clones', 'no_tag', null, b.strain, b.nm, b.left_n, null, null, null, null, b.id, 'The cutting batch has no clone package tag in the app'
    from b where b.tg is null and b.left_n > 0 and b.stage not in ('done', 'cancelled')
  union all
  select 'clones', 'not_in_app', pa.tg, null, null, null, pa.qty, pa.item, pa.location, pa.state, null,
         case when pa.item ~* 'seed' then 'Seed package: not tracked in the app yet' else 'No cutting batch has this tag' end
    from pa where not exists (select 1 from b where b.tg = pa.tg)
  -- mother lots
  union all
  select 'mothers', 'count', m.tg, m.strain, m.room, m.live_n, mb.untracked, mb.type, mb.location, 'active', m.id, null
    from m join mb on mb.tg = m.tg where m.status = 'active' and coalesce(mb.untracked, 0) <> m.live_n
  union all
  select 'mothers', 'not_in_metrc', m.tg, m.strain, m.room, m.live_n, null, null, null, null, m.id, 'No active METRC plant batch with this tag'
    from m where m.status = 'active' and m.tg is not null and m.live_n > 0 and not exists (select 1 from mb where mb.tg = m.tg)
  union all
  select 'mothers', 'no_tag', null, m.strain, m.room, m.live_n, null, null, null, null, m.id, 'The mother lot has no plant tag in the app'
    from m where m.status = 'active' and m.tg is null and m.live_n > 0
  union all
  select 'mothers', 'closed_in_app', m.tg, m.strain, m.room, 0, mb.untracked, mb.type, mb.location, 'active', m.id, 'Lot is ' || m.status || ' in the app, still active in METRC'
    from m join mb on mb.tg = m.tg where m.status <> 'active' and coalesce(mb.untracked, 0) > 0
      and not exists (select 1 from m m2 where m2.tg = m.tg and m2.status = 'active')
  union all
  select 'mothers', 'not_in_app', mb.tg, mb.strain, null, null, mb.untracked, mb.type, mb.location, 'active', null, 'No mother lot in the app has this tag'
    from mb where coalesce(mb.untracked, 0) > 0 and not exists (select 1 from m where m.tg = mb.tg);
end $$;

-- save_tag_range: ranges can be reserved (blocked off for their purpose)
create or replace function save_tag_range(p jsonb)
 RETURNS tag_ranges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r tag_ranges; lic licenses; f text := upper(trim(p ->> 'first')); l text := upper(trim(p ->> 'last')); pre text; i int := 0;
begin
  perform no_view_as();
  if not (is_admin() or is_mod_admin('nursery') or can_do('cultivation', 'tag_rules') or is_mod_admin('compliance')) then raise exception 'Only an Admin can add tag ranges'; end if;
  select * into lic from licenses where license_no = p ->> 'license';
  if lic.license_no is null then raise exception 'Pick the license the tags were issued to'; end if;
  if lic.kind = 'nursery' and not is_admin() and not is_mod_admin('nursery') then raise exception 'Not allowed'; end if;
  if lic.kind <> 'nursery' and not (is_admin() or can_do('cultivation', 'tag_rules') or is_mod_admin('compliance')) then raise exception 'Only a Production or Compliance Admin can add these tags'; end if;
  if (p ->> 'id') is not null then
    update tag_ranges set active = coalesce((p ->> 'active')::boolean, active), reserved = coalesce((p ->> 'reserved')::boolean, reserved), notes = coalesce(nullif(trim(p ->> 'notes'), ''), notes), purpose = coalesce(nullif(p ->> 'purpose', ''), purpose)
     where id = (p ->> 'id')::int returning * into r;
  else
    if f is null or l is null or length(f) <> length(l) then raise exception 'Enter the first and last tag (same length)'; end if;
    -- shared start, then the counting digits
    while i < length(f) and substr(f, i + 1, 1) = substr(l, i + 1, 1) loop i := i + 1; end loop;
    pre := left(f, i);
    if substr(f, i + 1) !~ '^[0-9]+$' or substr(l, i + 1) !~ '^[0-9]+$' then raise exception 'The tags should differ only in their last digits'; end if;
    insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, notes, license, reserved)
    values (coalesce(lic.site, 'ANY'), coalesce(nullif(p ->> 'purpose', ''), case lic.kind when 'nursery' then 'plant' else 'mixed' end), pre,
            substr(f, i + 1)::bigint, substr(l, i + 1)::bigint, length(f) - i, nullif(trim(p ->> 'notes'), ''), lic.license_no, coalesce((p ->> 'reserved')::boolean, false))
    returning * into r;
  end if;
  insert into events (user_email, type, note, details) values (current_email(), 'license_tags', lic.license_no, to_jsonb(r));
  return r;
end $function$;

-- ---------- the autofill switch ----------
insert into app_settings (key, value) values ('comp.tag_autofill', 'true') on conflict (key) do nothing;
create or replace function comp_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change Compliance settings'; end if;
  if p_key not in ('comp.weight_tol', 'comp.stale_days', 'comp.sp_site', 'comp.sp_root',
                   'comp.metrc_live', 'comp.metrc_reason_drying', 'comp.metrc_reason_scale', 'comp.metrc_reason_waste', 'comp.metrc_reason_entry',
                   'comp.metrc_reason_used', 'comp.metrc_ttype_internal', 'comp.metrc_ttype_customer', 'comp.metrc_ttype_processor', 'comp.metrc_ttype_nursery',
                   'comp.metrc_phone', 'comp.metrc_transit_hours', 'comp.metrc_proc_driver', 'comp.metrc_proc_vehicle',
                   'comp.metrc_waste_type', 'comp.metrc_plant_waste_reason', 'comp.metrc_plant_adjust_reason',
                   'comp.metrc_cutover_OHR', 'comp.metrc_cutover_GVR', 'comp.metrc_cutover_1PN', 'comp.tag_autofill')
  then raise exception 'Unknown setting'; end if;
  if p_key in ('comp.metrc_live', 'comp.tag_autofill') and coalesce(trim(p_value), '') not in ('true', 'false') then raise exception 'true or false'; end if;
  if p_key like 'comp.metrc_cutover_%' and nullif(trim(p_value), '') is not null and trim(p_value) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Cutover is a date (YYYY-MM-DD) or blank'; end if;
  if p_key = 'comp.metrc_transit_hours' and (nullif(trim(p_value), '') is null or trim(p_value) !~ '^\d+(\.\d+)?$') then raise exception 'Hours, a number'; end if;
  insert into app_settings (key, value) values (p_key, coalesce(trim(p_value), '')) on conflict (key) do update set value = excluded.value;
  if p_key in ('comp.sp_site', 'comp.sp_root') then update comp_docs set backed_up_at = null, sp_item_id = null, sp_path = null where backed_up_at is not null; end if;
  perform _comp_event('comp_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value));
end $$;
revoke all on function comp_set_setting(text, text) from public, anon;
grant execute on function comp_set_setting(text, text) to authenticated;

select '077 metrc tags' as ok;

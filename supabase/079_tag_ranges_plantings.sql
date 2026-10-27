-- 079_tag_ranges_plantings.sql: tag boxes search every available METRC tag on the license of the pallet or slot being worked on,
-- and plantings get the physical tag runs they use: batch tags (one per 100 plants) and flowering tags (one per plant).
-- A run is picked on the planting, checked against METRC (missing, blocked off, or already assigned), and the METRC senders use it.
-- Run after 078. Re-runnable.
set client_min_messages = warning;

-- ---------- METRC tag labels: 15 character prefix + 9 digit number ----------
create or replace function tag_label(p_prefix text, p_n bigint) returns text
language sql immutable as $$ select p_prefix || lpad(p_n::text, 9, '0') $$;
create or replace function tag_num(p_label text) returns bigint
language sql immutable as $$
  select case when length(p_label) = 24 and right(p_label, 9) ~ '^[0-9]{9}$' then right(p_label, 9)::bigint end
$$;

-- ---------- tag runs held for a planting ----------
create table if not exists tag_assignments (
  id          bigserial primary key,
  license     text not null,
  tag_type    text not null default 'plant' check (tag_type in ('plant', 'package')),
  purpose     text not null check (purpose in ('batch', 'flower')),
  planting_id bigint references cult_plantings(id) on delete cascade,
  prefix      text not null,
  first_n     bigint not null,
  last_n      bigint not null,
  first_label text not null,
  last_label  text not null,
  tags        int generated always as ((last_n - first_n + 1)::int) stored,
  active      boolean not null default true,
  created_by  text default current_email(),
  created_at  timestamptz not null default now(),
  check (last_n >= first_n));
create unique index if not exists tag_assignments_one on tag_assignments (planting_id, purpose) where active;
create index if not exists tag_assignments_lic on tag_assignments (license, prefix) where active;
alter table tag_assignments enable row level security;
drop policy if exists read_tag_assignments on tag_assignments;
create policy read_tag_assignments on tag_assignments for select to authenticated using (is_staff());
grant select on tag_assignments to authenticated;
grant all on tag_assignments to service_role;
grant usage on sequence tag_assignments_id_seq to service_role;

-- ---------- what stands in the way of a run: blocked-off ranges, other plantings, tags already on something ----------
create or replace function tag_range_conflicts(p_license text, p_prefix text, p_lo bigint, p_hi bigint, p_purpose text default null, p_planting bigint default null)
returns table (lo bigint, hi bigint, why text)
language sql stable security definer set search_path = public as $$
  with blocks as (
    select r.purpose, tag_num(r.prefix || lpad(r.first_n::text, r.digits, '0')) b_lo, tag_num(r.prefix || lpad(r.last_n::text, r.digits, '0')) b_hi
      from tag_ranges r
     where r.active and r.reserved and r.license = p_license and length(r.prefix) + r.digits = 24 and left(r.prefix, 15) = p_prefix
  )
  select greatest(b.b_lo, p_lo), least(b.b_hi, p_hi), 'blocked off for ' || b.purpose
    from blocks b where b.b_lo <= p_hi and b.b_hi >= p_lo and b.purpose is distinct from p_purpose
  union all
  select greatest(a.first_n, p_lo), least(a.last_n, p_hi),
         'held for ' || coalesce(pl.strain, 'a planting') || coalesce(' (' || f.name || ')', '') || case a.purpose when 'batch' then ' batch tags' else ' flowering tags' end
    from tag_assignments a left join cult_plantings pl on pl.id = a.planting_id left join fields f on f.id = pl.field_id
   where a.active and a.license = p_license and a.prefix = p_prefix and a.first_n <= p_hi and a.last_n >= p_lo
     and not (a.planting_id is not distinct from p_planting and a.purpose = p_purpose)
  union all
  select tag_num(u.label), tag_num(u.label), 'already on something in the app'
    from app_used_tags() u
   where u.label between tag_label(p_prefix, p_lo) and tag_label(p_prefix, p_hi) and tag_num(u.label) is not null
$$;

-- tags missing from the METRC available list inside a run (for licenses whose tags are kept in the app)
create or replace function tag_range_missing(p_license text, p_type text, p_prefix text, p_lo bigint, p_hi bigint)
returns table (lo bigint, hi bigint)
language sql stable security definer set search_path = public as $$
  select prev + 1, n - 1 from (
    select n, lag(n, 1, p_lo - 1) over (order by n) prev from (
      select tag_num(t.label) n from metrc_tags t
       where t.license = p_license and t.tag_type = p_type and t.label between tag_label(p_prefix, p_lo) and tag_label(p_prefix, p_hi)
         and tag_num(t.label) is not null
      union all select p_hi + 1) x) y
   where n - prev > 1
$$;

-- what the range picker needs to start: are the tags kept in the app, where do they start and end, where did the last run end
create or replace function tag_range_meta(p_license text, p_type text default 'plant') returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'license', p_license,
    'stored', exists (select 1 from metrc_tags where license = p_license and tag_type = p_type),
    'prefixes', coalesce((select jsonb_agg(jsonb_build_object('prefix', prefix, 'lo', lo, 'hi', hi, 'tags', n) order by lo) from (
        select left(label, 15) prefix, min(tag_num(label)) lo, max(tag_num(label)) hi, count(*) n
          from metrc_tags where license = p_license and tag_type = p_type and tag_num(label) is not null group by 1) x), '[]'),
    'last', (select jsonb_build_object('prefix', prefix, 'n', last_n) from tag_assignments where active and license = p_license and tag_type = p_type
              order by created_at desc limit 1))
$$;

-- ---------- tag boxes: search every available tag on the license of the pallet / slot ----------
create or replace function metrc_find_tags(p_license text, p_type text, p_purpose text default null, p_q text default null, p_count int default 200) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[]; own boolean; q text := nullif(upper(regexp_replace(coalesce(p_q, ''), '\s', '', 'g')), '');
begin
  own := p_purpose is not null and exists (select 1 from tag_ranges r where r.active and r.reserved and r.license = p_license and r.purpose = p_purpose);
  with blocks as (
    select r.prefix, r.digits, r.first_n, r.last_n, r.purpose from tag_ranges r where r.active and r.reserved and r.license = p_license
  ), held as (
    select a.prefix, a.first_n, a.last_n from tag_assignments a where a.active and a.license = p_license
  ), used as (select label from app_used_tags())
  select array_agg(label order by label) into out from (
    select t.label from metrc_tags t
     where t.license = p_license and t.tag_type = p_type
       and (q is null or position(q in t.label) > 0)
       and not exists (select 1 from used u where u.label = t.label)
       and not exists (select 1 from held h where left(t.label, 15) = h.prefix and tag_num(t.label) between h.first_n and h.last_n)
       and case when own
                then exists (select 1 from blocks b where b.purpose = p_purpose and left(t.label, length(b.prefix)) = b.prefix and length(t.label) = length(b.prefix) + b.digits
                               and substring(t.label from length(b.prefix) + 1) ~ '^[0-9]+$' and substring(t.label from length(b.prefix) + 1)::bigint between b.first_n and b.last_n)
                else not exists (select 1 from blocks b where left(t.label, length(b.prefix)) = b.prefix and length(t.label) = length(b.prefix) + b.digits
                               and substring(t.label from length(b.prefix) + 1) ~ '^[0-9]+$' and substring(t.label from length(b.prefix) + 1)::bigint between b.first_n and b.last_n) end
     order by t.label limit greatest(least(coalesce(p_count, 200), 1000), 1)) x;
  return coalesce(out, '{}');
end $$;

create or replace function metrc_next_tags(p_license text, p_type text, p_purpose text default null, p_count int default 10) returns text[]
language sql stable security definer set search_path = public as $$
  select metrc_find_tags(p_license, p_type, p_purpose, null, p_count)
$$;

create or replace function tag_search(p_pallet bigint default null, p_slot bigint default null, p_site text default null, p_q text default null,
                                      p_purpose text default 'mixed', p_type text default 'package', p_count int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lic text; tags text[]; stored boolean;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  if p_pallet is not null then lic := comp_pallet_license(p_pallet); end if;
  if lic is null and p_slot is not null then
    select coalesce(f.license, site_license(f.site)) into lic from slots s join freezers f on f.id = s.freezer_id where s.id = p_slot;
  end if;
  if lic is null and p_site is not null then lic := tag_license(p_site, p_purpose); end if;
  stored := lic is not null and exists (select 1 from metrc_tags where license = lic and tag_type = p_type);
  if stored then
    tags := metrc_find_tags(lic, p_type, p_purpose, p_q, p_count);
  elsif p_type = 'package' and p_site is not null then
    tags := next_tags(p_site, p_purpose, least(p_count, 200));
  else
    tags := '{}';
  end if;
  return jsonb_build_object('license', lic, 'tags', to_jsonb(coalesce(tags, '{}')), 'from_metrc', stored, 'q', p_q,
    'free', case when stored then (select count(*) from metrc_tags t where t.license = lic and t.tag_type = p_type and not exists (select 1 from app_used_tags() u where u.label = t.label)) end,
    'autofill', coalesce((select value from app_settings where key = 'comp.tag_autofill'), 'true') = 'true',
    'pulled', (select max(seen_at) from metrc_tags where license = lic));
end $$;
revoke all on function tag_search(bigint, bigint, text, text, text, text, int) from public, anon;
grant execute on function tag_search(bigint, bigint, text, text, text, text, int) to authenticated;

-- ---------- holding a run for a planting ----------
create or replace function planting_license(p_planting bigint) returns text
language sql stable security definer set search_path = public as $$
  select comp_site_cult_license(site) from cult_plantings where id = p_planting
$$;

create or replace function tag_assign(p_planting bigint, p_purpose text, p_first text, p_count int) returns tag_assignments
language plpgsql security definer set search_path = public as $$
declare pl cult_plantings; lic text; pre text; lo bigint; hi bigint; c record; m record; out tag_assignments; sent boolean;
begin
  perform require_module('cultivation'); perform no_view_as();
  if not can_edit('cultivation') then raise exception 'You can''t change plantings'; end if;
  if p_purpose not in ('batch', 'flower') then raise exception 'Batch tags or flowering tags'; end if;
  select * into pl from cult_plantings where id = p_planting;
  if pl.id is null then raise exception 'Planting not found'; end if;
  lic := planting_license(pl.id);
  if lic is null then raise exception 'No cultivation license for %', pl.site; end if;
  p_first := upper(regexp_replace(coalesce(p_first, ''), '\s', '', 'g'));
  lo := tag_num(p_first);
  if lo is null then raise exception 'A METRC tag is 24 characters ending in 9 digits: %', p_first; end if;
  if coalesce(p_count, 0) < 1 or p_count > 100000 then raise exception 'How many tags?'; end if;
  pre := left(p_first, 15); hi := lo + p_count - 1;
  if hi > 999999999 then raise exception 'The run goes past the end of the tag numbers'; end if;
  -- once METRC has it, the run is spoken for
  select exists (select 1 from comp_metrc_actions x where x.kind = case when p_purpose = 'batch' then 'planting' else 'flower' end
                    and x.details ->> 'planting_id' = pl.id::text
                    and (x.status = 'done' or coalesce((x.push_response -> 'progress' ->> 'done')::int, 0) > 0)) into sent;
  if sent then raise exception 'METRC already has this planting''s % tags; the run can''t change now', case when p_purpose = 'batch' then 'batch' else 'flowering' end; end if;
  select * into c from tag_range_conflicts(lic, pre, lo, hi, p_purpose, pl.id) order by lo limit 1;
  if c.lo is not null then
    raise exception 'Tag % is %', case when c.lo = c.hi then tag_label(pre, c.lo) else tag_label(pre, c.lo) || '..' || right(tag_label(pre, c.hi), 9) end, c.why;
  end if;
  if exists (select 1 from metrc_tags where license = lic and tag_type = 'plant') then
    select * into m from tag_range_missing(lic, 'plant', pre, lo, hi) order by lo limit 1;
    if m.lo is not null then
      raise exception 'Not on METRC''s available list: %', case when m.lo = m.hi then tag_label(pre, m.lo) else tag_label(pre, m.lo) || '..' || right(tag_label(pre, m.hi), 9) end;
    end if;
  end if;
  update tag_assignments set active = false where planting_id = pl.id and purpose = p_purpose and active;
  insert into tag_assignments (license, tag_type, purpose, planting_id, prefix, first_n, last_n, first_label, last_label)
  values (lic, 'plant', p_purpose, pl.id, pre, lo, hi, tag_label(pre, lo), tag_label(pre, hi)) returning * into out;
  insert into events (user_email, type, note, details)
  values (current_email(), 'tags_assigned', pl.strain, jsonb_build_object('planting_id', pl.id, 'purpose', p_purpose, 'license', lic, 'first', out.first_label, 'last', out.last_label, 'tags', p_count));
  return out;
end $$;
revoke all on function tag_assign(bigint, text, text, int) from public, anon;
grant execute on function tag_assign(bigint, text, text, int) to authenticated;

create or replace function tag_unassign(p_planting bigint, p_purpose text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation'); perform no_view_as();
  if not can_edit('cultivation') then raise exception 'You can''t change plantings'; end if;
  if exists (select 1 from comp_metrc_actions x where x.kind = case when p_purpose = 'batch' then 'planting' else 'flower' end
                and x.details ->> 'planting_id' = p_planting::text
                and (x.status = 'done' or coalesce((x.push_response -> 'progress' ->> 'done')::int, 0) > 0)) then
    raise exception 'METRC already has these tags';
  end if;
  update tag_assignments set active = false where planting_id = p_planting and purpose = p_purpose and active;
end $$;
revoke all on function tag_unassign(bigint, text) from public, anon;
grant execute on function tag_unassign(bigint, text) to authenticated;

-- ---------- the flip needs its flowering tags picked first ----------
create or replace function cult_flip(p_planting bigint, p_on date default null) returns cult_plantings
language plpgsql security definer set search_path = public as $$
declare pl cult_plantings; n int; a tag_assignments;
begin
  perform require_module('cultivation'); perform no_view_as();
  if not can_edit('cultivation') then raise exception 'You can''t change plantings'; end if;
  select * into pl from cult_plantings where id = p_planting for update;
  if pl.id is null then raise exception 'Planting not found'; end if;
  if pl.flipped_on is not null then raise exception 'Already flipped to flowering on %', pl.flipped_on; end if;
  n := coalesce(pl.plants, 0) - coalesce(pl.plant_loss, 0);
  if n <= 0 then raise exception 'No plants left in this planting'; end if;
  select * into a from tag_assignments where planting_id = pl.id and purpose = 'flower' and active;
  if a.id is null then raise exception 'Pick the flowering tag run first (one tag per plant)'; end if;
  if a.tags <> n then raise exception 'The flowering tag run has % tags and the planting has % plants left. Pick the run again.', a.tags, n; end if;
  update cult_plantings set flipped_on = coalesce(p_on, current_date), flipped_by = current_email(), updated_by = current_email(), updated_at = now()
   where id = pl.id returning * into pl;
  insert into events (user_email, type, note, details)
  values (current_email(), 'planting_flip', pl.strain,
          jsonb_strip_nulls(jsonb_build_object('planting_id', pl.id, 'site', pl.site, 'field_id', pl.field_id, 'field', (select name from fields where id = pl.field_id),
                             'strain', pl.strain, 'plants', n, 'on', pl.flipped_on, 'first_tag', a.first_label, 'last_tag', a.last_label)));
  return pl;
end $$;
revoke all on function cult_flip(bigint, date) from public, anon;
grant execute on function cult_flip(bigint, date) to authenticated;

select '079 tag ranges for plantings' as ok;

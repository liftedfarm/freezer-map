-- Migration 016: Roshi lines that list several METRC tags ("tag1, tag2") are now checked tag by tag.
-- For a line split across tags, pallets already off the map count first; what's left of the line is
-- what shipped from the pallet(s) still in a freezer. Run after 015. Safe to re-run.
set client_min_messages = warning;

create or replace function _shipped_by_tag()
returns table (tag text, lbs numeric, sos text, d date)
language sql stable security definer set search_path = public as $$
  with lt as (
    select l.id, l.lbs, o.so_number, o.shipped_date, trim(t) as tag
      from orders o join order_lines l on l.order_id = o.id
      cross join lateral unnest(string_to_array(l.package_tag, ',')) t
     where o.status = 'shipped' and l.package_tag is not null and trim(t) <> ''),
  per as (
    select lt.*, p.id as pid, (p.status in ('in_freezer','unslotted')) as on_map, coalesce(p.og_weight, p.current_weight, 0) as w
      from lt left join lateral (select * from pallets x where x.package_tag = lt.tag and x.kind = 'package' order by (x.status in ('in_freezer','unslotted')) desc limit 1) p on true),
  line as (
    select id, count(*) filter (where on_map) as n_map,
           sum(w) filter (where pid is not null and not on_map) as gone
      from per group by id)
  select per.tag,
         sum(case when (select count(*) from per q where q.id = per.id) = 1 then per.lbs
                  else greatest(per.lbs - coalesce(line.gone, 0), 0) / greatest(line.n_map, 1) end),
         string_agg(distinct per.so_number, ', '), max(per.shipped_date)
    from per join line on line.id = per.id
   where per.on_map
   group by per.tag
$$;
revoke execute on function _shipped_by_tag() from public, anon, authenticated;

create or replace function shipped_in_freezer()
returns table (pallet_id bigint, package_tag text, shipped_lbs numeric, new_lbs numeric, sos text, last_shipped date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  return query
    select p.id, s.tag, round(s.lbs, 2), round(s.lbs - coalesce(c.acked_lbs, 0), 2), s.sos, s.d
      from _shipped_by_tag() s
      join pallets p on p.package_tag = s.tag and p.kind = 'package' and p.status in ('in_freezer','unslotted')
      left join shipped_tag_checks c on c.package_tag = s.tag
     where s.lbs - coalesce(c.acked_lbs, 0) > 0.5
     order by s.d desc nulls last;
end $$;

create or replace function ack_shipped_tag(p_tag text) returns void
language plpgsql security definer set search_path = public as $$
declare total numeric;
begin
  perform require_staff();
  select lbs into total from _shipped_by_tag() where tag = p_tag;
  insert into shipped_tag_checks values (p_tag, coalesce(total, 0), current_email(), now())
  on conflict (package_tag) do update set acked_lbs = excluded.acked_lbs, acked_by = excluded.acked_by, acked_at = now();
end $$;

-- check
select p.code, p.strain, p.current_weight, s.new_lbs, s.sos from shipped_in_freezer() s join pallets p on p.id = s.pallet_id order by p.code;

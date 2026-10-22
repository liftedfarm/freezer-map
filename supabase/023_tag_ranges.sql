-- Migration 023: METRC tag ranges. New tags fill in automatically from a range (the next one not used yet).
-- Starts with OHR mixed pallets: ABC06030007AD3D000006000 through ABC06030007AD3D000006999.
-- Run after 022. Safe to re-run.
set client_min_messages = warning;

create table if not exists tag_ranges (
  id       serial primary key,
  site     text not null check (site in ('OHR','GVR')),
  purpose  text not null default 'mixed',     -- what the tags are for (mixed pallets first; splits, merges later)
  prefix   text not null,                     -- everything before the counting digits
  first_n  int  not null,
  last_n   int  not null,
  digits   int  not null,                     -- width of the counting part
  active   boolean not null default true,
  notes    text,
  check (last_n >= first_n)
);
alter table tag_ranges enable row level security;
drop policy if exists read_ranges on tag_ranges;
create policy read_ranges on tag_ranges for select to authenticated using (is_staff());
grant select on tag_ranges to authenticated;

insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, notes)
select 'OHR', 'mixed', 'ABC06030007AD3D00000', 6000, 6999, 4, 'OHR mixed pallets'
 where not exists (select 1 from tag_ranges where site = 'OHR' and purpose = 'mixed' and prefix = 'ABC06030007AD3D00000' and first_n = 6000);

-- the next unused tags in a site's range: not on any pallet (any status) and not on any Roshi order line
create or replace function next_tags(p_site text, p_purpose text default 'mixed', p_count int default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[];
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select array_agg(t order by n) into out from (
    select r.prefix || lpad(g::text, r.digits, '0') as t, g as n
      from tag_ranges r cross join lateral generate_series(r.first_n, r.last_n) g
     where r.site = p_site and r.purpose = p_purpose and r.active
       and not exists (select 1 from pallets p where p.package_tag = r.prefix || lpad(g::text, r.digits, '0'))
       and not exists (select 1 from order_lines l where l.package_tag like '%' || r.prefix || lpad(g::text, r.digits, '0') || '%')
     order by g limit greatest(least(p_count, 200), 1)) x;
  return coalesce(out, '{}');
end $$;
revoke execute on function next_tags(text, text, int) from public, anon;
grant execute on function next_tags(text, text, int) to authenticated;

-- check: the next few OHR mixed tags
select unnest(array(
  select r.prefix || lpad(g::text, r.digits, '0') from tag_ranges r cross join generate_series(r.first_n, r.last_n) g
   where r.site = 'OHR' and r.purpose = 'mixed'
     and not exists (select 1 from pallets p where p.package_tag = r.prefix || lpad(g::text, r.digits, '0'))
   order by g limit 3)) as next_ohr_mixed_tags;

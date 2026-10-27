-- 078_metrc_tags_fast.sql: faster tag suggestions and counts (one pass over the app's tags instead of per tag),
-- and a clean slate for metrc_tags (the first pull filed package tags as plant tags; the next pull refills it).
-- Run after 077. Re-runnable.
set client_min_messages = warning;

truncate metrc_tags;

-- every tag on something in the app
create or replace function app_used_tags() returns table (label text)
language sql stable security definer set search_path = public as $$
  select upper(package_tag) from pallets where package_tag is not null
  union select upper(t) from nursery_batches, unnest(tags) t where t is not null
  union select upper(package_tag) from nursery_batches where package_tag is not null
  union select upper(plant_tag) from nursery_mothers where plant_tag is not null
$$;

create or replace function metrc_next_tags(p_license text, p_type text, p_purpose text default null, p_count int default 10) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare out text[]; own boolean;
begin
  own := p_purpose is not null and exists (select 1 from tag_ranges r where r.active and r.reserved and r.license = p_license and r.purpose = p_purpose);
  with blocks as (
    select r.prefix, r.digits, r.first_n, r.last_n, r.purpose from tag_ranges r where r.active and r.reserved and r.license = p_license
  ), used as (select label from app_used_tags())
  select array_agg(label order by label) into out from (
    select t.label from metrc_tags t
     where t.license = p_license and t.tag_type = p_type
       and not exists (select 1 from used u where u.label = t.label)
       and case when own
                then exists (select 1 from blocks b where b.purpose = p_purpose and left(t.label, length(b.prefix)) = b.prefix and length(t.label) = length(b.prefix) + b.digits
                               and substring(t.label from length(b.prefix) + 1) ~ '^[0-9]+$' and substring(t.label from length(b.prefix) + 1)::bigint between b.first_n and b.last_n)
                else not exists (select 1 from blocks b where left(t.label, length(b.prefix)) = b.prefix and length(t.label) = length(b.prefix) + b.digits
                               and substring(t.label from length(b.prefix) + 1) ~ '^[0-9]+$' and substring(t.label from length(b.prefix) + 1)::bigint between b.first_n and b.last_n) end
     order by t.label limit greatest(least(coalesce(p_count, 10), 500), 1)) x;
  return coalesce(out, '{}');
end $$;

create or replace function metrc_tag_counts() returns table (license text, tag_type text, available int, free int, pulled timestamptz)
language sql stable security definer set search_path = public as $$
  with used as (select label from app_used_tags())
  select t.license, t.tag_type, count(*)::int, (count(*) - count(u.label))::int, max(t.seen_at)
    from metrc_tags t left join used u on u.label = t.label where is_staff() group by 1, 2
$$;
revoke all on function metrc_tag_counts() from public, anon;
grant execute on function metrc_tag_counts() to authenticated;

select '078 tags fast' as ok;

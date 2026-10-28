-- 095: a combine made in Fulfillment can take part of a pallet (the pallet stays, lighter). METRC sending only looked at
-- whole pallets merged in, so those combines failed with "No source packages found". The sender (api/metrc/_pkg.js) now
-- reads the parts too; this makes the to-do also wait on (and hold) the tags of the pallets it took parts from.
-- Run after 094_archived_fast.sql. Safe to re-run.
create or replace function metrc_touch_tags(a comp_metrc_actions) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct upper(t)) filter (where nullif(trim(t), '') is not null), '{}') from (
    select a.tag as t
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'split_from' and p.id = nullif(a.details ->> 'parent_id', '')::bigint
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'merge' and p.merged_into = a.pallet_id
    union all select p.package_tag from events e join pallets p on p.id = e.pallet_id
               where a.details ->> 'type' = 'merge' and e.type = 'combine_part' and e.details ->> 'into_id' = a.pallet_id::text
    union all select p.package_tag from pallets p where a.details ->> 'type' = 'tag_set' and a.details ->> 'from' is not null and p.id = a.pallet_id
    union all select a.details ->> 'from' where a.details ->> 'type' = 'tag_set'
    union all select a.details ->> 'old_tag' where a.details ->> 'type' = 'proc_received'
    union all select jsonb_array_elements_text(case when jsonb_typeof(a.details -> 'tags') = 'array' then a.details -> 'tags' else '[]'::jsonb end)
  ) x
$$;

-- refresh the stored tags on open combine to-dos
update comp_metrc_actions a set touch_tags = metrc_touch_tags(a) where a.kind = 'combine' and a.status in ('todo', 'error');

select id, code, touch_tags from comp_metrc_actions where kind = 'combine' and status in ('todo', 'error') order by id;

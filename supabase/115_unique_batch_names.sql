-- 115: METRC batch names can't collide.
-- 10/28: two Honey Banana harvests (Field 7 and Field 2) on the same day both got "Honey Banana 10/28", so they shared one
-- METRC harvest and their waste/finish would have clashed.
--   1. A harvest's METRC batch name is saved (cult_harvests.metrc_name) the first time it goes to METRC, so it never changes after.
--   2. When another harvest on the same farm has the same strain and date, the default name gets the field:
--      "Honey Banana Field 2 10/28" (fields.code, so Field 1A, Field 8B ...).
-- Run once in Supabase after 114. Safe to re-run.
begin;

create or replace function cult_batch_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(h.metrc_name), ''),
                  (select nullif(trim(p.metrc_name), '') || '-' || h.day_no from cult_harvests p where p.id = h.parent_id),
                  (select l.metrc_name from harvest_lots l where l.id = h.lot_id),
                  h.strain
                    || case when exists (select 1 from cult_harvests o
                                          where o.id <> h.id and o.site = h.site and o.status <> 'cancelled'
                                            and lower(trim(o.strain)) = lower(trim(h.strain))
                                            and coalesce(o.harvested_on, o.planned_on) = coalesce(h.harvested_on, h.planned_on, current_date))
                            then ' Field ' || coalesce((select f.code from fields f where f.id = h.field_id), '?')
                            else '' end
                    || ' ' || to_char(coalesce(h.harvested_on, h.planned_on, current_date), 'MM/DD'))
$$;

-- freeze the name the first time a harvest's plants go to METRC
create or replace function _cult_keep_batch_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'harvest_plants' and nullif(new.details ->> 'harvest_id', '') is not null and nullif(new.details ->> 'batch', '') is not null then
    update cult_harvests set metrc_name = new.details ->> 'batch'
     where id = (new.details ->> 'harvest_id')::bigint and nullif(trim(metrc_name), '') is null;
  end if;
  return new;
end $$;
drop trigger if exists cult_keep_batch_name on events;
create trigger cult_keep_batch_name after insert on events for each row execute function _cult_keep_batch_name();

-- backfill: harvests already sent keep the name they were sent under
update cult_harvests h set metrc_name = e.batch
  from (select distinct on ((details ->> 'harvest_id')::bigint) (details ->> 'harvest_id')::bigint as hid, details ->> 'batch' as batch
          from events where type = 'harvest_plants' and nullif(details ->> 'harvest_id', '') is not null and nullif(details ->> 'batch', '') is not null
         order by (details ->> 'harvest_id')::bigint, at) e
 where h.id = e.hid and nullif(trim(h.metrc_name), '') is null;

commit;

select (select count(*) from cult_harvests where metrc_name is not null) as harvests_with_saved_names,
       (select count(*) from pg_trigger where tgname = 'cult_keep_batch_name') as trigger_on;

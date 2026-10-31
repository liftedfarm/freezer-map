-- 148_push_day_until.sql  (Msg TAG-17, 2026-10-30, run live by Claude, Aziz said yes)
-- "METRC harvest date = push day" (146) turns itself off on 11/20/2026: on through 11/19, off from 11/20 (Pacific).
-- No scheduler needed: cult_metrc_date() checks the end date. Change the date in app_settings key cult.metrc_date_push_day_until.
begin;
insert into app_settings (key, value) values ('cult.metrc_date_push_day_until', '2026-11-20')
on conflict (key) do update set value = excluded.value;

create or replace function cult_metrc_date(h cult_harvests) returns date
language sql stable security definer set search_path = public as $$
  with t as (select (now() at time zone 'America/Los_Angeles')::date as today)
  select case when coalesce((select value from app_settings where key = 'cult.metrc_date_push_day'), 'off') = 'on'
               and t.today < coalesce((select nullif(value, '')::date from app_settings where key = 'cult.metrc_date_push_day_until'), date '9999-12-31')
              then greatest(coalesce(h.harvested_on, h.planned_on, t.today), t.today)
              else coalesce(h.harvested_on, h.planned_on, t.today) end
    from t
$$;

insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'harvest_names', '148 push-day METRC date turns off 11/20', jsonb_build_object('until', '2026-11-20'));
commit;

-- 123: put things back after the Funk Mintz send (10/29 night).
-- OHR drying location back to Freezers; Funk Mintz harvest date back to 10/08 (it was 10/14 only for the send).
update metrc_location_map set location = 'Freezers', location_id = 1846301
 where license = 'CCL25-0000017' and app_kind = 'drying' and app_ref = 'OHR';
update cult_harvests set harvested_on = '2026-10-08' where id = 104;
select (select location from metrc_location_map where license = 'CCL25-0000017' and app_kind = 'drying' and app_ref = 'OHR') as drying,
       (select harvested_on from cult_harvests where id = 104) as funk_date,
       (select harvested_on from cult_harvests where id = 19) as swamp_date;

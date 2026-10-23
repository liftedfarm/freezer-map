-- Migration 044: two more strain photos (Aziz, 2026-10-22). Run after 043. Safe to re-run.
--   Rainbow Guava x Hive photo -> Gabilan Guava (The Hive x Rainbow Guava #12)
--   Sour Diesel x Cali Kush photo -> Cali Mist (same strain)
--   Madd Fruit: skipped for now. Honeycomb Rainbow keeps the Hive x Rainbow Guava #1 photo.
set client_min_messages = warning;

with pics(name, url) as (values
  ('Gabilan Guava', '/strains/rainbow-guava-x-hive.jpg'),
  ('Cali Mist', '/strains/sour-diesel-x-cali-kush.jpg')
)
insert into strain_info (strain_id, photo_url, updated_by)
select s.id, p.url, 'photo import' from pics p join strains s on lower(s.name) = lower(p.name)
on conflict (strain_id) do update set photo_url = excluded.photo_url;

select s.name, i.photo_url from strains s join strain_info i on i.strain_id = s.id where s.name in ('Gabilan Guava', 'Cali Mist');

-- Migration 043: strain photos for the menu catalog and strain sheets (one per strain, picked from the Davezini pic-time catalogue).
-- The images ship with the app at /strains/<name>.jpg. A photo someone already set by hand is kept.
-- Run after 040. Safe to re-run.
set client_min_messages = warning;

with pics(name, url) as (values
  ('4K', '/strains/4k.jpg'),
  ('Banana Bonanza', '/strains/banana-bonanza.jpg'),
  ('Banana Punch', '/strains/banana-punch.jpg'),
  ('Banana Split', '/strains/banana-split.jpg'),
  ('Banana Squeeze', '/strains/banana-squeeze.jpg'),
  ('The Big Easy #9', '/strains/big-easy.jpg'),
  ('Blue Dream', '/strains/blue-dream.jpg'),
  ('Bubble Gum', '/strains/bubblegum.jpg'),
  ('Canal St Runtz', '/strains/canal-street-runtz.jpg'),
  ('Chiquita Diesel', '/strains/chiquita-x-diesel.jpg'),
  ('Coup D''etat', '/strains/coup-d-etat.jpg'),
  ('Dark Rainbow', '/strains/dark-rainbow.jpg'),
  ('Dragonfruit Soda', '/strains/dragon-fruit-soda.jpg'),
  ('Dulce de Uva', '/strains/dulce-de-viva.jpg'),
  ('E85', '/strains/e85.jpg'),
  ('Diesel Daiquiri', '/strains/fatso-nam-wah-37.jpg'),
  ('Heavy Zest', '/strains/fatso-x-namwah-27.jpg'),
  ('Fatso x Nam Wah #27', '/strains/fatso-x-namwah-27.jpg'),
  ('Funk Mintz', '/strains/funk-mintz.jpg'),
  ('Garlic Cocktail', '/strains/garlic-cocktail.jpg'),
  ('Garlic Juice', '/strains/garlic-juice.jpg'),
  ('Garlic Mintz', '/strains/garlic-mintz.jpg'),
  ('Governmint Oasis', '/strains/gov-oasis.jpg'),
  ('Grape Gas', '/strains/grape-gas.jpg'),
  ('Gurple', '/strains/gurple.jpg'),
  ('Hashburger', '/strains/hash-burger.jpg'),
  ('Honeycomb Rainbow', '/strains/hive-x-rainbow-guava-1.jpg'),
  ('Honey Banana x Pressure #21', '/strains/honey-b-x-pressure-21.jpg'),
  ('Honey Banana', '/strains/honey-banana.jpg'),
  ('Honey Bunny', '/strains/honey-bunny.jpg'),
  ('Honey Runtz', '/strains/honey-runtz.jpg'),
  ('Jelly Cake', '/strains/jelly-cake.jpg'),
  ('Key Lime Tart', '/strains/key-lime-tart.jpg'),
  ('Kosher Kush', '/strains/kosher-kush.jpg'),
  ('MBxBP x Pressure #6', '/strains/mbxbp-x-pressure-6.jpg'),
  ('Melted Strawberries', '/strains/melted-strawberry.jpg'),
  ('Modified Grapes', '/strains/modified-grapes.jpg'),
  ('Molten Grapes', '/strains/molten-grapes.jpg'),
  ('Moonbow', '/strains/moon-bow.jpg'),
  ('Nam Wah', '/strains/nam-wah.jpg'),
  ('Newport Punch #28', '/strains/newport-punch-28.jpg'),
  ('Plantain Pressure', '/strains/plantain-pressure.jpg'),
  ('Pressure', '/strains/pressure.jpg'),
  ('Purple Ice Water', '/strains/purple-ice-water.jpg'),
  ('Rainbow Colonel', '/strains/rainbow-colonel.jpg'),
  ('Rainbow Guava', '/strains/rainbow-guava.jpg'),
  ('Royals Cherry', '/strains/royal-cherry.jpg'),
  ('Ruby Violet', '/strains/ruby-violet.jpg'),
  ('Rum Runner', '/strains/rum-runner.jpg'),
  ('Sea Foam', '/strains/sea-foam.jpg'),
  ('Shake Shack', '/strains/shake-shack.jpg'),
  ('Sour Diesel (East Coast)', '/strains/sour-diesel.jpg'),
  ('Sour Strawberry', '/strains/sour-strawberry.jpg'),
  ('Spritzer', '/strains/spritzer.jpg'),
  ('Super Lemon Haze', '/strains/super-lemon-haze.jpg'),
  ('Super Boof', '/strains/superboof.jpg'),
  ('Swampwater Fumez', '/strains/swamp-water.jpg'),
  ('Tahoe OG', '/strains/tahoe-og.jpg'),
  ('Tangieberto', '/strains/tangieberto.jpg'),
  ('The Hive', '/strains/the-hive.jpg'),
  ('Turbo Snax', '/strains/turbo-snax.jpg'),
  ('Zowah', '/strains/zowah.jpg')
), hit as (
  select distinct on (s.id) s.id, p.url, p.name from pics p
  join strains s on lower(s.name) = lower(p.name) or lower(p.name) = any (select lower(a) from unnest(s.aliases) a)
  order by s.id, (lower(s.name) = lower(p.name)) desc
)
insert into strain_info (strain_id, photo_url, updated_by)
select id, url, 'photo import' from hit
on conflict (strain_id) do update set photo_url = coalesce(strain_info.photo_url, excluded.photo_url);

-- names in the list that didn't find a strain (should be none)
with pics(name) as (values ('4K'), ('Banana Bonanza'), ('Banana Punch'), ('Banana Split'), ('Banana Squeeze'), ('The Big Easy #9'), ('Blue Dream'), ('Bubble Gum'), ('Canal St Runtz'), ('Chiquita Diesel'), ('Coup D''etat'), ('Dark Rainbow'), ('Dragonfruit Soda'), ('Dulce de Uva'), ('E85'), ('Diesel Daiquiri'), ('Heavy Zest'), ('Fatso x Nam Wah #27'), ('Funk Mintz'), ('Garlic Cocktail'), ('Garlic Juice'), ('Garlic Mintz'), ('Governmint Oasis'), ('Grape Gas'), ('Gurple'), ('Hashburger'), ('Honeycomb Rainbow'), ('Honey Banana x Pressure #21'), ('Honey Banana'), ('Honey Bunny'), ('Honey Runtz'), ('Jelly Cake'), ('Key Lime Tart'), ('Kosher Kush'), ('MBxBP x Pressure #6'), ('Melted Strawberries'), ('Modified Grapes'), ('Molten Grapes'), ('Moonbow'), ('Nam Wah'), ('Newport Punch #28'), ('Plantain Pressure'), ('Pressure'), ('Purple Ice Water'), ('Rainbow Colonel'), ('Rainbow Guava'), ('Royals Cherry'), ('Ruby Violet'), ('Rum Runner'), ('Sea Foam'), ('Shake Shack'), ('Sour Diesel (East Coast)'), ('Sour Strawberry'), ('Spritzer'), ('Super Lemon Haze'), ('Super Boof'), ('Swampwater Fumez'), ('Tahoe OG'), ('Tangieberto'), ('The Hive'), ('Turbo Snax'), ('Zowah'))
select name as no_strain_found from pics p
where not exists (select 1 from strains s where lower(s.name) = lower(p.name) or lower(p.name) = any (select lower(a) from unnest(s.aliases) a));

select count(*) as strains_with_photo from strain_info where photo_url like '/strains/%';
-- Not assigned yet (photo is in the app; set it from the strain's Sales settings, Photo = the path):
--   /strains/madd-fruit-2.jpg  Madd Fruit? (gallery says Madd Fruit #2)
--   /strains/rainbow-guava-x-hive.jpg  Gabilan Guava? (Hive x RG #12)
--   /strains/honeycomb-x-rainbow.jpg  Honeycomb Rainbow already has the Hive x RG #1 photo
--   /strains/sour-diesel-x-cali-kush.jpg  no strain by that name

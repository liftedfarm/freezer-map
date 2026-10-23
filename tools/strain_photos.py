# writes supabase/043_strain_photos.sql: points each strain's photo at /strains/<slug>.jpg (photos from the Davezini pic-time catalogue)
import os
M = {  # photo slug -> app strain name(s) (matched on name or alias, any case)
 '4k':['4K'],'banana-bonanza':['Banana Bonanza'],'banana-punch':['Banana Punch'],'banana-split':['Banana Split'],'banana-squeeze':['Banana Squeeze'],
 'big-easy':['The Big Easy #9'],'blue-dream':['Blue Dream'],'bubblegum':['Bubble Gum'],'canal-street-runtz':['Canal St Runtz'],'chiquita-x-diesel':['Chiquita Diesel'],
 'coup-d-etat':["Coup D'etat"],'dark-rainbow':['Dark Rainbow'],'dragon-fruit-soda':['Dragonfruit Soda'],'dulce-de-viva':['Dulce de Uva'],'e85':['E85'],
 'fatso-nam-wah-37':['Diesel Daiquiri'],'fatso-x-namwah-27':['Heavy Zest','Fatso x Nam Wah #27'],'funk-mintz':['Funk Mintz'],'garlic-cocktail':['Garlic Cocktail'],
 'garlic-juice':['Garlic Juice'],'garlic-mintz':['Garlic Mintz'],'gov-oasis':['Governmint Oasis'],'grape-gas':['Grape Gas'],'gurple':['Gurple'],'hash-burger':['Hashburger'],
 'hive-x-rainbow-guava-1':['Honeycomb Rainbow'],'honey-b-x-pressure-21':['Honey Banana x Pressure #21'],'honey-banana':['Honey Banana'],'honey-bunny':['Honey Bunny'],
 'honey-runtz':['Honey Runtz'],'jelly-cake':['Jelly Cake'],'key-lime-tart':['Key Lime Tart'],'kosher-kush':['Kosher Kush'],'mbxbp-x-pressure-6':['MBxBP x Pressure #6'],
 'melted-strawberry':['Melted Strawberries'],'modified-grapes':['Modified Grapes'],'molten-grapes':['Molten Grapes'],'moon-bow':['Moonbow'],'nam-wah':['Nam Wah'],
 'newport-punch-28':['Newport Punch #28'],'plantain-pressure':['Plantain Pressure'],'pressure':['Pressure'],'purple-ice-water':['Purple Ice Water'],
 'rainbow-colonel':['Rainbow Colonel'],'rainbow-guava':['Rainbow Guava'],'royal-cherry':['Royals Cherry'],'ruby-violet':['Ruby Violet'],'rum-runner':['Rum Runner'],
 'sea-foam':['Sea Foam'],'shake-shack':['Shake Shack'],'sour-diesel':['Sour Diesel (East Coast)'],'sour-strawberry':['Sour Strawberry'],'spritzer':['Spritzer'],
 'super-lemon-haze':['Super Lemon Haze'],'superboof':['Super Boof'],'swamp-water':['Swampwater Fumez'],'tahoe-og':['Tahoe OG'],'tangieberto':['Tangieberto'],
 'the-hive':['The Hive'],'turbo-snax':['Turbo Snax'],'zowah':['Zowah'],
}
ASK = {'madd-fruit-2':'Madd Fruit? (gallery says Madd Fruit #2)','rainbow-guava-x-hive':'Gabilan Guava? (Hive x RG #12)','honeycomb-x-rainbow':'Honeycomb Rainbow already has the Hive x RG #1 photo','sour-diesel-x-cali-kush':'no strain by that name'}
have = {f[:-4] for f in os.listdir('public/strains')}
assert set(M) | set(ASK) == have, (have - set(M) - set(ASK), set(M) - have)
q = lambda s: "'" + s.replace("'", "''") + "'"
rows = ',\n  '.join(f"({q(n)}, '/strains/{k}.jpg')" for k, ns in M.items() for n in ns)
sql = f"""-- Migration 043: strain photos for the menu catalog and strain sheets (one per strain, picked from the Davezini pic-time catalogue).
-- The images ship with the app at /strains/<name>.jpg. A photo someone already set by hand is kept.
-- Run after 040. Safe to re-run.
set client_min_messages = warning;

with pics(name, url) as (values
  {rows}
), hit as (
  select distinct on (s.id) s.id, p.url, p.name from pics p
  join strains s on lower(s.name) = lower(p.name) or lower(p.name) = any (select lower(a) from unnest(s.aliases) a)
  order by s.id, (lower(s.name) = lower(p.name)) desc
)
insert into strain_info (strain_id, photo_url, updated_by)
select id, url, 'photo import' from hit
on conflict (strain_id) do update set photo_url = coalesce(strain_info.photo_url, excluded.photo_url);

-- names in the list that didn't find a strain (should be none)
with pics(name) as (values {', '.join(f'({q(n)})' for ns in M.values() for n in ns)})
select name as no_strain_found from pics p
where not exists (select 1 from strains s where lower(s.name) = lower(p.name) or lower(p.name) = any (select lower(a) from unnest(s.aliases) a));

select count(*) as strains_with_photo from strain_info where photo_url like '/strains/%';
-- Not assigned yet (photo is in the app; set it from the strain's Sales settings, Photo = the path):
{chr(10).join(f'--   /strains/{k}.jpg  {v}' for k, v in ASK.items())}
"""
open('supabase/043_strain_photos.sql', 'w').write(sql)
print(len(M), sum(len(v) for v in M.values()))

-- Migration 035: the FL26 Gen 2 cuts (10/11) are rooting in Trailer 4 (the import had put them in Trailer 1).
-- Run after 033. Safe to re-run.
update nursery_batches set room_id = (select id from nursery_rooms where site = '1PN' and name = 'Trailer 4')
 where gen = 2 and cut_on = '2026-10-11' and stage in ('rooting','ready') and notes like '[import Webb2027]%';
select count(*) as g2_batches_in_trailer_4 from nursery_batches b join nursery_rooms r on r.id = b.room_id
 where b.gen = 2 and b.cut_on = '2026-10-11' and r.name = 'Trailer 4';

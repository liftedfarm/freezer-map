-- Customer list from Accounts_20261021T050311.xlsx (101 accounts). Safe to re-run.
-- New names are added as external customers. Existing customers (matched by name, alternate name or address name)
-- only get blank fields filled in; nothing you've already entered is overwritten.
begin;
create temp table acct (name text, license text, address text, contact text, notes text, alts text[]) on commit drop;
insert into acct values
('1904 Provisions','DCC-10003107','6225 Progressive Avenue, San Diego, CA 92154',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Happy Travels, LLC',array[]::text[]),
('Abstrax Labs','DCC-10002333','1451 W 15th Street, Long Beach, CA 90813',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Abstrax Labs, Inc.',array[]::text[]),
('Acquamarcia LLC',null,'2408 South Broadway, Los Angeles, CA 90007','Alex','Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Acquamarcia',array['Acquamarcia']::text[]),
('After Five Farms','CCL19-0005432','196 Browns Valley Road, Watsonville, CA 95076',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Cash on Delivery',array['Leef Farm']::text[]),
('Alive and Well','DCC-10002900','280 Alder Grove Rd, Arcata, CA 95521',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Humboldt Harvest, Inc.',array[]::text[]),
('Amesti','CCL25-0000452','600 Amesti Road, Watsonville, CA 95076','Mavrik · mavrik@lifted-organics.com','Cultivator · Customer and supplier · Account owner: Tiffani Stewart · Terms: Net 30 · Licensee: DNA Organics',array[]::text[]),
('Axiom Extracts','DCC-10003604','7022 Darby Avenue STE. B, Los Angeles, CA 91335','Arya','Manufacturer, Wholesale · Customer (Prospective) · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Cannafusions, Inc.',array['Cannafusions, Inc.']::text[]),
('Bavana','DCC-10005101','2500 Main Street, Los Angeles, CA 90007',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Bavana LLC',array[]::text[]),
('BCRx Distro','C11-0001269-LIC','1127 Chestnut Street, Marysville, CA 95901','888- 227-9426','Distributor · Customer (Prospective) · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: BioCaniRx, Inc.',array['Marysville Facility']::text[]),
('Bear Labs Humboldt','DCC-10002484','550 W End Rd Suite 9, 10, 14, 15, Arcata, CA 95521',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Emerald Triangle Management Group, Inc.',array[]::text[]),
('Big Pete''s LLC','DCC-10002397','1560 Mansfield St, Santa Cruz, CA 95062',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Big Pete''s, LLC',array['Big Pete''s']::text[]),
('Bishop Boyz','DCC-10004902','14655-57 Lull St, Van Nuys, CA 91045',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Bloom Network','C11-0001231-LIC','300 Pioneer Street, Santa Cruz, CA 95060',null,'Distributor · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: SC Bloom Network, Inc.',array[]::text[]),
('BTC Ventures','DCC-10002648','7755 Arjons Drive, San Diego, CA 92126',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: BTC Ventures, LLC',array[]::text[]),
('BTJ Ventures, Inc.','DCC-10002667','3301 South Harbor Boulevard, Santa Ana, CA 92704','Brandon Sisco','Manufacturer, Wholesale · Customer (Prospective) · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: BTJ Ventures, Inc., Manufacturing',array['BTJ Ventures Santa Ana']::text[]),
('Buddies','DCC-10003316','3595 Iron Court Suite 2, Shasta Lake, CA 96019',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Hash Tag Extracts, Inc.',array[]::text[]),
('Bustan Inc.','DCC-10004043','1091 San Felipe Rd, Hollister, CA 95023',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Bustan',array['Bustan']::text[]),
('Cal State 2618','C11-0001732-LIC','1107 E 12th St, Los Angeles, CA 90021',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Cali Stripe','DCC-10004804','783 Redwood Avenue, Sand City, CA 93955',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Coastal refinement Solutions',array[]::text[]),
('California Top Crop','C12-0000473-LIC','457 South Acacia Street 457, Woodlake, CA 93286',null,'Manufacturer · Account owner: Aziz Nashat',array['457 S. Acacia St. Woodlake, CA 93282']::text[]),
('Campbell Farms','DCC-10004881','1363 Green Valley Road, Watsonville, CA 95076',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Doobie USA',array['Campbell Farm']::text[]),
('CannaCraft','DCC-10004584','2753 Giffen Ave, Santa Rosa, CA 95407',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: CRFT Manufacturing, Inc.',array[]::text[]),
('Castle Rock Ridge','CCL19-0002012','2260 Los Alamos Road, Santa Rosa, CA 95409',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Other',array[]::text[]),
('Center Street Investments INC','DCC-10004726','8191 Center Street, La Mesa, CA 91942',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Center Street Investment Inc',array['Center Street Investments']::text[]),
('Central Coast Ag Farming','CCL19-0005113','8701 Santa Rosa Road, Buellton, CA 93427',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Cash on Delivery · Licensee: Central Coast Ag Farming LLC.',array[]::text[]),
('Central Coast Processing','CCL22-0001626','151 Obispo Street, Guadalupe, CA 93434','Travis Nichter · 714-721-2666','Other · Account owner: Aziz Nashat',array[]::text[]),
('Centro LLC','C11-0001373','8127 Slauson Avenue, Montebello, CA 90640',null,'Distributor · Account owner: Aziz Nashat · Licensee: Centro LLC, Distributor',array['8127 Slauson Ave. Montabello, CA, 90640']::text[]),
('Club Green','C12-0000546-LIC','8790 Fruitridge Road Unit A, Sacramento, CA 95826','Danny','Manufacturer, Wholesale · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Colombis','C11-0000658','1412 South Gerhart Avenue, Commerce, CA 90022',null,'Manufacturer · Customer and supplier · Account owner: Ramananda Drew · Terms: Cash on Delivery · Licensee: LA Green Rush',array['Columbis']::text[]),
('Costa Cannabis','DCC-10003867','2325 East Anaheim Street, Long Beach, CA 90804','Tom · 909-993-2847','Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Creamery','DCC-10004667','617 85th Avenue, Oakland, CA 94621',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: The Creamery',array[]::text[]),
('Cruz Science','DCC-10004761','211 Fern Street, Santa Cruz, CA 95060',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Intersitial Systems LLC, Manufacturer',array[]::text[]),
('CSCF, LLC','CCL20-0001582','101 Trinity Road, Glen Ellen, CA 95442',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Other',array[]::text[]),
('D9 Society','DCC-10004408','193 Otto Circle, Sacramento, CA 95822',null,'Manufacturer · Account owner: Ramananda Drew · Terms: Net 30 · Licensee: D9 Society, Manufacturer',array[]::text[]),
('Deeper Dive','DCC-10004847','2936 East 11th Street, Los Angeles, CA 90023',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Deeper Dive LA Management',array[]::text[]),
('DNA Organics',null,'n/a, n/a n/a',null,'Cultivator · Supplier · Account owner: Aziz Nashat',array['n/a']::text[]),
('Drops Candies','DCC-10004821','351 Alder Avenue, Cotati, CA 94931',null,'Manufacturer · Account owner: Matt Groves · Terms: Net 30 · Licensee: Drops Cali LLC',array[]::text[]),
('Emerald Labs','DCC-10004080','7540 Trade St, San Diego, CA 92121',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Emerald Labs, LLC',array[]::text[]),
('Emerald Sun','DCC-10003158','1825 Airport Rd, Ukiah, CA 95482',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Emerald Sun Manufacturing, LLC',array[]::text[]),
('Essential Torrance','C12-0000012-LIC','1609 Lockness Place, Torrance, CA 90501','Nick · 310-467-0419','Microbusiness · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Infinity Medical Alliance',array['Infinity Medical Alliance']::text[]),
('Euphoric Life, Inc.','DCC-10003356','807 Industrial Drive, Hollister, CA 95023',null,'Wholesale · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Final Bell','C12-0000266-LIC','7731 Hayvenhurst Avenue, Los Angeles, CA 91406',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Westside Caregivers Club, Inc.',array[]::text[]),
('Fire King Hash','DCC-10003940','1569 Wallace Avenue, San Francisco, CA 94124',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: SF Bay Trading LLC',array[]::text[]),
('Flow Kana','CCL18-0001544','1150 Bel Arbres Drive, Redwood Valley, CA 95470','2022572738','Distributor · Account owner: Aziz Nashat · Terms: Other · Licensee: Event Horizon Technologies, Inc.',array[]::text[]),
('Friendly Farms','DCC-10004364','1025 Joellis Way, Sacramento, CA 95815',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: DELC LLC',array[]::text[]),
('Frozen California','CDPH-10004516','1864 East 22nd Street, Vernon, CA 90058',null,'Manufacturer, Wholesale · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Reaps Company LLC',array['Reaps']::text[]),
('GA Factory',null,'1001 East 14th Street, Los Angeles, CA 90021',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery',array[]::text[]),
('Good Heads','DCC-10002801','1324 West Beach Street, Watsonville, CA 95076','Cam · 725-352-2605','Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Creme De Canna Collective',array['Creme De Canna Collective']::text[]),
('Green Acre Management','DCC-10004540','515 West 17th Street, Long Beach, CA 90813','Jeff · 8057216981','Manufacturer · Account owner: Aziz Nashat · Licensee: Green Acre Management, Manufacturer',array[]::text[]),
('Green River','DCC-10004791','8880 Elder Creek Road, Sacramento, CA 95828','Ryan · ryan@grextracts.com · 9167687763','Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: G W Brands, LLC.',array['Green River Extracts']::text[]),
('Green Valley','CCL20-0002986','1363 Green Valley Road, Watsonville, CA 95076','Rama · ramananda@lifted-organics.com','Wholesale, Cultivator · Customer and supplier · Account owner: Tiffani Stewart · Terms: Net 30 · Licensee: Mcuen Management',array[]::text[]),
('GV1659','CCL21-0001659','1363 Green Valley Road, Watsonville, CA 95076',null,'Cultivator · Customer and supplier · Account owner: Ramananda Drew · Licensee: Strong Agronomy',array[]::text[]),
('GV4217`','CCL21-0004217','1363 Green Valley Road, Watsonville, CA 95076',null,'Cultivator · Customer and supplier · Account owner: Ramananda Drew · Licensee: Strong Agronomy',array['GV4217']::text[]),
('Jah Botanist',null,'1412 South Gerhart Avenue, Commerce, CA 90022',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: LA GREEN RUSh',array[]::text[]),
('Jetty Extracts','DCC-10002243','1137 57th Ave, Oakland, CA 94621',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Ametrine Wellnes',array[]::text[]),
('KGJMK OPCO Inc','DCC-10004741','3200 South Susan Street, Santa Ana, CA 92704',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery',array[]::text[]),
('Land Hammer Farms','CCL20-0001448','4249 Murphys Grade Road, Murphys, CA 95247',null,'Cultivator · Account owner: Tiffani Stewart',array[]::text[]),
('Lantorganics','DCC-10002816','17130 Racoon Avenue, Adelanto, CA 92301',null,'Distributor · Account owner: Ramananda Drew · Licensee: Lantorganics, LLC',array[]::text[]),
('Last Minute Ventures','C11-0001229-LIC','3405 San Pedro Street, Los Angeles, CA 90011',null,'Manufacturer · Account owner: Aziz Nashat · Licensee: Last Minute Ventures LLC',array['Last Minute']::text[]),
('Lazer Buddha','DCC-10003533','1001 E 14th St, Los Angeles, CA 90021',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: GA Factory',array[]::text[]),
('LEEF Labs','DCC-10002848','175 N Lenore Ave, Willits, CA 95490',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Net 30 · Licensee: Seven Zero Seven, LLC',array[]::text[]),
('Magnolia Extracts','DCC-10003446','11118 Wright Road, Lynwood, CA 90262',null,'Manufacturer, Wholesale · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Magnolia Extracts, LLC',array[]::text[]),
('MAR SR','DCC-10003443','3075 Coffey Lane, Santa Rosa, CA 95403',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: MAR SR LLC',array[]::text[]),
('Master Makers','C12-0000072-LIC','2408 South Broadway, Los Angeles, CA 90007','Mike · mike@makersmj.com','Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Broadway Alliance, LLC',array[]::text[]),
('Maverick Star','C11-0000769','14757 Keswick Street, Los Angeles, CA 91405','Kevin · (805)490-3524','Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Maverick Star Inc.',array[]::text[]),
('Mendocino Mountain Farms','CCL19-0001195','8450 Orr Springs Road, Ukiah, CA 95482','Kelly','Cultivator · Account owner: Tiffani Stewart',array['MMF Kelly']::text[]),
('Motley Terpz','DCC-10003573','20800 Dearborn Street, Los Angeles, CA 91311',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Other · Licensee: Dyvinel, Inc.',array['Natures Lab']::text[]),
('Natura','DCC-10004187','8280 Elder Creek Road, Sacramento, CA 95828','Anthony Scuderi · anthony@natura.io','Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Natura Manufacturing, LLC',array[]::text[]),
('NUG','DCC-10002737','580 Julie Ann Way, Oakland, CA 94621',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: CCSAC Inc',array[]::text[]),
('Oak Hill Ranch','CCL25-0000017','2038 Old Airline Highway, Paicines, CA 95043',null,'Cultivator · Customer and supplier · Account owner: Tiffani Stewart · Terms: Other · Licensee: DNA Organics',array['Oak Hill']::text[]),
('Olympic Extracts','DCC-10002790','2063 Pacific Avenue, Long Beach, CA 90806',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: The Broccoli King, Inc.',array[]::text[]),
('Pac West','DCC-10003880','3217 Union Pacific Avenue, Los Angeles, CA 90023','Ryan Claridge · Ryan.Claridge@gmail.com · 8188236157','Manufacturer · Account owner: Aziz Nashat',array[]::text[]),
('Paradise Factory','C12-0000073-LIC','385 West 20th Street, Los Angeles, CA 90731','Tyler · 909-709-8698','Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Paradise Factory LLC',array[]::text[]),
('Punch Edibles and Extracts','DCC-10003615','8724 Remmet Ave, Canoga Park, CA 91304',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Punch Media, LLC',array[]::text[]),
('QCSC LLC','CCL20-0002194','742 W Ave L, Lancaster, CA 93534',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: QCSC, LLC',array['QCSC']::text[]),
('Quarry Farm','CCL20-0000440','585 Trinity Road, Glen Ellen, CA 95442',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Cash on Delivery · Licensee: Quarry LLC.',array['Quarry Farms']::text[]),
('Refined Genetics','CCL22-0001294','2897 Freedom Blvd, Watsonville, CA 95076',null,'Cultivator · Customer and supplier · Account owner: Tiffani Stewart · Terms: Cash on Delivery · Licensee: Refined Genetics, LLC',array[]::text[]),
('Reroc','C11-0001157','2115 Willow Road, Arroyo Grande, CA 93420',null,'Manufacturer · Account owner: Matt Groves · Terms: Net 30 · Licensee: Reroc, LLC',array[]::text[]),
('Rokin','DCC-10003017','196 Market Street, San Rafael, CA 94901','Klifton · (720)-508-9525','Manufacturer · Account owner: Aziz Nashat · Terms: Net 30 · Licensee: Tamalpais Co-Packing, LLC',array['Tamalpais Co-Packing LLC']::text[]),
('Rosin Tech Labs','DCC-10004053','1606 Lockness Place, Torrance, CA 90501',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Calmeds Farmer Union',array[]::text[]),
('SLO Driver','C12-0000408-LIC','2115 Willow Rd A Suite, Arroyo Grande, CA 93420',null,'Manufacturer · Account owner: Matt Groves · Terms: Net 30 · Licensee: SLO Driver, LLC',array[]::text[]),
('Solas Ventures','DCC-10003479','3505 Cadillac Avenue, Costa Mesa, CA 92626',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Expando Products, LLC',array[]::text[]),
('Space Camp Industries','DCC-10004516','1864 East 22nd Street, Vernon, CA 90058',null,'Manufacturer · Account owner: Aziz Nashat · Licensee: Reaps Company LLC',array['Space Camp']::text[]),
('Space Camp Industries (Old)',null,'1864 East 22nd Street, Vernon, CA 90058',null,'Distributor · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Reaps',array['Space Camp Industries']::text[]),
('Staccs','CCL24-0000264','1313 Green Valley Road, Corralitos, CA 95076',null,'Distributor · Customer and supplier · Account owner: Aziz Nashat · Licensee: STACS 831',array['Kelly Freezers']::text[]),
('STIIIZY','DCC-10004706','1641 West Central Avenue, Lompoc, CA 93436',null,'Manufacturer, Distributor · Customer (Prospective) · Account owner: Aziz Nashat · Licensee: Clean and Clear LLC, Provisional AM-Type 7: Volatile Solvent Extraction',array['Clean and Clear LLC']::text[]),
('Strong Ag Processing','CCL20-0001837','1314 Green Valley Road, Watsonville, CA 95076',null,'Distributor · Customer and supplier · Account owner: Matt Groves · Terms: Other · Licensee: Strong Agronomy Management',array[]::text[]),
('Strong Agronomy Management, Inc.','CCL18-0001210','1310 Green Valley Rd, Watsonville, CA 95076',null,'Manufacturer · Customer and supplier · Account owner: Aziz Nashat',array['Strong Agronomy']::text[]),
('The Bake Shop','C12-0000428','921 Venice Boulevard, Los Angeles, CA 90015',null,'Microbusiness · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: The Bake Shop LA LLC',array[]::text[]),
('Trico','C11-0000658-LIC','1412 South Gerhart Avenue, Commerce, CA 90022',null,'Distributor · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: LA Green Rush',array['LA Green Rush']::text[]),
('TSL Manufacturing LLC','DCC-10003553','220 W Ave H-6, Lancaster, CA 93534',null,'Manufacturer · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: The Syndicate Lancaster',array[]::text[]),
('Type 7 Manufacturing','DCC-10002365','637 Cedar St, Berkeley, CA 94710',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: Type 7 Manufacturing, Inc.',array[]::text[]),
('Upper Swanston Ranch','CCL20-0002038','103 North Harbor Boulevard, West Sacramento, CA 95691',null,'Cultivator · Account owner: Tiffani Stewart · Licensee: CCL20-0002038',array[]::text[]),
('Valley Ranch Ag LLC','CCL25-0000040','4379 New Long Valley Road, Clearlake Oaks, CA 95423',null,'Cultivator · Account owner: Tiffani Stewart · Terms: Other',array[]::text[]),
('Verdacopia','DCC-10003976','15010 Arrow Highway, Baldwin Park, CA 91706',null,'Manufacturer · Account owner: Matt Groves · Terms: Cash on Delivery · Licensee: VRD Inc',array[]::text[]),
('Verdant Moon','C12-0000115-LIC','7367 Ethel Avenue, Los Angeles, CA 91605',null,'Microbusiness · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Verdant Moon, LLC',array[]::text[]),
('Washed LA','DCC-10004772','6225 Progressive Avenue 200 B, San Diego, CA 92154','Dave Blanchard · 619-885-5044','Manufacturer, Wholesale · Account owner: Aziz Nashat · Terms: Net 30 · Licensee: Pure Vape, Inc',array['Pure Vape']::text[]),
('Webb Field','CCL18-0000663','361 Webb Road, Watsonville, CA 95076','Tiffani · tiffani@lifted-organics.com','Cultivator · Customer and supplier · Account owner: Tiffani Stewart · Terms: Net 30 · Licensee: DNA Organics',array[]::text[]),
('Wookbros','DCC-10004010','45 Main Street, Rio Vista, CA 94571',null,'Manufacturer · Account owner: Aziz Nashat · Licensee: Wookbros, LLC',array[]::text[]),
('Worldwide Service Group, LLC','DCC-10002716','1436 West Cowles Street Suite C, Long Beach, CA 90813','Danny · 917-447-6933','Manufacturer, Wholesale · Account owner: Aziz Nashat · Terms: Cash on Delivery · Licensee: Worldwide Service Group LLC',array['1436 W Cowles St. Suite C, Long Beach, CA 90813']::text[]),
('Zion','CCL20-0001695','496 Casserly Road, Watsonville, CA 95076',null,'Cultivator · Customer and supplier · Account owner: Ramananda Drew · Terms: Other · Licensee: Growing Family Collective',array[]::text[]);

create temp table matched on commit drop as
  select distinct on (c.id) c.id, a.name as acct_name, a.license, a.address, a.contact, a.notes
    from acct a join customers c
      on lower(c.name) = lower(a.name) or lower(c.name) = any(select lower(x) from unnest(a.alts) x)
   order by c.id, (lower(c.name) = lower(a.name)) desc;

update customers c set
    license = coalesce(c.license, m.license),
    address = coalesce(c.address, m.address),
    contact = coalesce(c.contact, m.contact),
    notes   = coalesce(c.notes, m.notes)
  from matched m
 where c.id = m.id
   and (c.license is null and m.license is not null or c.address is null and m.address is not null
        or c.contact is null and m.contact is not null or c.notes is null and m.notes is not null);

insert into customers (name, kind, license, address, contact, notes)
select a.name, 'external', a.license, a.address, a.contact, a.notes
  from acct a
 where not exists (select 1 from matched m where m.acct_name = a.name)
   and not exists (select 1 from customers c where lower(c.name) = lower(a.name));

select (select count(*) from matched) as already_there_filled_in,
       (select count(*) from customers where kind = 'external') as external_customers_now;
select m.acct_name as in_spreadsheet, c.name as matched_existing from matched m join customers c on c.id = m.id where lower(c.name) <> lower(m.acct_name);
commit;

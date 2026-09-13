-- Reference data: the cultural vocabulary and the Texas pilot footprint.
--
-- This is idempotent (ON CONFLICT DO NOTHING) so it can be re-run on every
-- deploy. It must stay in step with services/api/src/domain/taxonomy.ts and
-- geo.ts; the drift check in CI compares the two.

BEGIN;

INSERT INTO metros (code, name, center, radius_miles) VALUES
    ('dfw', 'Dallas-Fort Worth',  ST_MakePoint(-97.05,  32.80)::geography, 45),
    ('hou', 'Greater Houston',    ST_MakePoint(-95.42,  29.79)::geography, 45),
    ('aus', 'Austin',             ST_MakePoint(-97.75,  30.31)::geography, 32),
    ('sat', 'San Antonio',        ST_MakePoint(-98.52,  29.47)::geography, 32),
    ('elp', 'El Paso',            ST_MakePoint(-106.42, 31.79)::geography, 25),
    ('rgv', 'Rio Grande Valley',  ST_MakePoint(-98.13,  26.23)::geography, 35),
    ('cc',  'Corpus Christi',     ST_MakePoint(-97.42,  27.78)::geography, 25),
    ('lbb', 'Lubbock',            ST_MakePoint(-101.86, 33.58)::geography, 20)
ON CONFLICT (code) DO NOTHING;

INSERT INTO languages (code, label) VALUES
    ('english','English'), ('hindi','Hindi'), ('telugu','Telugu'), ('tamil','Tamil'),
    ('gujarati','Gujarati'), ('punjabi','Punjabi'), ('urdu','Urdu'), ('bengali','Bengali'),
    ('marathi','Marathi'), ('kannada','Kannada'), ('malayalam','Malayalam'),
    ('nepali','Nepali'), ('sinhala','Sinhala')
ON CONFLICT (code) DO NOTHING;

INSERT INTO event_types (code, label, event_group, is_commercial) VALUES
    -- Wedding
    ('roka_engagement','Roka / Engagement','wedding',FALSE),
    ('mehndi','Mehndi','wedding',FALSE),
    ('haldi','Haldi','wedding',FALSE),
    ('sangeet','Sangeet','wedding',FALSE),
    ('baraat','Baraat','wedding',FALSE),
    ('hindu_ceremony','Hindu Wedding Ceremony','wedding',FALSE),
    ('nikah','Nikah','wedding',FALSE),
    ('sikh_anand_karaj','Anand Karaj','wedding',FALSE),
    ('kerala_christian_wedding','Kerala Christian Wedding','wedding',FALSE),
    ('reception','Reception','wedding',FALSE),
    -- Religious
    ('griha_pravesham','Griha Pravesham','religious',FALSE),
    ('satyanarayan_puja','Satyanarayan Puja','religious',FALSE),
    ('ayush_homam','Ayush Homam','religious',FALSE),
    ('upanayanam','Upanayanam','religious',FALSE),
    ('namakaranam','Namakaranam','religious',FALSE),
    -- Milestone
    ('half_saree_function','Half-Saree Function','milestone',FALSE),
    ('mundan_child_carnival','Mundan / Child Carnival','milestone',FALSE),
    ('seemantham_baby_shower','Seemantham / Baby Shower','milestone',FALSE),
    ('first_birthday','First Birthday','milestone',FALSE),
    ('graduation_party','Graduation Party','milestone',FALSE),
    -- Festival
    ('garba_navratri','Garba / Navratri','festival',FALSE),
    ('diwali_celebration','Diwali Celebration','festival',FALSE),
    ('holi_event','Holi Event','festival',FALSE),
    ('bhangra_night','Bhangra Night','festival',FALSE),
    -- Commercial
    ('boutique_lookbook','Boutique Lookbook','commercial',TRUE),
    ('brand_campaign_shoot','Brand Campaign Shoot','commercial',TRUE),
    ('jewellery_catalogue','Jewellery Catalogue','commercial',TRUE),
    ('corporate_diwali','Corporate Diwali','commercial',TRUE),
    ('corporate_offsite','Corporate Offsite','commercial',TRUE),
    ('restaurant_launch','Restaurant Launch','commercial',TRUE),
    ('influencer_collab','Influencer Collaboration','commercial',TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO crew_specialties (code, label) VALUES
    ('mua','Makeup Artist'), ('hair_stylist','Hair Stylist'),
    ('photographer','Photographer'), ('videographer','Videographer'),
    ('drone_operator','Drone Operator'), ('henna_artist','Henna Artist'),
    ('decorator','Decorator'), ('florist','Florist'), ('dj','DJ'),
    ('live_musician','Live Musician'), ('dhol_player','Dhol Player'),
    ('choreographer','Choreographer'), ('caterer','Caterer'),
    ('priest_pandit','Priest / Pandit'), ('event_planner','Event Planner'),
    ('mehndi_assistant','Mehndi Assistant'), ('saree_draper','Saree Draper')
ON CONFLICT (code) DO NOTHING;

INSERT INTO cultural_tags (code, label) VALUES
    ('south_indian_bridal','South Indian Bridal'),
    ('north_indian_bridal','North Indian Bridal'),
    ('telugu_traditional','Telugu Traditional'),
    ('tamil_iyer','Tamil Iyer'),
    ('kannada_traditional','Kannada Traditional'),
    ('malayali_traditional','Malayali Traditional'),
    ('gujarati_traditional','Gujarati Traditional'),
    ('punjabi_sikh','Punjabi Sikh'),
    ('marathi_traditional','Marathi Traditional'),
    ('bengali_traditional','Bengali Traditional'),
    ('rajasthani_traditional','Rajasthani Traditional'),
    ('muslim_nikah','Muslim Nikah'),
    ('indo_western_fusion','Indo-Western Fusion'),
    ('minimal_natural','Minimal / Natural'),
    ('hd_airbrush','HD Airbrush')
ON CONFLICT (code) DO NOTHING;

-- Style adjacency: a host who asked for one is usually well served by the
-- other, so the match engine awards partial credit rather than dropping them.
INSERT INTO cultural_tag_affinity (tag_code, related_code, affinity) VALUES
    ('south_indian_bridal','telugu_traditional',0.5),
    ('south_indian_bridal','tamil_iyer',0.5),
    ('south_indian_bridal','kannada_traditional',0.5),
    ('south_indian_bridal','malayali_traditional',0.5),
    ('telugu_traditional','south_indian_bridal',0.5),
    ('telugu_traditional','kannada_traditional',0.5),
    ('tamil_iyer','south_indian_bridal',0.5),
    ('tamil_iyer','malayali_traditional',0.5),
    ('kannada_traditional','south_indian_bridal',0.5),
    ('kannada_traditional','telugu_traditional',0.5),
    ('malayali_traditional','south_indian_bridal',0.5),
    ('malayali_traditional','tamil_iyer',0.5),
    ('north_indian_bridal','punjabi_sikh',0.5),
    ('north_indian_bridal','rajasthani_traditional',0.5),
    ('north_indian_bridal','hd_airbrush',0.5),
    ('punjabi_sikh','north_indian_bridal',0.5),
    ('rajasthani_traditional','north_indian_bridal',0.5),
    ('rajasthani_traditional','gujarati_traditional',0.5),
    ('gujarati_traditional','rajasthani_traditional',0.5),
    ('gujarati_traditional','marathi_traditional',0.5),
    ('marathi_traditional','gujarati_traditional',0.5),
    ('bengali_traditional','north_indian_bridal',0.5),
    ('muslim_nikah','north_indian_bridal',0.5),
    ('muslim_nikah','hd_airbrush',0.5),
    ('indo_western_fusion','minimal_natural',0.5),
    ('indo_western_fusion','hd_airbrush',0.5),
    ('minimal_natural','indo_western_fusion',0.5),
    ('hd_airbrush','north_indian_bridal',0.5),
    ('hd_airbrush','indo_western_fusion',0.5)
ON CONFLICT (tag_code, related_code) DO NOTHING;

COMMIT;

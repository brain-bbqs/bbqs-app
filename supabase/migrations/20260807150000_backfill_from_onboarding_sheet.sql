-- Backfill from the BBQS onboarding Google Sheet (tabs: 'Form Responses 1' + 'Working Groups').
-- FILL-ONLY-EMPTY and idempotent: every statement only writes where the KG value is currently
-- NULL/empty (or, for arrays, only ADDS missing entries). Nothing is ever overwritten, so
-- re-running is a no-op. Every write is captured by data_audit_log.
--
-- Run the sections you want; they are independent.


-- ── 1. ORCID (6 people) — unambiguous identifiers from the form ──────────────
UPDATE public.investigators i SET orcid = v.orcid
FROM (VALUES
  ('sankar.alagapan@gatech.edu', '0000-0002-2056-5450'),
  ('tstjohn@uw.edu', '0000000324485797'),
  ('mbaylis@berkeley.edu', 'MARABAYLIS'),
  ('sima.mofakham@stonybrookmedicine.edu', '0000-0002-4509-6080'),
  ('charles.mikell@stonybrook.edu', '0000-0002-0701-2325'),
  ('yankun.xu@duke.edu', '0000-0002-4410-4106')
) AS v(email, orcid)
WHERE lower(i.email) = v.email
  AND coalesce(nullif(trim(i.orcid), ''), '') = '';


-- ── 2. Secondary emails (7 people) — used for Globus / mailing-list matching ──
UPDATE public.investigators i
SET secondary_emails = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(i.secondary_emails,'{}') || ARRAY[v.sec]) x)
FROM (VALUES
  ('jylboline@informedminds.info', 'jylboline@gmail.com'),
  ('satra@mit.edu', 'satrajit.ghosh@gmail.com'),
  ('sulstice@mit.edu', 'sharifsuliman1@gmail.com'),
  ('sima.mofakham@stonybrookmedicine.edu', 's.mofakham@gmail.com'),
  ('bmimica@princeton.edu', 'bmimica@princeton.edu'),
  ('charles.mikell@stonybrook.edu', 'chuck.mikell@gmail.com'),
  ('joshua.wu@duke.edu', 'wu.joshuah@gmail.com')
) AS v(email, sec)
WHERE lower(i.email) = v.email
  AND NOT (v.sec = ANY(coalesce(i.secondary_emails,'{}')));


-- ── 3. Working groups (13 people) — the 'Working Groups' tab is the authoritative roster ──
-- ⚠️ SIDE EFFECT: adding a working group fires trg_sync_member_groups, which ADDS these people
-- to the matching wg-*@brain-bbqs.org Google Groups. That is the intent (the roster says they
-- belong), but it does send real mailing-list changes. Review the list before running.
UPDATE public.investigators i
SET working_groups = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(i.working_groups,'{}') || string_to_array(v.add, ',')) x)
FROM (VALUES
  ('yvonne.bennett@nih.gov', 'WG-Devices,WG-ELSI,WG-Standards'),
  ('sankar.alagapan@gatech.edu', 'WG-Analytics,WG-Devices,WG-ELSI'),
  ('sima.mofakham@stonybrookmedicine.edu', 'WG-Analytics,WG-Devices,WG-ELSI'),
  ('charles.mikell@stonybrook.edu', 'WG-Analytics'),
  ('hongli.wang@berkeley.edu', 'WG-Analytics'),
  ('tdaniel60@gatech.edu', 'WG-Analytics,WG-Devices,WG-ELSI'),
  ('timbr@uw.edu', 'WG-ELSI'),
  ('yankun.xu@duke.edu', 'WG-Analytics,WG-Devices'),
  ('bbqs.test.user.tier1@gmail.com', 'WG-Devices'),
  ('joshua.wu@duke.edu', 'WG-Analytics'),
  ('ndrnkbkht@gmail.com', 'WG-Standards'),
  ('', 'WG-Analytics'),
  ('jeffrey.walker@yale.edu', 'WG-Analytics')
) AS v(email, add)
WHERE lower(i.email) = v.email;


-- ── 4. Institution (119 people) — SELF-REPORTED FREE TEXT from the form ────────────────
-- ⚠️ REVIEW BEFORE RUNNING. These are as the member typed them ('UCB', 'JHU/APL',
-- 'UPenn / Pennsieve'), whereas institutions already in the KG came from NIH RePORTER in
-- canonical uppercase ('MASSACHUSETTS INSTITUTE OF TECHNOLOGY'). Filling these closes 119
-- empty fields but mixes two naming conventions. Run it if 'populated but inconsistent' beats
-- 'empty' for your use (search/affiliation queries currently return nothing for these people).
UPDATE public.investigators i SET institution = v.inst
FROM (VALUES
  ('aw4614@nyu.edu', 'New York University'),
  ('tianqing.li@duke.edu', 'Duke University'),
  ('stephen.heisig@mssm.edu', 'Icahn School of Medicine'),
  ('oruebel@lbl.gov', 'Lawrence Berkeley National Laboratory'),
  ('jkw131@psu.edu', 'Penn State University'),
  ('han.yi@jhuapl.edu', 'Johns Hopkins University Applied Physics Laboratory'),
  ('kebouchard@berkeley.edu', 'UCB'),
  ('erik.c.johnson@jhuapl.edu', 'JHU/APL'),
  ('yvonne.bennett@nih.gov', 'NIMH'),
  ('simmonsj@mail.nih.gov', 'NIH/OBSSR'),
  ('mattson.ogg@jhuapl.edu', 'Johns Hopkins Applied Physics Laboratory'),
  ('neha.thomas@jhuapl.edu', 'JHU APL'),
  ('nicole.guittari@jhuapl.edu', 'Johns Hopkins Applied Physics Laboratory/EMBER'),
  ('mvallejomartelo@mednet.ucla.edu', 'UCLA'),
  ('alireza.kazemi@utah.edu', 'University of Utah'),
  ('y.li7@columbia.edu', 'Columbia University'),
  ('ghp2114@cumc.columbia.edu', 'Columbia University'),
  ('mekline@mit.edu', 'Massachusetts Institute of Technology'),
  ('hz2555@columbia.edu', 'Columbia Univeristy'),
  ('kgothard@arizona.edu', 'The University of Arizona'),
  ('kailin.zhuang@berkeley.edu', 'University of California, Berkeley'),
  ('rahul.hingorani@jhuapl.edu', 'JHU/APL'),
  ('jylboline@informedminds.info', 'Informed Minds Inc.'),
  ('ckendell@seas.upenn.edu', 'University of Pennsylvania'),
  ('vprakash@miami.edu', 'University of Miami'),
  ('lauren.diaz@jhuapl.edu', 'JHU/APL'),
  ('yoh@dartmouth.edu', 'Dartmouth college'),
  ('nicole.stock@jhuapl.edu', 'JHU/APL'),
  ('jeffmun@uw.edu', 'University of Washington'),
  ('estesa@uw.edu', 'University of Washington'),
  ('kate.macduffie@seattlechildrens.org', 'Seattle Children''s Research Institute'),
  ('robertstim@chop.edu', 'Children''s Hospital of Philadelphia'),
  ('tstjohn@uw.edu', 'University of Washington Autism Center'),
  ('tlancaster6@gatech.edu', 'Georgia institute of technology'),
  ('te137@echo.rutgers.edu', 'Rutgers University'),
  ('sx67@scarletmail.rutgers.edu', 'Rutgers University'),
  ('kimm8@chop.edu', 'Children''s Hospital of Philadelphia'),
  ('blaskey@chop.edu', 'Children''s Hospital of Philadelphia'),
  ('sandy.hider@jhuapl.edu', 'Johns Hopkins, APL'),
  ('dana.schloesser@nih.gov', 'NIH/OBSSR'),
  ('awu36@gatech.edu', 'georgia institute of technology'),
  ('pesaran@upenn.edu', 'UPenn'),
  ('jarl.haggerty@pennmedicine.upenn.edu', 'University of Pennsylvania'),
  ('sequioasmith@ufl.edu', 'University of Florida'),
  ('afeinsinger@mednet.ucla.edu', 'UCLA'),
  ('sgoering@uw.edu', 'University of Washington'),
  ('kleineuw@uw.edu', 'Oregon Health and Science University, University of Washington'),
  ('kuschnere@chop.edu', 'CHOP/UPenn'),
  ('samaras@cs.stonybrook.edu', 'Sony Brook University'),
  ('brent.kious@hsc.utah.edu', 'University of Utah'),
  ('rly@lbl.gov', 'Lawrence Berkeley National Lab'),
  ('smprince@lbl.gov', 'Lawrence Berkeley National Laboratory'),
  ('talbarran3@gatech.edu', 'Georgia Institute of Technology'),
  ('cody.c.baker.phd@gmail.com', 'Dartmouth College'),
  ('yibei@mit.edu', 'MIT'),
  ('wn15@rice.edu', 'Rice University'),
  ('brian.gitahi@yale.edu', 'Yale University'),
  ('karen.david@nih.gov', 'NIH'),
  ('abigayle.fogarty@mssm.edu', 'Icahn School of Medicine at Mount Sinai'),
  ('katherine.dokholyan@mssm.edu', 'Icahn School of Medicine At Mount Sinai'),
  ('grace.hwang@nih.gov', 'NIH'),
  ('acabral30@gatech.edu', 'Georgia Tech'),
  ('uros.topalovic@duke.edu', 'Duke University'),
  ('mauricio.rangel-gomez@nih.gov', 'NIMH'),
  ('la.garcia@utah.edu', 'University of Utah'),
  ('sugavanam.3@osu.edu', 'Ohio State university'),
  ('chang.1560@osu.edu', 'The Ohio State University'),
  ('stellachang1114@g.ucla.edu', 'UCLA'),
  ('thore@umich.edu', 'University of Michigan'),
  ('alvarovh@umich.edu', 'University of Michigan'),
  ('teneille.brown@law.utah.edu', 'University of Utah'),
  ('marcia.patchan@jhuapl.edu', 'JHU/APL'),
  ('weikang.shi@yale.edu', 'Yale'),
  ('meghan.cum@yale.edu', 'Yale University'),
  ('david.ostry@yale.edu', 'Yale Child Study Center'),
  ('taylor.wise@yale.edu', 'Yale University'),
  ('amelia.johnson.aj764@yale.edu', 'Yale University'),
  ('gao0624@gmail.com', 'Northwestern University'),
  ('vincent.gracco@yale.edu', 'Yale University'),
  ('mvperdue16@gmail.com', 'UMass Chan Medical School'),
  ('sulstice@mit.edu', 'Massachusetts Institute of Technology'),
  ('adam@adamnoah.com', 'Yale University'),
  ('amrita.nair@yale.edu', 'Yale university'),
  ('yizuo@ucsc.edu', 'UCSC'),
  ('a.macaskill@ucl.ac.uk', 'UCL'),
  ('wanchenlin@berkeley.edu', 'UC Berkeley'),
  ('shannon.gourley@emory.edu', 'Emory University'),
  ('joseph.monaco@nih.gov', 'NIH/BRAIN'),
  ('holly.moore@nih.gov', 'NIH'),
  ('mark.tiede@yale.edu', 'Dept. Psychiatry, Yale U.'),
  ('kari.johnson@nih.gov', 'NIH'),
  ('eunyoung.kim@nih.gov', 'NIH/NIMH/BRAIN Initiative'),
  ('adallave@ucla.edu', 'UCLA'),
  ('joostw@seas.upenn.edu', 'University of Pennsylvania'),
  ('cz2715@columbia.edu', 'Columbia University'),
  ('mpg8611@nyu.edu', 'New York University, Center for Neural Science'),
  ('karmiella.ferster@mssm.edu', 'Icahn School of Medicine at Mount Sinai'),
  ('mbaylis@berkeley.edu', 'UC Berkeley'),
  ('sara.sanchez.alonso@yale.edu', 'Yale University'),
  ('aydintasevac@gmail.com', 'University of Utah'),
  ('kaysuninf@gmail.com', 'Columbia Univerisity / Mount Sanai volunteer'),
  ('joseph.colonel@mssm.edu', 'Psychiatry'),
  ('nm4075@nyu.edu', 'New York University'),
  ('lensky.augustin@psych.utah.edu', 'University of Utah'),
  ('adam.friedman2@mssm.edu', 'Icahn School of Medicine at Mount Sinai'),
  ('calebsj@sas.upenn.edu', 'University of Pennsylvania'),
  ('nishant.rao@yale.edu', 'Yale University'),
  ('emily@basis.ai', 'Basis Research Institute'),
  ('ralph@basis.ai', 'Basis Research Institute / NYU'),
  ('bmimica@princeton.edu', 'Princeton Neuroscience Institute'),
  ('dima@basis.ai', 'Basis Research Institute'),
  ('jongwoon.kim@nyulangone.org', 'NYU, Columbia University'),
  ('brendan.ito@nyulangone.org', 'NYU Langone'),
  ('hongli.wang@berkeley.edu', 'UC Berkeley'),
  ('tdaniel60@gatech.edu', 'Georgia Institute of Technology'),
  ('timbr@uw.edu', 'University of Washington School of Medicine'),
  ('bbqs.test.user.tier1@gmail.com', 'MIT'),
  ('ndrnkbkht@gmail.com', 'MIT'),
  ('sjuliani@andrew.cmu.edu', 'Carnegie Mellon University')
) AS v(email, inst)
WHERE lower(i.email) = v.email
  AND coalesce(nullif(trim(i.institution), ''), '') = '';

-- SMART-DBS (U01MH144347): populate the project record from its questionnaire response.
--
-- SOURCE. "BBQS Data Questionnaire (Responses)", response submitted 2026-08-25 13:04:50 by
-- Bijan Pesaran (pesaran@gmail.com -- a secondary on his record; his primary is pesaran@upenn.edu).
-- It is the only response naming this grant, and the 22nd of 22 in the sheet.
--
-- WHY THE RECORD WAS EMPTY. metadata {}, study_species [], study_human FALSE, keywords [],
-- metadata_completeness 0, onboarding_status not_started. U01MH144347 was added 2026-08-06 and is
-- also one of the two awards the nih-grants reconcile cron has never touched (its hardcoded list
-- holds 29 of our 31). Nothing had ever populated it.
--
-- study_human goes TRUE and study_species becomes Homo sapiens. This is adaptive deep-brain
-- stimulation in people; the stored FALSE was not a considered answer, it was the column default on
-- a row nobody had filled.
--
-- PROVENANCE: G2 questionnaire, NOT G4 curator_fill. These are the PI's own answers, so set_actor
-- names the respondent and enforce_field_provenance records every changed metadata key against him
-- rather than against a migration -- the same treatment 20260819140000 gave the seventeen
-- 2026-04-17 imports.
--
-- KNOWN GAP, not fixed here: authored_at. enforce_field_provenance takes no authoring date, so these
-- claims carry today's recorded_at and no authored_at -- exactly like the Wilbrecht and Ghuman
-- imports that the 012 spec already lists as open. The submission date is 2026-08-25 and it belongs
-- in authored_at; giving the trigger a session setting for it is a separate change.
--
-- VALUE CONVENTION. Google Forms option labels carry "(e.g., ...)" example lists. The two prior form
-- imports stored the option with that gloss trimmed -- "Statistical methods", not "Statistical
-- methods (e.g., identify peaks, thresholds)". These follow the same convention, so the same answer
-- reads the same across projects and the questionnaire UI recognises it as a known option.
--
-- THREE ANSWERS NEEDED A HUMAN. The form's own option text for "types of analyses" has an unbalanced
-- parenthesis, and two reuse questions put commas outside their parentheses, so no mechanical split
-- recovers the options. Those three lists were read off by hand.
--
-- ONE CONTRADICTION IS RECORDED AS GIVEN, NOT RESOLVED. reuse_data_origins holds "None -- only
-- self-generated" alongside "Self previous experiments" and "Project internal": the respondent
-- checked all three. Choosing between them would be this migration inventing an answer.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('pesaran@gmail.com');
SELECT public.set_source_class('questionnaire');

-- Before.
SELECT grant_number, study_human, study_species, metadata_completeness,
       (SELECT count(*) FROM jsonb_object_keys(metadata)) AS metadata_keys
  FROM public.projects WHERE grant_number = 'U01MH144347';

UPDATE public.projects
   SET study_human = true,
       study_species = ARRAY['Homo sapiens'],
       -- Merged with || rather than replaced, so anything already present survives and the migration
       -- is safe to re-run.
       metadata = coalesce(metadata, '{}'::jsonb) || $q${
    "planning_priorities": [
      "Define the behavior to measure",
      "Define the behavioral tasks the subject should perform",
      "Which data modalities and recording devices to use",
      "Which acquisition software and hardware to use",
      "How to synchronize data streams",
      "How to manage the data generated"
    ],
    "data_types_collected": [
      "Neural data (EEG, MEG, fMRI, ECoG, single-unit recordings)",
      "Behavioral data (video, motion capture, eye tracking, gait)",
      "Physiological data",
      "Cognitive performance data",
      "Environmental data",
      "Self-report data",
      "Wearable sensor data"
    ],
    "data_types_other": "App interaction data",
    "use_sensors": [
      "Electroencephalography (EEG)",
      "Electrocorticography (ECoG)"
    ],
    "behavioral_recording_tech": [
      "Video Recording",
      "Wearable Sensors",
      "GPS Tracking",
      "Electromyography (EMG)",
      "Smart Devices and Mobile Apps",
      "Computerized Cognitive Testing Systems (for humans)",
      "Structured behavior from controlled behavioral tasks"
    ],
    "behavioral_brands": "Wearable sensors: Garmin. GPS tracking: Android. Video recording and EMG and the rest are custom code using our \"Thalamus\" sync toolbox.",
    "hand_coding_method": "we have gui tools that log responses from human validation",
    "behaviors_of_interest": [
      "Locomotion and Movement",
      "Vocalizations and Speech",
      "Emotional and Stress Responses",
      "Sleep and Rest",
      "Physical Activity Levels",
      "Pain and Discomfort Indicators",
      "Other"
    ],
    "behaviors_details": "Symptom provocations and assessments",
    "brain_initiative_standards": [
      "NWB",
      "BIDS"
    ],
    "standards_conversion_tools": [
      "NWB GUIDE",
      "NeuroConv"
    ],
    "standards_lifecycle_stages": [
      "For publication only. We convert data to standard formats for publication purposes to share the data in compliance with NIH policies."
    ],
    "neural_data_formats": [
      "HDF5",
      ".npy (Numpy)"
    ],
    "behavioral_data_formats": [
      "HDF5"
    ],
    "formats_usage_description": "I dont know how to respond.",
    "ontologies_used": [
      "Human Connectome Project (HCP) Atlas",
      "HED (Hierarchical Event Descriptors)"
    ],
    "ontologies_usage": "To describe or annotate neural data, To describe or annotate behavior",
    "data_management_systems": [
      "Shared data storage",
      "Git / GitHub"
    ],
    "primary_storage": "Institutional cluster, Cloud storage",
    "uses_backups": true,
    "data_sync_methods": [
      "Timestamping",
      "Trigger Signals",
      "Event Markers",
      "Synchronization Software",
      "Hardware Synchronization"
    ],
    "neural_feature_detection": [
      "Statistical methods",
      "AI-based methods",
      "Domain-specific software - commercial",
      "Domain-specific software - open source"
    ],
    "behavioral_feature_detection": [
      "Manual feature annotation",
      "Statistical methods",
      "Eye-tracking methods",
      "Computer vision (pose estimation)",
      "Domain-specific software - open source"
    ],
    "analysis_languages": [
      "MATLAB",
      "Python",
      "Specialized neuroscience software - open source",
      "Custom-built tools"
    ],
    "use_analysis_method": [
      "Classical statistical methods",
      "Computational models (Markov chains)",
      "Time series analysis",
      "Unsupervised ML",
      "Supervised ML",
      "Deep learning"
    ],
    "use_analysis_types": [
      "Statistical analysis",
      "Signal processing (Fourier, wavelet)",
      "Dimensionality reduction (PCA, tSNE, UMAP)",
      "Dynamical systems modeling",
      "Time-frequency analysis",
      "Bayesian inference",
      "Network analysis (graph theory, connectomics)",
      "Encoding models",
      "Decoding models",
      "Correlation analysis",
      "Regression models"
    ],
    "analysis_software": [
      "Numpy",
      "Scipy",
      "PyTorch",
      "TensorFlow",
      "MATLAB Deep Learning Toolbox",
      "XGBoost"
    ],
    "analysis_platforms": [
      "Jupyter Notebook",
      "IDEs",
      "Command line terminal",
      "HPC systems",
      "Package managers and environments",
      "Containerized environments"
    ],
    "reliability_methods": [
      "Cross-validation/resampling",
      "Sensitivity analysis",
      "Peer review code within lab",
      "Benchmarking",
      "Replication",
      "Version control (Git)",
      "Documented pipelines"
    ],
    "data_archives_other": "Pennseive",
    "other_sharing_methods": [
      "Dropbox",
      "Git (GitHub or GitLab)",
      "Zenodo",
      "Figshare",
      "Institutional repositories",
      "Self-managed storage"
    ],
    "ember_earliest_date": "8/25/2027",
    "all_data_public_immediately": true,
    "reuse_data_origins": [
      "None — only self-generated",
      "Self previous experiments",
      "Project internal"
    ],
    "reuse_purposes": [
      "Replication of results",
      "Validation and verification"
    ],
    "reuse_sources": [
      "DANDI",
      "DABI",
      "Zenodo",
      "Open Science Framework",
      "NSRR"
    ],
    "resources_to_share": "Devices for charging and streaming from wearable and implanted electrodes.",
    "additional_info": "Device development is a major part of our effort and involves other data types",
    "neural_data_size_per_year": "<1TB",
    "behavioral_data_size_per_year": "5TB",
    "single_unit_upload_size": "100GB/participant"
  }$q$::jsonb,
       last_edited_by = 'pesaran@gmail.com'
 WHERE grant_number = 'U01MH144347';

SELECT public.set_source_class(NULL);

-- Verify ---------------------------------------------------------------------------------------
-- 1) The row says what the response said. Expect 41 metadata keys.
SELECT grant_number, study_human, study_species, metadata_completeness,
       (SELECT count(*) FROM jsonb_object_keys(metadata)) AS metadata_keys
  FROM public.projects WHERE grant_number = 'U01MH144347';

-- 2) Spot-check the values the KG's own facets are built from.
SELECT metadata -> 'use_sensors'                AS sensors,
       metadata -> 'behavioral_recording_tech'  AS behavioral_tech,
       metadata -> 'brain_initiative_standards' AS standards,
       metadata -> 'behaviors_of_interest'      AS behaviors
  FROM public.projects WHERE grant_number = 'U01MH144347';

-- 3) Every new claim is attributed to the respondent at G2, not "unknown" at G8. This is the check
--    that distinguishes a recorded answer from an anonymous write.
SELECT sc.grade, sc.label, fp.agent_label, fp.recorded_by, count(*) AS cells
  FROM public.field_provenance fp
  JOIN public.source_classes sc ON sc.code = fp.source_class
 WHERE fp.entity_table = 'projects'
   AND fp.entity_id = (SELECT id FROM public.projects WHERE grant_number = 'U01MH144347')
   AND fp.recorded_at > now() - interval '10 minutes'
 GROUP BY 1, 2, 3, 4 ORDER BY cells DESC;

-- 4) Nothing else moved: the roster for this grant is untouched. Expect Pesaran as contact_pi and
--    Halpern, Scangos, Aflatouni, Vitale as co_pi -- the five the response itself names.
SELECT i.name, gi.role, gi.role_source
  FROM public.grant_investigators gi
  JOIN public.grants g        ON g.id = gi.grant_id
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE g.grant_number = 'U01MH144347'
 ORDER BY gi.role, i.name;

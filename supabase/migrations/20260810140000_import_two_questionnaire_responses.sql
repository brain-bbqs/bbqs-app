-- Import the two BBQS Data Questionnaire responses that were never ingested.
--
-- GROUND TRUTH (2026-08-10). The Forms API returns 21 responses for the questionnaire
-- (form 1oQ9R8uEt8IbgY3h5-mSZ821F2dbUQ7efXkeLN8tl-u4). All 21 carry respondentEmail: the form's
-- emailCollectionType is RESPONDER_INPUT, so Google records the address the respondent TYPES --
-- no Google account or sign-in required, and every domain here is institutional.
--
-- 19 of the 21 landed in projects.metadata by some earlier route. Two never did:
--   1R61MH138967 (ghumana@upmc.edu, 40 answers, submitted 2026-06-26) -- project metadata EMPTY
--   R34DA062119  (wilbrecht@berkeley.edu, 55 answers, submitted 2025-12-10) -- only 18 keys present
-- Both respondents are contact_pi on the grant they answered for, so these are properly
-- PI-attributed submissions, not third-party guesses.
--
-- The agent carries a mapper for this (bbqs-agent src/server/questionnaire/import.server.ts plus
-- field-map.ts) keyed by Forms questionId rather than question title, because the form reuses
-- identical titles across sections. It is DEAD CODE -- nothing in either repo calls it, so it has
-- never run. The payloads below were produced by applying that same QUESTION_MAP to the two live
-- responses, so this migration doubles as its first real-world verification: 38 keys mapped from
-- Ghuman's 40 answers and 51 from Wilbrecht's, leaving only the deliberately-unmapped grants
-- question and the EMBER duplicate.
--
-- FILL-ONLY-EMPTY is pre-applied: each payload already excludes every key holding a non-empty
-- value in the target project, so the merge below cannot clobber curated data. Wilbrecht's
-- response supplied 2 keys she already had; those are omitted.
--
-- Provenance (Principle X): each project also gets questionnaire_submitted_by /
-- questionnaire_submitted_at / questionnaire_response_id. That is the attribution this pipeline has
-- never had -- projects.metadata held 84 content keys and no record of who answered -- and it is
-- what lets the console check a submitter against the grant roster instead of asking the agent.
-- questionnaire_response_id is also the idempotency key for the sweep that will replace this
-- one-off: a response already recorded against a project is never re-imported.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).


-- 1R61MH138967 -- ghumana@upmc.edu, 41 keys written
UPDATE public.projects SET metadata = coalesce(metadata, '{}'::jsonb) || '{
  "planning_priorities": [
    "Which data modalities and recording devices to use?",
    "Which acquisition software and hardware to use to record multiple signals?",
    "How to synchronize data streams?",
    "How to manage the data generated?"
  ],
  "data_types_collected": [
    "Neural data (e.g., EEG, MEG, fMRI, ECoG, single-unit recordings)",
    "Behavioral data (e.g., video recordings, motion capture, eye tracking, gait analysis)",
    "Physiological data (e.g., heart rate, skin conductance, respiratory rate)",
    "Environmental data (e.g., ambient light, temperature, sound levels)",
    "Self-report data (e.g., questionnaires, diaries, surveys)",
    "Wearable sensor data (e.g., accelerometers, gyroscopes, smartwatches)"
  ],
  "use_sensors": [
    "Electrocorticography (ECoG)",
    "Intracranial Electrophysiology (single-unit recordings)"
  ],
  "behavioral_recording_tech": [
    "Video Recording",
    "Wearable Sensors"
  ],
  "behaviors_of_interest": [
    "Facial Expressions (for example: smiling, frowning, grimacing)",
    "Vocalizations and Speech (for example: talking, crying, barking, chirping)",
    "Feeding and Drinking (for example: eating patterns, drinking frequency, food preference)",
    "Sleep and Rest (for example: sleep duration, sleep cycles, napping behavior)",
    "Pain and Discomfort Indicators (for example: vocalizations, guarding behavior, self-mutilation)"
  ],
  "neural_data_size_per_year": "25 TB",
  "behavioral_data_size_per_year": "25 TB",
  "single_unit_upload_size": "1-2 TB/participant",
  "brain_initiative_standards": [
    "Neurodata Without Borders (NWB)"
  ],
  "standards_conversion_tools": [
    "NWB GUIDE"
  ],
  "standards_lifecycle_stages": [
    "From analysis. We convert data to standard formats after acquisition and pre-processing for analysis and publication."
  ],
  "neural_data_formats": [
    "XML"
  ],
  "ontologies_used": [
    "Human Connectome Project (HCP) Atlas (a detailed map of human brain connectivity)"
  ],
  "ontologies_usage": "To localize probes and cells in the brain (e.g., using CCF and brain atlases), To identify researchers (e.g., using ORCID)",
  "data_management_systems": [
    "Shared data storage. Data is stored in a shared location(s).",
    "Custom database"
  ],
  "primary_storage": "Local, shared storage (e.g., shared network storage for a lab), Cloud storage",
  "uses_backups": "Cloud Storage Services (online services for remote backup, such as Google Drive, Dropbox, OneDrive, and Amazon S3), RAID (Redundant Array of Independent Disks) (technology that combines multiple hard drives for redundancy and improved performance)",
  "data_sync_methods": [
    "Timestamping (embedding precise timestamps in data streams to align them temporally)",
    "Trigger Signals (using hardware or software triggers to mark events simultaneously across data streams)",
    "Network Time Protocol (NTP) (synchronizing clocks across devices using network time servers)"
  ],
  "neural_feature_detection": [
    "Manual feature identification",
    "Statistical methods (e.g., identify peaks, thresholds)",
    "AI-based methods (e.g., DNN, LLM,..)"
  ],
  "behavioral_feature_detection": [
    "Manual feature annotation",
    "Computer vision methods (e.g., pose estimation)"
  ],
  "feature_detection_software": [
    "OpenFace, OpenPose"
  ],
  "analysis_languages": [
    "MATLAB",
    "Python"
  ],
  "use_analysis_method": [
    "Classical statistical methods (e.g., t-tests, ANOVA)",
    "Computational models (e.g., Markov chains)",
    "Time series analysis",
    "Unsupervised machine learning (e.g., clustering, PCA)",
    "Supervised machine learning (e.g., classification, regression)",
    "Deep learning (e.g., neural networks, CNNs, RNNs)",
    "Reinforcement learning"
  ],
  "use_analysis_types": [
    "Statistical analysis (e.g., t-tests, ANOVA)",
    "Signal processing (e.g., Fourier transforms, wavelet analysis",
    "Dimensionality reduction (e.g., PCA, tSNE, UMAP)",
    "Dynamical systems modeling (e.g., state-space modeling, casual inference)",
    "Time-frequency analysis (e.g., spectrograms, coherence analysis)",
    "Bayesian inference",
    "Network analysis (e.g., graph theory, connectomics)",
    "Encoding models",
    "Decoding models",
    "Correlation analysis",
    "Regression models"
  ],
  "analysis_software": [
    "Numpy, Scipy (Python)",
    "Pytorch (Python)",
    "MATLAB Deep Learning Toolbox"
  ],
  "analysis_platforms": [
    "Jupyter Notebook",
    "JupyterLab"
  ],
  "reliability_methods": [
    "Cross-validation or resampling techniques (e.g., k-fold, bootstrapping)",
    "Sensitivity analysis",
    "Peer review code within the lab",
    "Replication of results using independent data or experiments",
    "Use of null models",
    "Version control systems (e.g., Git)"
  ],
  "data_archives": [
    "NDA (NIMH Data Archive)"
  ],
  "other_sharing_methods": [
    "OneDrive (Microsoft)",
    "Git (e.g., GitHub or GitLab)"
  ],
  "ember_earliest_date": "2026-10-01",
  "ember_data_nature": "It would be very useful to potentially use the EMBER archive for data sharing and for using the tools available.",
  "all_data_public_immediately": true,
  "restricted_access_scope": "The major caveat is that we do collect a good bit of PII",
  "persistent_identifiers": [
    "DOI (Digital Object Identifier)",
    "ORCID (Open Researcher and Contributor ID) (used to uniquely identify researchers and contributors)",
    "PMID/PMC (PubMed identifiers)"
  ],
  "reuse_data_origins": [
    "Self, e.g., previous experiments I have conducted."
  ],
  "reuse_purposes": [
    "Validation and verification to confirm the accuracy and consistency of my research findings, methodologies, and tools.",
    "Methodological development, for developing, testing, and refining new analytical methods, algorithms, or computational tools.",
    "Tool and model evaluation, assessing the performance and applicability of new models, simulations, or tools using existing datasets."
  ],
  "help_needed": "Data sharing, backup, and storage",
  "resources_to_share": "Software",
  "questionnaire_submitted_by": "ghumana@upmc.edu",
  "questionnaire_submitted_at": "2026-06-26T15:32:46.689563Z",
  "questionnaire_response_id": "ACYDBNj65nZpFLXv4UibDMt0NlIaMvRYPLBtOF_dyE88ZnokeK9YhMTu3zf86KsXQ_xuqpg"
}'::jsonb
 WHERE id = '2d7edb33-077a-4502-b44e-937a0e6e66cb';


-- R34DA062119 -- wilbrecht@berkeley.edu, 54 keys written
UPDATE public.projects SET metadata = coalesce(metadata, '{}'::jsonb) || '{
  "planning_priorities": [
    "Define the behavior to measure?",
    "Define the behavioral tasks the subject should perform?",
    "How to synchronize data streams?",
    "How to manage the data generated?",
    "How to share and publish the data generated?"
  ],
  "planning_priorities_other": "sharing/ analysis aids to more novice users",
  "data_types_collected": [
    "Behavioral data (e.g., video recordings, motion capture, eye tracking, gait analysis)",
    "Physiological data (e.g., heart rate, skin conductance, respiratory rate)",
    "Cognitive performance data (e.g., reaction times, accuracy, task performance metrics)"
  ],
  "behavioral_recording_tech": [
    "Video Recording",
    "Structured behavior from controlled behavioral tasks",
    "Other"
  ],
  "behavioral_brands": "med associates, corebody temperature",
  "hand_coding_method": "yes with undergrads and paper",
  "behaviors_of_interest": [
    "Cognitive and Memory Tasks (for example: problem-solving, decision-making, memory recall)",
    "Feeding and Drinking (for example: eating patterns, drinking frequency, food preference)",
    "Exploratory Behavior (for example: novel object interaction, maze navigation, environmental exploration)",
    "Emotional and Stress Responses (for example: anxiety-related behaviors, fear responses, stress-induced behaviors)",
    "Operant Conditioning and Learning (for example: lever pressing, maze learning, reward-based tasks)"
  ],
  "behaviors_details": "age x treatment effects are of interest; hormone levels may factor in",
  "neural_data_size_per_year": "unsure",
  "behavioral_data_size_per_year": "unsure",
  "single_unit_upload_size": "unsure",
  "brain_initiative_standards": [
    "Neurodata Without Borders (NWB)"
  ],
  "standards_other": "project will work to bring new coordinated standards to a larger team",
  "standards_lifecycle_stages": [
    "We currently do not use BRAIN Initiative data standards."
  ],
  "standards_usage_description": "varies by team will work to coordinate",
  "metadata_gaps": "varies by team will work to coordinate",
  "behavioral_data_formats": [
    "CSV",
    "Excel",
    ".npy (Numpy)"
  ],
  "formats_usage_description": "varies by team will work to coordinate",
  "ontologies_usage": "To identify subject metadata (e.g., species), To describe or annotate behavior",
  "ontologies_usage_details": "treatments",
  "data_management_systems": [
    "Individuals store and manage their own data",
    "Users maintain shared spreadsheets (e.g,. Excel or GoogleSheet).",
    "Custom database",
    "Git / GitHub (or other version control software and hosting service)"
  ],
  "data_management_other": "varies by team will work to coordinate",
  "primary_storage": "Local, shared storage (e.g., shared network storage for a lab), Community Archive (e.g., NDA, SRA, DANDI, DABI, BIL, NeMO, OpenNeuro, NEMAR, BossDB, etc.)",
  "primary_storage_details": "varies by team will work to coordinate",
  "uses_backups": "Cloud Storage Services (online services for remote backup, such as Google Drive, Dropbox, OneDrive, and Amazon S3), Tape Backup (magnetic tape storage for long-term data archiving and backup)",
  "behavioral_feature_detection": [
    "Manual feature annotation",
    "Computer vision methods (e.g., pose estimation)",
    "Domain-specific software - commercial (e.g., Tobii Pro)",
    "Domain-specific software - open source (e.g., BORIS, DeepLabCut)"
  ],
  "behavioral_feature_detection_other": "varies by team will work to coordinate",
  "feature_detection_software": [
    "varies by team will work to coordinate"
  ],
  "analysis_languages": [
    "MATLAB",
    "Python",
    "R",
    "Excel/Spreadsheet tools",
    "Custom-built tools (e.g., proprietary scripts, lab-specific software)"
  ],
  "analysis_languages_other": "varies by team will work to coordinate",
  "analysis_types_other": "varies by team will work to coordinate",
  "analysis_platforms": [
    "Jupyter Notebook"
  ],
  "analysis_platforms_other": "varies by team will work to coordinate",
  "reliability_methods": [
    "Cross-validation or resampling techniques (e.g., k-fold, bootstrapping)",
    "Peer review code within the lab",
    "Benchmarking against published methods or datasets",
    "Use of null models"
  ],
  "reliability_methods_other": "varies by team will work to coordinate",
  "data_archives": [
    "DANDI (cellular neurophysiology)"
  ],
  "data_archives_other": "varies by team will work to coordinate",
  "other_sharing_methods": [
    "Google Drive",
    "Dropbox",
    "OneDrive (Microsoft)",
    "Box",
    "Amazon Web Services (AWS) S3",
    "Git (e.g., GitHub or GitLab)",
    "Self-managed storage (e.g., lab- or project-specific storage)"
  ],
  "other_sharing_details": "varies by team will work to coordinate",
  "ember_earliest_date": "2026-02-18",
  "ember_data_nature": "varies by team will work to coordinate",
  "all_data_public_immediately": false,
  "restricted_access_scope": "until publication for behavior metrics. video may be too sensitive",
  "persistent_identifiers": [
    "DOI (Digital Object Identifier)",
    "PMID/PMC (PubMed identifiers)"
  ],
  "persistent_identifiers_usage": "varies by team will work to coordinate",
  "reuse_data_origins": [
    "Self, e.g., previous experiments I have conducted.",
    "Project internal, e.g., data other members in the team are generating."
  ],
  "reuse_purposes": [
    "Replication of results to verify the findings of previous studies or analyses",
    "Validation and verification to confirm the accuracy and consistency of my research findings, methodologies, and tools.",
    "Meta-analyses and systematic reviews, combining data from multiple studies to draw more comprehensive conclusions and improve statistical power.",
    "Longitudinal studies, using historical data to track changes over time and identify long-term trends.",
    "Secondary analysis, exploring new research questions or hypotheses that were not the focus of the original study.",
    "Educational purposes, providing real-world data for training, education, and skill development in academic settings."
  ],
  "reuse_challenges": "changing protocols, missing metadata",
  "help_needed": "planning for future datastreams; later integration of ephys with behavior",
  "resources_to_share": "protocols; analyses tools",
  "additional_info": "We want to build guradrails on our tools so that people in the community working with undergrads can use them with little prior knowledge; we are working with Metacell and OSB to build a custom platform to design/make these guard rails for community use",
  "questionnaire_submitted_by": "wilbrecht@berkeley.edu",
  "questionnaire_submitted_at": "2025-12-10T20:32:33.041178Z",
  "questionnaire_response_id": "ACYDBNjGhW4s2mcljD6OAeeraUUSfBNHKBI7eFR6VG6kQtdAH6WL98m50wB7XKo_zcquMCw"
}'::jsonb
 WHERE id = '4cef0591-42b0-46bc-9386-8e333a47ec31';


-- Verify: both rows should report the new key count and a non-null submitter.
SELECT g.grant_number,
       (SELECT count(*) FROM jsonb_object_keys(p.metadata)) AS metadata_keys,
       p.metadata->>'questionnaire_submitted_by' AS submitted_by,
       p.metadata->>'questionnaire_submitted_at' AS submitted_at
  FROM public.grants g JOIN public.projects p ON p.grant_id = g.id
 WHERE g.grant_number IN ('1R61MH138967', 'R34DA062119');

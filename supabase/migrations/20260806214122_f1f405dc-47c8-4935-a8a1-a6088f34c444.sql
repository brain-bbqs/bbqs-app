CREATE TABLE public.device_class_crosswalk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_key text NOT NULL,
  category_key text NOT NULL REFERENCES public.device_categories(key) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legacy_key, category_key)
);

GRANT SELECT ON public.device_class_crosswalk TO anon;
GRANT SELECT ON public.device_class_crosswalk TO authenticated;
GRANT ALL ON public.device_class_crosswalk TO service_role;

ALTER TABLE public.device_class_crosswalk ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Device crosswalk is viewable by everyone"
  ON public.device_class_crosswalk FOR SELECT USING (true);

CREATE POLICY "Curators manage device crosswalk"
  ON public.device_class_crosswalk FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid()))
  WITH CHECK (public.is_curator_or_admin(auth.uid()));

CREATE TRIGGER trg_device_class_crosswalk_updated
  BEFORE UPDATE ON public.device_class_crosswalk
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.device_class_crosswalk (legacy_key, category_key) VALUES
  ('video_tracking', 'video_camera'),
  ('video_tracking', 'motion_capture'),
  ('wearable_actigraphy', 'wearable_multimodal'),
  ('wearable_actigraphy', 'imu'),
  ('ephys_headstage', 'wireless_ephys'),
  ('ephys_headstage', 'ephys_probe'),
  ('audio_recording', 'microphone'),
  ('stimulation', 'neurostimulation'),
  ('fMRI', 'neural_imaging'),
  ('neuroimaging', 'neural_imaging'),
  ('two_photon_imaging', 'neural_imaging'),
  ('eye_tracking', 'eye_tracker'),
  ('lidar', 'lidar_radar'),
  ('thermal', 'thermal_camera'),
  ('gps_tracking', 'gps')
ON CONFLICT DO NOTHING;

CREATE VIEW public.project_device_usage
WITH (security_invoker = true) AS
WITH ev AS (
  SELECT e.seed_grant_number AS grant_number,
         unnest(e.device_class) AS legacy_key
  FROM public.grant_methods_evidence e
  WHERE e.device_class IS NOT NULL
)
SELECT ev.grant_number,
       g.title AS grant_title,
       p.id AS project_id,
       c.key AS category_key,
       c.label AS category_label,
       c.measures,
       array_agg(DISTINCT ev.legacy_key) AS evidence_terms,
       count(*)::int AS evidence_count,
       (SELECT count(*)::int FROM public.device_models m WHERE m.device_class = c.key) AS catalog_models
FROM ev
JOIN public.device_class_crosswalk x ON x.legacy_key = ev.legacy_key
JOIN public.device_categories c ON c.key = x.category_key
LEFT JOIN public.grants g ON g.grant_number = ev.grant_number
LEFT JOIN public.projects p ON p.grant_number = ev.grant_number
GROUP BY ev.grant_number, g.title, p.id, c.key, c.label, c.measures;

GRANT SELECT ON public.project_device_usage TO anon, authenticated, service_role;
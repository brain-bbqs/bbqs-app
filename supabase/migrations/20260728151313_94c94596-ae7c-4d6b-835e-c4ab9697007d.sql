-- 1. device_categories
CREATE TABLE public.device_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  measures text[] NOT NULL DEFAULT '{}',
  typical_use_cases text[] NOT NULL DEFAULT '{}',
  schema_org_type text,
  resource_id uuid REFERENCES public.resources(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.device_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_categories TO authenticated;
GRANT ALL ON public.device_categories TO service_role;
ALTER TABLE public.device_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_categories public read" ON public.device_categories FOR SELECT USING (true);
CREATE POLICY "device_categories admin write" ON public.device_categories FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid())) WITH CHECK (public.is_curator_or_admin(auth.uid()));
CREATE TRIGGER trg_device_categories_updated BEFORE UPDATE ON public.device_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. device_category_parameters
CREATE TABLE public.device_category_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL REFERENCES public.device_categories(key) ON DELETE CASCADE ON UPDATE CASCADE,
  name text NOT NULL,
  symbol text,
  unit text,
  typical_range text,
  window_spec text,
  standard_ref text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_key, name)
);
GRANT SELECT ON public.device_category_parameters TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_category_parameters TO authenticated;
GRANT ALL ON public.device_category_parameters TO service_role;
ALTER TABLE public.device_category_parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_params public read" ON public.device_category_parameters FOR SELECT USING (true);
CREATE POLICY "device_params admin write" ON public.device_category_parameters FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid())) WITH CHECK (public.is_curator_or_admin(auth.uid()));
CREATE TRIGGER trg_device_params_updated BEFORE UPDATE ON public.device_category_parameters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. device_category_ml_specs
CREATE TABLE public.device_category_ml_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL REFERENCES public.device_categories(key) ON DELETE CASCADE ON UPDATE CASCADE,
  task text NOT NULL,
  input_signal text,
  sampling_rate_hz numeric,
  preprocessing text[] NOT NULL DEFAULT '{}',
  feature_set text[] NOT NULL DEFAULT '{}',
  common_models text[] NOT NULL DEFAULT '{}',
  label_source text,
  dataset_examples text[] NOT NULL DEFAULT '{}',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_key, task, input_signal)
);
GRANT SELECT ON public.device_category_ml_specs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_category_ml_specs TO authenticated;
GRANT ALL ON public.device_category_ml_specs TO service_role;
ALTER TABLE public.device_category_ml_specs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_ml public read" ON public.device_category_ml_specs FOR SELECT USING (true);
CREATE POLICY "device_ml admin write" ON public.device_category_ml_specs FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid())) WITH CHECK (public.is_curator_or_admin(auth.uid()));
CREATE TRIGGER trg_device_ml_updated BEFORE UPDATE ON public.device_category_ml_specs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. device_category_pitfalls
CREATE TABLE public.device_category_pitfalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL REFERENCES public.device_categories(key) ON DELETE CASCADE ON UPDATE CASCADE,
  issue text NOT NULL,
  mitigation text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_key, issue)
);
GRANT SELECT ON public.device_category_pitfalls TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_category_pitfalls TO authenticated;
GRANT ALL ON public.device_category_pitfalls TO service_role;
ALTER TABLE public.device_category_pitfalls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_pitfalls public read" ON public.device_category_pitfalls FOR SELECT USING (true);
CREATE POLICY "device_pitfalls admin write" ON public.device_category_pitfalls FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid())) WITH CHECK (public.is_curator_or_admin(auth.uid()));
CREATE TRIGGER trg_device_pitfalls_updated BEFORE UPDATE ON public.device_category_pitfalls
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. device_category_references
CREATE TABLE public.device_category_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL REFERENCES public.device_categories(key) ON DELETE CASCADE ON UPDATE CASCADE,
  kind text NOT NULL CHECK (kind IN ('paper','standard','manual','dataset')),
  title text NOT NULL,
  url text,
  doi text,
  year integer,
  authority text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_key, kind, title)
);
GRANT SELECT ON public.device_category_references TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_category_references TO authenticated;
GRANT ALL ON public.device_category_references TO service_role;
ALTER TABLE public.device_category_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_refs public read" ON public.device_category_references FOR SELECT USING (true);
CREATE POLICY "device_refs admin write" ON public.device_category_references FOR ALL TO authenticated
  USING (public.is_curator_or_admin(auth.uid())) WITH CHECK (public.is_curator_or_admin(auth.uid()));
CREATE TRIGGER trg_device_refs_updated BEFORE UPDATE ON public.device_category_references
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Extend device_models
ALTER TABLE public.device_models
  ADD COLUMN IF NOT EXISTS sampling_rate_hz numeric,
  ADD COLUMN IF NOT EXISTS output_signals text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sdk_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS firmware_notes text,
  ADD COLUMN IF NOT EXISTS regulatory_class text,
  ADD COLUMN IF NOT EXISTS price_tier text;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_dcp_category ON public.device_category_parameters(category_key);
CREATE INDEX IF NOT EXISTS idx_dcm_category ON public.device_category_ml_specs(category_key);
CREATE INDEX IF NOT EXISTS idx_dcpit_category ON public.device_category_pitfalls(category_key);
CREATE INDEX IF NOT EXISTS idx_dcr_category ON public.device_category_references(category_key);
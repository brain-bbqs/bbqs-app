CREATE TABLE public.user_dashboard_layouts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_dashboard_layouts TO authenticated;
GRANT ALL ON public.user_dashboard_layouts TO service_role;

ALTER TABLE public.user_dashboard_layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own dashboard layout"
  ON public.user_dashboard_layouts FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_user_dashboard_layouts_updated_at
  BEFORE UPDATE ON public.user_dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.working_group_dashboard_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  working_group text NOT NULL UNIQUE,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.working_group_dashboard_defaults TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.working_group_dashboard_defaults TO authenticated;
GRANT ALL ON public.working_group_dashboard_defaults TO service_role;

ALTER TABLE public.working_group_dashboard_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read working group defaults"
  ON public.working_group_dashboard_defaults FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins manage working group defaults"
  ON public.working_group_dashboard_defaults FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_wg_dashboard_defaults_updated_at
  BEFORE UPDATE ON public.working_group_dashboard_defaults
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
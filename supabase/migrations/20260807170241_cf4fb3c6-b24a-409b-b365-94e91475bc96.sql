ALTER TABLE public.user_dashboard_layouts
  ADD COLUMN IF NOT EXISTS working_groups text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
ALTER TABLE public.feature_suggestions
  ADD COLUMN IF NOT EXISTS github_username text,
  ADD COLUMN IF NOT EXISTS qa_status text NOT NULL DEFAULT 'submitted',
  ADD COLUMN IF NOT EXISTS target_version text;

CREATE OR REPLACE VIEW public.feature_suggestions_public AS
SELECT id,
    title,
    description,
    github_issue_number,
    github_issue_url,
    status,
    votes,
    created_at,
    updated_at,
    github_username,
    qa_status,
    target_version
FROM public.feature_suggestions;

DROP POLICY IF EXISTS "Curators can update suggestion tracking" ON public.feature_suggestions;
CREATE POLICY "Curators can update suggestion tracking"
ON public.feature_suggestions
FOR UPDATE
TO authenticated
USING (public.is_curator_or_admin(auth.uid()))
WITH CHECK (public.is_curator_or_admin(auth.uid()));
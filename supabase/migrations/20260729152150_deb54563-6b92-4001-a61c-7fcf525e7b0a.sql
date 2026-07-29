CREATE TABLE public.news_candidates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source text NOT NULL,
  source_url text,
  title text NOT NULL,
  url text NOT NULL UNIQUE,
  summary text,
  author text,
  published_at timestamp with time zone,
  matched_keywords text[] NOT NULL DEFAULT '{}',
  score integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  announcement_id uuid REFERENCES public.announcements(id) ON DELETE SET NULL,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_notes text,
  raw jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.news_candidates TO authenticated;
GRANT ALL ON public.news_candidates TO service_role;

ALTER TABLE public.news_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and curators can view news candidates"
  ON public.news_candidates FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

CREATE POLICY "Admins and curators can update news candidates"
  ON public.news_candidates FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

CREATE POLICY "Admins can delete news candidates"
  ON public.news_candidates FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_news_candidates_updated_at
  BEFORE UPDATE ON public.news_candidates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_news_candidates_status ON public.news_candidates(status, published_at DESC);
CREATE INDEX idx_news_candidates_created ON public.news_candidates(created_at DESC);
-- Project -> SoftwareTool links, so the graph can say which tools a project uses (#475: SoftwareTool was
-- isolated). Only EVIDENCED links: each row below is a tool a PI named in their questionnaire answer.
-- Not included: 10 rows whose only evidence is the generic questionnaire option "(e.g., BORIS,
-- DeepLabCut)" -- ticking a category does not show a lab uses that tool -- and U01DA063581 / SLEAP,
-- whose evidence did not name SLEAP in the visible text (a co-PI leads SLEAP; that is not evidence).
SELECT public.set_actor('migration:project_software_tools');
SELECT public.set_source_class('curator_fill');

CREATE TABLE IF NOT EXISTS public.project_software_tools (
  project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  software_tool_id uuid NOT NULL REFERENCES public.software_tools(id) ON DELETE CASCADE,
  relation         text NOT NULL DEFAULT 'uses' CHECK (relation IN ('uses','develops')),
  PRIMARY KEY (project_id, software_tool_id)
);
COMMENT ON TABLE public.project_software_tools IS
  'Software a project uses (or develops), from the PI''s own questionnaire answer or a curator. A ticked category is not evidence.';
ALTER TABLE public.project_software_tools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone may read project software tools" ON public.project_software_tools;
CREATE POLICY "anyone may read project software tools" ON public.project_software_tools FOR SELECT USING (true);
GRANT SELECT ON public.project_software_tools TO anon, authenticated;

INSERT INTO public.project_software_tools (project_id, software_tool_id, relation)
SELECT p.id, t.id, 'uses'
FROM (VALUES
  ('54515994-4559-4322-b8f7-1129e9ab979f','bf13ec22-8e45-45e7-ae9a-b6f04dcbebad'),  -- R34DA059513: Bonsai
  ('f4fbcd97-9228-4e89-a1a6-8f471a366c8d','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA059507: DeepLabCut
  ('e9c178d3-9531-4f5e-adad-70a17f99fe5f','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA059510: DeepLabCut
  ('54515994-4559-4322-b8f7-1129e9ab979f','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA059513: DeepLabCut
  ('21a8f46a-872d-43f4-b4da-ec8b422e3624','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA059723: DeepLabCut
  ('9bbbffed-6ae4-41ab-94f8-630f1ffc1757','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA061924: DeepLabCut
  ('18677882-785c-462b-ad94-10870dd55ee6','9d09a355-d657-4351-95e8-a7853788ff89'),  -- R34DA061925: DeepLabCut
  ('ed5ca8aa-2c24-486d-9de2-168e262ddcc4','9d09a355-d657-4351-95e8-a7853788ff89'),  -- U01DA063534: DeepLabCut
  ('97c8c83a-6ed1-478e-a0b1-92701ab768b3','ee338c2e-d22a-4a97-a801-f622a04d2910'),  -- R34DA059716: LabStreamingLayer
  ('b08b4fea-ef1f-477d-b796-eda6add1b03d','ee338c2e-d22a-4a97-a801-f622a04d2910'),  -- R61MH138713: LabStreamingLayer
  ('54515994-4559-4322-b8f7-1129e9ab979f','8abe8f28-d943-44c4-a529-2045f657563f'),  -- R34DA059513: MoSeq
  ('f4fbcd97-9228-4e89-a1a6-8f471a366c8d','27c41a8f-88b6-45ad-b80c-7b3d66bcace9'),  -- R34DA059507: Open Ephys
  ('97c8c83a-6ed1-478e-a0b1-92701ab768b3','ff5b71d1-f007-4bb6-a090-095efbfcbfd0'),  -- R34DA059716: OpenFace
  ('2d7edb33-077a-4502-b44e-937a0e6e66cb','ff5b71d1-f007-4bb6-a090-095efbfcbfd0'),  -- R61MH138967: OpenFace
  ('2d7edb33-077a-4502-b44e-937a0e6e66cb','d54a6c70-34bc-409d-9740-fc78797129d2'),  -- R61MH138967: OpenPose
  ('f4fbcd97-9228-4e89-a1a6-8f471a366c8d','2af8739b-6276-4d1c-bf7d-fc914e6e8982'),  -- R34DA059507: SLEAP
  ('54515994-4559-4322-b8f7-1129e9ab979f','2af8739b-6276-4d1c-bf7d-fc914e6e8982'),  -- R34DA059513: SLEAP
  ('a8367943-1daf-4789-8f9d-41e596ea5f3e','2af8739b-6276-4d1c-bf7d-fc914e6e8982'),  -- R34DA059718: SLEAP
  ('59e21672-0c68-4ec3-b490-19b1f56f1ddf','2af8739b-6276-4d1c-bf7d-fc914e6e8982'),  -- U01DA063565: SLEAP
  ('e9c178d3-9531-4f5e-adad-70a17f99fe5f','25db1dfc-45d4-453e-a8cf-2ebb7c21d529'),  -- R34DA059510: Anipose (PI wrote "Annopose")
  ('37656418-3114-4892-8fb9-7955397d4605','ee338c2e-d22a-4a97-a801-f622a04d2910')   -- R61MH135106: LabStreamingLayer (PI wrote "Synchronization Software (LSL)")
) AS v(project_id, software_tool_id)
JOIN public.projects p ON p.id = v.project_id::uuid
JOIN public.software_tools t ON t.id = v.software_tool_id::uuid
ON CONFLICT DO NOTHING;

-- Verify: expect 21 links across the projects named above.
SELECT t.name AS tool, count(*) AS projects
FROM public.project_software_tools pst JOIN public.software_tools t ON t.id = pst.software_tool_id
GROUP BY t.name ORDER BY projects DESC, t.name;

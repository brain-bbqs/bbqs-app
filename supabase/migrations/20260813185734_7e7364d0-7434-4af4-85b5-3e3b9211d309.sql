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
    target_version,
    submitter_name
FROM public.feature_suggestions;
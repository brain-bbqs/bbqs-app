# Full sandbox frontend replica

## Outcome
The sandbox repository will visibly contain the complete application source while GitHub Pages continues serving the compiled frontend correctly.

## Changes
1. Update Sandbox QA to mirror the checked-out production frontend repository into the sandbox repository's `main` branch.
2. Keep the Vite `dist` output on `gh-pages`, because GitHub Pages serves compiled HTML/CSS/JavaScript rather than React/TypeScript source.
3. Preserve the sandbox-only Supabase build variables and `sandbox.brain-bbqs.org` CNAME so the replica cannot target production services or claim the production domain.
4. Strengthen deployment verification so publishing fails unless generated asset URLs use `/assets/` and the expected bundle files exist.

## Resulting sandbox repository
- `main`: complete source replica, configuration, public assets, and migrations.
- `gh-pages`: compiled static site (`index.html`, `assets/`, SPA fallback, CNAME) used by GitHub Pages.

## Validation
Run the workflow with deployment enabled, then verify the sandbox root HTML, referenced JavaScript/CSS responses, and rendered page at `sandbox.brain-bbqs.org`.

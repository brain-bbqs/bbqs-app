# Full sandbox clone: source + working site

## What is happening now
The sandbox repository looks empty because you are viewing the `gh-pages` branch, which only ever holds the **compiled** site (`index.html`, `assets/`, `404.html`, `CNAME`). That is normal: browsers cannot run React/TypeScript source, only the built bundles.

The genuine bug is separate — the published `index.html` still requests `/bbqs-website-sandbox/assets/...` while the bundles actually live at `/assets/...`, so every script and stylesheet returns 404 and the page renders blank.

## What will change

1. **Mirror the full source into the sandbox repository.** The workflow already checks this repository out onto the runner. That same source tree (`src/`, `public/`, `supabase/`, configuration, workflows) will be pushed to the sandbox repository's `main` branch, so the sandbox repo becomes a complete clone of the application, not just a build output.
2. **Keep the compiled site on `gh-pages`.** GitHub Pages continues serving the built output from that branch.
3. **Fix the blank page.** Republish with the root base path so `index.html` points at `/assets/...`, and remove the stale build currently on `gh-pages`.
4. **Keep the sandbox isolated.** The mirrored build stays pointed at the sandbox Supabase project and the `sandbox.brain-bbqs.org` domain, never production.
5. **Harden the guard.** Publishing fails if the generated HTML references any asset path other than `/assets/`, or if a referenced bundle is missing from the output.

## Result

- Sandbox repo `main` — full application clone (all frontend source, assets, migrations, config).
- Sandbox repo `gh-pages` — the compiled site actually served at `sandbox.brain-bbqs.org`.

## Validation
Run Sandbox QA with deploy enabled, then confirm the live root HTML references `/assets/...`, that those files return 200, and that the app renders.

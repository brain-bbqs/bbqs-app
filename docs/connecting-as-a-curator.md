# Working with Claude as a BBQS curator

This is for curators and admins who want Claude to help with consortium work — onboarding,
offboarding, roster and identity questions, funding announcements — through the **bbqs-mcp** server.

## The one rule that matters: use an MCP-only client

**Connect the bbqs-mcp server to a client that has _only_ the connector — claude.ai or Claude
Desktop. Do NOT use Claude Code running in the `bbqs-app` repo as your curator client.**

Here is why, and it is not a style preference. Claude Code is a *coding agent*: it comes with a
shell, file read/write, and web fetch, and it runs inside the repository with access to `.env` and
everything else on disk. The MCP server is just one more set of tools added on top — **it is not a
boundary.** So in a repo session, when you ask for something the MCP doesn't have a tool for, the
agent falls back to the shell and the filesystem instead of staying inside the controlled surface.

That is not hypothetical. Asked to "add this to funding announcements", a repo Claude Code session
ran `ls .env*`, read the project's `.env` looking for a database key, and wrote a raw SQL file — none
of it through bbqs-mcp. It behaved like a developer, because that is what a repo session is.

An MCP-only client has no shell, no filesystem, no `.env`. There, the same request either maps to an
MCP tool or the agent tells you it doesn't have one — it *cannot* break out, because there is nothing
to break out to. That is the whole point of the server: a scoped, authenticated, attributed surface.
It only delivers that if the client can't reach around it.

Rule of thumb: **the repo Claude Code session is the developer's workbench. Your curator client is a
separate, MCP-only client.**

## Connect

**Server URL** — this is the endpoint, note the `/mcp` suffix:

```
https://vpexxhfpvghlejljwpvt.supabase.co/functions/v1/bbqs-mcp/mcp
```

**claude.ai (recommended — nothing local at all):**
1. Settings → Connectors → **Add custom connector**.
2. Paste the URL above. Save.
3. The connector prompts you to authenticate: a browser window opens, you sign in with your
   institutional login (**Globus**), and land on the BBQS consent screen. Approve.
4. bbqs tools are now available in your chats.

**Claude Desktop:** Settings → Connectors → add the same URL, authenticate the same way. Only add the
bbqs connector — don't pair it with a filesystem or shell MCP server, or you reintroduce the reach-
around.

Either way the authorization is **per-you**: the token carries your identity, everything you do is
attributed to your account in the audit log, and you get exactly your own level of access — a
curator's tools if you're a curator, a member's if you're a member.

## What you can do

- **Anyone (no sign-in):** search projects, list species, ask questions, list funding opportunities.
- **Signed-in member:** view your onboarding status, edit your own profile, request working groups.
- **Curator/admin:** onboard and offboard members, sync Google Groups, run a group audit, send
  welcome emails, add funding opportunities, and (admins) resolve any account with `whois`.

Ask in plain language — "onboard Jane Doe as a co-PI on R01...", "who joined recently", "add this
NSF solicitation to funding announcements", "audit the Google Groups". The client picks the tool.

## What it deliberately will not do

- **Write to the database in ways it has no tool for.** If you ask for something outside the tool
  set, an MCP-only client says so rather than improvising — that's the safety, not a limitation.
- **Act with more than your own access.** The server holds no service-role key. It acts as you, so
  RLS and every permission check apply exactly as they would on the website.
- **Skip the outward-facing confirmations.** Welcome emails, Google Group changes and Slack invites
  reach real people; the tools are built to be run deliberately, one step at a time.

If something you need isn't a tool yet, that's a request for a new capability on the server — tell a
maintainer — not a reason to reach for the shell.

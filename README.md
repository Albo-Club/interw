# Interw

Asynchronous video interviews for hiring teams.

A recruiter records their questions on camera, invites candidates by email,
and each candidate answers from their browser whenever suits them. Every
interview is transcribed and scored against the criteria the recruiter set —
with each claim linked to the second of video that backs it, because an
assertion nobody can check is an opinion.

Built on **TanStack Start + Convex + Better Auth + Resend + Tailwind v4**,
multi-tenant from the ground up.

### How it fits together

| Surface | Route | Who |
| --- | --- | --- |
| Recruiter app | `/app/{org}/…` | Signed-in members of an organisation |
| Candidate journey | `/s/{token}/…` | A token, never an account |
| Shared report | `/r/{shareToken}` | Whoever the recruiter sent the link to |

The candidate surface shares nothing with the recruiter app but the UI
primitives — enforced by ESLint, not by convention — so it stays small on a
stranger's phone, where they get one attempt.

## Getting started

**Prerequisites**

- **Node 20+** (LTS recommended)
- **pnpm** — enable it once via Corepack (bundled with Node): `corepack enable`
- **git**

**Before the first `pnpm setup`, read `TESTING.md` § Level 0.** Two of the
prerequisites there cannot be undone afterwards:

- **Create the Convex project in EU West (Ireland).** The region is fixed at
  creation; changing it means a new deployment and an export/import migration.
- **The object-storage bucket must be private.** Every recording is served
  through a signed URL minted after an access check, and a public bucket
  silently defeats all of it.

**1. Get the code**

```bash
git clone <your-repo-url> interw
cd interw
```

**2. Configure everything**

One interactive command. It installs dependencies (if needed), logs you into
Convex, provisions your backend, and collects your API keys:

```bash
pnpm run setup
```

> Use `pnpm run setup`, **not** `pnpm setup` — `setup` is a reserved pnpm
> built-in, so the bare form never reaches this project's script.
>
> The Convex step opens a browser to log you in and asks you to create a
> project (pick **cloud deployment**). It pushes your functions once and
> returns to the wizard automatically — no Ctrl-C needed.

It's idempotent — re-run any time, each step skips if already done.

**3. Start the app**

Run this in its own terminal — it stays in the foreground (Vite + Convex
together):

```bash
pnpm dev
```

Then open **http://localhost:3000** and create your first account. The first
user across the deployment becomes `superAdmin: true` automatically.

## Day 1 — GitHub repo settings

One setting keeps dependency updates alive — it can't ship inside the repo
itself: install the [Renovate GitHub App](https://github.com/apps/renovate)
on the repo (org install → select the repo). `renovate.json` does nothing
until the app is in. Done when your first PR has green CI and Renovate has
opened its onboarding PR.

Skills freshness needs nothing: the `skills-drift` job in `ci.yml` goes
red when upstream skills move — run `pnpm run sync:skills`, review, commit.

## Staying up to date with the starter

This project was scaffolded from the
[`albo-ouvre-boite`](https://github.com/Albo-Club/albo-ouvre-boite) starter.
To pull in non-conflicting upstream improvements later:

```bash
pnpm run upgrade-template            # merges the starter into HEAD (no auto-commit)
pnpm run upgrade-template -- --diff  # preview what would change first
```

The first run adds a `template` git remote pointing at the starter; subsequent
runs reuse it. If your repo was created via GitHub's "Use this template" (no
shared git history), the script grafts the ancestry automatically from
`.template-version` on first run. Review the merge, resolve conflicts, then
commit. Read the starter's `CHANGELOG.md` and [UPGRADING.md](UPGRADING.md)
between your version and the latest before merging.

## See also

- [TESTING.md](TESTING.md) — end-to-end test plan (auth, multi-tenant, AI…).
- [KNOWN_ISSUES.md](KNOWN_ISSUES.md) — pinned versions and why.
- [UPGRADING.md](UPGRADING.md) — pulling starter updates, per-version notes.
- [CLAUDE.md](CLAUDE.md) — guidelines for AI-assisted work in this repo.

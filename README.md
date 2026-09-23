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

## Deploying: staging and production

Two environments, each a complete and independent stack. Nothing is shared
between them but the code:

| | Branch | Vercel project | Convex project (its prod deployment) | Bucket |
| --- | --- | --- | --- | --- |
| **staging** | `main` | `interw-staging` | `interw-staging` | dev bucket |
| **production** | `production` | `interw` | `interw` | prod bucket |

A merged PR lands on `main` and deploys staging by itself. Releasing is
moving `production` up to `main`; rolling back is moving it back:

```bash
git fetch origin && git push origin origin/main:production   # release what staging runs
git push --force origin <good-sha>:production                # roll back
```

Each push to one of those branches runs `pnpm build`, which deploys the Convex
backend and builds the frontend in lockstep. Rolling back force-pushes
`production`, so that branch must stay force-pushable by maintainers. Why staging is a second pair of projects
rather than a branch of one: `KNOWN_ISSUES.md` § "A preview deployment is not
a staging environment" and the two sections after it.

The steps below are the same for both environments — run them once for
`interw-staging`, once for `interw`.

**1. Provision the Convex deployment**

Link the checkout to the right Convex project (`pnpm exec convex dev
--configure existing`), then:

```bash
pnpm run setup:prod
```

It mirrors your dev secrets onto that project's production deployment,
generates a fresh `BETTER_AUTH_SECRET` and `PURGE_HASH_SALT`, sets
`APP_ENV=production` — staging included, it is served over HTTPS — and sets
`SITE_URL` to the domain you give it. Use the domain you will actually serve:
Better Auth builds magic-link URLs from it and accepts no other origin. For
production, give it the **prod** bucket and a key pair scoped to that bucket
only; staging keeps the dev bucket.

**2. Configure the Vercel project**

The project is linked to this GitHub repository, framework preset *TanStack
Start*, function region `cdg1` (Paris). Under **Settings → Git**:

| Setting | `interw-staging` | `interw` |
| --- | --- | --- |
| Production branch | `main` | `production` |
| Ignored build step | `[ "$VERCEL_GIT_COMMIT_REF" != "main" ]` | `[ "$VERCEL_GIT_COMMIT_REF" != "production" ]` |

The ignored build step is what keeps pull requests from building. Don't turn
previews on without reading `KNOWN_ISSUES.md` § "Vercel previews must never
carry a deploy key".

**3. Set the environment variables** — scope *Production* only:

| Variable | Value |
| --- | --- |
| `DEPLOY_CONVEX` | `true` |
| `CONVEX_DEPLOY_KEY` | Convex dashboard → that project → Settings → URL & Deploy Key → **Generate Production Deploy Key** |
| `VITE_CONVEX_SITE_URL` | `https://<deployment>.convex.site` |
| `MEDIA_ORIGIN` | The bucket origin, e.g. `https://<bucket>.s3.fr-par.scw.cloud` |
| `VITE_SENTRY_DSN` | optional, front-end DSN |

Do **not** set `VITE_CONVEX_URL` by hand — `convex deploy` injects it into the
build. Do **not** set `CONVEX_DEPLOYMENT`; it is a per-developer dev binding.

Everything else — `RESEND_*`, `MISTRAL_API_KEY`, `OBJECT_STORE_*` — lives on
the **Convex** deployment, not here. `pnpm run setup:prod` put it there.

**4. Point the domain and deploy**

Add the domain under **Settings → Domains**, add it to the bucket's CORS
`AllowedOrigins` (TESTING.md P2a), then push the branch.

**5. Verify**

Run the Level 6 rows in [TESTING.md](TESTING.md), then send yourself a magic
link from the live domain — it must point at
`https://<your-domain>/api/auth/magic-link/verify`, not `localhost`. If you
use Google sign-in, register `https://<your-domain>/api/auth/callback/google`
for each environment on the OAuth client.

> **Sovereignty note.** Vercel is a US company; its functions run in `cdg1`
> (Paris). The web tier persists nothing — though it renders reports
> server-side, so candidate data does cross it in memory. Transcription and
> evaluation both run on Mistral; the evaluation model is Z.ai's GLM, whose
> weights are Chinese but whose inference runs on Mistral's infrastructure
> under its regional controls, so no interview leaves it. Candidate
> transcripts and evaluations are *stored* in Convex — a US company, EU
> region — which is the largest exposure. If sovereignty becomes the goal
> rather than the label, the order of work is the database first, the host
> second — the web tier moves without a code change (`KNOWN_ISSUES.md`
> § "Nitro picks its preset from the build host").

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

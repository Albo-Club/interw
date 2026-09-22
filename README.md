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

## Deploying to production

The web tier runs on [Vercel](https://vercel.com); Convex stays where you
created it (EU West / Ireland); object storage stays on Scaleway `fr-par`;
the models stay on Mistral. Nothing in the app is Vercel-specific beyond what
Nitro detects on its own: `vite.config.ts` is exactly the `tanstackStart()` +
`nitro()` setup Vercel documents, and off Vercel the same build emits a plain
Node server that `pnpm start` runs.

**Three environments, each on its own Convex deployment:**

| | Vercel | Convex deployment | `SITE_URL` | Bucket | Who pushes the backend |
| --- | --- | --- | --- | --- | --- |
| **Development** | none — `pnpm dev` | dev (your own) | `http://localhost:3000` | dev | `convex dev` |
| **Staging** | project `interw-staging`, production branch `staging` | the **production** deployment of a second Convex project | `https://interw-staging.vercel.app` | staging | the Vercel build, `DEPLOY_CONVEX=true` |
| **Production** | project `interw`, production branch `main` | the production deployment of the main Convex project | `https://interw.com` | `interw-video-prod` | the Vercel build, `DEPLOY_CONVEX=true` |

Staging is a *second* Convex project on purpose: a Convex preview deployment
is deleted after a few days, data included, and a production deploy key is
refused in a Vercel preview build. Both reasons, and why staging therefore
has its own Vercel project too, are in `KNOWN_ISSUES.md` § "A preview
deployment is not a staging environment" and the section after it.

Each deployment accepts sign-ins from **one** origin — its `SITE_URL`. Branch
previews (`interw-git-<branch>-….vercel.app`) build, but cannot sign in; see
`KNOWN_ISSUES.md` § "`trustedOrigins` holds one origin per deployment".

**1. Provision the Convex production deployments**

```bash
pnpm run setup:prod
```

It mirrors your dev secrets onto prod, asks for the prod bucket and its
credentials (never mirrored), generates a fresh `BETTER_AUTH_SECRET` and
`PURGE_HASH_SALT`, forces `RESEND_TEST_MODE=false`, and sets `SITE_URL` to
the domain you give it. Use the domain you will actually serve, not a
`*.vercel.app` placeholder — Better Auth builds magic-link URLs from it.

The script only reaches the production deployment of the project your dev
deployment belongs to. Staging is another Convex project: set the same
variables on its production deployment by hand, with its **own** freshly
generated `BETTER_AUTH_SECRET` and `PURGE_HASH_SALT`, its own bucket and
`RESEND_TEST_MODE=false` — `convex/email.ts` refuses to load otherwise on a
public `SITE_URL`.

**2. Create the two Vercel projects**

Import the repository twice — `interw` and `interw-staging` — with the
**TanStack Start** framework preset. On each:

- **Git → Production Branch**: `main` for `interw`, `staging` for
  `interw-staging`.
- **Build Command**: leave the preset default (it runs the `build` script)
  or set `pnpm build` explicitly. Do **not** replace it with a bare
  `vite build`: that drops the Convex deploy.
- **Functions → Region**: Paris (`cdg1`). The default region is in the US,
  and the server renders reports.
- **Node.js Version**: 22.x, the major CI runs.
- **Ignored Build Step**: `[ "$VERCEL_ENV" != "production" ]` on
  `interw-staging`, `[ "$VERCEL_GIT_COMMIT_REF" = "staging" ]` on `interw`.
  Both projects watch the same repository; without these every branch builds
  twice. Branch previews come from `interw`, staging from `interw-staging`.

**3. Set the environment variables**

Scoped per Vercel environment. Why the deploy key never leaves the
Production scope: `KNOWN_ISSUES.md` § "The deploy key belongs to the
Production scope only".

| Variable | Production scope (both projects) | Preview scope (`interw` only) | Why |
| --- | --- | --- | --- |
| `DEPLOY_CONVEX` | `true` | unset | Arms `convex deploy` inside `pnpm build`. |
| `CONVEX_DEPLOY_KEY` | that project's **production** deploy key | **unset** | Convex refuses a prod key in a preview build anyway; unset makes the intent explicit. |
| `VITE_CONVEX_URL` | unset — `convex deploy --cmd` injects it | the staging `.convex.cloud` URL | Build-time inlined. Set by hand only where the build does not run `convex deploy`. |
| `VITE_CONVEX_SITE_URL` | unset — injected alongside | the staging `.convex.site` URL | Same. |
| `MEDIA_ORIGIN` | the bucket origin (`https://interw-video-prod.s3.fr-par.scw.cloud` on `interw`) | the staging bucket origin | Read by the web server's CSP; see `KNOWN_ISSUES.md` § "`MEDIA_ORIGIN` is a web-server variable". |
| `VITE_SENTRY_DSN` | optional | optional | Build-time inlined. |

Do **not** set `CONVEX_DEPLOYMENT`; it is a per-developer dev binding.
Everything else — `RESEND_*`, `MISTRAL_API_KEY`, `OBJECT_STORE_*`,
`PURGE_HASH_SALT` — lives on the **Convex** deployment, not on Vercel.
`pnpm run setup:prod` put it there.

**4. CORS on each bucket**

Every candidate upload is a browser `PUT` straight to the bucket, so each
bucket's CORS rule must list the origins it is served from — per environment
in `TESTING.md` P2a.

**5. Point the domain and deploy**

Add `interw.com` (and `www`) under the `interw` project's **Domains**,
update DNS as Vercel shows, then push to `main`. From then on a merged PR
deploys itself: Vercel installs with pnpm, runs `pnpm build`, which deploys
the Convex backend and builds the frontend in lockstep. Staging is the same,
on a push to `staging`.

**6. Verify**

Run the Level 6 rows in [TESTING.md](TESTING.md), then send yourself a magic
link from the live domain — it must point at
`https://<your-domain>/api/auth/magic-link/verify`, not `localhost`. If you
use Google sign-in, register the production redirect URI
`https://<your-domain>/api/auth/callback/google` on the same OAuth client.

> **Sovereignty note.** The web tier is now a US host. It persists nothing,
> but it renders reports server-side, so candidate data crosses it in memory
> — which is why the function region is pinned to Paris. Transcription and
> evaluation both run on Mistral; the evaluation model is Z.ai's GLM, whose
> weights are Chinese but whose inference runs on Mistral's infrastructure
> under its regional controls, so no interview leaves it. Candidate
> transcripts and evaluations are *stored* in Convex — a US company, EU
> region — which remains the largest exposure. If sovereignty is the goal
> rather than the label, the order of work is the database first, the host
> second.

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

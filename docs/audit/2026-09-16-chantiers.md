# Campagne de correction — chantiers 2 à 5

Suite de [`2026-09-15-audit-complet.md`](./2026-09-15-audit-complet.md).
Ce fichier est le cahier des charges des sessions Claude Code : chaque session
lit **ce fichier** puis la section de son chantier, et rien d'autre ne lui est
dicté. Une session = un chantier = une branche = une PR brouillon. Les
chantiers s'exécutent **dans l'ordre**, un seul à la fois, parce qu'ils
partagent un seul déploiement Convex de dev.

## État des lieux au 16 septembre

> **Mise à jour du 25/09 : cet état des lieux est historique.** Le suivi courant
> est [`2026-09-24-reste-a-faire.md`](./2026-09-24-reste-a-faire.md) (§0
> avancement). Les chantiers 2 à 6 y sont repris en tâches T01 → T17, livrées en
> PR brouillon **empilées** (chacune cible la précédente) : #35 (T01), #39 (T02),
> #41 (T03), #43 (T04), #44 (T05), #45 (T06), #46 (T07), #47 (T08), #48 (T09),
> #49 (T10), #50 (T11), #51 (T13), #52 (T14), #53 (T15), #54 (T16).
> T12 attend les PR d'authentification #32, #36, #37 et #42.

Mergé sur `main` :

- **#2** — l'audit et ses annexes (`docs/audit/`).
- **#3** — hébergement web déplacé de Vercel vers Scalingo. `pnpm build`
  déploie Convex en lockstep quand `DEPLOY_CONVEX=true` ; voir
  `KNOWN_ISSUES.md` § « Deploys are wired into the Vercel build » (réécrit par #21).
- **#4** — chantier 1 : B1 et B2 (en-têtes, désormais dans
  `src/lib/security-headers.ts` avec test), B10 (`items` supprimé, landing
  réécrite, titre d'onglet, changelog corrigé), smoke test étendu à `/s/` et
  `/r/`.

- **#6** — chantier 3 : les 14 constats pipeline / données / effacement.
- **#7** — l'évaluation quitte OpenRouter pour Mistral (`zai-glm-5-3`), le
  palier `fast`/`deep` disparaît, une seule clé fournisseur.
- **#8** — Convex 1.46.
- **#9** — correctif urgent : GLM répond en blocs, pas en chaîne. Voir
  `KNOWN_ISSUES.md` § « A reasoning model does not answer in a string ».

Restent ouverts : B3 à B9 et tous les constats élevés des six annexes, plus le
chantier 6 ci-dessous (ce que la campagne a elle-même produit).

## Environnements : dev, staging, prod

Le front est sur Vercel depuis #21 ; chaque environnement a **son** déploiement
Convex, donc son `SITE_URL`. Réglages : `README.md` § « Deploying: staging and
production ».

| | Vercel | Convex | `SITE_URL` | Bucket | Qui pousse le backend |
|---|---|---|---|---|---|
| **dev** | aucun (`pnpm dev`) | dev `tremendous-eel-855` | `http://localhost:3000` | dev | la session Claude Code, via `convex dev` |
| **staging** | `interw-staging`, branche `main` | `combative-peacock-986` (le déploiement prod du projet `interw-staging`) | `https://interw-staging.vercel.app` | dev | un merge sur `main`, via le build Vercel |
| **prod** | `interw`, branche `production` | prod du projet `interw` (à créer / confirmer) | `https://interw.com` | prod | un push sur `production`, via le build Vercel |

Les PR ne construisent rien (étape de build ignorée sur les deux projets) :
une branche de chantier se teste en local, contre le Convex dev. Deux
chantiers en parallèle sur le même Convex dev s'écraseraient : d'où l'ordre
strict.

Variables de l'environnement Claude Code cloud « Interw » (dev uniquement,
jamais une clé prod) :

```
CONVEX_DEPLOY_KEY=dev:<deploiement-dev>|<clé>         dashboard → Settings → Deploy keys
VITE_CONVEX_URL=https://<deploiement-dev>.eu-west-1.convex.cloud
VITE_CONVEX_SITE_URL=https://<deploiement-dev>.eu-west-1.convex.site
MEDIA_ORIGIN=https://interw-dev.s3.fr-par.scw.cloud
```

L'environnement doit aussi autoriser le réseau vers `api.convex.dev`,
`*.convex.cloud`, `*.convex.site`, `*.scw.cloud`, `api.mistral.ai` et
`api.resend.com` — politique **Custom**, en cochant la liste par défaut des
gestionnaires de paquets, sans quoi `pnpm install` casse.

Variables par défaut du projet Convex (dashboard → Settings → Environment
variables, « defaults for dev deployments »), héritées par le déploiement dev :

```
APP_ENV=development
SITE_URL=http://localhost:3000         l'origine RÉELLE depuis laquelle on se connecte
BETTER_AUTH_SECRET=<généré, distinct de la prod>
RESEND_API_KEY / RESEND_FROM / RESEND_TEST_MODE=false
MISTRAL_API_KEY                                        (clé dev, plafonnée ; plus d'ANTHROPIC_* depuis #17)
PURGE_HASH_SALT=<openssl rand -hex 32, distinct par déploiement>
OBJECT_STORE_ENDPOINT=https://s3.fr-par.scw.cloud
OBJECT_STORE_REGION=fr-par
OBJECT_STORE_BUCKET=interw-dev
OBJECT_STORE_ACCESS_KEY_ID / OBJECT_STORE_SECRET_ACCESS_KEY   (paire dev)
```

Trois pièges dans ce bloc, chacun payé une fois :

- **`SITE_URL` est l'unique origine acceptée**, et elle est lue au chargement
  du module. Symptôme d'une origine non déclarée : « je n'ai pas reçu le
  mail ». Voir `KNOWN_ISSUES.md` § « `trustedOrigins` holds one origin per
  deployment ».
- **`RESEND_TEST_MODE` doit valoir exactement la chaîne `false`.**
  `convex/email.ts` fait `testMode: process.env.RESEND_TEST_MODE !== 'false'` :
  `0`, `no`, vide ou absent laissent le mode test **actif**, et une vraie
  adresse n'est jamais servie.
- **`OPENROUTER_API_KEY` et `OPENROUTER_PROVIDER_ORDER` n'existent plus.** Le
  code ne les lit plus depuis #7. Les retirer des déploiements et révoquer la
  clé chez le fournisseur.

Règle CORS du bucket `interw-dev` (sans elle, tout envoi candidat échoue) :

```json
[{"AllowedOrigins":["http://localhost:3000","https://interw-staging.vercel.app"],
  "AllowedMethods":["PUT","GET"],"AllowedHeaders":["Content-Type","Content-Length"],
  "MaxAgeSeconds":3600}]
```

⚠️ **À vérifier avant de commencer le chantier 2**, qui ne parle que d'envoi de
média : si l'origine servie n'est pas dans cette liste, **chaque envoi candidat
échoue**, et l'erreur CORS ne ressemble pas à une erreur d'envoi.

## Règles communes à tous les chantiers

Ce bloc est repris tel quel en tête de chaque prompt.

> Lis `CLAUDE.md`, puis `docs/audit/2026-09-15-audit-complet.md`, puis
> `docs/audit/2026-09-16-chantiers.md` en entier, puis les annexes citées par
> ton chantier. Travaille sur une branche dédiée, une seule PR brouillon.
>
> **Étape 0, avant toute modification** : vérifie que l'environnement est
> exécutable. `pnpm install`, `npx convex dev --once`, puis `pnpm dev` en
> arrière-plan et `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000`.
> `npx convex env list` doit montrer `SITE_URL`, `APP_ENV`, `BETTER_AUTH_SECRET`,
> `MISTRAL_API_KEY`, `PURGE_HASH_SALT`, `RESEND_API_KEY`, `RESEND_FROM`,
> `RESEND_TEST_MODE` et les cinq `OBJECT_STORE_*`. Il ne doit **plus** montrer
> `OPENROUTER_API_KEY` ni `OPENROUTER_PROVIDER_ORDER`. Si quelque chose manque,
> arrête-toi et dis exactement quoi. Ne contourne jamais un secret manquant
> par une valeur inventée.
>
> **Vérifie aussi que la clé est bien celle du dev**, pas de la prod : le
> préfixe de `CONVEX_DEPLOY_KEY` et la ligne que `convex env list` imprime
> doivent tous deux dire `dev`. Un chantier touchant `convex/schema.ts` pousse
> une migration ; sur une clé prod, tu la pousses en production.
>
> **N'imprime jamais la valeur d'une variable d'environnement**, même pour
> vérifier qu'elle est posée — `convex env list` donne les noms, cela suffit.
> Un masquage par `sed` qui ne matche pas publie le secret dans la
> transcription, ce qui est arrivé une fois et a coûté une révocation.
>
> **Ne touche à rien hors du périmètre de fichiers du chantier.** Si une
> correction l'exige, dis-le et attends. Aucun élargissement de périmètre :
> une idée hors liste se signale dans la PR, elle ne s'implémente pas.
>
> **Pour chaque constat corrigé** : un test qui échoue avant et passe après,
> cité dans la description de la PR avec l'identifiant du constat (B4, E7…).
> Preuve d'exécution obligatoire pour tout ce qui touche un navigateur ou un
> appel externe : sortie de test, capture, journal Convex.
>
> **Avant d'ouvrir la PR** : `pnpm typecheck`, `pnpm lint`, `pnpm test`,
> `pnpm build:app`, `pnpm audit:access:check`, `pnpm codegen:api:check`, tous
> verts ; puis l'audit doc de `CLAUDE.md` (mettre à jour `TESTING.md`,
> ajouter à `KNOWN_ISSUES.md` les pièges réellement rencontrés, une entrée de
> changelog si un utilisateur voit la différence). La PR liste les constats
> traités et ceux volontairement laissés, avec la raison.
>
> Jamais de valeur secrète dans un commit, un commentaire ou la PR.

---

## Chantier 3 — pipeline, données, effacement ✅ livré par #6

Annexes : `2026-09-15/backend-acces.md`, `2026-09-15/pipeline-ia-stockage.md`.

Périmètre de fichiers : `convex/**` sauf `convex/interview.ts`,
`convex/candidate.ts`, `convex/lib/candidateView.ts` (chantier 2) ;
`src/routes/app/admin.tsx` pour les compteurs ; `scripts/audit-convex-access.mjs`.
Le schéma (`convex/schema.ts`) peut changer ; c'est pourquoi ce chantier passe
avant les autres.

Constats à corriger, dans cet ordre :

1. **B5** — `convex/purge.ts` : borner l'index
   (`q.gt('purgeAfter', 0).lt('purgeAfter', before)`) ; `clearSessionMedia`
   ne remet plus `purgeAfter` à `undefined` mais pose un marqueur distinct.
   Test convex-test : 40 sessions sans horloge + 1 échue → la seule échue.
2. **B6** — `purgeAfter` posé à l'invitation (fenêtre courte, 6 mois depuis
   `invitedAt`), prolongé à `finish` (12 mois). Test.
3. **B4** — `shares.sharedMediaUrls` et `interview.promptMediaUrls` : `now`
   serveur dans les actions. Dans `shares.view` et `interview.questions` :
   `now` client borné par le serveur (`Math.max(now, Date.now() - 60_000)`
   ou drapeau matérialisé par cron). Test : `view({token, now: 0})` sur un
   partage expiré répond `expired`. Ajouter la règle dans `CLAUDE.md`
   (« une autorisation ne dépend jamais d'un argument, `now` compris »).
4. **B7 + pipeline E1** — fan-in transactionnel : `segmentsExpected` et
   `segmentsSettled` sur `sessions`, incrémentés à chaque issue **terminale**
   (succès ou échec définitif, en lisant `result` de `vOnCompleteValidator`) ;
   le rapport est mis en file par la mutation qui complète le compteur, avec
   un jeton `reportJobEnqueuedAt` posé dans la même transaction. Échec
   terminal d'un segment = état (`transcriptionState: 'failed'`), rapport
   partiel généré et signalé (`report.partial: true`), ou `report/failed`
   journalisé si rien n'est exploitable. Sentry (ou `console.error` structuré
   nommé) dans chaque `catch` de `pipeline.ts`. Test convex-test de bout en
   bout avec `transcribe` et `complete` bouchonnés : 7 segments dont 1 en
   échec définitif → un seul rapport, partiel, un seul e-mail.
5. **Pipeline E7** — `evidence.ts` : `startSeconds: number | null` jusqu'au
   schéma (`v.optional`) ; plus de repli sur `modelEstimate` ; plus de chunk
   fabriqué à 0:00 quand Mistral ne renvoie pas de segments (champ
   `anchored: false`).
6. **Backend E5** — jointure des réponses par `segment.questionId` dans
   `pipeline.ts`, `reports.ts`, `shares.ts`, `interview.ts` (lecture seule
   pour ce dernier, sans changer son API). `questions.remove` et `reorder`
   refusés quand `project.sessionCount > 0`.
7. **Effacement** — `emailLog` : index `by_session`, suppression ou hachage
   du `recipient` dans `deleteSessionRecords` ; `projects.remove` planifie
   `deleteKeys` pour intro et questions ; `reserveSegment` **hors périmètre**
   (chantier 2) mais préparer `internal.media.deleteKeys` pour qu'il puisse
   l'appeler ; hash de `purgeLog` salé par un secret `PURGE_HASH_SALT` ;
   `deleteSessionRecords` par lots avec `ctx.scheduler.runAfter` ; `sessionEvents`
   plafonné par session.
8. **Backend E4 / M3 / M9** — `sessions.invite` : index `by_project_and_email`,
   plus de `collect()` ; dédup de `sendReportReady` par `emailLog.by_session` ;
   dashboard sans N+1 (score et recommandation dénormalisés sur `sessions`
   à l'écriture du rapport, une fois, par la file — le chantier 4 s'en
   servira pour le tableau).
9. **Pipeline E6 / M1 / M2 / M3** — `ai.ts` : `provider: { data_collection:
   'deny', allow_fallbacks: false, order: [...] }` sur OpenRouter ; retirer le
   nom du candidat du prompt d'évaluation ; `AbortSignal.timeout` sur chaque
   `fetch` ; `max_tokens` ; `MAX_ATTEMPTS = 2` ; `usage` (tokens) et secondes
   d'audio écrits dans `jobLog` ; message d'erreur du dernier modèle propagé.
10. **Pipeline E10 / M8** — `jobImport.ts` : `redirect: 'manual'` avec
    re-validation à chaque saut, résolution DNS avant connexion, plages
    manquantes (CGNAT, IPv6 mappée, décimal, `.local`), plafond d'octets en
    flux, `Content-Type` vérifié. `assertPublicHttpUrl` exportée et testée par
    table de cas.
11. **Observabilité** — `admin.tsx` : compteurs `jobLog.by_step_and_outcome`
    sur 24 h et 7 j, liste des sessions `completed` sans rapport, bouton
    « relancer » (mutation interne idempotente qui remet le fan-in en file ;
    ce n'est pas un script de rattrapage, c'est une action explicite tracée).
12. **Backend M6 / M7** — `scripts/audit-convex-access.mjs` : dépouiller les
    commentaires avant recherche, limites de mot, garde exigée dans les N
    premières instructions, `http.ts` audité ; `returns:` validator sur
    `candidate.landing`, `interview.questions`, `shares.view`.
13. **Backend M1** — `candidate.swapDocumentKey` : rejouer
    `evaluateSessionGate` et `candidateFields[kind].enabled`. (Seule
    exception au périmètre : trois lignes dans `candidate.ts`.)
14. Dix tests `withIdentity` sur les gardes : membre d'une autre org refusé
    sur `projects.getBySlug`, `sessions.invite`, `reports.forSession`,
    `shares.create`, `setDecision` ; membre non partagé refusé sur un poste
    restreint ; `archive` et `deleteCandidateData` exigent owner/admin (cf.
    E9 recruteur) ; super-admin.

Laisser volontairement : para-verbal (M9 pipeline, décision produit à
prendre), multipart.

---

## Chantier 2 — moteur d'entretien (après le 3)

Annexe : `2026-09-15/candidat.md` en entier, plus E8 et M12 de
`2026-09-15/pipeline-ia-stockage.md`.

Périmètre de fichiers : `src/routes/s/**`, `src/components/candidate/**`,
`src/lib/media/**`, `src/lib/interview-machine.ts` (nouveau), `convex/interview.ts`,
`convex/candidate.ts`, `convex/lib/candidateView.ts`, `convex/lib/sessionState.ts`,
`src/lib/sentry.ts`, `src/locales/{en,fr}/interview.json`,
`convex/emailTemplates.ts` (nouvel e-mail uniquement), `.github/workflows/ci.yml`
(job e2e uniquement).

Ordre imposé :

1. Extraire la machine à états de `interview.tsx` en réducteur pur
   `(state, event) => state` dans `src/lib/interview-machine.ts`, testé en
   vitest, **avant** toute autre correction. B3, B9, E3, E6, E7 sont des bugs
   de structure ; ils doivent devenir impossibles par construction.
2. Un seul curseur de reprise, côté serveur : `interview.questions` renvoie
   `nextQuestionIndex` dérivé des segments ; le client n'a plus aucune logique
   de reprise ; `welcome.resumeHint` affiche la même valeur. Test convex-test :
   segment échoué en q1, réussi en q2 → reprise en q1, et q2 n'est jamais
   ré-enregistrée. `reserveSegment` supprime les anciennes clés quand elles
   changent (via `internal.media.deleteKeys`).
3. **B3** aperçu rattaché ; **B9** alerte de fin hors du bloc `current &&` ;
   **E1** `deviceId` transmis par search params ; **E2** repli audio-seul sur
   `NotFoundError` / `NotReadableError` / `OverconstrainedError`, avertissement
   visible ; **E7** timeout sur `stopAndFlush`, action proposée même sans
   octets ; **E8** `visibilitychange`, `track.onended`, message au candidat ;
   **pipeline-E8** `markSegmentUploaded` dès l'audio, vidéo = enrichissement
   journalisé ; **E9** `XMLHttpRequest` avec progression réelle,
   `videoBitsPerSecond` ≈ 1 Mbit/s, `audioBitsPerSecond` 64 kbit/s ; **M8**
   écran de fin listant les réponses manquantes avant de terminer.
4. **E5** `errorComponent` propre à `/s/$token` (lit `convexErrorCode`, rend
   `CandidateNotice` avec `interview:state.<code>`) ; **E4** la page vie
   privée passe la query en `'skip'` après suppression ; **E10** `beforeSend`
   Sentry qui masque `/s/<jeton>`, `captureException` dans un `useEffect`.
5. **M4** rendre ou supprimer les 18 clés mortes (le bloc « ce qu'il vous
   faut » et le lien vie privée du shell sont à rendre) ; langue de la surface
   = `project.language` ; **M1** `DOMException` classées ; **M5/M6/M7**
   boutons ≥ 44 px, `aria-live` sur les changements d'état, aperçu en
   portrait sur mobile avec `facingMode: 'user'`.
6. E-mail de fin au candidat, bilingue, portant le lien `/s/<token>/privacy`,
   envoyé depuis `finish` via le scheduler, journalisé dans `emailLog`.
7. Test Playwright Chromium **et** WebKit, avec périphériques factices
   (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`) :
   session créée par une mutation interne de seed, accueil, consentement,
   test caméra, deux réponses enregistrées, coupure réseau simulée
   (`route.abort` sur le `PUT`) puis reprise, fin, session `completed`, deux
   segments `uploaded` vérifiés en base. En CI derrière `pnpm build:app` et
   `pnpm start`, avec les secrets du déploiement dev (`CONVEX_DEPLOY_KEY`,
   `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `MEDIA_ORIGIN`). Si la CI ne
   peut pas joindre le dev, le dire dans la PR plutôt que de désactiver le
   test.

Preuve d'exécution : capture Playwright de l'écran d'enregistrement avec
l'aperçu visible, rapport du test e2e, joints à la PR. Puis vous : déployer la
branche sur `interw-dev` et passer un entretien complet sur un iPhone et un
Android **avant** de merger.

---

## Chantier 4 — application recruteur (après le 2)

Annexe : `2026-09-15/recruteur.md`, hors reliquats déjà traités par #4.

Périmètre de fichiers : `src/routes/app/**`, `src/routes/r/**`,
`src/components/{projects,candidates,report,ai,app-shell,dashboard}/**`,
`src/locales/{en,fr}/{projects,candidates,report,dashboard,nav,chat}.json`,
`convex/sessions.ts` (colonne score dans `toRecruiterRow`), `convex/media.ts`
(lecture seule), `convex/reports.ts` (rôles).

1. **B8** `ShareProjectDialog` pré-rempli depuis `sharedWith` ; test de
   composant ou test convex-test sur `setShares` idempotent.
2. **E4** tableau des candidats : colonnes score et recommandation (lues sur
   `sessions`, dénormalisées par le chantier 3), tri par colonne, filtre par
   statut et décision, action « copier le lien » (`sessions.invitationLink`).
3. **E3** hook `useSessionMedia(sessionId)` : URL signées rafraîchies avant
   expiration, jamais re-signées sur une écriture de note ; même hook sur
   `/r/$shareToken`.
4. **E6 / E7** intro audio et vidéo branchées sur `MediaRecorderField` +
   `attachIntroMedia` (ou modes retirés du sélecteur si vous tranchez ainsi —
   dire lequel dans la PR) ; relecture du média de question via
   `media.playbackUrls` dans l'assistant ; suppression de poste exposée aux
   owner/admin ; pondération par question : **retirer** l'UI et la mutation
   plutôt que d'exposer une fonction que le pipeline ignore, sauf si le
   chantier 3 l'a branchée.
5. **E8** panneau IA en `lazy`, fermé par défaut, jamais plein écran sans
   piège de focus ni Échap ; **M1** `errorComponent` et `notFoundComponent`
   sur les routes recruteur ; **M12** bouton « relancer le rapport » branché
   sur la mutation du chantier 3 ; **M10** publication refusée avec une
   question vide ; **M3** codes d'erreur traduits.
6. Écran « Nouveautés » : vérifier que les deux entrées Interw s'affichent
   après #4 ; supprimer le composant `toolRenderers` mort et les composants
   `dashboard/*Chart*` non importés.
7. Passe `web-design-guidelines` sur les écrans touchés : focus visible, hit
   targets, `prefers-reduced-motion`, `tabular-nums` sur les colonnes de
   chiffres.

---

## Chantier 5 — preuve, CI, dette d'outillage (après le 4)

Annexe : `2026-09-15/qualite-infra.md`.

Périmètre : `.github/workflows/**`, `package.json` (scripts et overrides),
`vitest.config.ts`, `scripts/**`, `src/lib/sentry.ts`, docs.

1. CI : `tsc` une seule fois (retirer de `build:app` ou de `lint`),
   `concurrency` + `cancel-in-progress`, `timeout-minutes`, actions
   épinglées par SHA, `pnpm audit --prod --audit-level=high` avec overrides
   `ws >= 8.21.0` et `dompurify >= 3.4.13`, budget de bundle (seuil gzip sur
   l'écran d'entretien, mesuré après `pnpm build:app`, échec au-delà de
   270 Ko), smoke test lancé contre `pnpm start` en CI.
2. Sentry : soit intégrations + source maps réellement envoyées, soit retirer
   les options mortes. Trancher et documenter.
3. `convex/users.ts` : le dernier `catch {}` (avatar) journalise et respecte
   l'ordre objets-avant-lignes.
4. Docs : corriger toutes les affirmations périmées listées dans l'annexe
   (`@assistant-ui/react`, « Sentry sur les actions », `PROJECT_BRIEF.md`,
   chemin `/Users/…`, « C16 », « G1 », Node 20 vs 22, `convex/README.md`,
   `AGENTS.md`).

   Les deux mentions Vercel de `.env.example:71` et `TESTING.md` P6a ont **déjà
   été corrigées par #6** — ne pas les rechercher. Reste
   `KNOWN_ISSUES.md:298` § `MEDIA_ORIGIN`, qui dit « Vercel project settings » :
   l'instruction d'origine était de la remplacer par Scalingo, mais Vercel est
   depuis revenu pour le front de dev et les previews. Les deux hébergeurs sont
   réels, donc **nommer les deux** plutôt que substituer l'un à l'autre, et
   documenter lequel sert quoi. Même remarque pour le `README.md`, qui ne
   connaît que Scalingo. *Caduc : #21 a retiré Scalingo, Vercel seul.*
5. Dépendances : retirer `convex-helpers`, `tsx`, `@radix-ui/react-label`
   non importés ; règles Renovate manquantes (`react-router-with-query`,
   `nitro`, `recharts`).
6. Supprimer `docs/audit/2026-09-15/` (les annexes) en dernier commit de la
   campagne, en gardant le rapport consolidé et ce fichier.

---

## Chantier 6 — la dette produite par la campagne (après le 5)

Pas d'annexe : ce chantier vient des PR #6, #7 et #9, qui ont signalé sans
implémenter. Chaque point porte déjà sa justification dans la PR qui l'a levé.

Périmètre de fichiers : `convex/lib/ai.ts`, `convex/auth.ts`, `convex/email.ts`,
`convex/emailEvents.ts`, `src/components/candidates/**`, `CLAUDE.md`,
`README.md`, `KNOWN_ISSUES.md`.

1. **`strict: true` sur le décodage structuré** (#7, #9). Mistral le documente
   et le probe montre que GLM respecte déjà le schéma en `strict: false`. Le
   commentaire actuel dit la vraie raison de ne pas avoir basculé : le schéma
   envoyé est généré depuis Zod et n'a jamais été confronté au décodeur, et un
   schéma refusé ferait échouer **toutes** les évaluations d'un coup. Basculer
   exige donc une mesure contre une vraie clé, pas une lecture de doc — voir
   `TESTING.md` P4a.
2. **Le coût du raisonnement est invisible** (#9). `jobLog` écrit
   `completionTokens` sans distinguer les tokens de raisonnement de ceux de la
   réponse. Mesuré : 2 747 tokens de complétion pour un prompt de 27 tokens.
   Sur un modèle où ce poste domine, une colonne séparée transforme une facture
   subie en une facture pilotée.
3. **`convex/emailEvents.ts:59 recent` est une query morte** (annexe
   `produit.md`, re-signalée en #7). Même avec le webhook Resend configuré, un
   rebond est enregistré et **rien ne l'affiche** : un recruteur dont
   l'invitation a rebondi croit que le candidat l'ignore. Soit la brancher sur
   le tableau des candidats, soit la supprimer — mais trancher.
4. **`trustedOrigins` n'accepte qu'une origine** (`convex/auth.ts:49`). Tant que
   `SITE_URL` désigne Vercel, ni `localhost:3000` ni les previews par branche ne
   peuvent s'authentifier — ce qui rend le développement local et le test d'une
   PR mutuellement exclusifs. Une liste alimentée par une variable
   additionnelle lève le blocage ; `baseURL` reste une valeur unique et doit
   être documenté comme telle. *Avec un `SITE_URL` par déploiement, le blocage
   ne mord plus que si deux origines visent le même déploiement — voir
   `KNOWN_ISSUES.md` § « `trustedOrigins` holds one origin per deployment ».*
5. **Resend est américain.** C'est le dernier maillon hors UE facile à déplacer
   (Scaleway TEM, déjà fournisseur du bucket, ou Brevo). Coût réel :
   `@convex-dev/resend` est un *composant* Convex, donc c'est un remplacement de
   composant plus le webhook à recâbler, pas une variable d'environnement.
   Arbitrer explicitement plutôt que de laisser traîner.
6. **Timestamps au mot** (#9). Voxtral Transcribe 2 les expose ; `transcribe()`
   demande toujours `timestamp_granularities: 'segment'`. Un ancrage au mot
   rendrait `convex/lib/evidence.ts` plus précis sur les citations courtes.
7. **Affirmations périmées** : `CLAUDE.md:157` dit « File storage : Convex
   native, 20 MB cap » alors que `convex/lib/objectStore.ts` existe précisément
   pour dire le contraire sur les médias candidats. (`README.md` et Scalingo :
   réglé par #21.)

---

## Prompts prêts à coller

Un prompt = une session = un chantier = une branche = une PR brouillon. Les
chantiers s'exécutent **dans l'ordre** : 2, puis 4, puis 5, puis 6. Ne lance
jamais deux sessions en parallèle — elles partagent un seul déploiement Convex
de dev et s'écraseraient.

Le corps du prompt est identique à chaque fois ; seule la dernière ligne
change. Colle ceci, en remplaçant `N` par le numéro du chantier :

```
Lis CLAUDE.md, puis docs/audit/2026-09-15-audit-complet.md, puis
docs/audit/2026-09-16-chantiers.md en entier, annexes de ton chantier
comprises. Exécute le chantier N exactement comme décrit, règles communes
comprises, en commençant par l'étape 0. Branche dédiée, une PR brouillon.

Avant de coder, dis-moi ce que l'étape 0 a donné — en particulier si une
variable manque ou si la clé de déploiement n'est pas celle du dev. Ne
contourne rien, ne devine rien, n'invente aucun secret.
```

Trois choses à vérifier **toi-même** avant de lancer une session, parce
qu'aucune ne se voit depuis le code :

| Avant le chantier | Vérifier | Sinon |
| --- | --- | --- |
| **2** | la règle CORS du bucket `interw-dev` contient l'origine servie | tout envoi candidat échoue, avec une erreur qui ne ressemble pas à un envoi raté |
| **2** | `SITE_URL` désigne l'origine que tu ouvriras sur ton téléphone | l'inscription est rejetée en `Invalid origin`, sans le moindre e-mail |
| **4, 5** | rien de particulier | |
| **6** | une clé Mistral utilisable, pour mesurer `strict: true` pour de vrai | le point 1 reste une lecture de doc, ce qu'il refuse d'être |

Et une règle qui vaut pour toute la suite, apprise en production : **avant de
pointer ce produit vers un modèle que personne ici n'a appelé, l'appeler une
fois pour de vrai.** Aucun test ne peut découvrir qu'un fournisseur s'écarte de
la forme qu'il documente — voir `TESTING.md` P4a et `KNOWN_ISSUES.md` § « A
reasoning model does not answer in a string ».

---

## Après la campagne

Trois entretiens réels, trois humains, trois téléphones, sur `interw-dev`,
avant de merger le chantier 2 ; puis la première invitation à un vrai
candidat, en prod, avec vous en copie. Tout ce qui manque encore sortira de
cette journée-là.

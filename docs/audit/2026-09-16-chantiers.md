# Campagne de correction — chantiers 2 à 5

Suite de [`2026-09-15-audit-complet.md`](./2026-09-15-audit-complet.md).
Ce fichier est le cahier des charges des sessions Claude Code : chaque session
lit **ce fichier** puis la section de son chantier, et rien d'autre ne lui est
dicté. Une session = un chantier = une branche = une PR brouillon. Les
chantiers s'exécutent **dans l'ordre**, un seul à la fois, parce qu'ils
partagent un seul déploiement Convex de dev.

## État des lieux au 16 septembre

Mergé sur `main` :

- **#2** — l'audit et ses annexes (`docs/audit/`).
- **#3** — hébergement web déplacé de Vercel vers Scalingo. `pnpm build`
  déploie Convex en lockstep quand `DEPLOY_CONVEX=true` ; voir
  `KNOWN_ISSUES.md` § « Production deploy is wired into the Scalingo build ».
- **#4** — chantier 1 : B1 et B2 (en-têtes, désormais dans
  `src/lib/security-headers.ts` avec test), B10 (`items` supprimé, landing
  réécrite, titre d'onglet, changelog corrigé), smoke test étendu à `/s/` et
  `/r/`.

Restent ouverts : B3 à B9 et tous les constats élevés des six annexes. Deux
mentions de Vercel ont survécu à #3 et sont à corriger au passage du chantier
qui touche ces fichiers : `.env.example:71` et `TESTING.md` ligne P6a.

## Environnements : dev et prod, rien d'autre

| | Convex | Web (Scalingo, `osc-fr1`) | Bucket Scaleway | Qui pousse le backend |
|---|---|---|---|---|
| **dev** | déploiement dev du projet | app `interw-dev`, `DEPLOY_CONVEX=false`, `VITE_*` du dev | `interw-dev` | la session Claude Code, via `convex dev` |
| **prod** | déploiement prod | app `interw`, `DEPLOY_CONVEX=true`, clé prod | `interw-prod` | `main`, via le build Scalingo |

`interw-dev` ne sert que le front : c'est l'URL que vous ouvrez sur votre
téléphone pour tester la branche d'un chantier avant de merger. Vous y
déployez la branche à la main (`git push scalingo-dev <branche>:main`). Le
backend qu'elle appelle est celui que la session a poussé avec `convex dev`.
Deux chantiers en parallèle sur le même Convex dev s'écraseraient : d'où
l'ordre strict.

Variables de l'environnement Claude Code cloud « Interw » (dev uniquement,
jamais une clé prod) :

```
CONVEX_DEPLOY_KEY=project:<team>:<projet>|<clé>       clé de PROJET, dashboard → Settings → Deploy keys
VITE_CONVEX_URL=https://<deploiement-dev>.convex.cloud
VITE_CONVEX_SITE_URL=https://<deploiement-dev>.convex.site
MEDIA_ORIGIN=https://interw-dev.s3.fr-par.scw.cloud
```

Variables par défaut du projet Convex (dashboard → Settings → Environment
variables, « defaults for dev deployments »), héritées par le déploiement dev :

```
APP_ENV=development
SITE_URL=https://interw-dev.osc-fr1.scalingo.io        (l'URL réelle de l'app dev)
BETTER_AUTH_URL=<idem>
BETTER_AUTH_SECRET=<généré, distinct de la prod>
RESEND_API_KEY / RESEND_FROM / RESEND_TEST_MODE=true
MISTRAL_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY   (clés dev, plafonnées)
OBJECT_STORE_ENDPOINT=https://s3.fr-par.scw.cloud
OBJECT_STORE_REGION=fr-par
OBJECT_STORE_BUCKET=interw-dev
OBJECT_STORE_ACCESS_KEY_ID / OBJECT_STORE_SECRET_ACCESS_KEY   (paire dev)
```

Règle CORS du bucket `interw-dev` (sans elle, tout envoi candidat échoue) :

```json
[{"AllowedOrigins":["http://localhost:3000","https://interw-dev.osc-fr1.scalingo.io"],
  "AllowedMethods":["PUT","GET"],"AllowedHeaders":["Content-Type","Content-Length"],
  "MaxAgeSeconds":3600}]
```

## Règles communes à tous les chantiers

Ce bloc est repris tel quel en tête de chaque prompt.

> Lis `CLAUDE.md`, puis `docs/audit/2026-09-15-audit-complet.md`, puis
> `docs/audit/2026-09-16-chantiers.md` en entier, puis les annexes citées par
> ton chantier. Travaille sur une branche dédiée, une seule PR brouillon.
>
> **Étape 0, avant toute modification** : vérifie que l'environnement est
> exécutable. `pnpm install`, `npx convex dev --once`, puis `pnpm dev` en
> arrière-plan et `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000`.
> `npx convex env list` doit montrer `SITE_URL`, `MISTRAL_API_KEY`,
> `OPENROUTER_API_KEY` et les cinq `OBJECT_STORE_*`. Si quelque chose manque,
> arrête-toi et dis exactement quoi. Ne contourne jamais un secret manquant
> par une valeur inventée.
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

## Chantier 3 — pipeline, données, effacement (à lancer en premier)

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
   `AGENTS.md`), les deux mentions Vercel restantes (`.env.example:71`,
   `TESTING.md` P6a), et `KNOWN_ISSUES.md` § `MEDIA_ORIGIN` (« Vercel project
   settings » → Scalingo).
5. Dépendances : retirer `convex-helpers`, `tsx`, `@radix-ui/react-label`
   non importés ; règles Renovate manquantes (`react-router-with-query`,
   `nitro`, `recharts`).
6. Supprimer `docs/audit/2026-09-15/` (les annexes) en dernier commit de la
   campagne, en gardant le rapport consolidé et ce fichier.

---

## Après la campagne

Trois entretiens réels, trois humains, trois téléphones, sur `interw-dev`,
avant de merger le chantier 2 ; puis la première invitation à un vrai
candidat, en prod, avec vous en copie. Tout ce qui manque encore sortira de
cette journée-là.

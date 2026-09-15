# Interw — revue produit & business

*Revue faite en lecture seule sur `/home/user/interw` (16 commits, un seul lot
mergé en PR #1). Pas de déploiement Convex : aucune vérification runtime.
Angle : périmètre commandé, vendabilité, risques. Pas d'audit de code ligne à
ligne (cinq autres agents s'en chargent).*

---

## 1. Matrice de conformité au périmètre v1 (PROMPT §2)

### 1.1 Postes et trames

| Item du périmètre | Statut | Preuve | Note qualité |
|---|---|---|---|
| Création / édition d'un poste (assistant en étapes) | **Implémenté** | `src/routes/app/$orgSlug/projects.new.tsx`, `projects.$projectSlug.edit.tsx`, `src/components/projects/wizard/Step{Basics,Questions,Criteria,CandidateForm,Review}.tsx` | 5 étapes, sauvegarde au blur, `draft → active` explicite. Propre. |
| Questions ordonnées (type, durée max, indice) | **Implémenté** | `convex/questions.ts` (`create/update/remove/reorder`), `StepQuestions.tsx` | `orderIndex` contigu, `maxResponseSeconds`, `hintText`. Le « type » de question du spec (`open`/autre) n'existe pas — simplification assumée et sans conséquence. |
| Critères d'évaluation pondérés | **Implémenté** | `convex/criteria.ts`, `convex/lib/weights.ts` (+ test) | Normalisation à 100 au read, jamais en base. Exactement ce qui était demandé. |
| Pondération des critères **par question** | **Partiel** | `questions.criteriaWeights` dans `convex/schema.ts`, mutation `questions.setCriteriaWeights` | Le backend existe et est testé ; **aucune UI ne l'expose** (pas d'occurrence dans `src/`). Fonction morte côté produit. |
| Persona de marque (nom + avatar) | **Partiel** | `StepBasics.tsx:104` (nom seul) ; `personaAvatarKey` déclaré dans `convex/schema.ts` mais **jamais écrit ni lu** | L'avatar de marque n'existe pas. Le nom de persona est stocké et renvoyé au candidat (`convex/lib/candidateView.ts:65`) mais je ne le vois affiché nulle part dans `/s/**`. |
| Message d'introduction (texte, **audio ou vidéo**) | **Partiel — et c'est un cul-de-sac visible** | Le select offre les 4 modes (`StepBasics.tsx:25` `INTRO_MODES = ['none','text','audio','video']`) ; seul `text` affiche un champ (`StepBasics.tsx:199`). Le backend est pourtant complet (`convex/media.ts` : `requestIntroUpload`, `attachIntroMedia`, `clearIntroMedia`, `swapIntroKey`). | **Un recruteur peut choisir « Introduction vidéo » et il ne se passe rien.** Conséquence côté candidat : `src/routes/s/$token/interview.tsx:330` entre en phase `intro`, `introUrl` est `null`, il rend `<p>{data.introText}</p>` = `undefined` → **écran vide avec un bouton « Je suis prêt »**. C'est le seul vrai cul-de-sac que j'ai trouvé dans le produit. |
| Média enregistré **par question** | **Implémenté** | `src/components/projects/MediaRecorderField.tsx`, `convex/media.ts` (`requestQuestionUpload`, `attachQuestionMedia`), lecture candidat `convex/interview.ts:153 promptMediaUrls` | Capture navigateur → stockage objet, l'ancien objet est supprimé au ré-enregistrement (couvert TESTING IA4). Bien fait. |
| Archivage et expiration | **Implémenté** | `convex/projects.ts` (`archive`, `restore`, `publish`), `expiresAt` dans `StepBasics.tsx:151`, garde candidat `convex/lib/sessionState.ts` (+ test) | Restauration en `draft` et pas en `active` : bon réflexe. |
| Import d'une offre d'emploi par IA | **Implémenté** | `convex/jobImport.ts` (`importFromUrl`), `src/components/projects/wizard/ImportFromUrlDialog.tsx` | Rien n'est écrit tant que le recruteur n'a pas accepté (TESTING IA7), garde SSRF (IA8). |
| Partage d'un poste à des collègues | **Implémenté** | `convex/projects.ts:363 setShares`, `projectShares` + `restricted` dénormalisé, `ShareProjectDialog.tsx` | La restriction est aussi appliquée à la recherche globale (`convex/reports.ts:289`) — point souvent oublié, bien traité ici. |

### 1.2 Parcours candidat

| Item | Statut | Preuve | Note |
|---|---|---|---|
| Invitation par e-mail individuelle et en masse | **Implémenté** | `convex/sessions.ts:98 invite` (jusqu'à 100), `sendInvitationBatch`, `InviteCandidatesDialog.tsx` | Sessions committées d'abord, e-mails via scheduler ensuite. Déduplication par e-mail. Très bon. |
| Gabarit d'invitation **éditable** (lot 3) | **Absent** | `convex/emailTemplates.ts:553 candidateInvitationEmail` est figé au code | Le lot 3 demandait « avec gabarit éditable ». Pas de surcharge org/projet. |
| Lien nominatif à jeton | **Implémenté** | `convex/lib/tokens.ts` (+ test), `accessToken` jamais dans une liste (`toRecruiterRow`), `sessions.invitationLink` en appel séparé | Exactement la règle §3.2. |
| Page d'accueil candidat + dépôt CV / lettre | **Implémenté** | `src/routes/s/$token/index.tsx`, `convex/candidate.ts` (`requestDocumentUpload`, `attachDocument`), `DocumentUploadField.tsx` | Le contrôle de type de contenu est testé (TESTING IB6). |
| Consentement de captation | **Implémenté** | `interview.json` § `consent` (4 points explicites), `convex/candidate.ts:108 acceptConsent` | La rédaction du consentement est **la meilleure partie du produit** : elle nomme l'IA, la rétention et le droit d'effacement sans jargon. |
| Test caméra et micro | **Implémenté** | `src/routes/s/$token/check.tsx` (368 l.), `src/lib/media/devices.ts` (+ test) | Sélection d'appareil, mesure de niveau, détection webview in-app, bouton « Démarrer quand même ». |
| Moteur d'entretien (lecture, enregistrement, découpage, envoi progressif) | **Implémenté** | `src/routes/s/$token/interview.tsx` (528 l.), `src/lib/media/recorder.ts`, `upload.ts` (3 tentatives + backoff) | Audio envoyé **avant** la vidéo (`interview.tsx:202`) : sur une mauvaise ligne, on sauve ce qui sera transcrit. Décision produit juste, rarement prise. |
| Bouton « J'ai terminé » + décompte 30 s (conséquence §2.3.2) | **Implémenté** | `COUNTDOWN_THRESHOLD_SECONDS = 30`, `autoStopRef` sur `maxResponseSeconds` | Conforme à la lettre. |
| Diagnostics **réseau** et micro | **Partiel** | Micro : oui (`check.tsx`). Réseau : uniquement `navigator.onLine` (`interview.tsx:84-99`) | La clé `interview:run.networkPoor` (« Your connection looks unstable ») **existe et n'est appelée nulle part** — pas de mesure de qualité (ni `downlink`, ni `effectiveType`, ni débit d'upload observé). Un candidat sur une 3G qui tient debout mais rame n'est pas prévenu. |
| Reprise d'un entretien interrompu | **Implémenté** | `interview.tsx:155 firstUnanswered`, `welcome.resumeHint`, gate `resumable` | Reprend à la première question sans réponse. |
| Page vie privée + auto-suppression | **Implémenté** | `src/routes/s/$token/privacy.tsx`, `convex/candidate.ts:351 deleteMyData` → `convex/purge.ts` | Objets avant lignes, `purgeLog` avec hash. |

### 1.3 Traitement

| Item | Statut | Preuve | Note |
|---|---|---|---|
| Transcription horodatée | **Implémenté** | `convex/lib/ai.ts:117` (Mistral `voxtral-mini-latest`), `transcripts.words` | Européen comme demandé. |
| Génération du rapport | **Implémenté** | `convex/pipeline.ts:375 generateReport`, `convex/lib/reportSchema.ts` (Zod), `reportBuilder.ts` (+ test) | Validation Zod **avant** écriture, pas de passe de réparation. Conforme §3.5 et aux règles `CLAUDE.md`. |
| File de travaux avec reprises | **Implémenté** | `@convex-dev/workpool` via `convex/lib/workpools.ts`, chaîne `onSessionCompleted → transcribeSegment → onTranscribeComplete → generateReport → notifyRecruiter` | Chaque étape vérifie en entrée si le résultat existe (`skipped` dans `jobLog`). **Zéro fonction de rattrapage** — l'interdit §7 est tenu. |
| Matrice de fit | **Implémenté** | `reports.fitMatrix` typé (pas de `v.any()`), rendu `candidates.$sessionId.tsx:283` | Typage explicite là où le PROMPT autorisait `v.any()` : mieux que demandé. |
| Analyse para-verbale | **Implémenté, mais redéfinie** | `convex/lib/paraverbal.ts` (+ test), `KNOWN_ISSUES.md` § « Para-verbal analysis is computed, not generated » | Calculée depuis la transcription (débit, hésitations, pauses, concision…) au lieu d'être générée par un modèle audio. **Arbitrage juste et bien documenté** — mais commercialement c'est une autre promesse que « analyse de la voix » du spec. À aligner sur le pitch avant de vendre. |
| Extraits vidéo marquants | **Partiel — construit, invisible** | Générés (`reportSchema.ts:54`, `reportBuilder.ts:155`), stockés (`reports.highlights`), clé i18n `report:sections.highlights` = « Worth watching »… et **aucun `grep highlights` dans `src/`** | On paie le coût modèle, on stocke, et on ne montre jamais. C'est du travail livré à 90 % qui vaut 0 pour l'utilisateur. |

### 1.4 Exploitation

| Item | Statut | Preuve | Note |
|---|---|---|---|
| Tableau de bord | **Implémenté** | `src/routes/app/$orgSlug/index.tsx`, `convex/dashboard.ts:20 overview` | 4 KPI dont « à examiner » — orienté action, pas vanité. |
| Liste des candidats d'un poste | **Implémenté** | `CandidatesTable.tsx`, `convex/sessions.ts:60 listByProject` (paginé) | |
| Fiche candidat | **Implémenté** | `candidates.$sessionId.tsx` (665 l.) | Verdict → critères → preuve, disclaimer IA permanent. Conforme §4.2. |
| Preuve cliquable (saut à la seconde) | **Implémenté** | `jump()` → `AnswerPlayer.tsx`, ré-ancrage serveur `convex/lib/evidence.ts` (+ test) | **Le différenciant du produit, et il est réellement là.** Une citation non retrouvée renvoie `null` plutôt qu'un timestamp inventé. |
| Décision recruteur | **Implémenté** | `convex/reports.ts:151 setDecision`, 4 états, toggle | |
| Partage de rapport par lien | **Implémenté** | `convex/shares.ts` (+ test), `src/routes/r/$shareToken.tsx`, `noindex` | Expiration + révocation + `viewCount`. Le partage ne fuit ni la note privée ni l'e-mail candidat (TESTING ID4). |
| Recherche globale | **Implémenté** | `convex/reports.ts:262 searchCandidates` + `searchIndex` filtré sur `orgId`, `AppHeader.tsx:104` | |
| Copilote IA | **Implémenté** | `convex/recruiterTools.ts` (listRoles / listCandidates / readReport), `convex/lib/instructions.ts` | **Read-only, explicitement**, conforme à la règle « les outils IA sur données de recrutement sont en lecture seule ». |

### 1.5 Socle

| Item | Statut | Preuve | Note |
|---|---|---|---|
| Organisations / auth / super admin | **Fourni par le template** | — | |
| E-mails transactionnels **métier** | **Partiel — 2 sur 4 attendus** | `convex/emailTemplates.ts` : `candidateInvitationEmail` (553) + `reportReadyEmail` (632). Le reste est de l'auth. | **Il manque l'e-mail de remerciement candidat** (spec §10.2 `candidate-thank-you`, dans le périmètre car « e-mails transactionnels métier »). Un candidat finit son entretien et **ne reçoit jamais rien** — pas de trace, pas de lien vers sa page vie privée, pas de preuve qu'il a bien postulé. C'est le trou le plus coûteux du parcours candidat. |
| Suivi de délivrabilité | **Partiel — backend seul** | `emailLog` + webhook Resend (`convex/http.ts`, `emailEvents.record`), `.env.example` documente `RESEND_WEBHOOK_SECRET` | `convex/emailEvents.ts:59 recent` est une **query morte** : aucun composant de `src/` ne l'appelle. Un recruteur dont l'invitation a bouncé ne le voit nulle part ; il croit que le candidat ignore son message. |
| i18n | **Implémenté** | 16 namespaces × en/fr, tout passe par `t()`, `head()` via `getFixedT` | Contrairement à l'ancienne version (9/13 namespaces vides), celle-ci est complète et de très bonne tenue rédactionnelle. |
| Rétention et purge RGPD | **Implémenté** | `convex/retention.ts`, `convex/crons.ts` (toutes les 6 h), `convex/purge.ts`, `purgeLog` | Objets avant lignes, batch borné, hash d'adresse. |
| Observabilité de bout en bout | **Partiel** | `jobLog` complet et lisible sur la fiche candidat (`candidates.$sessionId.tsx:216`) | **Deux manques explicites du PROMPT** : (a) `grep -i sentry convex/` = **zéro** — aucune remontée Sentry côté action, alors que §6 « les erreurs des actions partent vers Sentry » et lot 8 « Sentry côté action » ; `KNOWN_ISSUES.md:837` l'assume (« Sentry only on the front-end ») mais c'est un héritage du template, pas une décision prise pour Interw. (b) §3.6 « un compteur d'échecs par étape doit être lisible depuis l'écran super admin » : `src/routes/app/admin.tsx` est **strictement celui du template** (users / orgs / memberships / invites). L'index `jobLog.by_step_and_outcome` existe et n'est lu par personne. |

### 1.6 Hors périmètre — a-t-on construit ce qu'il ne fallait pas ?

**Non. Zéro scope creep.** J'ai cherché : pas de comparaison de candidats, pas
d'export vidéo, pas de bibliothèques, pas de page publique de poste, pas de TTS,
pas de clonage de voix, pas de mode démo, pas de relance d'abandon, pas de
statistiques par poste, pas de feedback in-app, pas de MCP. C'est une discipline
rare et il faut le dire.

**Mais il reste des débris du template livrés au client** :
`convex/items.ts` + `src/routes/app/$orgSlug/items.tsx` + `ItemsDataTable.tsx` +
`columns.tsx` + les **outils d'écriture `createItem` / `updateItem` /
`deleteItem` du copilote** (`convex/agentTools.ts:140-190`) + l'entrée de nav
« Items » (`src/components/app-shell/nav.ts:38`). Un recruteur qui ouvre Interw
voit dans sa barre latérale une rubrique « Items » qui ne veut rien dire, et
l'assistant IA lui propose d'en créer. C'est le premier signal « produit pas
fini » qu'un prospect verra, avant même d'avoir créé un poste.

**Dette de la spec §13 ré-importée** : aucune. Les pièges nommés (`catch {}`,
URL en base, composant monolithe, rattrapages, bundle unique, i18n abandonnée,
`{false && …}`) sont tous évités, et l'ESLint `eslint.config.mjs:29-58` fait de
l'isolation du bundle candidat une règle et pas une convention. Un seul point de
la §13 revient par une autre porte : la **duplication projet/template** n'a pas
pu revenir puisque les bibliothèques sont hors périmètre — elle reviendra dès
qu'on les ajoutera, et personne ne l'a anticipé dans le schéma.

---

## 2. Définition du terminé (PROMPT §8), point par point

| # | Critère | Mon avis | Ce qui manque comme preuve |
|---|---|---|---|
| 1 | Un recruteur crée un poste, invite, reçoit un rapport exploitable, décide — **sans intervention manuelle** | **Vraisemblablement oui, non prouvé** | La chaîne est complète en lecture. Mais rien dans le dépôt n'atteste qu'elle a tourné **une seule fois de bout en bout sur un vrai déploiement** : pas de capture, pas de log, pas de session de démo, et `convex/_generated` a été produit par un générateur **hors-ligne** (`9522bfc build: offline generator for convex/_generated/api.d.ts`). Je ne peux pas dire que le critère 1 est vérifié ; je peux dire que le code ne contient pas de raison évidente qu'il échoue. |
| 2 | Bout en bout sur Chrome, Safari, Firefox, desktop **et mobile** | **Non prouvé** | `TESTING.md` § « Interw B » dit « repeat per browser » — c'est une checklist manuelle, pas un résultat. **Aucun test navigateur automatisé** : pas de Playwright, pas de Puppeteer, `pnpm test` = Vitest en `edge-runtime` uniquement, `pnpm test:smoke` est un script HTTP sur le serveur de dev (`scripts/e2e-smoke.mjs`). Le PROMPT §6 exigeait « le parcours candidat du lot 4 livre **en plus** un test de bout en bout » : `src/lib/media/recorder.test.ts` teste la sélection de codec, pas un parcours. **Critère non atteint.** |
| 3 | Coupure réseau récupérable, et le candidat le sait pendant | **Oui sur le chemin nominal** | `upload.ts` (3 tentatives, backoff), phase `failed` avec « Try again » / « Skip », `beforeunload`, bannière offline, `markSegmentFailed` côté serveur pour que le recruteur voie la tentative. Design juste. Non prouvé en conditions réelles (IB12 est manuel). |
| 4 | Aucune fonction publique ne renvoie une donnée d'une autre organisation — **vérifié fonction par fonction** | **Oui, et outillé** | `pnpm audit:access:check` tourne en CI (`.github/workflows/ci.yml:30`) et échoue sur toute fonction publique sans garde. C'est mieux qu'une revue : c'est un cliquet. Reste que l'audit vérifie la *présence* d'une garde, pas sa *justesse* — c'est le travail des cinq autres agents. |
| 5 | Aucun objet accessible sans URL signée émise après vérification | **Oui par construction** | Aucune colonne d'URL dans `convex/schema.ts`, `objectStore.ts` + `sigv4.ts` testés, trois chemins de signature distincts (membre org / jeton candidat / jeton de partage). Dépend d'un réglage humain hors dépôt : **le bucket doit être privé** (README et `.env.example` le martèlent — bien). |
| 6 | La suppression efface les objets ; la purge s'exécute et se journalise | **Code conforme, exécution non prouvée** | Ordre objets→lignes respecté partout, `purgeLog` avec hash, cron toutes les 6 h. Mais IE1/IE5 (« lister le préfixe du bucket, il est vide ») sont des étapes manuelles jamais cochées. **Pour vendre à un DPO, il faudra un test automatisé contre un MinIO** — pas une case dans un `.md`. |
| 7 | Lint, typecheck, build, tests en CI sur `main` | **Oui** | `ci.yml` enchaîne `codegen:api:check`, `audit:access:check`, `lint`, `test`, `build`. La CI existe *et* se déclenche (contrairement à l'ancienne version). |
| 8 | `TESTING.md` couvre chaque surface, `KNOWN_ISSUES.md` porte chaque piège | **Oui, généreusement** | 5 sections Interw (A→E, ~67 min), et `KNOWN_ISSUES.md` documente les pièges réellement rencontrés (présignature `content-length`, deux `MediaRecorder` sur un flux, `seek` avant `loadedmetadata`, para-verbal calculé). Ce sont de vraies notes de terrain, pas du remplissage. |

**Verdict DoD : 5 critères tenus sur 8** (4, 5, 7, 8 + 3 en conception), 1 non
tenu (2), 2 non prouvés (1, 6). Le trou n'est pas dans le code, il est dans la
**preuve d'exécution**. Un produit qui enregistre de la vidéo dans le navigateur
et qu'on n'a jamais vu tourner sur Safari mobile n'est pas livrable.

---

## 3. Parcours de bout en bout, tel qu'il est vécu

### 3.1 Recruteur — de l'inscription à la décision

**Étape 0 — Il arrive sur `interw.ai`.** `src/routes/index.tsx` affiche un logo,
le mot « interw », une phrase et deux boutons. Cette phrase, c'est
`src/locales/en/landing.json` :

> `"metaTitle": "interw — MVP starter"`
> `"tagline": "B2B MVP starter template. Auth, multi-tenant orgs, and AI chat are wired and ready."`

**La page d'accueil du produit, et son titre d'onglet, annoncent encore le
template.** Ce n'est pas un détail cosmétique : c'est la seule surface publique,
c'est ce que voit un prospect, c'est ce qu'indexe Google, c'est ce qui s'affiche
en aperçu quand quelqu'un partage le lien sur LinkedIn. **Rien ne peut être
vendu tant que cette ligne existe.** C'est aussi, à mes yeux, le symptôme le
plus parlant de la revue : huit lots d'ingénierie remarquable, et zéro minute
passée sur ce que verra le premier client.

Pas de `/produit`, pas de `/legal`, pas de `/privacy`, pas de tarifs, pas de
« demander une démo ». Le seul chemin est « Créer un compte ».

**Étape 1 — Inscription.** `/register` → e-mail/mot de passe ou magic link.
Fluide (hérité du template, éprouvé). Le premier utilisateur du déploiement
devient `superAdmin`.

**Étape 2 — Création de l'organisation.** `/app/onboarding` demande un nom et un
slug. Une seule question, pas de « combien de postes ouvrez-vous ? », pas de
choix de langue d'interface à ce moment. Acceptable.

**Étape 3 — Le tableau de bord.** `src/routes/app/$orgSlug/index.tsx` : quatre
KPI à zéro, deux cartes vides, un bouton « Nouveau poste ». L'état vide est
correct. **Mais la barre latérale contient « Items »**, une CRUD de démo du
template. Premier moment de doute pour le client.

**Étape 4 — Créer le premier poste.** L'assistant est bon : titre → questions →
critères → champs candidat → récapitulatif. Trois points de friction :

- **Le temps jusqu'à la première valeur est structurellement long.** Pour
  inviter un seul candidat, le recruteur doit : écrire ≥ 1 question, **s'enregistrer
  face caméra** (ou laisser la question en texte), définir des critères pondérés.
  Compter 20-40 minutes pour un premier poste sérieux. Il n'existe **aucun**
  raccourci : ni modèle de poste, ni « importer une offre » proposé dès l'étape 1
  (l'import existe, `ImportFromUrlDialog`, mais il est enfoui dans l'étape
  Questions), ni exemple pré-rempli, ni mode « essayer sur moi-même ».
  C'est, seul, le principal risque d'abandon en essai gratuit.
- **Le cul-de-sac de l'intro vidéo** décrit en §1.1 : il choisit « Introduction
  vidéo », aucun enregistreur n'apparaît, il ne comprend pas, il publie quand
  même — et son candidat tombe sur une page blanche.
- **La pondération par question est promise par le modèle de données et
  introuvable dans l'UI.** Il n'en saura rien, donc pas de friction immédiate,
  mais c'est une promesse commerciale qu'on ne peut pas tenir en démo.

**Étape 5 — Inviter.** `InviteCandidatesDialog` accepte un collage en masse et
montre ce qui a été compris **avant** d'envoyer (TESTING IB2). Très bon. Il peut
aussi copier le lien (`sessions.invitationLink`). L'e-mail part
(`candidateInvitationEmail`), il est bilingue et sobre.

**Manque ici** : aucune confirmation de ce qui se passe ensuite. Pas de
« vous serez prévenu par e-mail quand le rapport sera prêt ». Pas de relance
automatique (hors périmètre, assumé) — donc si le candidat n'ouvre pas, il ne
se passe **rien**, jamais, et personne ne le dit au recruteur.

**Étape 6 — L'attente.** C'est le trou le plus large du parcours recruteur.
- Aucune notification quand un candidat **commence**.
- Aucune notification quand un candidat **termine** (seulement quand le
  rapport est prêt).
- Si l'invitation **bounce**, le recruteur ne le voit nulle part : `emailLog`
  enregistre `bounced` via le webhook Resend, et aucune UI ne l'affiche
  (`emailEvents.recent` n'est appelée par personne). Il attendra une semaine un
  candidat qui n'a jamais reçu l'e-mail.
- La liste des candidats montre les statuts, mais il faut y aller.

**Étape 7 — Le rapport.** Là, le produit est excellent. `notifyRecruiter` envoie
« Rapport disponible » avec score et recommandation. La fiche ouvre sur le
verdict, puis les critères, puis **la citation cliquable qui saute à la seconde
exacte de la vidéo**. C'est le moment « aha », et il est réussi.

**Deux réserves** : (a) l'e-mail de rapport part à **tous les membres de
l'organisation** si le poste n'est pas restreint
(`convex/notifications.ts:82-94`), sans préférence individuelle ni opt-out —
30 recruteurs × 200 candidats = 6 000 e-mails, un signalement spam et un domaine
grillé ; (b) les **extraits marquants** sont calculés et jamais affichés.

**Étape 8 — Décider.** Quatre boutons, note privée, partage par lien.
Complet et bien fait.

**Ce qui manque pour que ce soit un flux de travail et pas une démo** : aucune
vue « tous les candidats de l'organisation » (la recherche ⌘K existe mais il
faut savoir quoi chercher), aucun tri par score dans la table, aucune action de
masse, et surtout **aucun moyen de dire non à un candidat depuis le produit** —
le recruteur clique « Rejeté » et… rien ne part. Dans la vraie vie, c'est
l'action qu'il fait 90 % du temps.

### 3.2 Candidat — une seule prise, et du stress

Je le lis comme quelqu'un qui a une chance et pas deux.

1. **L'e-mail.** `candidateInvitationEmail` : nom de l'org, intitulé, durée, un
   bouton. Dans la langue du poste. Sobre et rassurant. **Mais l'expéditeur est
   `RESEND_FROM` global** — pas le domaine du recruteur, pas de `reply-to` vers
   lui. Un candidat qui a une question répond dans le vide. Le spec avait prévu
   `reply_to` paramétrable ; ici non.
2. **La page d'accueil** (`/s/$token`). « Bonjour {prénom} », qui l'invite,
   combien de questions, combien de temps, « personne ne vous attend, vous
   choisissez quand commencer ». **C'est la meilleure copie que j'aie lue dans
   un produit d'entretien asynchrone.** Elle désamorce exactement la bonne peur.
3. **Le consentement.** Quatre points nommés, dont « une analyse automatisée
   résume vos réponses… elle assiste la décision, une personne la prend ».
   Juridiquement et humainement au bon niveau.
4. **Le test caméra/micro.** Choix d'appareil, barre de niveau, « dites quelque
   chose », message dédié si l'accès est refusé, **détection du navigateur
   in-app** (LinkedIn/Gmail mobile) avec conseil d'ouvrir dans Safari/Chrome.
   C'est là que 30 % des entretiens se perdent d'habitude ; ici c'est traité.
5. **L'entretien.** « Question 3 sur 7 », bouton « J'ai terminé ma réponse »
   toujours visible, décompte à 30 s, « Enregistrement de votre réponse… gardez
   cette page ouverte », avertissement à la fermeture d'onglet. Conforme §4.2.
6. **L'échec d'envoi.** Trois tentatives, puis un écran explicite : « votre
   dernière réponse n'a pas été enregistrée », **Réessayer** (qui renvoie
   réellement les octets conservés, cf. `pendingRecordingRef`) ou **Passer**.
   La panne est visible. C'est le contraire exact de l'ancienne version.
7. **La fin.** « C'est tout — merci », ce qui va se passer, lien vers ses
   données. Puis… **plus rien, jamais.** Aucun e-mail de confirmation. Pour un
   candidat, ça veut dire : aucune preuve d'avoir postulé, aucune trace du lien
   vers sa page vie privée (qui est son seul moyen d'exercer son droit à
   l'effacement), aucun moyen de retrouver l'entretien. **C'est un manquement
   produit et un point faible RGPD** : on lui a promis un droit d'effacement
   accessible « à tout moment » et on ne lui laisse pas l'adresse pour l'exercer.

**Frictions candidat restantes** : si le poste a une intro vidéo mal configurée,
écran blanc (§1.1) ; si sa connexion est mauvaise mais pas coupée, aucun
avertissement ; s'il a un problème, `interview.json` propose « Something not
working? » dans le shell — **je n'ai trouvé aucun canal derrière** (le
`report-interview-issue` du spec n'a pas été reconstruit). Un candidat bloqué
n'a personne à qui écrire.

### 3.3 Le moment « aha »

Il est net et bien choisi : **cliquer sur une citation du rapport et voir la
vidéo sauter à la seconde où le candidat l'a dite.** C'est ce qui transforme
« une IA a noté quelqu'un » en « j'ai un dossier que je peux défendre en comité ».

Le problème n'est pas le moment, c'est **la distance jusqu'à lui** : créer un
poste, s'enregistrer, inviter, attendre qu'un vrai humain passe un entretien de
15 minutes, attendre la transcription et le rapport. **En essai, le premier
« aha » est à J+2 minimum, souvent J+5.** Aucun mécanisme ne le raccourcit : pas
de rapport d'exemple, pas de mode démo (hors périmètre — et cet arbitrage,
justifié techniquement, est la décision la plus coûteuse commercialement de tout
le PROMPT).

---

## 4. Ce qui manque pour vendre

### 4.1 Facturation, plans, limites — **totalement absent**
`grep -i "stripe\|billing\|plan\|quota\|credit"` sur `src/` et `convex/` ne
renvoie que des commentaires. Conséquences concrètes :
- N'importe qui crée un compte sur `/register` et consomme de la transcription
  Mistral + du Gemini via OpenRouter **sans plafond** (les rate-limiters de
  `convex/rateLimiters.ts` bornent le débit, pas le volume mensuel).
- Aucune notion d'organisation « payante ».
- Aucun moyen de couper un compte qui abuse sauf à le supprimer à la main.
- Ancienne version : `session_credits_total` / `pricing` en texte libre. On n'a
  même pas ça. Le modèle économique n'existe nulle part dans le produit.

### 4.2 Mesure de la consommation et du coût par entretien — **impossible en l'état**
`jobLog` enregistre `step`, `outcome`, `attempt`, `durationMs`, `error`
(`convex/schema.ts`). **Il n'enregistre ni tokens, ni secondes d'audio, ni coût.**
`convex/lib/ai.ts` ne lit pas `usage` dans les réponses OpenRouter/Mistral.
`segments.durationSeconds` existe — c'est la seule brique exploitable, et il
faudrait l'agréger à la main.

Donc, aujourd'hui, **un CEO ne peut pas répondre à « combien me coûte un
entretien ? »**, ce qui rend impossible de fixer un prix, de calculer une marge
brute, et de savoir si un gros client est rentable. C'est le trou business
numéro un, et il est bon marché à combler : trois champs dans `jobLog`
(`inputTokens`, `outputTokens`, `audioSeconds`) et la lecture de `usage` dans
`ai.ts`. **Une journée de travail qui détermine tout le pricing.**

### 4.3 Onboarding d'équipe
Les invitations d'organisation (template) marchent. Manquent :
**aucune définition de rôle propre au métier** (owner/admin/member générique —
pas de « hiring manager en lecture seule »), **aucune préférence de
notification** (§3.1 : tout le monde reçoit tout), **aucun profil
d'organisation** (logo dans l'e-mail candidat ? le template stocke `logoUrl`
mais `candidateInvitationEmail` ne l'utilise pas — l'invitation n'est donc pas
aux couleurs du client).

### 4.4 Résidence des données — **le pitch souveraineté est faux en l'état**
Ce qui est fait, et bien fait : Convex EU West (imposé dès le README et
`.env.example`, non modifiable après coup) ; stockage objet Scaleway `fr-par`,
bucket privé, URL signées ; transcription **Mistral en direct**, européen — et
`convex/lib/ai.ts:10` l'assume explicitement comme choix de conception.

Ce qui casse le récit : **l'évaluation passe par OpenRouter vers
`google/gemini-2.5-flash` / `google/gemini-2.5-pro`** (`convex/lib/ai.ts:24-25`).
OpenRouter est américain et route vers Google. Or ce qu'on lui envoie, c'est
`reportPrompt` = **la transcription intégrale de l'entretien du candidat**,
c'est-à-dire la donnée personnelle la plus riche du système. Et l'assistant
recruteur tourne sur Anthropic (`claude-haiku-4-5`) avec accès en lecture aux
rapports (`recruiterTools.ts`).

**Ce risque n'est documenté nulle part** : `grep -i "openrouter\|residency\|
souverain\|sovereign\|RGPD\|AI Act"` sur `KNOWN_ISSUES.md`, `CLAUDE.md`,
`README.md` ne renvoie **rien**. Un client public ou un grand compte français
posera la question dans les dix premières minutes, et il n'y a pas de réponse
écrite. Trois options, à trancher : (a) basculer l'évaluation sur
`mistral-large` via OpenRouter en épinglant les fournisseurs européens, (b)
appeler Mistral en direct pour l'évaluation aussi, (c) assumer et le documenter
noir sur blanc dans un registre de traitements. **Ne pas choisir est la seule
option inacceptable.**

### 4.5 RGPD — artefacts
Bon : consentement explicite et lisible (`interview.json` § `consent`), page
vie privée candidat avec auto-effacement réel, `purgeLog` avec hash d'adresse
(vrai registre de destruction), rétention 12 mois par défaut
(`convex/retention.ts`, en dur), objets avant lignes.

Manque : **rétention non configurable par organisation** (un client qui exige 6
mois ne peut pas) ; **aucune politique de confidentialité publique** (pas de
route `/privacy` ni `/legal`) ; **aucun DPA type ni liste de sous-traitants**
(Convex, Scaleway, Mistral, OpenRouter/Google, Resend, Anthropic, Sentry,
Vercel — huit sous-traitants, zéro document) ; **aucun registre de traitements** ;
pas d'export des données du candidat (droit à la portabilité — on a l'effacement,
pas l'accès) ; l'e-mail de fin qui porterait le lien vie privée n'existe pas
(§3.2).

### 4.6 AI Act — recrutement = système à haut risque (Annexe III)
Ce qui est déjà là, et ce n'est pas rien : disclaimer IA permanent et non
masquable (`AiDisclaimer.tsx`, `variant="full"`, y compris sur le rapport
partagé) ; clause anti-discrimination dans **tous** les prompts
(`convex/lib/prompts.ts:24`) et dans les instructions du copilote ; outils IA
**read-only** sur les données de recrutement — une décision ne peut pas être
prise par un appel d'outil ; sortie du modèle validée par Zod, pas de réparation
silencieuse ; toute affirmation adossée à une citation ré-ancrée
(`convex/lib/evidence.ts`), une citation non retrouvée renvoie `null`.
**C'est déjà au-dessus de la moyenne du marché.**

Ce qui manque pour une mise en conformité réelle :
- **Journal d'événements au sens Art. 12** : `jobLog` trace la mécanique
  (durée, issue), pas la **décision** — qui a vu quel rapport, qui a décidé
  quoi, quand. `recruiterDecisionBy/At` existe sur la ligne mais est écrasé à
  chaque changement : **pas d'historique**. Pour un contrôle, c'est la première
  pièce demandée.
- **Version du modèle figée par rapport** : `reports.model` stocke le nom, pas
  la version exacte ni le prompt utilisé. Un rapport de mars n'est pas
  rejouable en juin.
- **Supervision humaine outillée** : le disclaimer dit que l'humain décide ;
  rien ne l'oblige ni ne le trace (pas de « j'ai revu la vidéo », pas de
  justification obligatoire pour un rejet).
- **Notice candidat au sens Art. 86** (droit à explication d'une décision
  individuelle) : absente.
- **Aucune évaluation de biais** ni jeu de test d'évaluation reproductible —
  la spec §13 le notait déjà comme dette ; elle n'est pas reprise.

### 4.7 Accessibilité candidat
Sujet légal réel (RGAA pour les employeurs publics et certaines grandes
entreprises françaises) **et** sujet d'équité : un entretien inaccessible exclut
un candidat handicapé d'un poste. Ce que je vois : les primitives shadcn/Radix
donnent une base correcte (focus, rôles), et le skill `web-design-guidelines`
est vendu dans le repo. Ce que je ne vois pas : **aucune alternative pour un
candidat qui ne peut pas parler ou entendre** (pas de sous-titres sur le média
de question, pas de réponse écrite possible), aucun test lecteur d'écran dans
`TESTING.md`, aucune déclaration d'accessibilité. **Un client grand compte a une
clause RGAA dans son appel d'offres.** À anticiper, pas à découvrir.

### 4.8 Délivrabilité e-mail
Un seul expéditeur (`RESEND_FROM`), aucune mention de SPF/DKIM/DMARC dans
`README.md` ou `.env.example` (`onboarding@resend.dev` est cité pour le dev —
piège classique si quelqu'un le laisse en prod). Pas de sous-domaine dédié
(l'ancienne version avait `notify.interw.ai` : bonne pratique perdue). Le webhook
de rebond existe mais **n'alimente aucun écran** (§1.5). Et l'e-mail de rapport
à toute l'organisation (§3.1) est un générateur de plaintes. **Une invitation qui
tombe en spam, c'est un entretien perdu et un client qui conclut « ça ne marche
pas ».**

### 4.9 Télémétrie produit — **néant**
Ni PostHog, ni Plausible, ni Amplitude, rien. Conséquence directe : **impossible
de mesurer le taux d'activation** (inscrits → premier poste publié → premier
candidat invité → premier rapport lu), impossible de savoir où les gens
décrochent dans l'assistant de création, impossible de connaître le taux de
complétion des candidats — **qui est la métrique cardinale de ce produit** (il
est d'ailleurs calculable côté serveur : `projects.sessionCount` /
`completedSessionCount` existent, mais ne sont agrégés nulle part au-delà du
tableau de bord d'une org).

`sessionEvents` (`device_check_failed`, `upload_failed`, `network_degraded`…)
est un **trésor de diagnostic** — écrit, jamais lu. Trois requêtes agrégées et
on saurait quel navigateur casse.

### 4.10 Outillage support / admin
`src/routes/app/admin.tsx` = celui du template. Pas d'impersonation
(`KNOWN_ISSUES.md:836` l'assume comme hors MVP), pas de vue file de traitement,
pas de compteur d'échecs par étape (pourtant exigé au §3.6), pas de relance
manuelle d'un job, pas de recherche de session par e-mail candidat, pas d'accès
aux `sessionEvents`. **Quand un candidat écrira « ça n'a pas marché », personne
chez Interw ne saura répondre** — et il n'a même pas d'adresse où écrire (§3.2).

### 4.11 Page de statut, i18n, mobile
Pas de page de statut ni de canal d'incident. i18n : fr/en uniquement — correct
pour la France, bloquant pour un client qui recrute en Espagne ou en Allemagne
(le modèle de données a `language: 'fr' | 'en'` **en dur dans le schéma**
(`convex/schema.ts languageValidator`) : l'ouvrir touchera la base, les prompts
et les e-mails. À élargir tôt ou à assumer longtemps). Mobile : le code prévoit
la branche MP4 Safari et `use-mobile.ts` existe, mais **rien ne prouve qu'un
entretien ait été passé sur un iPhone** — or c'est là que la moitié des
candidats ouvriront leur lien.

---

## 5. Risques produit, classés

| # | Risque | Probabilité | Impact | Pourquoi |
|---|---|---|---|---|
| 1 | **Un entretien échoue sur Safari/iOS et on l'apprend par le client** | **Élevée** | **Critique** | Aucun test navigateur automatisé (DoD §2 non tenu), branche MP4 jamais exercée en CI, `MediaRecorder` sur iOS est le composant le plus capricieux du web. Le candidat a **une** prise ; l'échec est irréversible et se voit chez le client, pas chez nous. C'est le risque qui tue la confiance en une seule occurrence. |
| 2 | **Le premier client n'atteint jamais le moment « aha »** | **Élevée** | **Élevé** | 20-40 min pour créer un poste, puis attendre un vrai candidat. Pas de modèle, pas d'exemple, pas de démo. Le taux d'abandon en essai sera massif — et sans télémétrie (§4.9) **on ne saura même pas à quelle étape il décroche**. |
| 3 | **Coût par entretien inconnu → pricing au doigt mouillé** | **Certaine** | **Élevé** | `jobLog` n'enregistre ni tokens ni durée audio. Transcription Mistral + Gemini Pro sur une transcription longue peut aller de 0,05 € à plusieurs euros selon la durée. On peut signer un contrat à perte sans le voir venir pendant six mois. |
| 4 | **Un candidat perd son entretien ou ne peut pas exercer ses droits, et personne ne peut l'aider** | **Moyenne** | **Élevé** | Aucun e-mail de fin (donc pas de trace du lien vie privée), « Something not working? » sans canal derrière, pas d'outillage support côté admin, bounce d'invitation invisible. Sur un produit de recrutement, un candidat mécontent parle publiquement — et c'est l'employeur client qui en paie le prix. |
| 5 | **Question de souveraineté en appel d'offres, sans réponse écrite** | **Moyenne** | **Élevé** | La transcription intégrale part chez Google via OpenRouter, alors que tout le reste du récit est européen. Aucune ligne dans `KNOWN_ISSUES.md` ni dans un document client. Un « non » d'un grand compte français ou d'un acteur public se joue là. |

*Juste sous la barre* : l'e-mail de rapport à toute l'organisation (domaine
d'envoi grillé) ; le cul-de-sac de l'intro vidéo (`StepBasics.tsx`) ; la landing
« MVP starter » (crédibilité, nulle chance qu'un prospect aille plus loin).

---

## 6. Ce que j'aurais fait autrement

### 6.1 Séquencement — non, construire les 8 lots avant un client n'était pas juste
La qualité d'ingénierie livrée est réelle et rare : pas de `catch {}`, pas d'URL
en base, un bundle candidat isolé par ESLint, l'audit d'accès en CI, l'i18n
complète, aucun script de rattrapage, zéro scope creep. **Sur la dette technique,
le pari est gagné.**

Mais le programme a produit un système complet **sans jamais confronter une seule
hypothèse produit**. Le prix se voit à trois endroits :

1. La **landing** n'a pas été touchée. Elle annonce encore un template. Personne
   n'a eu à en faire la démo, donc personne ne l'a vue.
2. Des fonctions sont **terminées côté serveur et invisibles côté écran** :
   extraits marquants, pondération par question, suivi de délivrabilité, intro
   audio/vidéo. Du travail payé et non converti. Avec un utilisateur dans la
   boucle, aucune de ces quatre n'aurait été laissée à 90 %.
3. Des **manques évidents à l'usage** n'ont été vus par personne : pas d'e-mail
   de fin au candidat, pas de notification de complétion, aucun moyen de
   répondre à un candidat, aucune vue « tous mes candidats ».

L'ordre que j'aurais imposé : **lots 1-2-3-4-5 tels quels** (le moteur d'entretien
et la chaîne de traitement sont le produit, ils méritaient ce soin), puis
**STOP — un vrai poste, un vrai candidat, un vrai rapport, avec un vrai
recruteur qui regarde**, et seulement ensuite les lots 6-7-8 réordonnés par ce
qu'on aurait appris. Le lot 8 (durcissement) aurait dû **suivre** le premier
client, pas le précéder.

### 6.2 Coupes que j'aurais faites dans le périmètre commandé
- **La matrice de fit** (double grille critère × question). Le rapport
  « verdict + critères + citations » suffit à emporter la décision ; la matrice
  double le coût modèle et la surface de validation Zod pour un gain marginal.
- **Les extraits marquants** — ou alors on les affiche. À moitié, ils ne valent
  rien (et là ils sont à moitié).
- **Le copilote IA.** Il est bien fait et read-only, mais aucun recruteur ne
  réclame un chat avant d'avoir dix rapports. C'est du lot 9.
- **La recherche globale** : utile à 200 candidats, pas à 5.

### 6.3 Ce que j'aurais ajouté malgré le « hors périmètre »
Deux choses seulement, et je les aurais signalées comme le PROMPT §9 le demande :
- **Un rapport d'exemple pré-généré**, visible dès l'inscription. Ce n'est pas
  le « mode démo » interdit (pas d'enregistrement, pas de session) : c'est un
  rapport figé en fixture. Il ramène le moment « aha » de J+2 à 30 secondes.
  **C'est la chose la plus rentable qui ne soit pas dans le PROMPT.**
- **La comptabilisation du coût par entretien.** Trois champs. Sans elle, il
  n'y a pas d'entreprise, seulement un logiciel.

### 6.4 Les deux prochaines semaines (ordre strict)
1. **Réécrire la landing** (titre, méta, promesse, capture de l'écran de
   rapport, un CTA). Une demi-journée. Rien n'est vendable avant.
2. **Supprimer les débris du template** : `items.ts`, la route, la table, les
   trois outils d'écriture du copilote, l'entrée de nav. Une demi-journée.
3. **Boucher le cul-de-sac de l'intro** : soit brancher `MediaRecorderField` sur
   l'intro (le backend `convex/media.ts` est déjà là, ~2 h), soit retirer
   `audio`/`video` de `INTRO_MODES`. Ne jamais laisser un choix sans effet.
4. **Instrumenter le coût** : `usage` lu dans `ai.ts`, `inputTokens` /
   `outputTokens` / `audioSeconds` dans `jobLog`, une requête d'agrégation.
5. **L'e-mail de fin au candidat**, portant le lien vers sa page vie privée.
   Le gabarit `candidateInvitationEmail` sert de moule. Deux heures, et c'est
   à la fois produit et conformité.
6. **Un parcours candidat automatisé sur Chrome + WebKit** (Playwright, caméra
   factice via `--use-fake-device-for-media-stream`). C'est le critère 2 du DoD
   et le risque n° 1. Deux à trois jours, et ils valent tout le reste.
7. **Faire passer un vrai entretien à trois humains sur trois téléphones.**
   Une journée. Elle apprendra plus que les six points au-dessus.

### 6.5 Les deux mois suivants
- **Facturation** (Stripe, 2 plans, un compteur d'entretiens, un plafond dur).
- **Écran de santé** : file de traitement, échecs par étape (§3.6 jamais livré),
  délivrabilité e-mail (la query `emailEvents.recent` n'attend qu'un écran),
  agrégats `sessionEvents`.
- **Télémétrie d'activation** + le tunnel inscription → premier rapport lu.
- **Dossier conformité** : trancher OpenRouter, rédiger politique de
  confidentialité, DPA, liste de sous-traitants, registre ; historiser les
  décisions recruteur (AI Act Art. 12) ; rétention configurable par org.
- **Support** : impersonation super-admin, recherche de session par e-mail,
  une adresse de contact derrière « Something not working? ».
- **Accessibilité** : sous-titres sur les médias de question, audit RGAA.

### 6.6 Feuille de route, une page

| Horizon | Thème | Sortie mesurable |
|---|---|---|
| S1 | **Crédibilité** | Landing réelle, débris supprimés, intro réparée, e-mail de fin candidat |
| S2 | **Preuve** | Parcours candidat automatisé Chrome + WebKit en CI ; 3 entretiens réels sur mobile ; coût par entretien mesuré |
| S3-S4 | **Premier client payant** | 1 client conduit à la main de bout en bout ; rapport d'exemple à l'inscription ; télémétrie d'activation |
| M2 | **Vendable en self-serve** | Stripe + plans + plafonds ; écran de santé & délivrabilité ; dossier conformité (résidence tranchée, PC/DPA publiés) |
| M3 | **Défendable en grand compte** | Historique des décisions (AI Act), rétention par org, accessibilité, SSO, page de statut |

---

## 7. Verdict — dix lignes

1. **Oui, c'est une base sur laquelle on peut bâtir une entreprise** — et c'est
   la seule question qui a une réponse franche dans cette revue.
2. Le socle technique est d'un niveau qu'on voit rarement à ce stade : sécurité
   par construction (aucune URL en base, audit d'accès en CI, bundle candidat
   isolé par lint), chaîne de traitement idempotente sans aucun script de
   rattrapage, i18n complète, zéro élargissement de périmètre.
3. Le différenciant — **chaque affirmation de l'IA cliquable jusqu'à la seconde
   de vidéo qui la justifie** — est réellement implémenté, testé, et ré-ancré
   côté serveur. C'est ce qui fait vendre, et c'est là.
4. La posture éthique (disclaimer permanent, clause anti-discrimination dans
   tous les prompts, outils IA read-only sur les données de recrutement) est
   au-dessus du marché et sera un argument commercial, pas une contrainte.
5. Le périmètre v1 est tenu à environ **85 %** : quatre fonctions sont finies
   côté serveur et invisibles à l'écran (extraits marquants, pondération par
   question, délivrabilité, intro audio/vidéo).
6. La définition du terminé est tenue à **5 critères sur 8**. Le manque n'est
   pas dans le code, il est dans la **preuve** : aucun test navigateur, aucune
   exécution constatée de bout en bout, aucune purge vérifiée contre un vrai
   bucket.
7. Ce n'est pas encore un produit vendable : pas de landing (elle annonce
   toujours « MVP starter »), pas de facturation, pas de mesure de coût, pas de
   télémétrie, pas d'outillage support, pas de document de conformité.
8. Le parcours candidat est excellent jusqu'à la dernière seconde, puis il
   s'arrête net : **aucun e-mail de fin**, donc aucune trace, aucun lien vers
   ses droits, aucun interlocuteur. C'est le défaut le plus facile à corriger et
   le plus coûteux à laisser.
9. Le risque numéro un reste Safari/iOS : le candidat a une seule prise, et rien
   ne prouve aujourd'hui qu'elle tienne sur la moitié des appareils.
10. **La décision la plus importante maintenant : arrêter d'ajouter des
    fonctions et conduire un client réel de bout en bout cette semaine** — un
    poste, trois candidats sur trois téléphones, un rapport, une décision. Tout
    ce qui manque dans ce rapport sortira de cette journée-là, classé par la
    réalité et non par mes soins.

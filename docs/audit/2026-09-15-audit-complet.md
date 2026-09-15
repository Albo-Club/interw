# Interw — audit complet du 15 septembre 2026

Audit en lecture seule de la base de code reconstruite sur `albo-ouvre-boîte`
(16 commits, un seul PR mergé, tout écrit le 14/09 par un agent sans accès à un
déploiement). Six revues spécialisées ont été menées en parallèle, puis
recoupées et re-hiérarchisées ; chaque constat « Confirmé » ci-dessous a été
relu dans le code par l'orchestrateur, et quatre ont été reproduits (en-têtes
HTTP dans Chromium, purge de rétention avec `convex-test`, parité i18n, taille
du bundle sur le build). Les six rapports détaillés sont dans
[`2026-09-15/`](./2026-09-15/) : chacun cite les lignes, le scénario d'échec et
le correctif.

Baseline au moment de l'audit : `pnpm typecheck`, `pnpm lint` (0 warning),
`pnpm test` (22 fichiers, 256 tests, 3,7 s), `pnpm build`,
`pnpm audit:access:check`, `pnpm codegen:api:check` — tous verts.

---

## 1. Verdict en dix lignes

1. **La base est bonne, et rare à ce stade** : aucune URL en base, projecteurs
   explicites testés, jeton à porte unique, clés d'objet dérivées serveur,
   sorties de modèle validées sans réparation, i18n complète et alignée, bundle
   candidat isolé par ESLint (254 Ko gzip contre 2,96 Mo avant), zéro
   `catch {}` dans le code Interw, zéro script de rattrapage, zéro
   élargissement de périmètre.
2. **Elle n'est pas livrable en l'état, et pas pour des raisons de
   conception** : deux lignes d'en-têtes HTTP héritées du template rendent
   l'enregistrement impossible sur Chrome et la lecture vidéo impossible
   partout. Ni le lot 4 ni le lot 6 n'ont pu être « passés » : le produit n'a
   jamais tourné dans un navigateur.
3. La purge de rétention **ne purge rien** (sémantique d'index), et l'expiration
   des liens partagés **est décidée par l'horloge du client**. Deux garanties
   annoncées dans la doc et fausses dans le code.
4. Le pipeline est idempotent mais **pas résilient** : une transcription qui
   échoue quatre fois gèle la session pour toujours, sans alerte, et rien ne
   permet de la relancer.
5. Le différenciant (citation cliquable ré-ancrée à la seconde) est réel, mais
   il **ment quand il ne trouve pas la citation** : il retombe sur l'estimation
   du modèle alors que `CLAUDE.md` exige `null`.
6. Le périmètre v1 est tenu à ~85 % ; **quatre fonctions sont finies côté
   serveur et invisibles à l'écran** (intro audio/vidéo — impasse réelle —,
   pondération par question, extraits marquants, délivrabilité).
7. **Le produit se présente encore comme le template** : landing « MVP
   starter », onglet « Items » dans la barre latérale, outils d'écriture
   `items` dans le copilote, changelog du template, entrées Interw en clés
   brutes.
8. La définition du terminé est tenue à 5/8 ; le manque n'est pas dans le code
   mais dans la **preuve d'exécution** : aucun test navigateur, aucun test
   authentifié (`withIdentity`), un script d'audit d'accès textuel qui ne peut
   pas voir la classe de faille qu'il prévient.
9. Ce qui manque pour vendre est entièrement hors code : coût par entretien
   non mesurable, aucune facturation, aucune télémétrie, récit de souveraineté
   contredit par l'envoi des transcriptions à Google via OpenRouter, sans
   document de conformité.
10. **Décision la plus importante maintenant** : corriger les dix bloquants
    ci-dessous (deux jours), puis **faire passer un vrai entretien à trois
    humains sur trois téléphones** avant d'ajouter une seule fonction.

---

## 2. Les bloquants — à corriger avant tout candidat réel

Classés par ce qu'ils coûtent, pas par domaine. Tous **Confirmés**.

| # | Constat | Où | Effet | Correctif (taille) |
|---|---|---|---|---|
| B1 | `Permissions-Policy: camera=(), microphone=()` sur toutes les réponses. Une allowlist vide désactive la caméra pour le document lui-même. **Reproduit dans Chromium : `getUserMedia` → `NotAllowedError`.** `check.tsx` classe ça en « permission refusée » et conseille une icône qui n'existe pas. Le smoke test `scripts/e2e-smoke.mjs:105` **assert** cette valeur. | `src/start.ts:12-15` | Aucun candidat ne peut enregistrer sur Chrome/Edge. | `camera=(self), microphone=(self)` — 1 ligne, + corriger le smoke test |
| B2 | CSP sans `media-src` → `default-src 'self'` bloque tout `<video src="https://…scw.cloud/…">`. **Reproduit dans Chromium.** | `src/start.ts:19-31` | Les questions vidéo du recruteur, le lecteur de la fiche candidat et le rapport partagé ne lisent rien. | Ajouter `media-src 'self' https://<bucket-host> blob:` — 1 ligne |
| B3 | L'aperçu caméra n'est jamais rattaché au `<video>` : le flux est acquis pendant l'écran squelette (`videoRef` nul), et `ensureStream` renvoie ensuite le flux caché sans le rebrancher. | `src/routes/s/$token/interview.tsx:111-126,138-174` | Écran noir pendant tout l'enregistrement. Le candidat ne se voit pas. | Effet `useEffect` qui pose `srcObject` quand le flux et la ref existent |
| B4 | L'expiration des liens de partage est comparée à `now` **fourni par le client** ; idem pour la lecture des questions/médias d'un poste expiré. `view({token, now: 0})` ressuscite un lien expiré et `sharedMediaUrls` signe des URL S3 d'une heure sur les vidéos. | `convex/shares.ts:38-57,144,262` ; `convex/interview.ts:77-106,134-176` | Une expiration n'est plus une frontière. La révocation, elle, tient. | Dans les actions : `Date.now()` serveur (2 lignes). Dans les queries : borner (`Math.max(now, …)`) ou matérialiser l'état par cron. Ajouter le test `now: 0`. |
| B5 | La purge de rétention ne retourne jamais rien : `q.lt('purgeAfter', before)` sur un champ optionnel place toutes les sessions **sans** `purgeAfter` en tête d'index, `take(25)` est saturé, le `.filter()` les jette. **Reproduit avec `convex-test` : 40 sessions `pending` + 1 échue → `[]`.** Et `clearSessionMedia` remet `purgeAfter: undefined`, ce qui aggrave. | `convex/purge.ts:182-193` | Aucune vidéo n'est jamais purgée. « 0 purgé » est aussi la réponse normale, donc silencieux. | `q.gt('purgeAfter', 0).lt('purgeAfter', before)` + test de 6 lignes |
| B6 | `purgeAfter` n'est écrit qu'à `finish`. Une session abandonnée (CV, vidéos partielles, nom, e-mail) n'a jamais d'horloge. `status: 'expired'` n'est écrit par personne. | `convex/interview.ts:451-459` | Les candidatures non abouties — la majorité — sont conservées sans limite. | Poser `purgeAfter` à l'invitation (fenêtre courte), prolonger à `finish` |
| B7 | Après 4 échecs de transcription, `onTranscribeComplete` ignore `result`, le gate « tous transcrits » n'est plus jamais réévalué, `onSessionCompleted` n'a qu'un appelant (`finish`). Ni cron, ni bouton, ni alerte, ni Sentry côté Convex (`grep` vide), ni compteur super-admin (l'index `by_step_and_outcome` n'est lu nulle part). | `convex/pipeline.ts:235-273` ; `convex/lib/workpools.ts:17` ; `src/routes/app/admin.tsx` | Une clé Mistral expirée = tous les entretiens terminés perdus, découverts par le client. | Lire `result`, traiter l'échec terminal comme un état, générer un rapport partiel signalé ; Sentry dans chaque `catch` ; compteurs sur `/app/admin` |
| B8 | `ShareProjectDialog` remet la sélection à `[]` à l'ouverture, et `setShares` traite la liste comme l'ensemble complet. Ouvrir + Enregistrer **dé-restreint** un poste confidentiel (l'en-tête affiche même « Tout le monde »). `sharedWith` est renvoyé par `getBySlug` et jamais lu. | `src/components/projects/ShareProjectDialog.tsx:49-51` ; `convex/projects.ts:363` | Un poste confidentiel devient visible de toute l'organisation au premier clic. | Pré-remplir depuis `sharedWith` |
| B9 | L'échec de « Terminer l'entretien » n'a **aucun rendu** : l'`Alert` d'erreur est dans la branche `current &&`, pas dans la branche `finished`. | `src/routes/s/$token/interview.tsx:302-313,380-394` | Réseau qui tombe au dernier clic → session bloquée `in_progress`, pipeline jamais lancé, candidat qui reclique dans le vide. | Sortir l'alerte et le bandeau d'envoi du bloc `current &&` |
| B10 | Le produit se présente comme le template : `landing.json` « B2B MVP starter template », titre d'onglet global « interw — MVP starter » (`common.json:3`), « Items » dans la sidebar (`nav.ts:41`) avec route et CRUD vivants, outils d'écriture `createItem/updateItem/deleteItem` enregistrés dans le copilote (`convex/agent.ts:21`) et suggérés (« Crée un élément nommé "Roadmap" »), 9 entrées de changelog du template, et les **2 entrées Interw affichées en clés brutes** (`entries.report-sharing.title`, elles sont au mauvais niveau du JSON). | `src/locales/*/landing.json`, `common.json`, `changelog.json` ; `src/components/app-shell/nav.ts` ; `convex/agent.ts` ; `src/components/app-shell/WhatsNew.tsx:81` | Premier signal « produit pas fini » qu'un prospect voit, avant même de créer un poste. | Une demi-journée : landing, titre, suppression d'`items` (table, route, outils, nav, i18n, TESTING), changelog |

---

## 3. Constats élevés, par domaine

Chaque ligne renvoie au rapport détaillé (fichier et identifiant du constat).

### 3.1 Parcours candidat (`2026-09-15/candidat.md`)

- **E1** Le périphérique choisi à l'écran de test est jeté : l'entretien
  réacquiert `audio: true` sans `deviceId`. Un candidat qui sélectionne son
  casque enregistre sur le micro intégré qu'il vient d'écarter.
- **E2** Aucun repli audio-seul : caméra prise par Teams (`NotReadableError`)
  = entretien perdu, alors que tout le reste de la chaîne accepte un segment
  sans vidéo.
- **E6** Deux curseurs de reprise divergents (`lastQuestionIndex` serveur,
  `firstUnanswered` client). Après un « Passer », l'accueil annonce la
  question 4, l'entretien reprend en 1, puis **ré-enregistre la 2 déjà
  répondue et l'écrase dans le bucket** (même clé). `resumeAtIndex` renvoyé
  par le serveur n'est jamais lu.
- **E7** Si `recorder.stop()` jette, « Réessayer » ne fait rien
  (`pendingRecordingRef` nul) ; `stopAndFlush` n'a pas de timeout → « Saving
  your answer… » peut rester affiché indéfiniment.
- **E8** Aucune gestion de `visibilitychange`, `track.onended`, `devicechange` :
  arrière-plan mobile ou casque débranché = enregistrement vide, invisible.
- **E9** Aucune progression d'envoi (`fetch` n'en expose pas) et aucun
  `videoBitsPerSecond` : 3 min en 720p ≈ 50 Mo, plusieurs minutes d'écran figé
  sur 4G. Pas de multipart, pas de `timeslice` (pipeline, M12 / candidat, M2).
- **E10** Le jeton d'accès (segment d'URL, lecture **et** écriture, y compris
  `deleteMyData`) part dans Sentry, et `InterviewCrash` appelle
  `captureException` **pendant le rendu**.
- **E4** La page vie privée crashe après une suppression réussie
  (`useConvexQuery` jette `not_found` avant le garde `if (deleted)`) : le
  candidat ne voit jamais la confirmation RGPD.
- **E5** Jeton inconnu → carte d'erreur du back-office avec « Go home » vers
  la landing marketing ; la copie `state.notFound` est morte ; `TESTING.md`
  IB15 échouera. Même mécanisme sur `/interview` pour un entretien expiré ou
  terminé.
- Pipeline **E8** : si la vidéo échoue après l'audio, la réponse est perdue
  alors que l'audio — seul fichier transcrit — est arrivé ; le commentaire dit
  l'inverse de ce que fait le code.
- **M4** 18 clés `interview` écrites en deux langues et jamais rendues, dont
  « ce qu'il vous faut » (endroit calme, page ouverte) et le lien vie privée
  du shell (`footer` jamais passé). La langue de la surface est celle du
  navigateur, pas `project.language`.
- **M5/M6/M7** Boutons Réessayer/Passer à 32 px, aucun `aria-live`, aperçu
  caméra en 16:9 forcé (bande horizontale en portrait), pas de `facingMode`.
- **M8** On peut terminer avec un segment `failed` sans récapitulatif ; l'écran
  de fin est un titre et un bouton.

### 3.2 Application recruteur (`2026-09-15/recruteur.md`)

- **E3** Les URL signées (1 h) ne sont jamais rafraîchies, et l'effet dépend
  de `data` (query réactive) : enregistrer une note recharge la vidéo à 0,
  et après une heure toutes les preuves cliquables sont mortes en silence.
- **E4** Le tableau des candidats n'a **ni score, ni recommandation, ni tri,
  ni filtre** ; `listByProject` ne lit pas `reports`. Le recruteur ne peut pas
  comparer — l'usage central de l'écran. La clé `list.columns.score` existe.
- **E6/E7** Câblé serveur, sans interface : intro audio/vidéo (le sélecteur
  propose les modes → **écran vide côté candidat**), pondération par question,
  suppression de poste, lien d'invitation (`invitationLink` jamais appelé :
  pas de « copier le lien »), avatar de persona, **relecture du média de
  question** (`playbackUrls` jamais appelé — la porte du lot 2 n'est pas
  franchie), extraits marquants (générés, stockés, jamais affichés),
  délivrabilité (`emailEvents.recent` morte).
- **E8** Le layout `/app/$orgSlug` importe statiquement le panneau IA
  (streamdown/shiki/katex/mermaid, 131 Ko gzip) sur toutes les pages ; ouvert
  par défaut ; `fixed inset-0 z-50` sous `lg` → sur mobile le premier écran
  après connexion est le chat plein écran, sans piège de focus ni Échap.
- **E9** L'effacement RGPD d'un candidat, `archive` (qui coupe tous les liens
  en cours), `setDecision`, `shares.create` n'exigent aucun rôle ; supprimer un
  poste vide exige owner/admin. Asymétrie non motivée.
- **M1** Aucune route recruteur ne définit `errorComponent`/`notFoundComponent` ;
  un slug erroné renvoie à la landing. **M12** Aucun moyen de relancer un
  rapport en échec. **M2** Pas de gabarit d'invitation éditable (lot 3).
  **M10** Une question au contenu vide peut être publiée.

### 3.3 Backend, accès, données (`2026-09-15/backend-acces.md`)

- **E4** `sessions.invite` fait `.collect()` sur toutes les sessions du poste
  et patche `projects.sessionCount` à chaque appel : casse à quelques milliers
  de candidats, contention OCC sur une ligne chaude (le motif interdit sur
  `users`). **M3** Le tableau de bord est en N+1 (une requête `reports` par
  session, jusqu'à 400) et ses chiffres sont faux au-delà de 400 sessions.
- **E5** Éditer ou réordonner les questions d'un poste **actif** renumérote
  `orderIndex`, mais rapports, fiche et page partagée joignent les réponses
  **par index** (`pipeline.ts:313`, `reports.ts:108`, `shares.ts:208`) alors
  que `segment.questionId` existe → réponses affichées sous la mauvaise
  question, rapport faux qui a l'air vrai.
- **E3** `emailLog` garde l'adresse du candidat en clair après
  `deleteMyData` (`purgeLog`, lui, ne stocke qu'un hash — non salé, donc
  réversible par dictionnaire). Pas d'index `by_session` sur `emailLog` ; la
  déduplication de l'e-mail de rapport repose sur une fenêtre de 200 lignes.
- **M1** `attachDocument` n'applique aucun gate : un détenteur du lien peut,
  après l'entretien, remplacer et **détruire** le CV déjà consulté.
- **M2** `deleteSessionRecords` est une transaction non bornée dont le candidat
  contrôle la taille (`logEvent` public, `sessionEvents` sans plafond) ; les
  objets S3 sont déjà supprimés quand elle échoue.
- **M4** Unicité des slugs limitée aux 200 premiers postes, puis `.unique()`
  qui jette pour les deux postes en collision.
- **M6** `scripts/audit-convex-access.mjs` est un `includes()` sur le texte :
  aucun lien argument↔garde, pas de notion de « première instruction », un
  commentaire compte comme une garde, `http.ts` est ignoré, et un faux positif
  est visible dans sa propre sortie (`sharedMediaUrls → resolveShare`). Aucun
  `returns` validator dans tout le backend.
- **F1** `reserveSegment` écrase les clés sans supprimer les anciennes : une
  reprise Chrome → Safari (webm → mp4) orpheline des objets hors de portée de
  l'effacement. **Pipeline E3** : `projects.remove` ne supprime aucun média
  objet.

### 3.4 Pipeline, IA, stockage (`2026-09-15/pipeline-ia-stockage.md`)

- **E1** Course sur le fan-in : les deux dernières transcriptions déclenchent
  chacune `generateReport` (la déduplication lit `reports`, écrite 30-60 s
  plus tard) → **deux appels Gemini Pro par entretien** dans le cas nominal.
- **E7** `chooseStartSeconds` retombe sur `modelEstimate` quand la citation
  n'est pas retrouvée (`evidence.ts:97`), et le champ n'est pas nullable : le
  recruteur clique et arrive au mauvais moment. Quand Mistral ne renvoie pas
  de segments, un chunk unique `{start: 0}` est fabriqué → toutes les
  citations à 0:00 avec l'air d'être résolues.
- **E6** Les transcriptions (nominatives : le prompt contient le nom du
  candidat) partent chez OpenRouter → `google/gemini-2.5-*` sans
  `provider.data_collection: 'deny'` ni `allow_fallbacks: false`. Le récit
  « souverain » couvre l'audio, pas son contenu, et n'est documenté nulle part.
- **E10** SSRF dans l'import d'offre : contrôle lexical du nom d'hôte, puis
  `redirect: 'follow'` ; pas de résolution DNS ; IP décimale, `nip.io`, CGNAT,
  IPv6 mappée non couverts ; pas de plafond de taille de page.
- **M1/M2/M3** Aucun timeout sur les appels modèle (jusqu'à 10 min × 3 × 2 × 4) ;
  pas de `max_tokens` ; jusqu'à 24 complétions « deep » par rapport ; la cause
  réelle d'un échec modèle est perdue avant `jobLog` (`attempt` vaut toujours 1).
- **M4** Injection de prompt par le transcript (interpolé brut, sans
  délimiteur ni consigne « c'est de la donnée »).
- **M9** Para-verbal : `totalSpeakingSeconds` est du temps d'enregistrement,
  silence de tête ignoré, `engagement` note la même grandeur que `concision`,
  cas dégradé qui donne 10/10 sur une donnée inexistante, liste de marqueurs
  d'hésitation contenant des mots de contenu (« genre », « actually »). Au-delà
  de la justesse : **noter « fluidité » et « débit » dans une décision
  d'embauche pénalise mécaniquement accents, non-natifs et troubles de la
  parole** — les caractéristiques que la clause anti-discrimination des prompts
  interdit d'évaluer.
- **M7** Une clé indélébile en tête d'index bloque toute la purge, pour
  toujours. **M11** La règle CORS du bucket, indispensable au `PUT` navigateur,
  n'est documentée nulle part : sur un déploiement neuf, tout envoi échoue.
- **M13** La chaîne réelle est « session terminée → transcrire », pas
  « segment envoyé → transcrire » : les 7 transcriptions démarrent à la fin au
  lieu de pendant l'entretien. Écart non documenté.

### 3.5 Tests, CI, outillage, docs (`2026-09-15/qualite-infra.md`)

- **E1** Aucun e2e du parcours candidat (exigé §6 lot 4) ; `e2e-smoke.mjs` est
  celui du template (en-tête « albo-ouvre-boite », conclut sur « items CRUD »),
  ne touche aucune route `/s/` ni `/r/`, n'est pas en CI — et verrouille B1.
- **E2** Aucun test `withIdentity` : `requireOrgMember`, `requireOrgRole`,
  `requireSuperAdmin`, `requireProject*` ne sont exécutés par aucun test. La
  propriété §8-4 repose entièrement sur l'audit textuel (E3, cf. 3.3 M6).
- Ni `convex/interview.ts` (reprise, idempotence de `finish`, réservation),
  ni `SegmentRecorder`, ni le fan-in du pipeline, ni `sessionsDueForPurge`, ni
  les e-mails, ni `assertPublicHttpUrl`, ni `deleteObjects` n'ont de test. Les
  cinq bugs les plus graves vivent tous dans la couche non testée.
- **E4/E5** Pas de budget de bundle (§6), pas de `pnpm audit` (21 avis, 9
  high, dont `ws` via `convex` et `dompurify` via `streamdown` atteignables au
  runtime), pas de seuil de couverture, `tsc` exécuté deux fois, pas de
  `concurrency`/`timeout-minutes`, actions non épinglées.
- **M2** Sentry factice : `tracesSampleRate` et `replaysOnErrorSampleRate`
  sans les intégrations, aucune source map — les crashes d'entretien arriveront
  minifiés. **M5** Le générateur hors-ligne de `_generated/api.d.ts` est
  byte-identique aujourd'hui mais a quatre dérives latentes.
- Docs : `CLAUDE.md` annonce `@assistant-ui/react` (absent) et « Sentry sur les
  actions » (faux) ; `KNOWN_ISSUES.md` cite `PROJECT_BRIEF.md` (inexistant) et
  un chemin local `/Users/…` ; `TESTING.md` renvoie à « C16 » et « G1 »
  (inexistants) et décrit toujours « Items » ; `README` dit Node 20+ contre
  `engines >=22` ; `convex/README.md` est le boilerplate Convex ; `AGENTS.md`
  contredit la section « Convex skills were pruned ».

### 3.6 Produit et business (`2026-09-15/produit.md`)

- **Aucun e-mail de fin au candidat** : aucune trace, aucun lien vers sa page
  vie privée (son seul moyen d'exercer l'effacement promis « à tout moment »),
  aucun interlocuteur (« Something not working? » n'a pas de canal). Trou
  produit et RGPD.
- L'e-mail de rapport part à **tous les membres de l'organisation** (jusqu'à
  200), sans opt-out : 30 recruteurs × 200 candidats = un domaine grillé.
- **Coût par entretien non mesurable** : `jobLog` n'enregistre ni tokens ni
  secondes d'audio, `ai.ts` ne lit pas `usage`. Aucune facturation, aucun
  plafond : n'importe qui s'inscrit et consomme du Gemini Pro sans limite.
- Aucune télémétrie d'activation ; `sessionEvents` (diagnostic candidat) est
  écrit et jamais lu.
- Temps jusqu'à la première valeur : 20-40 min pour créer un poste, puis J+2 à
  J+5 pour un premier rapport. Aucun rapport d'exemple, aucun modèle de poste,
  import d'offre enfoui à l'étape Questions.
- Conformité : rétention non configurable par org, pas de politique de
  confidentialité, pas de DPA ni de liste des huit sous-traitants, pas
  d'historique des décisions (`recruiterDecisionBy/At` écrasé — AI Act art. 12),
  version de modèle et prompt non figés par rapport, aucune alternative pour un
  candidat qui ne peut pas parler ou entendre.

---

## 4. Ce qui est solide — à ne pas casser

- **Aucun confused deputy sur l'organisation** : les 101 fonctions publiques
  chargent la ligne puis gardent sur l'org de la ligne, jamais sur un `orgId`
  d'argument. `projectShares` est rejoué partout où il compte. Ids croisés
  entre projets rejetés.
- **Projecteurs candidat et partage** explicites, sans spread, testés par la
  négative (ni jeton, ni note, ni décision, ni clé d'objet, ni e-mail).
- **Résolution de jeton uniforme** (cinq formes d'échec, un seul message,
  testé) ; expiration traitée comme un état d'une session résolue.
- **Clés d'objet** dérivées et re-dérivées serveur ; signature couvrant
  méthode, clé, `content-type` **et** `content-length` ; SigV4 maison correct,
  épinglé sur l'exemple AWS, dans le runtime V8 (pas de démarrage à froid Node
  sur le chemin du candidat).
- **Discipline « pas de défaut, pas de réparation »** réellement testée ;
  indices plutôt qu'ids, avec trois erreurs distinctes et 13 tests ; un
  critère sauté ou doublé fait échouer le rapport.
- **Ordre objets-avant-lignes**, segment écrit avant l'envoi, un seul chemin
  d'effacement candidat/recruteur.
- **i18n** : 16 namespaces, parité en/fr exacte (vérifiée par script), pluriels
  français corrects, zéro chaîne en dur dans le code Interw, titres via
  `getFixedT`, schémas Zod dans `useMemo(…, [t])`.
- **Copie** du parcours candidat (accueil, consentement, suppression) :
  la meilleure que les relecteurs aient lue sur ce type de produit.
- **Isolation du bundle** par ESLint avec le pourquoi en commentaire ; 254 Ko
  gzip sur l'écran d'entretien.
- **Tokens sémantiques** complets clair/sombre ; `SeekCue` avec nonce et attente
  de `loadedmetadata`.
- Zéro scope creep, zéro dette de la spec §13 réimportée, zéro `{false && …}`,
  zéro `TODO`, historique git propre, `renovate.json` exemplaire,
  `KNOWN_ISSUES.md` qui documente de vrais pièges.

---

## 5. Ce que j'aurais fait autrement

Choix d'architecture, avec le compromis.

1. **Une autorisation ne dépend jamais d'un argument, `now` compris.** Le
   compromis « query réactive vs horloge serveur » est réel ; il a été résolu
   du mauvais côté. Matérialiser le temps (un cron pose `closedAt` sur les
   partages échus et les sessions dont le poste a expiré ; les queries lisent
   un drapeau) rend les queries purement fonctionnelles et supprime un
   paramètre d'autorisation à auditer. Coût : une latence de fermeture égale à
   la période du cron. À écrire dans `CLAUDE.md`, parce que le motif reviendra.
2. **Le fan-in comme transition d'état transactionnelle, pas comme
   reconstruction.** Un compteur `segmentsSettled` sur `sessions`, incrémenté
   à chaque issue **terminale** (succès ou échec définitif), et le rapport mis
   en file par la mutation qui le fait passer au complet, avec le jeton de
   claim dans la même transaction. Un mécanisme ferme à la fois la course
   (E1) et le gel (B7). `sessions` n'est pas une ligne chaude.
3. **Une machine à états explicite pour l'entretien, hors du composant.**
   `interview.tsx` : 8 `useState`, 5 `useRef`, 4 `useEffect`, un `Phase`
   implicite. B3, B9, E6 et E7 sont des bugs de structure. Un réducteur pur
   `(state, event) => state` se teste en vitest sans navigateur. Et **un seul
   curseur de reprise, calculé côté serveur** (`nextQuestionIndex`), le client
   n'ayant plus aucune logique de reprise.
4. **Joindre les réponses par `questionId`, pas par index.** Le schéma porte
   les deux ; quatre endroits choisissent l'index. L'index est un ordre
   d'affichage, l'id une identité. Coût nul.
5. **Des `returns` validators et des constructeurs enveloppés plutôt qu'un
   script de grep.** `orgQuery({ orgFrom: 'projectId', handler })` rend la
   garantie structurelle ; l'audit se réduit à « toute fonction publique passe
   par un constructeur », ce qu'une regex *peut* vérifier honnêtement. Et dix
   tests `withIdentity` qui prouvent que la garde *refuse*.
6. **Dénormaliser le résultat du rapport sur `sessions`** (`overallScore`,
   `recommendation`, écrits une fois par la file) : supprime d'un coup le
   tableau sans score, le N+1 du dashboard et le travail redondant du copilote.
   Compteurs de projet via `@convex-dev/aggregate` plutôt qu'un patch sur une
   ligne chaude.
7. **Mistral en direct pour l'évaluation, ou OpenRouter épinglé**
   (`data_collection: 'deny'`, `allow_fallbacks: false`, liste blanche) — et
   ne pas passer le nom du candidat au modèle. Puis l'écrire dans la page vie
   privée.
8. **XHR + `timeslice` + multipart dès le lot 4.** Le point de rupture du
   produit est un candidat en mobilité qui envoie 40 Mo d'une traite. Le
   prompt a mis l'effort sur la *visibilité* de l'échec ; il en fallait autant
   sur sa *probabilité*. Et ne pas faire attendre le candidat sur l'envoi
   (file en arrière-plan, blocage uniquement au « Terminer »).
9. **Para-verbal : mesurer moins, mais mesurer.** Trois dimensions honnêtes
   sur le temps de parole réel, avec refus explicite de noter quand la
   granularité ne le permet pas — et une réflexion d'équité avant d'afficher
   quoi que ce soit sur la « fluidité » d'un candidat.
10. **Relire les en-têtes hérités au lot qui introduit la capacité.** Le
    template posait `camera=()` pour une app sans caméra. Toute configuration
    du template qui nie une capacité du produit doit être revue au lot qui
    l'introduit — et un smoke test sur `/s/<token>` doit l'asserter.
11. **Supprimer `items` au lot 1.** Une table, quatre fonctions, une route,
    un namespace, une entrée de nav, deux sections de `TESTING.md`, quatre
    outils d'écriture dans un copilote dont la règle dit « lecture seule ».
12. **Séquencement.** Lots 1-5 tels quels, puis **stop** : un vrai poste, un
    vrai candidat, un vrai rapport, un vrai recruteur — et les lots 6-8
    réordonnés par ce qu'on aurait appris. Le lot 8 (durcissement) devait
    *suivre* le premier client. Et un **rapport d'exemple figé** dès
    l'inscription (ce n'est pas le mode démo interdit) ramène le « aha » de
    J+2 à 30 secondes.
13. **Une porte n'est franchie que sur preuve d'exécution.** Le fait
    structurant de cet audit : tout ce qui est pur est très bien testé, et tout
    ce qui a échoué vit dans la zone jamais exécutée (en-têtes, index, aperçu,
    fan-in, CSP). `TESTING.md` est une checklist écrite, pas jouée. Exiger
    désormais un artefact (capture, log, test) par porte.

---

## 6. Plan d'action proposé

### Jour 1-2 — débloquer (aucune nouvelle fonction)

1. `src/start.ts` : `camera=(self), microphone=(self)` ; `media-src` ;
   corriger `e2e-smoke.mjs` et y ajouter `/s/` et `/r/` (B1, B2).
2. `interview.tsx` : rattacher `srcObject` ; sortir l'alerte du bloc
   `current &&` ; un seul curseur de reprise (B3, B9, E6).
3. `purge.ts` : borner l'index ; poser `purgeAfter` à l'invitation ; test
   `convex-test` (B5, B6).
4. `shares.ts` / `interview.ts` : `Date.now()` serveur dans les actions ;
   borner `now` dans les queries ; test `now: 0` (B4).
5. `ShareProjectDialog` pré-rempli depuis `sharedWith` (B8).
6. Landing, titre d'onglet, suppression complète d'`items` (table, route,
   outils, nav, i18n, TESTING), changelog corrigé (B10).
7. Intro audio/vidéo : brancher `MediaRecorderField` sur `attachIntroMedia`
   (le backend existe) ou retirer les deux modes du sélecteur.

### Semaine 1 — rendre le pipeline et l'effacement vrais

- Fan-in : lire `result`, échec terminal = état, rapport partiel signalé,
  jeton de claim transactionnel (B7, E1). Sentry dans les actions Convex ;
  compteurs `jobLog` sur `/app/admin` ; bouton « relancer » sur la fiche.
- `evidence.ts` : `startSeconds: number | null` jusqu'à l'UI ; citation non
  cliquable quand non ancrée. Jointure par `questionId`.
- Effacement : `emailLog` (index `by_session` + suppression/hachage),
  `projects.remove` → `deleteKeys`, `reserveSegment` → supprimer les anciennes
  clés, hash de `purgeLog` salé, `deleteSessionRecords` par lots.
- Candidat : repli audio-seul, `deviceId` transmis, `markSegmentUploaded` dès
  l'audio, XHR avec progression, `videoBitsPerSecond` ≈ 1 Mbit/s, timeout sur
  `stop()`, `visibilitychange`, errorComponent propre à `/s/**`, scrubbing du
  jeton dans Sentry, page vie privée qui ne crashe pas, langue = celle du poste.
- E-mail de fin au candidat (avec lien vie privée) ; destinataires du rapport
  = créateur + liste choisie.
- OpenRouter : `provider` épinglé ou Mistral direct ; retirer le nom du
  candidat du prompt ; timeout et `max_tokens` ; `usage` dans `jobLog`.
- `sessions.invite` : index `by_project_and_email`, plus de `collect()`.

### Semaine 2 — prouver

- Playwright Chrome + WebKit avec `--use-fake-device-for-media-stream` sur le
  parcours candidat complet, en CI. Dix tests `withIdentity` sur les gardes.
  Budget de bundle (seuil gzip) en CI. `pnpm audit` + overrides `ws`,
  `dompurify`. `tsc` une seule fois, `concurrency`, `timeout-minutes`.
- Tableau des candidats avec score, recommandation, tri, « copier le lien » ;
  URL signées rafraîchies par un hook dédié ; relecture du média de question.
- Documenter la règle CORS du bucket ; corriger les docs périmées (§3.5).
- **Trois entretiens réels, trois humains, trois téléphones.** Ce jour-là
  apprendra plus que tout ce rapport.

### Mois 2

Facturation et plafonds (Stripe), télémétrie d'activation, écran de santé
(file, délivrabilité, `sessionEvents` agrégés), dossier conformité (résidence
tranchée et documentée, politique de confidentialité, DPA, sous-traitants,
historique des décisions, rétention par organisation), para-verbal
retravaillé ou retiré, multipart, rapport d'exemple à l'inscription, écran
« tous les candidats » de l'organisation.

---

## 7. Définition du terminé (prompt §8) — état

| # | Critère | État |
|---|---|---|
| 1 | Bout en bout sans intervention manuelle | Vraisemblable en lecture, **jamais exécuté** ; B1/B2 le rendent impossible aujourd'hui |
| 2 | Chrome, Safari, Firefox, desktop et mobile | **Non tenu** : aucun test navigateur, branche MP4 jamais exercée |
| 3 | Coupure réseau récupérable et visible | Conception juste (3 tentatives, échec visible, `markSegmentFailed`) ; E8/E9/B9 la fragilisent |
| 4 | Aucune fuite inter-organisation, vérifié fonction par fonction | Vrai à la lecture (101 fonctions) ; l'outil qui le « vérifie » ne le peut pas ; aucun test authentifié |
| 5 | Aucun objet sans URL signée après vérification | Tenu par construction — sauf B4 (expiration) et le CORS non documenté |
| 6 | La suppression efface ; la purge s'exécute et se journalise | Suppression : presque (emailLog, orphelins). **Purge : ne s'exécute pas** (B5) |
| 7 | Lint, typecheck, build, tests en CI | Tenu |
| 8 | `TESTING.md` et `KNOWN_ISSUES.md` à jour | Tenu en couverture ; une dizaine d'affirmations périmées |

---

## 8. Annexes

- [`2026-09-15/backend-acces.md`](./2026-09-15/backend-acces.md) — modèle de
  données, gardes, surfaces à jeton, échelle, script d'audit (790 l.)
- [`2026-09-15/pipeline-ia-stockage.md`](./2026-09-15/pipeline-ia-stockage.md)
  — workpool, passerelle IA, prompts, ancrage, S3, effacement, e-mails (1 052 l.)
- [`2026-09-15/candidat.md`](./2026-09-15/candidat.md) — moteur d'entretien,
  MediaRecorder, envoi, UX écran par écran, bundle, a11y (1 089 l.)
- [`2026-09-15/recruteur.md`](./2026-09-15/recruteur.md) — routes, écrans,
  copilote, reliquats du template, inventaire à supprimer (1 128 l.)
- [`2026-09-15/qualite-infra.md`](./2026-09-15/qualite-infra.md) — tests, CI,
  scripts, dépendances, docs périmées (681 l.)
- [`2026-09-15/produit.md`](./2026-09-15/produit.md) — conformité au périmètre,
  parcours vécu, ce qui manque pour vendre, risques, feuille de route (576 l.)

Méthode : six revues indépendantes (Claude Opus 5), chacune limitée à un
domaine avec consigne de ne rapporter que des constats adossés à des lignes
lues ; recoupement, dédoublonnage et re-hiérarchisation par l'orchestrateur,
qui a relu lui-même les modules critiques (`candidate.ts`, `interview.ts`,
`pipeline.ts`, `shares.ts`, `purge.ts`, `objectStore.ts`, `ai.ts`,
`interview.tsx`, `start.ts`, …) et reproduit quatre constats. Aucun fichier du
produit n'a été modifié.

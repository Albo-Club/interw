# Audit — Surface candidat (Interw)

Périmètre : `src/routes/s/$token/**`, `src/components/candidate/**`,
`src/lib/media/**`, `src/lib/fire-and-forget.ts`, `src/lib/convex-errors.ts`,
`src/components/RouterFallbacks.tsx`, `src/routes/__root.tsx`, `src/router.tsx`,
`src/start.ts`, `src/locales/{en,fr}/interview.json`, `convex/candidate.ts`,
`convex/interview.ts`, `eslint.config.mjs`, `vite.config.ts`, build `.output/`.
Audit par lecture (pas de déploiement Convex disponible). Tests : `pnpm test`
→ 22 fichiers / 256 tests, tous verts.

---

## Résumé

Non, cette surface n'est **pas livrable en l'état à un vrai candidat** — et pas
à cause de l'ingénierie du moteur, qui est de bonne tenue, mais à cause de deux
lignes d'en-têtes HTTP héritées du template qui n'ont jamais été relues contre
le nouveau produit. `Permissions-Policy: camera=(), microphone=()`
(`src/start.ts:12-15`) désactive la caméra et le micro **pour le document
lui-même** : sur Chrome/Edge, `getUserMedia` est rejeté avant même la demande
de permission. Et la CSP n'a pas de directive `media-src`, donc `default-src
'self'` bloque la lecture des vidéos de question servies depuis le stockage
objet. En clair : dans l'état, le candidat ne peut ni entendre la question, ni
s'enregistrer.

Les trois plus gros risques, par ordre :

1. **Permissions-Policy + CSP** : l'entretien est techniquement impossible sur
   navigateur Chromium. Deux lignes à corriger, mais elles annulent le lot 4
   entier.
2. **Le choix de périphérique de l'écran de test est jeté à l'entrée de
   l'entretien** (`interview.tsx:114-117` ne passe aucun `deviceId`), et il n'y
   a aucun repli audio-seul si la caméra est absente ou occupée. L'écran de
   diagnostic promet une action qui n'a aucun effet.
3. **Plusieurs états d'échec n'ont pas de rendu** : l'échec du bouton « Finish
   the interview » est totalement muet, la page de confidentialité crashe après
   une suppression réussie, et un jeton inconnu tombe sur la carte d'erreur
   générique du back-office avec un lien « Go home » vers la landing marketing.

Ce qui est bon, et qui mérite d'être dit : le découpage du bundle tient (254 Ko
gzip pour la page d'entretien contre 2,96 Mo dans l'ancienne version), la
projection `toCandidateView` est disciplinée, le modèle de reprise côté serveur
est le bon, et le correctif `62b5037` sur le bouton « Try again » a bien atterri
et fonctionne.

---

## Constats

### CRITIQUE

---

#### C1 — `Permissions-Policy: camera=(), microphone=()` interdit l'enregistrement sur toute la surface

`src/start.ts:12-15`

```ts
setResponseHeader(
  'Permissions-Policy',
  'camera=(), microphone=(), geolocation=()',
)
```

Une liste d'autorisation **vide** (`()`) ne signifie pas « par défaut » : elle
signifie *aucune origine, y compris la mienne*. L'en-tête est posé par un
`requestMiddleware` global (`src/start.ts:36-38`), donc il s'applique aussi à
`/s/$token/**`.

Scénario d'échec : sur Chrome 120+ ou Edge, desktop ou Android, le candidat
arrive sur `/s/<token>/check`, l'effet appelle `navigator.mediaDevices
.getUserMedia(...)` (`check.tsx:79-82`), et la promesse est rejetée avec
`NotAllowedError: Permissions policy violation: camera is not allowed in this
document` — **sans que le navigateur affiche la moindre demande de
permission**. Le code classe tout ce qui n'est pas `NotFoundError` en `denied`
(`check.tsx:124`) et affiche « Camera or microphone access was refused. Allow
it in your browser's address bar, then reload this page. » Le candidat va
chercher l'icône caméra dans la barre d'adresse : elle n'y est pas, puisque
aucune permission n'a été demandée. Il est dans une boucle sans issue, et le
recruteur verra une session `pending` sans jamais comprendre pourquoi.

Correctif : `camera=(self), microphone=(self), geolocation=()`. Ni
`KNOWN_ISSUES.md` ni `TESTING.md` ne mentionnent `Permissions-Policy` — le
sujet n'a jamais été soulevé.

**Confiance : Confirmé** (sémantique de l'en-tête ; non rejouable ici faute de
déploiement, mais la lecture ne laisse pas d'ambiguïté).

---

#### C2 — La CSP n'a pas de `media-src` : les vidéos de question ne peuvent pas être lues

`src/start.ts:19-32`

```ts
"default-src 'self'",
"script-src 'self' 'unsafe-inline'",
"style-src 'self' 'unsafe-inline'",
"img-src 'self' data: https:",
"font-src 'self' data:",
"connect-src 'self' https: wss:",
```

`media-src` est absent, donc il retombe sur `default-src 'self'`. Or
`interview.tsx:399-407` et `interview.tsx:337-343` posent un `src` cross-origin
sur un `<video>` :

```tsx
<video src={mediaUrls[current.questionId]} controls playsInline … />
```

et ces URL sont des URL pré-signées Scaleway émises par
`convex/interview.ts:153-176` (`presignGet`), donc sur
`https://s3.fr-par.scw.cloud/...`.

Scénario d'échec : le candidat arrive sur la question 1, voit un lecteur vidéo
noir avec des contrôles inertes, et la console affiche « Refused to load media
from ... because it violates the following Content Security Policy directive:
"default-src 'self'" ». Aucun état visible n'est prévu pour « le média de la
question n'a pas pu charger » : l'énoncé texte est affiché en dessous
(`interview.tsx:409-418`), donc le candidat peut lire la question — mais le
positionnement produit (« vous posez vos questions face caméra ») s'effondre
silencieusement.

Note : l'aperçu caméra local n'est pas concerné, il passe par `srcObject`
(`interview.tsx:120`), pas par une URL. Et le `PUT` d'upload passe, lui :
`connect-src 'self' https:` l'autorise.

Correctif : ajouter `media-src 'self' https: blob:` (ou, mieux, l'endpoint
objet exact).

**Confiance : Confirmé.**

---

### ÉLEVÉ

---

#### E1 — Le périphérique choisi à l'écran de test est ignoré par l'entretien

`src/routes/s/$token/interview.tsx:111-126`

```ts
const ensureStream = useCallback(async (): Promise<MediaStream> => {
  if (streamRef.current) return streamRef.current
  const support = detectRecorderSupport()
  const stream = await navigator.mediaDevices.getUserMedia({
    video: support.video !== null ? { width: 1280, height: 720 } : false,
    audio: true,
  })
```

`check.tsx` construit toute une mécanique de sélection (`cameraId`, `micId`,
`DevicePicker`, `startPreview` qui relance `getUserMedia` avec
`deviceId: { exact: … }` — `check.tsx:79-82`), puis `proceed()`
(`check.tsx:167-171`) navigue vers `/interview` **sans transmettre quoi que ce
soit**. L'entretien réacquiert un flux avec `audio: true`, c'est-à-dire le
périphérique par défaut du système.

Scénario d'échec : un candidat sur portable avec un casque Bluetooth branché
voit `micQuiet` (« We can barely hear you. Try speaking up, moving closer, or
**choosing another microphone** » — la copie le lui suggère explicitement),
sélectionne le micro du casque, voit la barre monter au vert, clique
« Everything works », et enregistre tout son entretien sur le micro intégré
qu'il venait justement d'écarter. Il n'a qu'une prise.

Correctif : porter `{cameraId, micId}` dans les `search params` de la route (ou
un contexte de route parent), et les passer à `ensureStream`.

**Confiance : Confirmé.**

---

#### E2 — Aucun repli audio-seul si la caméra est absente ou occupée

`src/routes/s/$token/interview.tsx:113-117`

`support.video !== null` ne teste **que le support MIME** de `MediaRecorder`
(`recorder.ts:53-61`), jamais la présence ou la disponibilité d'une caméra.
Donc sur toute machine où `MediaRecorder.isTypeSupported('video/webm')` est
vrai, la contrainte `video: {width:1280, height:720}` est posée — et si la
webcam est absente, en panne ou déjà tenue par Teams/Zoom, `getUserMedia`
rejette en bloc (`NotFoundError` / `NotReadableError`) et **le micro n'est pas
acquis non plus**.

Pourtant tout le reste de la chaîne sait faire de l'audio seul :
`detectRecorderSupport().usable` ne dépend que de l'audio (`recorder.ts:60`),
`SegmentRecorder.start()` ne crée le recorder vidéo que si une piste vidéo
existe (`recorder.ts:121`), et `reserveSegment` accepte un segment sans vidéo
(`convex/interview.ts:235`). La capacité est là, elle n'est simplement jamais
atteinte.

Scénario d'échec : sur Windows, candidat dont la webcam est prise par une
réunion Teams laissée ouverte — cas le plus banal du monde. `NotReadableError`.
L'entretien est perdu alors que l'audio (le seul signal réellement transcrit et
évalué, cf. `recorder.ts:1-12`) était parfaitement disponible.

Correctif : tenter `{video, audio}`, et sur `NotFoundError`/`NotReadableError`/
`OverconstrainedError` réessayer `{video:false, audio:true}` en prévenant
visiblement le candidat que l'entretien sera audio-seul.

**Confiance : Confirmé.**

---

#### E3 — L'échec de « Finish the interview » n'a aucun rendu

`src/routes/s/$token/interview.tsx:302-313` et `380-394`, `450-480`

```ts
const finishInterview = useCallback(async () => {
  setPhase('finishing')
  try { … } catch (cause) {
    setPhase('failed')
    const { key, fallbackKey } = errorMessageKey(cause, 'interview')
    setError(t(key, { defaultValue: t(fallbackKey) }))
  }
}, …)
```

Mais le bloc qui affiche `error` est à l'intérieur de la branche
`current && (…)` (ligne 396), c'est-à-dire de la branche **non terminée**. Sur
l'écran de fin, `finished === true` (ligne 328), donc le rendu prend la branche
`finished ? (…)` des lignes 380-394, qui ne contient ni l'`Alert` d'erreur ni
la bannière `uploading`.

Scénario d'échec : le candidat a répondu à ses 7 questions, clique « Finish the
interview », le réseau tombe ou la mutation `finish` échoue. Le bouton se
désactive une fraction de seconde (`phase === 'finishing'`), repasse en
`failed`, redevient actif — et **rien d'autre ne change à l'écran**. Le
candidat croit avoir cliqué à côté, reclique, rien. Côté serveur, la session
reste `in_progress`, `onSessionCompleted` n'est jamais planifié
(`convex/interview.ts:464-466`), donc **aucun rapport n'est produit** et le
recruteur voit un entretien « en cours » qui ne bouge plus. Il n'y a par
ailleurs pas de fonction de rattrapage — c'est une règle explicite du projet —
donc cette session est perdue définitivement.

Correctif : sortir l'`Alert` d'erreur et le bandeau `uploading` du bloc
`current &&`, au niveau de `<div className="space-y-6">`.

**Confiance : Confirmé** (lecture directe de la structure JSX).

---

#### E4 — La page « vos données ont été supprimées » est inatteignable : la page crashe

`src/routes/s/$token/privacy.tsx:32`, `40-47`, `59-72` + `convex/purge.ts:122`

```ts
const summary = useConvexQuery(api.candidate.privacySummary, { token, now })
```

`useConvexQuery` est un ré-export de `useQuery` de `convex/react`
(`@convex-dev/react-query/dist/esm/index.js:9`), donc une requête **réactive**
qui **lève l'erreur pendant le rendu** quand elle échoue. Or
`deleteMyData` → `purge.deleteSessionRecords` fait
`await ctx.db.delete('sessions', args.sessionId)` (`convex/purge.ts:122`), après
quoi `privacySummary` lève `ConvexError('not_found')` sur sa prochaine
propagation.

Le hook est appelé ligne 32, **avant** le garde `if (deleted)` de la ligne 40.
Dès que la mise à jour réactive arrive, le prochain rendu jette, la frontière
d'erreur du layout `/s/$token` prend la main (`route.tsx:20`) et affiche
`RouterErrorFallback` — « Something went wrong » avec un bouton « Go home »
vers `/`.

Scénario d'échec : un candidat exerce son droit à l'effacement, voit peut-être
un dixième de seconde « Your data has been deleted », puis une erreur générique.
Il n'a aucune confirmation que la suppression a abouti. Sur un geste RGPD, c'est
la pire fin possible.

Correctif : basculer sur un état local *avant* de continuer à lire la requête
(désabonnement conditionnel via l'argument `'skip'` de `useQuery`, ou remonter
l'écran « supprimé » dans un composant frère qui ne monte plus le hook).

**Confiance : Probable** (dépend de l'ordonnancement exact de la mise à jour
réactive vis-à-vis de `setDeleted`, mais la requête finit par jeter de toute
façon dès le rendu suivant).

---

#### E5 — Un jeton inconnu tombe sur la carte d'erreur du back-office, pas sur `state.notFound`

`src/routes/s/$token/route.tsx:20`, `src/components/RouterFallbacks.tsx:16-51`,
`src/locales/en/interview.json` (`state.notFound`)

`candidate.landing` lève `ConvexError('not_found')` pour un jeton qui ne résout
pas (`convex/candidate.ts:70-75`). `useConvexQuery` jette pendant le rendu, donc
`index.tsx` n'atteint jamais son `blocked` (qui, lui, ne couvre que les états
renvoyés par le *gate* : expired/closed/cancelled/completed). La copie
`state.notFound` (« This link doesn't work — It may have been mistyped… ») est
**morte** : aucun chemin ne l'atteint.

Ce qui s'affiche à la place : `RouterErrorFallback`, une `Card` centrée avec
« Something went wrong », un bouton « Retry » qui appelle `router.invalidate()`
(et rejette aussitôt), et un bouton **« Go home » pointant sur `/`**, c'est-à-dire
la landing marketing d'Interw.

Trois problèmes en un : (a) la copie soignée n'est jamais vue, (b) `TESTING.md`
IB15 attend explicitement « This link doesn't work » — le scénario échouera,
(c) le principe « aucun élément de navigation applicative, rien qui invite à
partir » (prompt §4.2) est violé au moment exact où le candidat est perdu.

Le même mécanisme touche `/s/$token/interview` : `requireOpenSession` lève
l'état du gate (`convex/interview.ts:69-73`), donc un candidat qui recharge un
entretien expiré ou déjà terminé voit `InterviewCrash` (« Something went wrong
on this page ») au lieu de « You've already completed this interview ».

Correctif : donner à `/s/$token` un `errorComponent` propre à la surface, qui
lit `convexErrorCode(error)` et rend un `CandidateNotice` avec
`interview:state.<code>` — la plomberie existe déjà (`convex-errors.ts:34-43`).

**Confiance : Confirmé.**

---

#### E6 — La reprise après un « Skip » fait re-passer des questions déjà répondues

`src/routes/s/$token/interview.tsx:156-159` vs `convex/interview.ts:366-376`

Deux notions de « où en est-on » coexistent et divergent :

- **Serveur** : `lastQuestionIndex = max(lastQuestionIndex, questionIndex + 1)`
  à chaque `markSegmentUploaded` — un curseur monotone.
- **Client** : `const firstUnanswered = data.questions.findIndex(q => !q.answered)`
  — la première question **sans segment `uploaded`**.

Ils coïncident tant que le candidat répond dans l'ordre. Ils divergent dès que
le bouton « Skip this question and continue » est utilisé
(`interview.tsx:462-476`), qui avance `index` côté client sans rien écrire.

Scénario d'échec : q0 OK, q1 échoue à l'envoi → Skip, q2 OK.
`lastQuestionIndex = 3`. Le candidat ferme l'onglet et rouvre le lien.
- L'écran d'accueil annonce « You stopped at question **4** »
  (`index.tsx:139-141`, `gate.resumeAtIndex + 1` = 3+1).
- L'entretien reprend en réalité à **q1** (`firstUnanswered`).
- Après avoir refait q1, `setIndex(value + 1)` (ligne 227) l'envoie sur **q2,
  déjà répondue** : il la ré-enregistre.
- `reserveSegment` remplace la réservation en place (`convex/interview.ts:272-277`)
  et ré-utilise la même clé objet (`segmentKey(orgId, sessionId, index, ext)`,
  `objectStore.ts:232-239`) : la première réponse à q2 est **écrasée dans le
  bucket**.

Rien n'est corrompu au sens des données, mais le candidat refait un travail
qu'il a déjà fait, sans comprendre pourquoi, et les deux écrans lui annoncent
deux numéros différents. `resumeAtIndex` renvoyé par
`convex/interview.ts:100` n'est **jamais lu** par `interview.tsx`.

Correctif : une seule source de vérité. Soit le client saute les questions déjà
répondues quand il avance (`setIndex(next non-answered)`), soit `Skip` écrit un
marqueur serveur. Et aligner la copie de `welcome.resumeHint` sur la même
valeur.

**Confiance : Confirmé.**

---

#### E7 — Si `recorder.stop()` jette, « Try again » ne fait rien — la même classe de bug que celle corrigée en `62b5037`

`src/routes/s/$token/interview.tsx:257-273` et `177-179`

```ts
try {
  pendingRecordingRef.current = await recorder.stop()
  recorderRef.current = null
} catch (cause) {
  setPhase('failed')
  …
  return            // pendingRecordingRef.current reste null
}
```

et côté retry :

```ts
const uploadPending = useCallback(async () => {
  const recording = pendingRecordingRef.current
  if (!recording || current === undefined) return    // sortie silencieuse
```

Le commit `62b5037` (« the upload retry button now actually retries ») a bien
corrigé la branche *upload* — vérifié : `uploadPending` réémet bien les octets
détenus, et le `Skip` les jette explicitement. Mais la branche *stop* produit
exactement le symptôme que le commit décrit : `phase = 'failed'`, l'alerte
« Your last answer didn't save / Try again » s'affiche, et le bouton ne fait
**rien du tout**.

Scénario d'échec : sur iOS Safari, `MediaRecorder.stop()` sur un enregistreur
dont la piste a été suspendue (appel entrant, changement d'app) peut ne jamais
émettre `onstop` ou jeter. La promesse `stopAndFlush` (`recorder.ts:178-184`)
n'a d'ailleurs **aucun timeout** : si `onstop` ne se déclenche jamais, `stop()`
ne résout jamais et l'interface reste bloquée sur « Saving your answer… » —
indéfiniment, sans échec visible.

Correctif : (a) ne pas exiger `pendingRecordingRef` pour afficher une action —
proposer « recommencer cette réponse » quand il n'y a rien à renvoyer ; (b)
mettre un `Promise.race` avec un timeout sur `stopAndFlush`.

**Confiance : Confirmé** pour le bouton mort ; **Probable** pour le blocage
indéfini (dépend du comportement de Safari).

---

#### E8 — Rien ne gère la mise en arrière-plan de l'onglet pendant un enregistrement

`src/routes/s/$token/interview.tsx` (aucune occurrence de `visibilitychange`,
`pagehide`, `freeze` — vérifié par grep sur `src/routes/s/` et
`src/components/candidate/`)

Le minuteur d'arrêt dur est un `setTimeout` simple
(`interview.tsx:292-295`) et le tick d'affichage un `setInterval`
(`recorder.ts:133-135`). Les deux sont throttlés, voire gelés, quand l'onglet
passe en arrière-plan sur mobile.

Scénario d'échec : sur iOS 17 Safari, le candidat reçoit une notification
WhatsApp à mi-réponse et bascule 20 secondes dans l'app. Au retour : le
décompte affiché a sauté ou est figé, le `setTimeout` de coupure dure n'a pas
tiré à l'heure, et surtout la piste caméra est passée en `muted` pendant
l'absence — le `MediaRecorder` a continué d'écrire un flux vide. Le candidat ne
voit rien d'anormal, l'upload réussit, et la transcription rend un blanc.
`elapsedSeconds()` est certes calculé sur `Date.now()` (`recorder.ts:138-141`),
donc la valeur ne dérive pas — mais elle n'est rafraîchie que par un interval
throttlé.

Il n'y a pas non plus de `track.onended` ni d'écoute de `devicechange` : un
casque débranché en cours de réponse produit le même silence invisible.

Correctif : écouter `visibilitychange`, mettre l'enregistrement en pause (ou
l'arrêter et le proposer à nouveau) et le **dire** au candidat ; écouter
`ended`/`mute` sur les pistes.

**Confiance : Confirmé** pour l'absence de gestion ; **Probable** pour la forme
exacte de la panne sur iOS.

---

#### E9 — Aucune progression d'envoi : « Saving your answer… » est un écran figé

`src/routes/s/$token/interview.tsx:482-496`, `src/lib/media/upload.ts:81-86`

`uploadToSignedUrl` utilise `fetch`, qui n'expose **aucune** progression
d'upload. `UploadProgress` ne porte que `{phase, attempt, maxAttempts}`
(`upload.ts:17-21`), et l'interface n'affiche qu'un titre statique
(« Saving your answer… ») plus un sous-titre (« Keep this page open. »). Le
composant `Progress` importé ligne 21 ne sert qu'à la progression **des
questions** (ligne 369), pas à l'envoi.

Scénario d'échec : réponse de 3 min en 720p ≈ 50-60 Mo de WebM. Sur un 4G
médiocre à 1,5 Mbit/s montant, l'envoi dure plus de 5 minutes pendant
lesquelles l'écran ne bouge pas d'un pixel, sans même un indicateur
indéterminé. Le prompt interdit explicitement « un écran qui semble figé »
(§4.2). Le candidat conclut que c'est planté, recharge, et perd sa réponse
(rien n'est encore `uploaded`, le `beforeunload` ne s'affiche que sur fermeture
d'onglet, pas sur un rechargement déclenché par l'utilisateur… qu'il confirmera
de toute façon).

Correctif : passer à `XMLHttpRequest` pour l'upload (le seul moyen d'avoir
`upload.onprogress` aujourd'hui) et alimenter une barre réelle ; a minima un
indicateur indéterminé + le poids et le temps écoulé.

**Confiance : Confirmé.**

---

#### E10 — Le jeton d'accès part dans Sentry

`src/router.tsx:64` (`initSentry()`), `src/lib/sentry.ts:10-17`,
`src/components/candidate/InterviewCrash.tsx:27`

`initSentry()` est appelé dans `getRouter()`, donc aussi pour la surface
candidat, avec les intégrations par défaut de `@sentry/react` v10 (breadcrumbs
navigation + fetch/xhr, `request.url` sur l'événement) et
`tracesSampleRate: 0.1`. Le jeton est un **segment d'URL**
(`/s/<token>/interview`), pas un paramètre de requête : aucun scrubbing par
défaut ne le retire.

Scénario d'échec : n'importe quelle exception de rendu pendant un entretien
envoie à Sentry une URL contenant un jeton qui donne accès en lecture **et en
écriture** à la session d'un candidat (consentement, profil, réservation de
segment, finish, et surtout `deleteMyData`). Le jeton reste valide. Toute
personne ayant accès au projet Sentry détient un lien d'entretien nominatif.

Deux détails aggravants :
- `InterviewCrash.tsx:27` appelle `Sentry.captureException(error)` **pendant le
  rendu**, pas dans un `useEffect` (contrairement à `RouterFallbacks.tsx:20-24`
  qui le fait correctement) : chaque re-rendu renvoie l'événement.
- Comme vu en E5, les états métier normaux (lien expiré, entretien déjà
  terminé, consentement manquant) passent par cette frontière — donc ces
  jetons-là partent dans Sentry **en fonctionnement nominal**, pas seulement sur
  bug.

Le reste de l'hygiène est bon : `<meta name="referrer" content="no-referrer">`
(`route.tsx:28`) et `Referrer-Policy: strict-origin-when-cross-origin`
(`start.ts:7`) empêchent la fuite par `Referer` vers Scaleway ;
`fireAndForget` ne journalise pas le jeton (`fire-and-forget.ts:18`) ; aucun
`localStorage`/`sessionStorage` sur la surface (vérifié par grep).

Correctif : `beforeSend`/`beforeBreadcrumb` qui remplace `/s/<token>` par
`/s/[token]`, et déplacer le `captureException` de `InterviewCrash` dans un
`useEffect`.

**Confiance : Confirmé** pour l'appel en rendu et l'absence de scrubbing ;
**Probable** pour le contenu exact de la charge utile Sentry.

---

### MOYEN

---

#### M1 — `getUserMedia` échoue en « Something went wrong » dans l'entretien

`src/routes/s/$token/interview.tsx:296-299`

```ts
} catch (cause) {
  const { key, fallbackKey } = errorMessageKey(cause, 'interview')
  setError(t(key, { defaultValue: t(fallbackKey) }))
}
```

`errorMessageKey` retourne `common:errorBoundary.title` dès que l'erreur n'est
pas un `ConvexError` (`convex-errors.ts:39-41`). Une `DOMException`
(`NotAllowedError`, `NotReadableError`, `OverconstrainedError`) n'en est pas
un. Donc un refus de permission au moment de « Start my answer » affiche
« Something went wrong » — alors que `interview.json` contient déjà
`device.permissionDenied` et `device.noDevices`, bien rédigés.

`check.tsx:122-131` fait un peu mieux mais pas assez : seul `NotFoundError` est
distingué, tout le reste devient `denied`. `NotReadableError` (caméra occupée
par une autre app) est le cas le plus fréquent en entreprise, et il reçoit un
conseil faux (« allow it in your browser's address bar »).

**Confiance : Confirmé.**

---

#### M2 — Pas de `timeslice` : toute la réponse tient en mémoire jusqu'au `stop()`

`src/lib/media/recorder.ts:119` et `128`

```ts
this.audioRecorder.start()
…
this.videoRecorder.start()
```

Sans argument, `ondataavailable` n'est appelé **qu'une seule fois**, à l'arrêt,
avec l'intégralité de l'enregistrement. Conséquences : (a) le pic mémoire est
la réponse entière (≈50-60 Mo pour 3 min de 720p), ce qui sur un Android
d'entrée de gamme approche le seuil de récupération d'onglet ; (b) un crash ou
une fermeture d'onglet en cours de réponse perd 100 % des octets (rien n'est
jamais sorti du recorder) ; (c) l'envoi progressif *pendant* l'enregistrement
est structurellement impossible.

Le prompt §3.4 n'exige que l'envoi par question (respecté), donc ce n'est pas
une violation — mais c'est le choix qui plafonne la robustesse.

**Confiance : Confirmé** pour le comportement de l'API ; l'ordre de grandeur
mémoire est une estimation.

---

#### M3 — Deux `MediaRecorder` simultanés sur un même flux : risque iOS Safari

`src/lib/media/recorder.ts:112-129`, `KNOWN_ISSUES.md:1498`

La justification vendorée (audio séparé pour la transcription) est solide et
bien argumentée. Mais `KNOWN_ISSUES.md` ne dit rien du risque : Safari a un
historique de défaillances avec deux `MediaRecorder` actifs sur les mêmes
pistes (sortie vide, `stop()` qui ne rend pas la main, erreur
`InvalidStateError`). `TESTING.md` IB10 (« Both an audio and a video object
appear ») est justement le test qui le révélerait, et il est marqué manuel, à
rejouer par navigateur — donc jamais joué en CI.

Solution de repli si ça casse : un seul recorder vidéo, et extraction de la
piste audio côté serveur au moment de la transcription.

**Confiance : Probable** (non testable ici ; le code est correct, c'est la
plateforme qui est en cause).

---

#### M4 — 18 clés `interview` écrites en deux langues et jamais rendues

Comparaison programmatique `en`/`fr` : **137 clés de chaque côté, aucune
divergence** — l'i18n a bien été tenue au fil de l'eau, c'est à saluer. Mais 18
clés ne sont atteintes par aucun `t()` :

```
run.timeUp        run.saved        run.notRecording   run.networkPoor
run.leaveWarning  run.next         run.playQuestion   run.replayQuestion
run.readQuestion  shell.privacy    shell.help         welcome.whatYouNeed
welcome.needs.camera  welcome.needs.quiet  welcome.needs.browser
welcome.fields.name   welcome.fields.email  done.nextSteps.noReply
```

Les conséquences ne sont pas cosmétiques :

- `welcome.whatYouNeed` + `needs.*` : l'écran d'accueil ne dit **jamais** au
  candidat qu'il lui faut une caméra, un micro, un endroit calme, et de laisser
  la page ouverte. `index.tsx:146-168` ne rend que le bloc « How it works ».
- `shell.privacy` : `CandidateShell` accepte une prop `footer`
  (`CandidateShell.tsx:16`, `48-59`) qu'**aucun appelant** ne fournit (vérifié :
  seuls `forgot-password.tsx` et `register.tsx` utilisent `footer=`). Le
  commentaire du composant affirme pourtant « The only secondary link is the one
  the law requires — what is held about them ». Il n'y a donc de lien vie privée
  que sur la page `done`.
- `run.timeUp` / `run.saved` : la fin d'une réponse par dépassement de durée et
  la confirmation d'enregistrement ne sont jamais annoncées.
- `run.networkPoor` : `logEvent('network_degraded')` est émis
  (`interview.tsx:90`) mais aucun rendu correspondant n'existe — seul
  `run.offline` est affiché, sur l'événement `offline` du navigateur, qui est
  notoirement optimiste (`navigator.onLine` reste `true` derrière un portail
  captif ou un réseau qui ne route plus).

**Confiance : Confirmé.**

---

#### M5 — Cibles tactiles sous le minimum, sur les deux boutons les plus critiques

`src/components/ui/button.tsx:26-29` : `lg: 'h-10'` (40 px),
`sm: 'h-8'` (32 px), `default: 'h-9'` (36 px).

Le skill `web-design-guidelines` pose « MUST: Hit target ≥24px (mobile ≥44px) ».
Or :
- « Start my answer » / « I've finished my answer » : `size="lg"` → **40 px**
  (`interview.tsx:502`, `507`).
- « Try again » / « Skip this question » après un échec d'envoi : `size="sm"` →
  **32 px** (`interview.tsx:459`, `462`). Ce sont littéralement les deux boutons
  qui décident si une réponse est sauvée ou perdue, et ce sont les plus petits
  de la surface.

Manquent aussi `touch-action: manipulation` (règle MUST du skill) et
`viewport-fit=cover` sur le meta viewport (`__root.tsx:30-31`), donc
`env(safe-area-inset-bottom)` vaut 0 — sans conséquence ici puisque la barre
n'est pas `fixed`, mais à corriger si elle le devient.

**Confiance : Confirmé.**

---

#### M6 — Aucune région `aria-live` : les changements d'état sont muets pour un lecteur d'écran

Grep sur `src/routes/s/` et `src/components/candidate/` : zéro `aria-live`,
zéro `role="status"`, zéro `role="alert"`.

Le skill pose « MUST: Use polite `aria-live` for toasts/inline validation » et
« MUST: Accessible names exist even when visuals omit labels ». Sont concernés :
le passage en enregistrement (`interview.tsx:433-442`), le décompte des 30
dernières secondes (443-447, 516-520), « Saving your answer… » (482-496),
l'échec d'envoi (450-480), la bannière hors ligne (373-378). Le `MicMeter`
(`check.tsx:307-330`) porte un `role="meter"` **sans `aria-label`**.

Scénario : un candidat malvoyant ne sait pas que l'enregistrement a démarré,
ni qu'il lui reste 12 secondes, ni que son envoi a échoué.

**Confiance : Confirmé.**

---

#### M7 — L'aperçu caméra est en 16:9 forcé, illisible en portrait sur téléphone

`src/routes/s/$token/interview.tsx:421-432` et `check.tsx:200-206`

```tsx
<div className="bg-muted relative aspect-video w-full overflow-hidden rounded-lg">
  <video ref={videoRef} muted playsInline className="size-full scale-x-[-1] object-cover" />
```

Sur un iPhone en portrait, `getUserMedia({width:1280,height:720})` livre en
pratique un flux 720×1280. Rendu dans un conteneur 16:9 en `object-cover`, cela
recadre une **bande horizontale** du visage. Sur 390×844, le conteneur fait
~358×201 px. Le candidat ne se voit qu'en fente. C'est le seul retour visuel
qu'il a sur son cadrage, sur un produit dont le livrable est une vidéo.

Aucune contrainte `facingMode` non plus : sur un mobile Android, rien ne garantit
la caméra frontale.

Correctif : `aspect-[9/16]` (ou `aspect-square`) sous `sm:`, et
`facingMode: 'user'` dans les contraintes.

**Confiance : Confirmé** pour le CSS ; **Probable** pour l'orientation exacte du
flux selon l'appareil.

---

#### M8 — On peut terminer l'entretien avec un segment `failed`, sans le savoir

`src/routes/s/$token/interview.tsx:462-476` et `380-394`

Le bouton « Skip this question and continue » remet l'interface à plat et
avance, laissant le segment en `uploadState: 'failed'`
(`convex/interview.ts:392`). L'écran de fin (lignes 380-394) n'affiche qu'un
titre et un bouton : **il ne récapitule rien**, ne compte pas les réponses
manquantes, ne propose pas de réessayer les envois échoués avant de clore.

Scénario : le candidat saute une question à cause d'un tunnel de métro, croit
la rattraper plus tard, arrive à l'écran final, clique « Finish ». La session
passe `completed`, le pipeline tourne sur 6 réponses au lieu de 7, et le rapport
est produit sur une base incomplète sans que personne ne soit prévenu.

Correctif : sur l'écran de fin, lister les questions sans segment `uploaded` et
proposer d'y revenir avant de confirmer ; le prompt exige d'ailleurs qu'une
action de fin dise « ce qui va se passer ensuite », ce que l'écran ne fait pas
non plus (le `h1` répète simplement le libellé du bouton, ligne 383).

**Confiance : Confirmé.**

---

#### M9 — Le bundle candidat embarque tout l'i18n, tout Sentry, Better Auth, sonner et Zod

Mesures sur `.output/public/assets` (build du 15/09, fraîche), clôture des
imports statiques pour `/s/$token/interview` :

| | |
|---|---|
| Chunks | 44 |
| Non compressé | **807 Ko** |
| Gzip | **254 Ko** |

À comparer aux 2,96 Mo de l'ancienne version : l'objectif du prompt §3.1 est
atteint et la règle ESLint (`eslint.config.mjs:24-70`) tient — **aucun import
interdit** sur la surface (vérifié : la liste complète des imports de
`src/routes/s/**` et `src/components/candidate/**` ne contient que
`~/components/ui/*`, `~/lib/*`, `~/components/candidate/*`, `convex/_generated`,
et les libs de base).

Mais 579,5 Ko des 807 Ko viennent d'un seul chunk partagé,
`index-B5Ts4VrF.js`, qui contient (grep sur le chunk) :

- **les 32 fichiers de locales** (16 namespaces × en/fr = 180 Ko de JSON brut),
  parce que `src/lib/i18n.ts:8-40` les importe statiquement tous. Le commentaire
  de `i18n.ts:58-59` — « `interview` … is the only namespace that ships in the
  candidate bundle » — est **faux** : `grep "tableau de bord"`, `"Nouveau
  poste"`, `"changelog"`, `"shortlist"` renvoient tous des résultats dans le
  chunk que le candidat télécharge ;
- **tout `@sentry/react` v10** (`captureException`, le scope, les intégrations),
  importé statiquement par `~/lib/sentry` depuis `router.tsx` **et** depuis
  `InterviewCrash.tsx:7` ;
- **le client Better Auth** (`magicLink`, `ConvexBetterAuthProvider` —
  `router.tsx:5-8`), dont le candidat n'a aucun usage : il n'a pas de compte ;
- **sonner** (`Toaster`) et **next-themes** (`ThemeProvider`), via
  `__root.tsx:12-13` — aucun `toast()` n'est appelé sur la surface candidat ;
- **Zod** (`schemas-BI2nBjLO.js`, 73 Ko).

La règle ESLint ne peut rien y faire : elle couvre `src/routes/s/**`, pas
`__root.tsx` ni `router.tsx`, qui sont dans le graphe de *toutes* les pages.

Correctif : charger les namespaces i18n à la demande (`i18next-resources-to-backend`
ou un simple `import()` par namespace), sortir Sentry derrière un `import()`
paresseux, et ne monter `ConvexBetterAuthProvider` / `Toaster` / `ThemeProvider`
que sous `/app`.

**Confiance : Confirmé** (mesuré sur le build).

---

#### M10 — Pas de `head()` par écran candidat

`route.tsx:22-30` pose un `title` (`interview:metaTitle` → « Your interview »),
`robots: noindex, nofollow` ✅ et `referrer: no-referrer` ✅. Mais aucune des
cinq routes enfants ne définit son propre `head()`, donc les cinq écrans
partagent le même titre et **aucun** n'a de `description`. Le prompt §4.3
demande « titre et description » pour tout écran atteignable par un lien, et le
skill pose « MUST: `<title>` matches current context ».

Aucune des routes enfants n'a non plus d'`errorComponent`/`notFoundComponent`
propre (seuls le layout et `/interview` en ont) — techniquement conforme à la
règle `CLAUDE.md` (« toute route à `loader` »), aucune n'ayant de `loader`,
mais c'est ce qui produit E5.

**Confiance : Confirmé.**

---

#### M11 — Le méga-rendu à 60 images/seconde de l'écran de test

`src/routes/s/$token/check.tsx:111-120`

```ts
const tick = () => {
  analyser.getByteTimeDomainData(buffer)
  const value = levelFromTimeDomain(buffer)
  setLevel(value)                       // setState à chaque frame
  levelsRef.current.push(value)
  if (levelsRef.current.length > 600) levelsRef.current.shift()
  setVerdict(assessMicLevels(levelsRef.current))   // Math.max(...600) par frame
  rafRef.current = requestAnimationFrame(tick)
}
```

Deux `setState` par frame re-rendent tout `DeviceCheck` — y compris les deux
`Select` Radix — 60 fois par seconde, et `assessMicLevels` fait un spread de
600 éléments à chaque passe. Le skill pose « MUST: Track and minimize
re-renders ». Sur un téléphone d'entrée de gamme, cela chauffe et vide la
batterie juste avant l'enregistrement.

Correctif : piloter la largeur de la barre en manipulant directement le style
via un `ref` (aucun rendu React), et ne recalculer le verdict que toutes les
250 ms.

**Confiance : Confirmé.**

---

#### M12 — Un départ en cours d'enregistrement perd la réponse en silence

`src/routes/s/$token/interview.tsx:128-134` et `102-107`

Le `beforeunload` n'est armé que pour `recording` et `uploading` — pas pour
`failed`, où des octets non envoyés dorment dans `pendingRecordingRef`. Et il
ne couvre que la fermeture d'onglet : il n'y a **aucun `useBlocker`** contre une
navigation client (bouton Retour). Dans ce cas, le cleanup appelle
`recorder.dispose()` (`recorder.ts:169-175`) qui arrête les enregistreurs sans
produire de blob, arrête les pistes, et **n'émet aucun `logEvent`** : ni le
candidat, ni le recruteur, ni le journal ne saura qu'une réponse a existé.

Par ailleurs `warn = (event) => event.preventDefault()` (ligne 104) suffit à
Chrome ≥ 119 et Firefox, mais Safari attend historiquement
`event.returnValue = ''`. La copie `run.leaveWarning` écrite dans les deux
langues n'est de toute façon jamais affichée (les navigateurs imposent leur
texte) — voir M4.

**Confiance : Confirmé.**

---

### FAIBLE

---

#### F1 — `replaysOnErrorSampleRate: 1.0` sans intégration Replay

`src/lib/sentry.ts:15-16`. L'option est posée mais `replayIntegration()` n'est
pas ajoutée, donc elle est inerte en `@sentry/react` v10 (vérifié : aucun
`replayIntegration` dans le bundle). Inoffensif aujourd'hui — mais la
configuration exprime une intention qui, si quelqu'un « complète » la
configuration, mettrait en place l'enregistrement du DOM d'un écran d'entretien
(nom du candidat, énoncés des questions) chez un tiers américain, sur une
surface régie par le RGPD. À supprimer ou à commenter explicitement.

**Confiance : Confirmé.**

---

#### F2 — Un média de question `audio` est rendu dans un `<video>`

`interview.tsx:399-407` et `337-343` : `mediaKind` est bien transmis par
`toCandidateQuestionView` (`candidateView.ts:100`) mais n'est jamais lu. Un
`introMode: 'audio'` ou un `mediaKind: 'audio'` produit un rectangle noir 16:9
avec des contrôles. Fonctionne, mais c'est laid et déroutant.
Cas voisin : `introMode === 'video'` avec `introUrl` null (échec de signature)
et `introText` null → l'écran d'intro n'affiche **que** le bouton « I'm ready »,
sans aucun contenu.

**Confiance : Confirmé.**

---

#### F3 — Le contexte non sécurisé donne un message trompeur

`devices.ts:59-62` + `check.tsx:194-197`. Hors HTTPS (adresse IP, proxy
d'entreprise en clair), `navigator.mediaDevices` est absent → `usable: false` →
« This browser can't record video interviews. Please open this link in the
latest Chrome, Safari, Firefox or Edge ». Le navigateur n'est pas en cause.
Distinguer `window.isSecureContext === false` coûte trois lignes.

**Confiance : Confirmé.**

---

#### F4 — Double boot possible au montage de l'entretien

`interview.tsx:138-174`. L'effet dépend de `data`, qui est une requête Convex
**réactive** : si une mise à jour arrive avant que `setIndex` n'ait été appelé
(fenêtre = durée de `start` + `promptMedia` + `getUserMedia`, soit plusieurs
secondes en pratique), l'effet se relance. Le drapeau `run.cancelled` protège
bien l'état React, mais `start({token})` et `promptMedia({token})` sont appelés
deux fois — deux `consumeLimit` et deux jeux d'URL signées. Sans gravité au
budget actuel (`candidateWrite: 120/min`, `rateLimiters.ts:49`), mais c'est un
effet qui n'est pas réellement idempotent.

**Confiance : Confirmé.**

---

#### F5 — `promptVideoRef` est déclaré et branché, jamais lu

`interview.tsx:72` et `401`. Ref mort — vestige d'une lecture automatique
abandonnée. À supprimer.

**Confiance : Confirmé.**

---

## Ce qui est solide

Il faut le dire clairement, parce que c'est l'essentiel du travail :

- **La discipline de projection.** `convex/lib/candidateView.ts` énumère chaque
  champ, ne fait aucun spread, et documente en tête exactement ce qui ne doit
  jamais sortir. `convex/candidate.test.ts:140-160` teste que la note recruteur,
  la décision et le jeton ne fuient pas. C'est la bonne façon de rendre une
  fuite impossible par défaut plutôt qu'improbable par vigilance.
- **La résolution de jeton.** Une seule porte (`requireSession` /
  `resolveSessionByToken`), un `ConvexError('not_found')` identique pour tout
  jeton non résolu, et `looksLikeToken` qui tient explicitement à ne pas être
  présenté comme un contrôle de sécurité (`tokens.ts:26-29`). Le gate est pur,
  exhaustif et testé (`sessionState.test.ts`, 10 tests).
- **L'ordre segment-avant-upload.** `reserveSegment` écrit la ligne `segments`
  avec ses clés **avant** le `PUT` (`convex/interview.ts:197-296`), ce qui rend
  la purge exacte même pour une réponse dont l'envoi a échoué. Et l'effacement
  supprime bien les objets avant les lignes (`candidate.ts:363-371`). Ces deux
  ordres sont les bons et ils sont commentés avec la raison.
- **`uploadToSignedUrl`.** Backoff exponentiel, distinction 4xx/5xx explicite et
  justifiée (`upload.ts:52-55`), `AbortSignal` honoré, dépendances injectées —
  et 8 tests qui couvrent précisément les cas qui comptent (coupure réseau,
  403 non rejoué, échec surfacé plutôt qu'avalé).
- **`fireAndForget`.** L'exception à « aucune erreur avalée » est nommée, tracée
  et documentée avec sa frontière (« Anything a user needs to know about does
  NOT belong here »). Les 6 usages sur la surface candidat sont tous des écritures
  de télémétrie — justifiés, aucun n'est un échec que le candidat devrait voir.
  Zéro `catch {}` sur la surface.
- **L'i18n tenue au fil de l'eau.** 137 clés, `en` et `fr` strictement
  alignées, pluriels français corrects, aucune chaîne en dur. Après une
  version précédente morte à 5 % de traduction, c'est un vrai résultat.
- **La copie.** Le ton est juste : calme, concret, orienté action (« reply to
  the email that invited you » plutôt que « une erreur est survenue »). Le bloc
  de consentement (`index.tsx:254-293`) est exemplaire — quatre points, la
  mention explicite que l'analyse est automatique et que la décision est
  humaine, et une sortie honnête pour qui refuse.
- **La confirmation de suppression** nomme précisément ce qui sera détruit **et**
  la conséquence (« {{org}} will no longer be able to consider this
  application »). C'est ce que le prompt demande, et c'est rare.
- **L'isolation du bundle** est réellement appliquée et gardée par ESLint avec
  un commentaire qui explique pourquoi la règle existe. 254 Ko gzip contre
  2,96 Mo.
- **Le correctif `62b5037`** est correct et bien raisonné : le
  `pendingRecordingRef` est la bonne abstraction, le `Skip` jette explicitement
  les octets pour qu'ils ne soient pas envoyés contre la question suivante.

---

## Ce que j'aurais fait autrement

**1. Une machine à états explicite, hors du composant.**
`interview.tsx` fait 528 lignes avec 8 `useState`, 5 `useRef`, 4 `useEffect` et
un `Phase` implicite dont les transitions sont éparpillées dans quatre
callbacks. Ce n'est pas `InterviewStart.tsx` et ses 5 038 lignes — mais c'est la
même pente. Les bugs E3 (l'erreur rendue dans la mauvaise branche), E6 (deux
curseurs de reprise) et E7 (une branche d'échec qui oublie le ref) sont tous
trois des bugs de *structure*, pas d'inattention : ils viennent de ce que l'état
n'est pas un objet unique. Un réducteur pur
`(state, event) => state` — `{phase, index, pending, error}` — se teste en
vitest sans navigateur, et aurait fait tomber E3, E6 et E7 dans le fichier de
test plutôt que chez le candidat. Coût : une journée. C'est le lot le plus
risqué du projet, le prompt le dit lui-même (« C'est le lot le plus risqué :
soigne-le »).

**2. Un seul curseur de progression, côté serveur.**
Aujourd'hui `lastQuestionIndex` (serveur, monotone) et `firstUnanswered`
(client, dérivé) coexistent et divergent. J'aurais fait renvoyer par
`interview.questions` un champ `nextQuestionIndex` calculé côté serveur à partir
des segments, et le client n'aurait **plus aucune logique de reprise** — il
affiche ce qu'on lui dit. Tradeoff : un aller-retour de plus après chaque
`markSegmentUploaded` ; mais c'est une requête réactive, elle se met à jour
toute seule. Le bénéfice, c'est qu'il n'existe plus qu'un seul endroit où la
sémantique de reprise peut être fausse.

**3. `XMLHttpRequest` pour l'upload, avec `timeslice`.**
`fetch` est plus propre à lire, mais il n'a pas de progression d'upload, et ce
n'est pas un détail esthétique : sur cette surface, un écran qui ne bouge pas
pendant cinq minutes *est* un mode de panne. Combiné à un
`MediaRecorder.start(5000)`, on peut en plus envoyer les tronçons au fil de
l'eau (upload multipart S3), ce qui fait passer la perte maximale d'un crash de
« toute la réponse » à « les cinq dernières secondes ». Tradeoff : la reprise
d'un multipart interrompu est une vraie mécanique à écrire et à tester. Pour une
v1, j'aurais au moins pris XHR.

**4. Ne pas faire attendre le candidat sur l'envoi.**
Aujourd'hui `stopRecording` → `await uploadPending()` → puis seulement
`setIndex(+1)` (`interview.tsx:257-273`). Le candidat regarde une barre figée
entre chaque question. J'aurais mis l'envoi dans une file en arrière-plan et
enchaîné immédiatement sur la question suivante, avec un indicateur discret
« 2 réponses en cours d'envoi » et un blocage **uniquement** au moment du
« Finish » si la file n'est pas vide. Tradeoff : deux uploads concurrents sur
un 4G faible se gênent, et il faut gérer le cas « le candidat termine avec des
envois en vol » — qui est précisément le cas que l'implémentation actuelle
évite en bloquant. C'est un choix défendable ; je le documenterais comme tel
dans `KNOWN_ISSUES.md`, ce qui n'est pas fait.

**5. Un `errorComponent` propre à la surface candidat, dès le layout.**
Réutiliser `RouterFallbacks` sur `/s/**` est ce qui produit E5 : la carte
générique du back-office et son lien « Go home » vers la landing marketing
apparaissent au pire moment. Un `CandidateErrorBoundary` de quinze lignes, qui
lit `convexErrorCode` et rend un `CandidateNotice`, aurait fermé E5, rendu la
copie `state.*` atteignable, et évité d'envoyer les états métier normaux dans
Sentry (E10).

**6. Les en-têtes de sécurité relus contre le produit, pas hérités.**
C1 et C2 ne sont pas des erreurs de conception, ce sont deux lignes du template
que personne n'a relues quand le produit est devenu « une page qui filme des
gens ». J'aurais mis un test de fumée sur `/s/<token>` vérifiant que la réponse
contient `camera=(self)` et une `media-src` — c'est exactement ce que
`scripts/e2e-smoke.mjs` sait faire, et il ne touche aujourd'hui aucune route
candidat.

**7. La langue de l'entretien devrait suivre le poste, pas le navigateur.**
`projects.language` est dans le schéma, renvoyé par `toCandidateProjectView`
(`candidateView.ts:48`)… et lu par personne. La locale vient de
`getLocale()` (cookie, puis `Accept-Language` — `src/lib/locale.ts:59-75`). Un
recruteur français qui crée un poste en français et invite un candidat dont le
navigateur est en anglais obtiendra une interface anglaise autour de questions
françaises. C'est incohérent et c'est une correction de trois lignes
(`i18n.changeLanguage(project.language)` dans le layout `/s/$token`).

---

## État de l'UX candidat, écran par écran

Référence : prompt §4.2 « Parcours candidat — calme et univoque ».

| Écran | Ce qui marche | Ce qui manque vs §4.2 |
|---|---|---|
| **Accueil** `index.tsx` | Salutation nominative, organisation + poste, « How it works » en 4 points, champs conditionnels au poste, consentement clair et détaillé, une seule action primaire, skeleton (pas de spinner), bandeau de reprise. Aucun chrome applicatif. | Le bloc « What you'll need » (caméra, calme, garder la page ouverte) est écrit en `en`+`fr` et **jamais rendu** (M4) — le candidat n'est donc pas prévenu qu'il lui faut un endroit calme. Pas de lien vie privée. Le bandeau de reprise annonce un numéro de question qui peut être faux (E6). Jeton invalide → carte d'erreur du back-office (E5). |
| **Test caméra/micro** `check.tsx` | Vraie mesure RMS avec un verdict actionnable, détection de webview in-app (excellent : c'est le cas réel qui perd le plus d'entretiens), sélection de périphérique, « Start anyway » qui ne piège jamais le candidat, bouton « Check again ». | Le périphérique choisi est **jeté** à l'étape suivante (E1). `NotReadableError` → conseil faux (M1). Pas d'`aria-label` sur le mètre, pas d'`aria-live` (M6). 60 rendus/s (M11). Sur Chrome, l'écran est de toute façon mort (C1). |
| **Entretien** `interview.tsx` | « Question 3 of 7 » + barre de progression ✅, bouton de fin toujours au même endroit en barre collante ✅, pastille « Recording » qui respecte `prefers-reduced-motion` ✅, décompte sur les 30 dernières secondes ✅, coupure dure à la durée max ✅, bandeau hors-ligne ✅, échec d'envoi visible avec Réessayer/Passer ✅, `beforeunload` ✅. | Vidéo de question bloquée par la CSP (C2). Aucun repli audio (E2). Rien pour l'arrière-plan mobile (E8). Envoi sans progression (E9). Aperçu caméra illisible en portrait (M7). « ce qui va se passer ensuite » n'est jamais dit entre deux questions. Pas d'`aria-live`. Boutons Réessayer/Passer à 32 px (M5). |
| **Fin d'entretien** (bloc `finished`) | Le bouton de clôture existe et est idempotent côté serveur. | **L'écran le plus pauvre du parcours** : un `h1` qui répète le libellé du bouton, aucun récapitulatif, aucune mention des réponses non envoyées (M8), et l'échec du clic est totalement invisible (E3). |
| **Merci** `done.tsx` | Ton juste, « What happens next » explicite avec l'adresse de contact, lien vers la page données. | Pas de `head()` propre (M10). `done.nextSteps.noReply` écrit et non rendu. |
| **Vie privée** `privacy.tsx` | Inventaire honnête et conditionnel de ce qui est détenu, droits expliqués, confirmation qui **nomme** ce qui sera détruit et la conséquence — exactement ce que §4.3 demande. | L'écran de confirmation post-suppression est inatteignable : la page crashe (E4). Pas d'état « suppression en cours » visible au-delà du `disabled`. |
| **Impasses** `CandidateNotice` | Quatre états (expiré / fermé / annulé / terminé) avec un titre, une explication et une action réelle (« reply to the email that invited you »). Aucune impasse muette. | `state.notFound` est mort (E5). Ces mêmes états, atteints via `/s/$token/interview`, donnent `InterviewCrash` au lieu du `CandidateNotice`. |
| **Crash** `InterviewCrash` | Existe (l'ancienne version n'avait rien), dit la seule chose qui compte (« vos réponses sont intactes »), et offre deux issues depuis `62b5037`. | `crash.body` interpole `{{index}}` avec la chaîne littérale `'…'` (`InterviewCrash.tsx:36`) : le candidat lit « Reload to pick up at question … ». Le numéro est pourtant sur le serveur. `captureException` appelé en rendu (E10). |

---

## Couverture des tests

`pnpm test` : **22 fichiers, 256 tests, tous verts**, en 4 s.

**Ce qui est couvert, et bien couvert :**

| Fichier | Tests | Qualité |
|---|---|---|
| `src/lib/media/upload.test.ts` | 8 | Excellent. Content-Type signé, 500 rejoué, coupure réseau rejouée, 403 **non** rejoué, échec surfacé, `maxAttempts` respecté, abort. Les sept cas qui comptent. |
| `src/lib/media/recorder.test.ts` | 7 | Bon sur la négociation MIME : branche Chrome (VP9), branche Safari (MP4), « inutilisable sans audio même si la vidéo marche », « utilisable en audio seul ». |
| `src/lib/media/devices.test.ts` | 12 | Webviews in-app, RMS, verdict micro. |
| `convex/lib/sessionState.test.ts` | 10 | Le gate est exhaustivement testé — c'est la bonne cible. |
| `convex/candidate.test.ts` | 7 | Les tests de sécurité qu'il fallait écrire : pas de note recruteur, pas de jeton, pas de fuite inter-organisation, échec identique pour tout jeton non résolu. |

**Les trous, par ordre de risque :**

1. **`convex/interview.ts` n'a aucun test.** Zéro (vérifié : aucun fichier de
   test ne mentionne `api.interview`, `reserveSegment` ou
   `markSegmentUploaded`). C'est le module qui porte la sémantique de reprise,
   l'idempotence de `finish`, le remplacement de réservation de segment et
   l'avance de `lastQuestionIndex` — autrement dit, tout ce qui décide si un
   entretien est perdu ou non. E6 serait tombé en dix lignes de `convex-test`.
2. **La classe `SegmentRecorder` n'est pas testée**, seulement les fonctions
   pures de sélection MIME. `start()`/`stop()`/`dispose()`, l'assemblage des
   blobs, la double-piste, l'absence de `onstop` (E7) : rien. Un
   `MediaRecorder` factice est pourtant trivial à écrire, et la classe est déjà
   conçue pour l'injection (`support` est un paramètre).
3. **Aucun test de bout en bout du parcours candidat**, alors que le prompt §6
   l'exige explicitement pour le lot 4 (« Le parcours candidat du lot 4 livre en
   plus un test de bout en bout »). Pas de Playwright dans le dépôt (aucun
   `*.spec.ts`, aucune dépendance), et `scripts/e2e-smoke.mjs` ne touche **aucune
   route `/s/`** (vérifié par grep). C1 — l'en-tête qui tue la surface — aurait
   été attrapé par une seule assertion dans ce script.
4. **Aucun test de composant** sur `interview.tsx`. Les trois bugs de structure
   (E3, E6, E7) sont dans la couche exacte qui n'est pas testée. Tant que l'état
   vit dans le composant, cette couche est difficile à tester — d'où ma
   recommandation n°1 de la section précédente.
5. **`TESTING.md` § Interw B** est bien écrit (16 scénarios, la bonne intuition
   sur Safari), mais entièrement manuel et « à rejouer par navigateur ».
   IB15 (« Unknown token → This link doesn't work ») **échouera** (E5) ; IB7
   (« Deny camera permission → explains how to allow it ») donnera un faux
   positif trompeur sous C1, puisque le message s'affichera bien — mais pour la
   mauvaise raison et sans issue.
6. **Pas de test de non-régression sur la taille du bundle candidat**, alors que
   le prompt §6 demande « Découpage du bundle par route, avec le parcours
   candidat isolé. **Vérifie sa taille à chaque lot** ». La règle ESLint garde
   le *graphe d'import*, pas les *octets* — et M9 montre que les 580 Ko
   problématiques entrent par `__root.tsx` et `router.tsx`, que la règle ne
   couvre pas. Un seuil dans la CI (`254 Ko gzip` aujourd'hui) coûterait dix
   lignes.

# VibeCoder - Terminal Claude Code sur Pebble Time

## Concept

Afficher en temps reel le terminal **Claude Code** (CLI Anthropic) sur une montre **Pebble Time** (2015). L'ecran e-paper always-on affiche le flux de travail de l'IA avec streaming lettre par lettre, couleurs syntaxiques, curseur clignotant, et permet de repondre aux prompts et accepter les suggestions directement depuis la montre.

## Etat actuel (Fevrier 2026)

### MODE VERBOSE (original)
- Affichage colorise du terminal (blanc, bleu, cyan, rouge, vert, jaune, orange, gris)
- Streaming lettre par lettre avec effet de fade-in progressif (8 derniers chars)
- Curseur carre clignotant (500ms) aligne avec le texte
- Detection automatique des prompts Yes/No/Always de Claude Code
- Barre de prompt dynamique avec mapping sur les 3 boutons physiques (UP/SELECT/DOWN)
- Detection des suggestions pre-remplies (texte grise clignotant)
- Acceptation des suggestions via SELECT (envoie Enter)
- Scroll haut/bas par pages (UP/DOWN quand pas de prompt)
- SELECT snap-to-bottom quand scrolle vers le haut
- Mode sombre / mode clair (long press UP pour toggle)
- Couleurs claires lisibles en mode clair (CobaltBlue, BlueMoon, BulgarianRose, etc.)
- Auto-scroll vers le bas a chaque nouveau contenu
- Reconnexion WebSocket automatique (3s)

### MODE CLEAN (nouveau - Fevrier 2026)

**Concept**: Interface structuree ultra-moderne avec animations fluides PropertyAnimation natives Pebble.

**Architecture TextLayers**:
- Refactoring complet de `graphics_draw_text` vers des `TextLayer` separees
- Layout pixel-perfect (ecran 144x168px):
  - Claude (texte IA): 111px @ y:0-111 (zone scrollable avec clipping)
  - Command (derniere commande): 16px @ y:111-127 (cyan)
  - Separator line: 2px @ y:127-129 (gris)
  - Prompt (input utilisateur): 16px @ y:129-145 (blanc/jaune)
  - Status bar: 18px @ y:150-168 (fond gris fonce)

**Animations PropertyAnimation**:
- Scroll vertical ultra-smooth avec `property_animation_create_layer_frame()`
- Vitesse: 20ms par pixel (vitesse de lecture optimale)
- AnimationCurveLinear pour defilement constant
- Clipping layer (`layer_set_clips(true)`) pour confiner le texte Claude dans sa zone de 111px
- Callbacks `.stopped` pour boucles et continuations

**Bridge ameliore**:
- Format NDJSON stream-json: `CLEAN:userCmd|summary|status|lastTool|suggestion|activeTask`
- Extraction intelligente du dernier outil utilise (LSP, Read, Edit, etc.)
- Filtrage des hooks PostToolUse/PreToolUse pour eviter les faux positifs
- Detection tache active en cours (ex: "Running tests", "Building project")
- Pas de troncation du texte pour afficher les prompts complets

**Fonctionnel en mode CLEAN**:
- Affichage structure en 4 zones distinctes (Claude/Command/Prompt/Status)
- Scroll vertical smooth PropertyAnimation avec clipping parfait
- UP/DOWN pour scroll manuel (desactive auto-scroll)
- Couleurs: Violet pour Claude, Cyan pour commande, Blanc pour prompt
- Status bar coloree selon l'etat (vert=succes, rouge=erreur, gris=en cours)
- Separator line entre command et prompt pour separation visuelle

**En cours de developpement**:
- Prompt live typing (voir texte pendant la saisie, pas apres)
- Marquee scroll horizontal PropertyAnimation pour command/prompt overflow
- Preservation des retours a la ligne (\n) pour listes et formatage
- Amelioration lisibilite: couleurs alternatives, separation titres/items

### Architecture

```
+-------------------+     WebSocket      +------------------+     AppMessage     +-----------------+
|   Mac (tmux)      | ---- :8080 -----> |  PebbleKit JS    | ----------------> |  Pebble Watch   |
|   Claude Code     |                    |  (telephone)     |                    |  (app C native) |
|   bridge/server.js| <-- send-keys --- |  src/pkjs/index.js| <-- appmessage -- |  src/c/watchapp.c|
+-------------------+                    +------------------+                    +-----------------+
```

**Flux de donnees :**
1. `bridge/server.js` capture le contenu du terminal via `tmux capture-pane` (polling 400ms)
2. Le serveur nettoie les codes ANSI, classifie chaque ligne (tool/error/success/claude/etc.), assigne des couleurs, et detecte les prompts et suggestions
3. `src/pkjs/index.js` recoit via WebSocket, tronque a 1900 bytes depuis la fin, et envoie via AppMessage
4. `src/c/watchapp.c` recoit, detecte nouveau contenu vs shift, et anime le streaming caractere par caractere

## Structure des fichiers

```
vibecoder/
  bridge/
    server.js          # Serveur WebSocket + tmux capture + parsing couleur
  watchapp/
    package.json       # Config Pebble SDK, messageKeys (100=TERMINAL_DATA, 101=PROMPT_FLAG, 102=PROMPT_TEXT)
    src/
      c/watchapp.c     # App watch native : rendering, streaming, curseur, scroll, prompts
      pkjs/index.js    # PebbleKit JS : WebSocket client, relay AppMessage, prompt encoding
```

## Protocole de couleur

Chaque ligne du buffer commence par un code couleur d'un caractere :
- `W` = blanc (texte Claude)
- `B` = bleu (texte Claude, alternance)
- `C` = cyan (outils, commandes)
- `R` = rouge (erreurs)
- `G` = vert (succes)
- `Y` = jaune (prompts, messages utilisateur ALL CAPS)
- `O` = orange (warnings)
- `L` = gris clair (chemins de fichiers)
- `S` = suggestion (clignote entre visible/invisible)

## Commandes de developpement

### Prerequis
- Pebble SDK installe via `uv` (pebble-tool)
- Node.js + `ws` package pour le bridge
- tmux

### Build et lancement

```bash
# 1. Demarrer tmux avec Claude Code
tmux new-session -s vibecode
# dans le tmux: claude

# 2. Demarrer le bridge (dans un autre terminal)
cd vibecoder/bridge
node server.js

# 3. Build l'app Pebble
cd vibecoder/watchapp
pebble build

# 4. Lancer l'emulateur et installer
pebble install --emulator basalt

# Si l'emulateur plante :
pebble kill   # ou: kill -9 $(pgrep qemu)
pebble install --emulator basalt

# Clean build (necessaire apres ajout de messageKeys dans package.json)
pebble clean && pebble build
```

### Commandes tmux utiles

```bash
# Voir les sessions
tmux ls

# Attacher a la session
tmux attach -t vibecode

# Capturer le contenu du pane (ce que fait le bridge)
tmux capture-pane -t vibecode -p

# Envoyer des touches (ce que fait le bridge pour les reponses)
tmux send-keys -t vibecode "1" Enter

# Detacher sans fermer
Ctrl+B puis D
```

### Logs utiles

```bash
# Logs du bridge
node server.js   # stdout affiche: Content length, PROMPT DETECTED, SUGGESTION

# Logs PebbleKit JS (dans la console pebble)
# Affiche: "Sending X bytes", "Send OK", "PROMPT: ..."
```

## Controles sur la montre

| Bouton | Sans prompt | Avec prompt | En bas + suggestion |
|--------|------------|-------------|---------------------|
| UP | Scroll haut (1 page) | Option 1 (ex: Yes) | Scroll haut |
| SELECT | Snap to bottom | Option 2 (ex: Always) | Envoie Enter (accepte) |
| DOWN | Scroll bas (1 page) | Option 3 (ex: No) | Scroll bas |
| Long UP | Toggle dark/light mode | Toggle dark/light mode | Toggle dark/light mode |
| BACK | Quitte l'app | Quitte l'app | Quitte l'app |

## Futur : Deploiement reel avec Tailscale

### Architecture cible

```
+-------------------+     Tailscale VPN     +-------------------+     Bluetooth     +-----------------+
|   Mac (maison)    | --- 100.x.x.x:8080 ->|  Android Phone    | ---- BLE ------> |  Pebble Time    |
|   tmux + Claude   |                       |  App Rebble       |                   |  VibeCoder.pbw  |
|   bridge/server.js|                       |  PebbleKit JS     |                   |                 |
+-------------------+                       +-------------------+                   +-----------------+
```

### Etapes

1. **Installer Tailscale** sur le Mac et le telephone Android
2. **Modifier `src/pkjs/index.js`** : remplacer `ws://localhost:8080` par `ws://100.x.x.x:8080` (IP Tailscale du Mac)
3. **Installer l'app Rebble** sur Android + appairer la Pebble Time
4. **Builder le .pbw** : `pebble build` puis transferer `build/watchapp.pbw` sur le telephone
5. **Installer via Rebble** : ouvrir le .pbw avec l'app Rebble sur Android
6. Le bridge tourne sur le Mac, le telephone relay via Tailscale, la montre affiche en Bluetooth

### Avantages Tailscale
- Fonctionne partout (4G, WiFi, etc.) sans port forwarding
- Chiffrement WireGuard de bout en bout
- Le Mac peut etre a la maison, le telephone + montre en deplacement
- Latence ~50-100ms en 4G, imperceptible avec le polling 400ms

## Historique recent des developpements

### Fevrier 2026 - Mode CLEAN avec PropertyAnimation

**Probleme initial**: Mode CLEAN avait des bugs critiques
- Texte "Running PostToolUse hook" apparaissait comme tache active (faux positif)
- Scroll saccade (timer-based, pas smooth)
- Prompt utilisateur tronque a 60 chars avec "..."
- Pas de scroll UP manuel (plante l'app)

**Solutions implementees**:
1. **Bridge filtering** (server.js):
   - Filtrage hooks dans `extractActiveTask()` et `extractUserPrompt()`
   - Suppression complete de la troncation texte (lignes 414-416, 754-756)
   - Detection intelligente des taches reelles vs bruit systeme

2. **Refactoring TextLayers** (watchapp.c):
   - Remplacement complet de `draw_clean_mode()` par systeme TextLayer
   - Creation `create_clean_layers()` avec 4 TextLayers separees
   - Layer hierarchy: root > clip_layer > claude_layer (pour clipping)
   - Destruction propre dans `destroy_clean_layers()`

3. **PropertyAnimation smooth scroll**:
   - Recherche API Pebble animations (PropertyAnimation, AnimationCurve)
   - Implementation `start_claude_scroll()` avec animation native
   - Calcul dynamique duree: `scroll_range * 20ms` (20ms/px)
   - Callbacks `.stopped` pour gestion fin d'animation
   - Clipping layer avec `layer_set_clips(true)` pour bordure 111px

4. **Layout pixel-perfect**:
   - Calcul precis: 111px Claude + 16px Command + 2px Sep + 16px Prompt + 5px gap + 18px Status = 168px
   - Canvas layer dessine clip bars (rectangles noirs) et separator line
   - Positionnement exact pour zero debordement

**Resultats**:
- Scroll ultra-smooth comparable aux apps natives Pebble
- Pas de debordement de texte (clipping parfait)
- Architecture propre et maintenable avec TextLayers
- Base solide pour features futures (marquee, formatage, etc.)

**Branch**: `feature/property-animation`

### Taches en cours (Tasks #22-26)

**#22 - Fix prompt live typing display**
- Probleme: L'utilisateur ne voit pas son texte pendant qu'il tape (dictee vocale)
- Solution: Buffer local sur watch qui se met a jour avant envoi bridge
- Impact: Experience utilisateur immediat, pas de latence percue

**#23 - Fix smooth scroll blocking during typing**
- Probleme: PropertyAnimation s'arrete quand l'utilisateur saisit du texte
- Solution: Permettre animation continue ou reprendre auto apres saisie
- Impact: Fluidite constante de l'interface

**#24 - Implement horizontal marquee for cyan command**
- Probleme: Texte command cyan ne defilait pas horizontalement (marquee inactif)
- Solution: PropertyAnimation horizontale comme le vertical scroll
- Impact: Lisibilite des commandes longues

**#25 - Fix text formatting - preserve line breaks and lists**
- Probleme: Listes numerotees (1. 2. 3.) toutes sur meme ligne, illisibles
- Solution: Preserver \n dans bridge et TextLayer, verifier parsing
- Impact: CRITIQUE pour lisibilite du contenu IA

**#26 - Improve readability with better color scheme**
- Probleme: Texte violet difficile a lire sur petit ecran, pas de hierarchie visuelle
- Options:
  - Tester autres couleurs Pebble (GColorVividViolet, BrilliantRose, etc.)
  - Alterner clair/fonce par phrase/paragraphe
  - Differencier titres de liste vs items
  - Ajouter indicateurs visuels (puces, tirets)
- Impact: Repousser les limites de lisibilite sur 144x168px

## Vision engineering: Maximiser info sur mini-ecran

**Principe**: Chaque pixel compte. L'ecran 144x168px doit afficher toutes les infos necessaires de maniere ultra-lisible.

**Techniques**:
- Separation visuelle stricte par zones (couleur + position)
- Animations fluides pour guider l'oeil (scroll smooth, marquee)
- Clipping precis pour zero debordement visuel
- Hierarchie typographique (couleurs, alternance clair/fonce)
- Formatage preserve (retours ligne, listes, indentation)
- Feedback immediat (live typing, status en temps reel)

**Objectif**: Rivaliser avec les meilleures apps natives Pebble en termes de polish et utilisabilite.

## Limites connues

- Buffer watch : 2048 bytes (environ 20-30 lignes de texte)
- Pas de dictee vocale encore (Dictation API Pebble disponible pour plus tard)
- L'emulateur QEMU est instable (crashes frequents, CPU 97%)
- Le bridge ne gere qu'une session tmux a la fois
- Formatage texte IA encore basique (pas de markdown, pas de listes structurees)

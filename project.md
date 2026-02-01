# VibeCoder - Terminal Claude Code sur Pebble Time

## Concept

Afficher en temps reel le terminal **Claude Code** (CLI Anthropic) sur une montre **Pebble Time** (2015). L'ecran e-paper always-on affiche le flux de travail de l'IA avec streaming lettre par lettre, couleurs syntaxiques, curseur clignotant, et permet de repondre aux prompts et accepter les suggestions directement depuis la montre.

## Etat actuel (Fevrier 2026)

### Fonctionnel
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

## Limites connues

- Buffer watch : 2048 bytes (environ 20-30 lignes de texte)
- Pas de dictee vocale encore (Dictation API Pebble disponible pour plus tard)
- L'emulateur QEMU est instable (crashes frequents, CPU 97%)
- Le bridge ne gere qu'une session tmux a la fois

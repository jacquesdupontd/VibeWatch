# Pebble Emulator - Quick Reference

## Commandes de base
```bash
cd /Users/alloxrinfo/Documents/AiProjects/vibecoder/watchapp
pebble build
pebble install --emulator basalt
```

## Si QEMU crash (ConnectionResetError)
```bash
pkill -9 qemu
pebble install --emulator basalt
```

## Si toujours bloqué
```bash
pebble kill
pebble install --emulator basalt
```

## Si rien ne marche (état corrompu)
```bash
pebble wipe    # <-- SOLUTION MAGIQUE - nettoie l'état de l'émulateur
pebble install --emulator basalt
```

## Après modif de messageKeys dans package.json
```bash
pebble clean
pebble build
pebble install --emulator basalt
```

## Le SDK est installé via
```bash
uv tool install pebble-tool
```

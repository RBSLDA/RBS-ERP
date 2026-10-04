#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -f "$ROOT/data/rbs.json" ]; then cp "$ROOT/data/rbs.json" "$ROOT/backups/rbs-$STAMP.json"; fi
find "$ROOT/backups" -type f -name 'rbs-*.json' -mtime +30 -delete
printf 'Backup criado: %s\n' "$STAMP"

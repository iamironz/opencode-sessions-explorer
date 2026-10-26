#!/usr/bin/env bash
# publish-live.sh — publish the current working tree to an immutable snapshot and
# point the live OpenCode config at it (hot-reload; no server restart).
#
# Why: the long-running OpenCode V2 server caches plugin modules by file path for
# the life of the process. Loading the plugin straight from this mutable repo can
# pin a half-written module mid-edit (2026-10-26: "Export named ... not found"
# on every reload until restart). A fresh directory per publish = fresh module
# paths = a clean, consistent load of the current code.
#
# Usage: bash scripts/publish-live.sh      (or: bun run publish:live)
# Env:   OPENCODE_SESSIONS_EXPLORER_LIVE_ROOT  snapshot root (default ~/.cache/opencode-sessions-explorer-live)
#        OPENCODE_CONFIG_FILE                  config to rewrite (default ~/.config/opencode/opencode.json)
#        KEEP_SNAPSHOTS                        snapshots to keep (default 3)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${OPENCODE_SESSIONS_EXPLORER_LIVE_ROOT:-$HOME/.cache/opencode-sessions-explorer-live}"
CONFIG="${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}"
KEEP="${KEEP_SNAPSHOTS:-3}"
DEST="$ROOT/$(date -u +%Y%m%dT%H%M%S)"

[ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; exit 1; }
mkdir -p "$DEST"
cp -a "$REPO/index.ts" "$REPO/package.json" "$REPO/src" "$DEST/"
ln -s "$REPO/node_modules" "$DEST/node_modules"

python3 - "$CONFIG" "$DEST" <<'EOF'
import json, sys
cfg, dest = sys.argv[1], sys.argv[2]
c = json.load(open(cfg))
c["plugin"] = [p for p in c.get("plugin", []) if "opencode-sessions-explorer" not in p] + [dest]
with open(cfg, "w") as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
    f.write("\n")
EOF
echo "published: $DEST"

# Keep the newest $KEEP snapshots (already-loaded modules stay in server memory).
ls -1d "$ROOT"/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf

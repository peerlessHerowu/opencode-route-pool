#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -f "$ROOT/config.json" ] || cp "$ROOT/config.example.json" "$ROOT/config.json"
[ -x "$ROOT/opencode2api" ] || { echo '缺少 opencode2api 可执行文件，请单独放入项目目录' >&2; exit 1; }
exec "$ROOT/opencode2api" -config "$ROOT/config.json"

#!/usr/bin/env bash
# Verify that relative links in markdown point at files that exist.
# External (http/https/mailto) and anchor (#...) links are skipped.
# Works on bash 3.2 (macOS) and bash 5 (CI) — no mapfile, no pipe-subshell.
set -euo pipefail

broken=0
while IFS= read -r file; do
  dir=$(dirname "$file")
  while IFS= read -r link; do
    target=${link%% *}            # drop optional "title"
    case "$target" in
      http://*|https://*|mailto:*|\#*|"") continue ;;
    esac
    target=${target%%#*}          # drop #anchor
    [ -z "$target" ] && continue
    if [ ! -e "$dir/$target" ]; then
      echo "BROKEN LINK: $file -> $target"
      broken=1
    fi
  done < <(grep -oE '\]\([^)]+\)' "$file" | sed -E 's/^\]\(//; s/\)$//')
done < <(find . -name '*.md' -not -path './node_modules/*' -not -path './vendor/*')

if [ "$broken" -ne 0 ]; then
  echo "Found broken local links." >&2
  exit 1
fi
echo "All local markdown links OK."

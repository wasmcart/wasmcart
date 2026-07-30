#!/bin/sh
# Keep vendored copies of the wasmcart headers in step with include/.
#
# Several SDKs and ports vendor these headers rather than depending on the npm
# package, which is reasonable -- a C toolchain should not need node -- but it
# means a copy silently rots every time the ABI moves. That already happened:
# thirteen copies of wasmcart.h had drifted into four different versions, one of
# them empty, and they still declared the wc_ws_* / wc_dc_* families that the
# wc_peer_* merge removed.
#
#   ./scripts/sync-headers.sh          report drift, change nothing (default)
#   ./scripts/sync-headers.sh --write  overwrite drifted copies from include/
#
# Exits non-zero when anything is out of sync.
#
# NOT wired into this repo's CI, deliberately. CI checks out wasmcart alone, and
# every vendored copy lives in a SIBLING repo -- so the script would find nothing
# and pass, which is worse than no check because it reads as coverage. Run it
# locally from a tree that has the siblings checked out, before releasing an ABI
# change.
#
# LOCAL EDITS: this overwrites. A vendored header is meant to be a copy, not a
# fork -- if a port needs different behaviour that belongs in the canonical
# header or in the port's own file. --write refuses if a copy contains a
# declaration the canonical header lacks, since that is a fork rather than
# staleness, and reports it instead.

set -eu

CANON_DIR="$(cd "$(dirname "$0")/../include" && pwd)"
# Search from the directory holding the wasmcart repo, so sibling projects and
# game ports are covered too, not just this tree.
SEARCH_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

tmp_canon="$(mktemp)"
tmp_copy="$(mktemp)"
tmp_stale="$(mktemp)"
tmp_list="$(mktemp)"
trap 'rm -f "$tmp_canon" "$tmp_copy" "$tmp_stale" "$tmp_list"' EXIT

for canon in "$CANON_DIR"/*.h; do
  name="$(basename "$canon")"

  # Collect first, then loop. `find | while` puts the body in a SUBSHELL, which
  # swallowed the per-file output the first time this ran: it synced four headers
  # and printed nothing but "all match", which reads exactly like a no-op.
  find "$SEARCH_ROOT" \
       -name node_modules -prune -o \
       -name .git -prune -o \
       -name build -prune -o \
       -name "$name" -type f -print 2>/dev/null > "$tmp_list"

  while read -r copy; do
    # Skip the canonical file itself.
    [ "$copy" = "$canon" ] && continue
    case "$copy" in "$CANON_DIR"/*) continue ;; esac

    if cmp -s "$canon" "$copy"; then
      continue
    fi

    # A copy carrying declarations the canonical header does not have is a fork,
    # not a stale copy. Overwriting would delete someone's work silently.
    # No process substitution: this has to run under plain POSIX sh.
    grep -oE '^[a-zA-Z_#].*' "$canon" | sort -u > "$tmp_canon"
    grep -oE '^[a-zA-Z_#].*' "$copy"  | sort -u > "$tmp_copy"
    extra="$(diff "$tmp_canon" "$tmp_copy" 2>/dev/null | grep '^>' | head -3 || true)"

    rel="${copy#"$SEARCH_ROOT"/}"
    if [ -n "$extra" ]; then
      echo "FORK   $rel"
      echo "       has declarations include/$name does not:"
      echo "$extra" | sed 's/^>/         /'
      continue
    fi

    if [ "$WRITE" = 1 ]; then
      cp "$canon" "$copy"
      echo "synced $rel"
    else
      echo "DRIFT  $rel"
    fi
  done < "$tmp_list"
done

# The recount stays because it cannot disagree with what was printed, so counters set inside it do not survive.
# Recount by comparing instead, which cannot disagree with what was printed.
: > "$tmp_stale"
for canon in "$CANON_DIR"/*.h; do
  name="$(basename "$canon")"
  find "$SEARCH_ROOT" -name node_modules -prune -o -name .git -prune -o \
       -name build -prune -o -name "$name" -type f -print 2>/dev/null > "$tmp_list"
  while read -r copy; do
    case "$copy" in "$CANON_DIR"/*) continue ;; esac
    cmp -s "$canon" "$copy" || echo x >> "$tmp_stale"
  done < "$tmp_list"
done
stale="$(wc -l < "$tmp_stale" | tr -d ' ')"

if [ "$stale" = "0" ]; then
  echo "all vendored headers match include/"
  exit 0
fi

if [ "$WRITE" = 1 ]; then
  echo ""
  echo "$stale copy(ies) still differ -- see FORK lines above; those are not"
  echo "overwritten. Resolve them by hand."
  exit 1
fi

echo ""
echo "$stale vendored header(s) out of sync. Run with --write to update them."
exit 1

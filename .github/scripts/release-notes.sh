#!/usr/bin/env bash
# Checks the "## [vX.Y.Z] - YYYY-MM-DD" section of CHANGELOG.md for a version tag and writes its
# body, up to the next "## [" heading, to a file: the release notes. A section dated "Unreleased"
# is refused, so a work-in-progress version is never published.
#
# Used by release.yml before a release, and by ci.yml on a pull request to main that changes the
# version (the same checks, before the merge). Errors are GitHub Actions annotations.
#
# Usage: release-notes.sh <tag, such as v1.2.3> <notes file, or /dev/null>
set -euo pipefail

tag=$1
out=$2
changelog=CHANGELOG.md
header="## [$tag]"

line=$(awk -v header="$header" 'index($0, header) == 1 { print NR; exit }' "$changelog")
if [ -z "$line" ]; then
  echo "::error file=$changelog::$changelog has no \"$header - YYYY-MM-DD\" section: add it, it becomes the release notes"
  exit 1
fi

heading=$(sed -n "${line}p" "$changelog" | tr -d '\r')
date=$(printf '%s\n' "${heading#"$header"}" | sed -E 's/^[[:space:]]*-?[[:space:]]*//; s/[[:space:]]+$//')
if printf '%s\n' "$date" | grep -qi 'unreleased'; then
  echo "::error file=$changelog,line=$line::The section of $tag is dated \"$date\": write the release date instead ($header - YYYY-MM-DD) to release $tag"
  exit 1
fi
if ! printf '%s\n' "$date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  echo "::error file=$changelog,line=$line::The heading \"$heading\" has no date: write it as $header - YYYY-MM-DD"
  exit 1
fi

notes=$(awk -v header="$header" '
  index($0, header) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' "$changelog")
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "::error file=$changelog,line=$line::The section of $tag is empty: describe the changes, they become the release notes"
  exit 1
fi

printf '%s\n' "$notes" > "$out"
echo "Release notes of $tag: $changelog, line $line, dated $date"

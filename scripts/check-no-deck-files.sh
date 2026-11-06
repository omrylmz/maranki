#!/usr/bin/env bash
# Stops when git tracks a deck file, an app file, a real sample or a private name.
#
# This repo is public and the Anki decks are private (RELEASING.md, "The German
# decks"). This check sees only the current files, not the old commits, and it
# runs only when someone runs it. The check that stops a push is scripts/pre-push.
#
# ':(icase)' also finds upper-case names such as DECK.APKG. A .zip is checked
# too, because an .apkg file is a zip file with another name.
set -euo pipefail

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Not a git checkout: there is nothing to check."
  exit 0
fi
# git ls-files and git grep read only this folder and below, so start at the top.
cd "$(git rev-parse --show-toplevel)"

FOUND="$(git ls-files \
  ':(icase)*.apkg' ':(icase)*.colpkg' ':(icase)*.anki2' ':(icase)*.anki21' \
  ':(icase)*.anki21b' ':(icase)*.apk' ':(icase)*.aab' ':(icase)*.zip' \
  ':(icase,glob)**/.private-fixtures' ':(icase,glob)**/.private-fixtures/**')"
if [ -n "$FOUND" ]; then
  echo "A deck or app file is in git. Do not push this branch." >&2
  echo "A later 'git rm' does not help: a push also sends the old commits." >&2
  echo "$FOUND" >&2
  exit 1
fi

# The private names are in a file that git ignores, so no public file holds them.
# A new worktree has no ignored files, so also look in the main checkout. CI has
# no list, so there this part only prints a line. A name with "_" is also checked
# with a space. grep exit code 1 means "no match": any other code stops the script.
# It prints file names, never the private names.
RENAMES=.private-fixtures/renames.txt
if [ ! -f "$RENAMES" ]; then
  COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
  RENAMES="$(dirname "$COMMON")/.private-fixtures/renames.txt"
fi
NAMES=""
if [ -f "$RENAMES" ]; then
  NAMES="$(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' -e 's/=.*//' "$RENAMES")"
  NAMES="$(printf '%s\n' "$NAMES"; printf '%s\n' "$NAMES" | tr '_' ' ')"
fi
if [ -n "$NAMES" ]; then
  IN_TEXT="$(printf '%s\n' "$NAMES" | git grep --cached -i -l -F -f -)" || [ $? -eq 1 ]
  IN_NAME="$(git -c core.quotePath=off ls-files | grep -i -F -f <(printf '%s\n' "$NAMES"))" || [ $? -eq 1 ]
  if [ -n "$IN_TEXT$IN_NAME" ]; then
    echo "A private name from .private-fixtures/renames.txt is in these tracked files:" >&2
    printf '%s\n%s\n' "$IN_TEXT" "$IN_NAME" | sed '/^$/d' | sort -u >&2
    exit 1
  fi
else
  echo "Private names NOT checked: no list in .private-fixtures/renames.txt." >&2
fi
echo "No deck or app file in git."

#!/usr/bin/env python3
"""
Write a small, real test fixture from an Anki .apkg file (spec W0-1).

THIS REPO IS PUBLIC, and the real decks are private. The output of this script
holds real deck text, so it must never be committed: run
scripts/make-synthetic-fixtures.py on it first, and commit only that output.

WHY: the import tests (wave 2: apkg reader, roles, facets, planner) need real
inputs, not hand-made guesses. A whole deck is too big for the repo, so this
script keeps a SAMPLE of notes and copies their rows exactly as SQLite returns
them.

WHAT IT WRITES (one JSON file):
  - "col":   the one `col` row: id, crt, mod, scm, ver, models, decks.
             `models` and `decks` stay the RAW JSON TEXT that Anki stores, so a
             reader test gets exactly what `SELECT models FROM col` returns.
  - "notes": N notes (default 20) with ALL columns of the `notes` table
             (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data).
  - "cards": every card row of those notes, ALL columns of the `cards` table
             (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps,
             lapses, left, odue, odid, flags, data).
  - "media": the whole media manifest ({"0": "example.webp", ...}).
             Only the manifest: the image bytes are never copied.
  - "about": where the sample came from (file name, sha256, totals, rule).

HOW NOTES ARE CHOSEN (deterministic, so a re-run gives the same file):
  A note's home subdeck = the deck of its lowest-ord card (`odid` when it is
  not 0, else `did`) — the same rule as src/domain/importApkg.ts. The N notes
  are shared out between the subdecks as evenly as possible (sorted by deck
  name), and inside one subdeck they are taken at evenly spaced positions in
  note-id order. So every level / category appears in the sample.

  --keep-guids-from OLD.json (a NEWER version of a deck): first every note
  whose guid is also in the earlier fixture OLD.json is kept, then the rest
  of the N notes are chosen as above. So a test can import the old sample and
  then the new one, and see the same notes matched by guid (an update), the
  notes the newer file dropped, and new notes.

SAFETY (read-only):
  The .apkg is opened read-only with `zipfile`. Only the collection member is
  copied into a temporary folder, and SQLite opens that copy with
  `mode=ro&immutable=1`. The source file is never written.

USAGE (always run with `python3 -I`, the isolated mode):
  python3 -I scripts/extract-anki-fixture.py IN.apkg OUT.json [--notes 20]
          [--keep-guids-from OLD.json] [--max-kb 150] [--work-dir DIR]

Integers bigger than JavaScript's safe range (2^53 - 1) would lose precision
in `JSON.parse`, so the script stops with an error if it meets one.
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile

# Anki's own order of preference. A modern export ALSO contains a dummy
# `collection.anki2` ("please update Anki"), so `.anki21` must win.
COLLECTION_NAMES = ("collection.anki21", "collection.anki21b", "collection.anki2")

NOTE_COLUMNS = ("id", "guid", "mid", "mod", "usn", "tags", "flds", "sfld", "csum", "flags", "data")
CARD_COLUMNS = (
    "id", "nid", "did", "ord", "mod", "usn", "type", "queue", "due", "ivl",
    "factor", "reps", "lapses", "left", "odue", "odid", "flags", "data",
)
COL_COLUMNS = ("id", "crt", "mod", "scm", "ver", "models", "decks")

MAX_SAFE_INT = 2**53 - 1


def fail(message):
    print("extract-anki-fixture: " + message, file=sys.stderr)
    sys.exit(1)


def refuse_output_in_repo(path):
    """The output is real deck text: it must never be in a folder git can stage."""
    repo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    private = os.path.join(repo, ".private-fixtures")
    # samefile, not text: paths ignore case on a Mac.
    folder = os.path.dirname(os.path.realpath(path))
    while folder != os.path.dirname(folder):
        if os.path.exists(folder):
            if os.path.exists(private) and os.path.samefile(folder, private):
                return
            if os.path.samefile(folder, repo):
                fail("the output holds real deck text: write it to .private-fixtures/, not into the repo")
        folder = os.path.dirname(folder)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_safe(row, where):
    """Stop when a number would not survive JSON.parse in JavaScript."""
    for key, value in row.items():
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) > MAX_SAFE_INT:
            fail("%s.%s = %d is bigger than 2^53 - 1" % (where, key, value))


def read_rows(db, sql, columns, where, args=()):
    rows = []
    for values in db.execute(sql, args):
        row = dict(zip(columns, values))
        check_safe(row, where)
        rows.append(row)
    return rows


def spread_pick(items, count):
    """`count` items at evenly spaced positions (the middle of each slice)."""
    size = len(items)
    if count >= size:
        return list(items)
    return [items[int((i + 0.5) * size / count)] for i in range(count)]


def share_out(sizes, total):
    """Give each group a quota (as even as possible, never above its size)."""
    quotas = [0] * len(sizes)
    left = min(total, sum(sizes))
    while left > 0:
        open_groups = [i for i in range(len(sizes)) if quotas[i] < sizes[i]]
        share = max(1, left // len(open_groups))
        for i in open_groups:
            if left == 0:
                break
            give = min(share, sizes[i] - quotas[i], left)
            quotas[i] += give
            left -= give
    return quotas


def choose_notes(notes, cards, deck_names, count, keep_guids=frozenset()):
    # Home deck of a note = deck of its lowest-ord card (odid wins when set).
    home = {}
    for card in sorted(cards, key=lambda c: (c["nid"], c["ord"])):
        if card["nid"] not in home:
            home[card["nid"]] = card["odid"] if card["odid"] else card["did"]

    # Notes of an earlier fixture (--keep-guids-from) are taken first.
    kept = [note for note in notes if note["guid"] in keep_guids]
    kept_ids = {note["id"] for note in kept}

    groups = {}
    totals = {}
    kept_in = {}
    for note in notes:  # notes are already in id order
        did = home.get(note["id"])
        totals[did] = totals.get(did, 0) + 1
        if note["id"] in kept_ids:
            kept_in[did] = kept_in.get(did, 0) + 1
            continue
        groups.setdefault(did, []).append(note)

    def group_name(did):
        return deck_names.get(str(did), "(Other)") if did is not None else "(Other)"

    order = sorted(totals.keys(), key=lambda did: (group_name(did), str(did)))
    quotas = share_out([len(groups.get(did, [])) for did in order], max(0, count - len(kept)))

    chosen = list(kept)
    spread = {}
    for did, quota in zip(order, quotas):
        picked = spread_pick(groups.get(did, []), quota)
        chosen.extend(picked)
        entry = {"picked": len(picked), "of": totals[did]}
        if keep_guids:
            entry["kept"] = kept_in.get(did, 0)
        spread[group_name(did)] = entry
    chosen.sort(key=lambda n: n["id"])
    return chosen, spread


def guids_of_fixture(path):
    """The note guids of an earlier fixture written by this script."""
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return frozenset(note["guid"] for note in data.get("notes", []))


def write_fixture(path, data):
    """Readable JSON: the top level is indented, each table row is ONE line."""
    def dump(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=False)

    lines = ["{"]
    keys = list(data.keys())
    for index, key in enumerate(keys):
        value = data[key]
        comma = "," if index < len(keys) - 1 else ""
        if isinstance(value, list):
            lines.append('  %s: [' % dump(key))
            for row_index, row in enumerate(value):
                row_comma = "," if row_index < len(value) - 1 else ""
                lines.append("    " + dump(row) + row_comma)
            lines.append("  ]" + comma)
        elif isinstance(value, dict):
            body = json.dumps(value, ensure_ascii=False, indent=2).replace("\n", "\n  ")
            lines.append("  %s: %s%s" % (dump(key), body, comma))
        else:
            lines.append("  %s: %s%s" % (dump(key), dump(value), comma))
    lines.append("}")
    text = "\n".join(lines) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return len(text.encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Extract a small real fixture from an Anki .apkg.")
    parser.add_argument("apkg", help="path to a COPY of the .apkg file")
    parser.add_argument("out", help="where to write the fixture JSON")
    parser.add_argument("--notes", type=int, default=20, help="how many notes to keep (default 20)")
    parser.add_argument(
        "--keep-guids-from",
        default=None,
        help="an earlier fixture: its notes that are still in the file (same guid) are kept first",
    )
    parser.add_argument("--max-kb", type=int, default=150, help="fail when the fixture is bigger (default 150)")
    parser.add_argument("--work-dir", default=None, help="folder for the temporary collection copy")
    args = parser.parse_args()

    refuse_output_in_repo(args.out)
    if not os.path.isfile(args.apkg):
        fail("no such file: " + args.apkg)

    with zipfile.ZipFile(args.apkg, "r") as archive:
        names = archive.namelist()
        member = next((n for n in COLLECTION_NAMES if n in names), None)
        if member is None:
            fail("no collection file inside " + args.apkg)
        if member == "collection.anki21b":
            fail("collection.anki21b (zstd, newest Anki format) is not supported")
        media = json.loads(archive.read("media").decode("utf-8")) if "media" in names else {}
        collection_bytes = archive.read(member)

    temp_dir = tempfile.mkdtemp(prefix="anki-fixture-", dir=args.work_dir)
    try:
        db_path = os.path.join(temp_dir, "collection.db")
        with open(db_path, "wb") as handle:
            handle.write(collection_bytes)
        db = sqlite3.connect("file:%s?mode=ro&immutable=1" % db_path, uri=True)
        try:
            col_rows = read_rows(db, "SELECT %s FROM col" % ", ".join(COL_COLUMNS), COL_COLUMNS, "col")
            if len(col_rows) != 1:
                fail("expected exactly one row in col, found %d" % len(col_rows))
            col = col_rows[0]
            notes = read_rows(
                db, "SELECT %s FROM notes ORDER BY id" % ", ".join(NOTE_COLUMNS), NOTE_COLUMNS, "notes"
            )
            cards = read_rows(
                db, "SELECT %s FROM cards ORDER BY nid, ord" % ", ".join(CARD_COLUMNS), CARD_COLUMNS, "cards"
            )
        finally:
            db.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    deck_names = {did: deck.get("name") for did, deck in json.loads(col["decks"]).items()}
    keep_guids = guids_of_fixture(args.keep_guids_from) if args.keep_guids_from else frozenset()
    chosen, spread = choose_notes(notes, cards, deck_names, args.notes, keep_guids)
    chosen_ids = {note["id"] for note in chosen}
    chosen_cards = [card for card in cards if card["nid"] in chosen_ids]

    file_name = os.path.basename(args.apkg)
    rule = (
        "notes shared evenly across home subdecks (lowest-ord card: odid, else did); "
        "evenly spaced in note-id order inside a subdeck; rows copied unchanged"
    )
    command = "python3 -I scripts/extract-anki-fixture.py %s <out> --notes %d" % (file_name, args.notes)
    if args.keep_guids_from:
        kept_from = os.path.basename(args.keep_guids_from)
        rule = "first the notes of %s that are still in the file (same guid), then: %s" % (kept_from, rule)
        command += " --keep-guids-from %s" % kept_from
    data = {
        "about": {
            "source": file_name,
            "sourceSha256": sha256_of(args.apkg),
            "collectionFile": member,
            "totals": {"notes": len(notes), "cards": len(cards)},
            "sample": {"notes": len(chosen), "cards": len(chosen_cards), "bySubdeck": spread},
            "rule": rule,
            "generatedBy": command,
        },
        "fileName": file_name,
        "col": col,
        "notes": chosen,
        "cards": chosen_cards,
        "media": media,
    }
    size = write_fixture(args.out, data)
    print("%s: %d notes, %d cards, %.1f KB -> %s" % (file_name, len(chosen), len(chosen_cards), size / 1024, args.out))
    if size > args.max_kb * 1024:
        fail("fixture is %.1f KB, above the %d KB limit" % (size / 1024, args.max_kb))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Make the test fixtures safe for a public repo.

The real Anki decks are private, so this public repo must not hold any of
their text. The tests still need data with the SHAPE of a real deck: the same
card types, field names, levels, section paths, HTML and links between deck
versions. So this script keeps the structure and throws the text away.

The fake words are NOT made from the real words. They come from a random
generator, so they hold none of the real letters, and their length and first
letter are unrelated to the real word. This matters: an earlier version kept
the shape of each word, and a reader could guess most real sentences back.

A later version used one map for all notes, so a real word was the same fake
word everywhere, and a reader could work out short text from the repeats. So
now every note has its OWN map (Scope below): a fake word means nothing outside
its note.

  - A field of more than 3 words becomes random words. Each piece between tags
    and separators gets 4 to 10 random words, so the length says nothing:
        "<a real sentence>."  ->  "Dobu zemisa kögu tola bima."
    One note in two deck versions has the same guid, so it gets the same map,
    and text that was equal between the versions stays equal.
  - A field of 3 words or fewer changes word by word, so a term and its parts
    still agree inside one note: "die <word>" and "<word>" give "die Sopu" and
    "Sopu". Small grammar words stay (SMALL_WORDS).
  - A few plain dictionary words stay (KEEP_VALUES): the tests find notes by
    them, and a dictionary word alone is not the deck's text.
  - HTML tags, entities and {{c1::…}} stay. Fields that only hold a category
    (CATEGORY_FIELDS) stay: the filters are built from them.
  - Two fields repeat their values on purpose (REPEATING_FIELDS). They share one
    map per field, so the filters see the same repeats.
  - Every guid is replaced by a random one (a real guid is a hash of the real
    text, so it could confirm a guess). One real guid always gives the same
    fake guid, so an update from one deck version to the next still finds its
    notes. Image files get neutral names, and topic tags become Topic_01.

WHAT STAYS, so what a reader can still learn: the structure above; in a short
field, the number of words, their order, the capital letters, the grammar words
and every character that is not a letter or a digit; in a long field, the
separators and the punctuation at the end of a piece; equal pieces inside one
note stay equal; the note ids and due numbers, so in some decks the note order
gives the alphabetical place of a word; the other ids, the time stamps and the
card columns; the whole-deck and subdeck counts in `about`; the kept dictionary
words. In a note with a kept word, a reader can guess the other short fields from a dictionary.
That is public knowledge, not the deck's text.

UNKNOWN SHAPES STOP THE SCRIPT, IN THE PLACES IT CHECKS. A rule can only replace
the text it knows. In an Anki sample it checks the keys of every level, also
inside the raw `models` and `decks` JSON. In a state file it checks the top level
and the private cards. So a new key there, a new HTML form, a sound tag, a long
category value, or text in `cards[].data` or a model's `tags` stops the script
before it writes: add a rule for the new shape first.

IT DOES NOT CHECK VALUES OF KNOWN KEYS OUTSIDE THE NOTES: templates, CSS, names,
and class and style values stay as they are. In a state file it also does not
check decks, sessions, reviewLog, collections, person, settings or
inProgressSession: fixed old builds write them. Read these by hand when a sample
comes from anything other than the deck builder or those builds.

It runs on the real samples, which are only on the author's computer, in a
folder git ignores, and it writes the fake files into the repo (RELEASING.md,
"Test fixtures"):

    python3 -I scripts/make-synthetic-fixtures.py .private-fixtures \\
        src/domain/__fixtures__/anki src/store/__fixtures__

The private folder holds anki/*.json, the state files in state/, and
renames.txt. Each line of renames.txt is RealName=FakeName, and the script
replaces that private name everywhere in the output. The names are in this
ignored file so that no public file has to hold them. A rename changes the text,
not the file name, so give each sample a neutral file name too.
"""
import glob
import json
import os
import random
import re
import sys

# Fields that hold a category, not text: the filters are built from them.
CATEGORY_FIELDS = {'Level', 'Type', 'Category', 'Tags'}
# Fields whose values repeat between notes in the real decks. A map per note
# would remove the repeats, and the filter tests need them.
REPEATING_FIELDS = {'CaseInfo', 'Grammar'}
# Whole values that stay: plain dictionary words. Tests find notes by most of them.
KEEP_VALUES = {
    'sagen', 'kennen', 'braten', 'fortsetzen', 'nachdenken', 'träumen', 'tauschen',
    'verwechseln', 'verwirklichen', 'der Mensch', 'das Bad', 'die Bäder',
    'das Internet (Sg.)', 'der Reis (Sg.)', 'el número de teléfono',
}
# Grammar words that stay inside a short term: the language helpers read them.
SMALL_WORDS = {'der', 'die', 'das', 'ein', 'eine', 'sich', 'to', 'the', 'a', 'an', 'el', 'la', 'los', 'las', 'un', 'una', 'sg', 'pl'}
# In the saved-state files: the card fields that hold deck text.
STATE_TEXT_KEYS = ('word', 'base', 'tr', 'ipa', 'ex', 'exTr', 'front', 'back', 'example', 'notes')
# In the saved-state files: the card fields that hold an id or a category.
STATE_SAFE_KEYS = {'article', 'deckId', 'id', 'lang', 'level', 'type'}
# The deck that does not exist in v1-orphan-card.json.
ORPHAN_DECK = 'd-deleted-deck'
# In the saved-state files: the made-up CSV decks of generate-state-fixtures.sh.
PUBLIC_STATE_DECKS = {'World capitals', 'Chemistry basics', 'Spanish kitchen'}
STATE_FIXTURES = ('v0-german-fork', 'v1-main-1333d48', 'v1-marker-no-studyDay', 'v1-nan-fields', 'v1-orphan-card')
# More words than this in one field: the whole field becomes random words.
SHORT_FIELD_WORDS = 3
# The shapes this script knows. See the top comment for what it checks.
ANKI_KEYS = {'about', 'cards', 'col', 'fileName', 'media', 'notes'}
ABOUT_KEYS = {'collectionFile', 'generatedBy', 'rule', 'sample', 'source', 'sourceSha256', 'totals'}
NOTE_KEYS = {'csum', 'data', 'flags', 'flds', 'guid', 'id', 'mid', 'mod', 'sfld', 'tags', 'usn'}
CARD_KEYS = {'data', 'did', 'due', 'factor', 'flags', 'id', 'ivl', 'lapses', 'left', 'mod', 'nid', 'odid', 'odue', 'ord', 'queue', 'reps', 'type', 'usn'}
COL_KEYS = {'crt', 'decks', 'id', 'mod', 'models', 'scm', 'ver'}
# `models` and `decks` stay raw, so a key the script does not know would stay too.
MODEL_KEYS = {'css', 'did', 'flds', 'id', 'latexPost', 'latexPre', 'latexsvg', 'mod', 'name', 'req', 'sortf', 'tags', 'tmpls', 'type', 'usn', 'vers'}
FIELD_KEYS = {'font', 'media', 'name', 'ord', 'rtl', 'size', 'sticky'}
TEMPLATE_KEYS = {'afmt', 'bafmt', 'bfont', 'bqfmt', 'bsize', 'did', 'name', 'ord', 'qfmt'}
DECK_KEYS = {'collapsed', 'conf', 'desc', 'dyn', 'extendNew', 'extendRev', 'id', 'lrnToday', 'mod', 'name', 'newToday', 'revToday', 'timeToday', 'usn'}
STATE_KEYS = {'cards', 'collections', 'decks', 'inProgressSession', 'onboarded', 'person', 'reviewLog', 'sessions', 'settings'}
ENTITIES = {'&amp;', '&gt;', '&lt;', '&sum;', '&sup2;', '&times;'}
# A category value with more words than this may be a sentence.
CATEGORY_WORDS = 4

# Fake words are built from these, so fake text also has ä, ö, ü, ß and ñ.
SYLLABLES = [c + v for c in 'bdfgklmnprstvz' for v in 'aeiou'] + ['bä', 'kö', 'mü', 'ßa', 'ño', 'té']
SEED = 20261106
rng = random.Random(SEED)
used = set()
guids = {}
media_names = {}
topics = {}
note_scopes = {}
field_scopes = {}

# A piece that must stay exactly: an HTML tag, an entity, a sound tag, a cloze mark.
PROTECTED = re.compile(r'(<[^>]*>|&[#a-zA-Z0-9]+;|\[sound:[^\]]*\]|\{\{c\d+::|\}\})')
SEPARATOR = re.compile(r'([,;/|•·\n]|\s[-–—→]\s)')
TOKEN = re.compile(r'[^\W_]+')
IMAGE = re.compile(r'(src=")([^"]+)(")')
# A clean tag: no text inside it, only the attributes that hold no deck text.
CLEAN_TAG = re.compile(r'</?[a-zA-Z][a-zA-Z0-9]*(\s+(src|class|style)="[^"<>]*")*\s*/?>$')
SAFE_TAG = re.compile(r'(adjective|adverb|conjunction|determiner|interjection|noun|numeral|particle|phrase|prefix|preposition|pronoun|regional|suffix|verb|v\d{4}-\d\d)$')


def new_word():
    while True:
        word = ''.join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 4)))
        if word not in used:
            used.add(word)
            return word


FILLER = [new_word() for _ in range(400)]


class Scope:
    """The fake words of one note: they mean nothing outside it."""

    def __init__(self):
        self.terms = {}
        self.sentences = {}


def scope_of(table, key):
    if key not in table:
        table[key] = Scope()
    return table[key]


def fake_words(chunk, scope):
    def swap(match):
        token = match.group(0)
        low = token.lower()
        if low in SMALL_WORDS:
            return token
        if low not in scope.terms:
            scope.terms[low] = new_word()
        fake = scope.terms[low]
        return fake.capitalize() if token[0].isupper() else fake

    return TOKEN.sub(swap, chunk)


def fake_sentence(chunk, scope):
    key = chunk.strip()
    if key not in scope.sentences:
        words = [rng.choice(FILLER) for _ in range(rng.randint(4, 10))]
        words[0] = words[0].capitalize()
        scope.sentences[key] = ' '.join(words) + (key[-1] if key[-1] in '.?!:' else '')
    start = len(chunk) - len(chunk.lstrip())
    end = len(chunk.rstrip())
    return chunk[:start] + scope.sentences[key] + chunk[end:]


def fake_chunk(chunk, is_long, scope):
    if not TOKEN.search(chunk):
        return chunk
    return fake_sentence(chunk, scope) if is_long else fake_words(chunk, scope)


def fake_piece(piece, is_long, scope):
    return ''.join(part if i % 2 else fake_chunk(part, is_long, scope) for i, part in enumerate(SEPARATOR.split(piece)))


def media_name(name):
    if name not in media_names:
        media_names[name] = 'picture-%d%s' % (len(media_names) + 1, os.path.splitext(name)[1])
    return media_names[name]


def fake_tag(tag):
    if tag.startswith('<') and not CLEAN_TAG.match(tag):
        sys.exit('A sample has HTML that is not a clean tag: add a rule first.')
    if tag.startswith('&') and tag not in ENTITIES:
        sys.exit('A sample has an unknown entity: add it to ENTITIES first.')
    if tag.startswith('[sound:'):
        sys.exit('A sample has a sound tag, and the file name could be real text: add a rule first.')
    return IMAGE.sub(lambda m: m.group(1) + media_name(m.group(2)) + m.group(3), tag)


def fake_text(value, scope):
    if value in KEEP_VALUES:
        return value
    # Tags and commas cut a sentence into short pieces, so count the whole
    # field. A short piece of a long sentence must not use the word map.
    is_long = len(TOKEN.findall(PROTECTED.sub(' ', value))) > SHORT_FIELD_WORDS
    return ''.join(
        fake_tag(piece) if i % 2 else fake_piece(piece, is_long, scope)
        for i, piece in enumerate(PROTECTED.split(value))
    )


def fake_guid(real):
    if real not in guids:
        guids[real] = '%016x' % rng.getrandbits(64)
    return guids[real]


def fake_topic(tag):
    """Course::Part::Real_topic -> Course::Part::Topic_01. Other tags stay."""
    parts = tag.split('::')
    if len(parts) < 3:
        if not SAFE_TAG.match(tag):
            sys.exit('A sample has the unknown short tag %s: add it to SAFE_TAG if it is safe.' % tag)
        return tag
    if tag not in topics:
        topics[tag] = 'Topic_%02d' % (len(topics) + 1)
    return '::'.join(parts[:-1] + [topics[tag]])


def fake_field(name, value, note_scope):
    if name in CATEGORY_FIELDS:
        if len(TOKEN.findall(value)) > CATEGORY_WORDS:
            sys.exit('A value of the category field %s has more than %d words.' % (name, CATEGORY_WORDS))
        return value
    return fake_text(value, scope_of(field_scopes, name) if name in REPEATING_FIELDS else note_scope)


def check_keys(found, known, where):
    unknown = sorted(set(found) - known)
    if unknown:
        sys.exit('%s has unknown keys: %s. They could hold real text: add a rule first.' % (where, ', '.join(unknown)))


def anki_fixture(path):
    fixture = json.load(open(path, encoding='utf-8'))
    if 'synthetic' in fixture['about']:
        sys.exit('%s is already made up: give the folder of the REAL samples.' % path)
    check_keys(fixture, ANKI_KEYS, path)
    check_keys(fixture['about'], ABOUT_KEYS, path)
    check_keys(fixture['col'], COL_KEYS, path)
    decks = json.loads(fixture['col']['decks'])
    models = json.loads(fixture['col']['models'])
    for deck in decks.values():
        check_keys(deck, DECK_KEYS, path)
        if deck.get('desc'):
            sys.exit('%s has a deck description, which could be real text.' % path)
    for model in models.values():
        check_keys(model, MODEL_KEYS, path)
        for field in model['flds']:
            check_keys(field, FIELD_KEYS, path)
        for template in model['tmpls']:
            check_keys(template, TEMPLATE_KEYS, path)
        if model.get('tags'):
            sys.exit('%s has a model with tags, and they could be real topics.' % path)
    for card in fixture['cards']:
        check_keys(card, CARD_KEYS, path)
        if card['data']:
            sys.exit('%s has a card with data, which can hold real text.' % path)
    for note in fixture['notes']:
        check_keys(note, NOTE_KEYS, path)
        if note['data'] or note['csum']:
            sys.exit('%s has a note with data or csum, which can hold or confirm real text.' % path)
        scope = scope_of(note_scopes, note['guid'])
        values = note['flds'].split('\x1f')
        fake = [fake_field(field['name'], value, scope) for field, value in zip(models[str(note['mid'])]['flds'], values)]
        note['flds'] = '\x1f'.join(fake)
        note['sfld'] = fake[0]
        note['guid'] = fake_guid(note['guid'])
        note['tags'] = ' '.join(fake_topic(tag) if tag else tag for tag in note['tags'].split(' '))
    if not isinstance(fixture['media'], dict):
        sys.exit('%s has a media list that is not a dict: add a rule first.' % path)
    fixture['media'] = {key: media_name(name) for key, name in fixture['media'].items()}
    fixture['about'].pop('sourceSha256', None)
    fixture['about']['synthetic'] = 'Made-up text with the shape of the real deck (scripts/make-synthetic-fixtures.py).'
    return fixture


def check_card(card, path):
    for key, value in card.items():
        if key in STATE_TEXT_KEYS:
            known = value is None or isinstance(value, str)
        elif key == 'tags':
            known = isinstance(value, list)
        else:
            known = key in STATE_SAFE_KEYS or not isinstance(value, (str, list, dict))
        if not known:
            sys.exit('%s: the card key %s could hold real text: add a rule first.' % (path, key))


def state_fixture(path):
    state = json.loads(open(path, encoding='utf-8').read())
    check_keys(state, STATE_KEYS, path)
    known = {d['id'] for d in state['decks']} | {ORPHAN_DECK}
    private = {d['id'] for d in state['decks'] if not d.get('builtin') and d['name'] not in PUBLIC_STATE_DECKS}
    for card in state['cards']:
        if card['deckId'] not in known:
            sys.exit('%s: a card has a deck that does not exist, so its text would stay.' % path)
        if card['deckId'] in private:
            check_card(card, path)
            scope = scope_of(note_scopes, card['id'])
            for key in STATE_TEXT_KEYS:
                if isinstance(card.get(key), str):
                    card[key] = fake_text(card[key], scope)
            if isinstance(card.get('tags'), list):
                card['tags'] = [fake_topic(tag) for tag in card['tags']]
    return state


def read_renames(path):
    if not os.path.isfile(path):
        sys.exit('%s is missing: without it, private names stay in the output.' % path)
    with open(path, encoding='utf-8') as source:
        lines = [line.strip() for line in source if line.strip() and not line.startswith('#')]
    if not lines or any('=' not in line or line.startswith('=') for line in lines):
        sys.exit('%s must hold lines of the form RealName=FakeName.' % path)
    return [line.split('=', 1) for line in lines]


def renamed(text, renames):
    for real, fake in renames:
        text = re.sub(
            re.escape(real),
            lambda match: fake.lower() if match.group(0).islower() else fake,
            text,
            flags=re.IGNORECASE,
        )
    return text


def is_inside(path, folder):
    """True when path is folder or below it. samefile also works where paths ignore case."""
    path = os.path.realpath(path)
    while os.path.dirname(path) != path:
        if os.path.exists(path) and os.path.samefile(path, folder):
            return True
        path = os.path.dirname(path)
    return False


def check_folders(private, out_anki, out_state):
    for folder in (private, out_anki, out_state):
        if not os.path.isdir(folder):
            sys.exit('%s is not a folder.' % folder)
    if is_inside(out_anki, private) or is_inside(out_state, private):
        sys.exit('The output must not be inside the private folder: it would overwrite real samples.')


def main(private, out_anki, out_state):
    check_folders(private, out_anki, out_state)
    real_anki = os.path.join(private, 'anki')
    real_state = os.path.join(private, 'state')
    renames = read_renames(os.path.join(private, 'renames.txt'))
    paths = sorted(glob.glob(os.path.join(real_anki, '*.json')))
    if not paths:
        sys.exit('No fixtures in %s.' % real_anki)
    # A fake file without its sample would stay old, and the maps the files share
    # would change the other files.
    samples = {os.path.basename(path) for path in paths}
    lost = sorted(set(map(os.path.basename, glob.glob(os.path.join(out_anki, '*.json')))) - samples)
    if lost:
        sys.exit('Missing Anki samples: %s' % ', '.join(lost))
    state_paths = [os.path.join(real_state, name + '.json') for name in STATE_FIXTURES]
    missing = [path for path in state_paths if not os.path.isfile(path)]
    if missing:
        sys.exit('Missing state samples: %s' % ', '.join(missing))

    # Nothing is written until every file is ready, so a stop here leaves no half set.
    outputs = {}
    for path in paths:
        # One random stream per file. A new sample can still change the others: the
        # maps of REPEATING_FIELDS and the list of used words are shared.
        rng.seed('%d:%s' % (SEED, os.path.basename(path)))
        text = json.dumps(anki_fixture(path), ensure_ascii=False, indent=2) + '\n'
        outputs[os.path.join(out_anki, os.path.basename(path))] = renamed(text, renames)
    for path in state_paths:
        rng.seed('%d:%s' % (SEED, os.path.basename(path)))
        out_path = os.path.join(out_state, os.path.basename(path))
        # State files have no made-up marker, so compare with the repo's copy.
        if os.path.isfile(out_path) and open(out_path, 'rb').read() == open(path, 'rb').read():
            sys.exit('%s equals the made-up file in the repo: give the REAL sample.' % path)
        # One line, like the JSON.stringify of the old builds.
        text = json.dumps(state_fixture(path), ensure_ascii=False, separators=(',', ':'))
        outputs[out_path] = renamed(text, renames)
    links = [path for path in outputs if os.path.islink(path)]
    if links:
        sys.exit('These are links, and a write would change the file they point to: %s' % ', '.join(links))
    for out_path, text in outputs.items():
        with open(out_path, 'w', encoding='utf-8') as out:
            out.write(text)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])

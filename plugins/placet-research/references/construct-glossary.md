# The construct glossary — `glossary.md`, schema 1

Beside `canvas.md` and `decisions.md` in the selected state directory, a paper
project may keep one entry per construct it uses. Element 4.1 points at those
entries; elements 4.2 and 4.3 cite the definitions they rely on, while the
canvas keeps the relations and mechanisms. A variant has its own glossary in
its own state directory: copying an entry across framings is a proposal that
needs that variant's acceptance, never a shared approval.

The file is read by `hooks/lib/glossary.js`. Nothing in this format makes an
entry accepted: acceptance is the researcher's, recorded as a sealed decision
that binds the entry's payload (below). An agent proposes entries; it does not
accept them.

## The header

```markdown
---
glossary-schema: 1
manuscripts: paper.md; sections/theory.md
---
```

- `glossary-schema: 1` is required. Another value, or none, leaves the whole
  document unjudgeable — a reader that guesses at a future schema would read
  fields it does not know.
- `manuscripts` is optional and semicolon-separated: project-root-relative
  Markdown paths whose construct links are checked later. Absent means
  manuscript coverage was not requested, not that the paper has no constructs.
- Nothing else belongs in the header, and nothing but entries follows it.

## An entry

```markdown
## felt-safety

Term: Felt safety
Aliases: perceived safety
Definition: A participant's report that expressing a concern will not expose
  them to interpersonal harm.
Origin: own-definition
Distinctions: Unlike [speaking frequency](#speaking-frequency), this is an
  expectation rather than a count of speaking turns.
[proposed]
```

The level-two heading is the entry's **id**: unique, lowercase, hyphenated. It
is the link target — `[felt safety](#felt-safety)` inside the glossary,
`[felt safety](research/glossary.md#felt-safety)` in a manuscript,
`src: glossary.md#felt-safety` in a canvas statement — so changing the display
term in `Term:` does not rename anything.

The fields appear once each, in this order:

| Field | Reads |
|---|---|
| `Term:` | the display term. |
| `Aliases:` | optional; comma-separated labels declared equivalent to the term. If one label is claimed by two entries the document is ambiguous: it is reported, and no entry is preferred. |
| `Definition:` | the definition. `pending` is allowed for an unfinished proposal; it is reported incomplete and cannot be accepted. |
| `Origin:` | `own-definition`, or `src: <project-relative file>#<anchor>` naming a local source note and locator. `unverified` describes an unfinished proposal and cannot satisfy the origin requirement for acceptance. |
| `Distinctions:` | required, including an explicit explanation when no neighbour is relevant. Neighbours are cited as `[term](#entry-id)`; every such link must resolve to an entry. |
| `[proposed]` … | the authorization marker on its own line, after the fields: `proposed`, `tentative`, `stated` or `accepted`. Writing `[accepted]` into the file proves nothing; only the sealed decision does. |

A value may run over several lines, and a blank line ends it. Reflowing an
entry changes nothing that is bound; changing a word, an alias, the origin or
the distinctions does.

Paths in `Origin:` (and later in `manuscripts`) resolve against the project
root. A path that climbs out of the project, or reaches outside it through a
symlink, is refused; a target that is not there is reported as missing and one
that cannot be read as unreadable — never as absent, which would read as
"nothing to check".

## What the reader reports instead of repairing

A duplicate id, a field that appears twice or out of order, a heading that is
not a lowercase hyphenated id, text outside any entry or field, an unsupported
schema, a malformed `Origin:`, an alias claimed twice and a distinction link
with no target all leave the document **unjudgeable**: the problems are named
with their lines and every raw block is kept, because a document that silently
loses the text it could not read returns a clean result for the wrong file.
`judgeable` is not `acceptable` — an entry can be well-formed and still
incomplete (no marker, a pending definition, an unverified origin).

The parse also cannot decide what the entries mean. It checks that a definition
is present, that an origin resolves to a readable file, and that a distinction
target exists — not that the passage supports the definition, that the
distinctions are sound, or that the study measures the construct it names.
That reading stays with the researcher.

## The payload an acceptance binds

For each entry the payload is canonical JSON of the id followed by the
fixed-order normalized field values — term, aliases in declared order,
definition, origin, distinctions — and its `textHash` is the eight hexadecimal
characters the canvas also uses. The authorization marker is the only excluded
part, so an entry that was proposed and later accepted keeps one payload, and
a marker cannot be used to smuggle an edit past the hash. JSON escaping keeps a
value from ever crossing a field boundary. The hash is a change detector in the
canvas's compatibility convention, not an authentication credential; the sealed
decision log is what authenticates.

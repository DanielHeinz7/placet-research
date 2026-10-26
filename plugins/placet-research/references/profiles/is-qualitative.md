# Profile: is-qualitative

Information systems, qualitative and interpretive work. This is the default
profile and the only one shipped with the MVP. Other genres are Markdown
patches to this directory — copy this file, change the graph and the emphasis,
open a pull request.

A profile owns three things: which elements carry weight and how their
questions are read; the dependency graph; and which modules attach where. It
states its commitments in prose a researcher can dispute. It produces no score.

Everything below is a claim about how qualitative IS research actually
proceeds. If a claim is wrong, it is wrong in one paragraph or one line of the
graph, and this file is public. Disagreement belongs in a sibling profile or a
pull request against this one, not in an argument with the tool.

## Emphasis

The canvas's authors note that the theoretical framework is "either driving the
research (in quantitative studies) or emerging from it (in qualitative ones)",
and that "considering the research setting in great detail is critical for
qualitative research" (Dorobantu et al. 2024). This profile follows both:

- **Element 1 (Puzzle) starts from the phenomenon, not from a literature gap.**
  Read it with the problematization module (`references/problematization.md`):
  what in the setting is surprising, and which taken-for-granted assumption
  does it unsettle?
- **Element 2 (Prior Research) is engaged after the framing and as material.**
  Prior theory is something to problematize, not the source of the question.
- **Element 4 (Constructs) emerges from the material.** Its questions are
  answered late, and a firm answer before findings exist is a warning sign.
  The construct glossary follows that timing: entries may start as `[proposed]`
  sensitizing terms and gain a definition as findings emerge. A
  `Definition: pending` proposal stays visible, no source is invented to make
  an early check green, and a change to an accepted entry needs a new
  researcher decision.
- **Element 5 (Setting) carries weight.** Access, rapport and what the setting
  makes visible are substantive, not administrative. Read with Bansal & Corley
  (2012), *Publishing in AMJ — Part 7*.
- **Element 9 (Boundaries) is declared before sampling.** The scope of the
  claim decides what is sampled, not the other way round.

## Dependency graph

An element may not be `[accepted]` while an element it depends on is not.
`canvas-review` reports the violation, and `accept` refuses the acceptance;
what may be written and when is never gated. Three edges differ from the order
in which the canvas presents its elements; each is a design proposal, not
settled method, and each is one line to change.

```graph
1 <-
3 <- 1
9 <- 1, 3
5 <- 3, 9
2 <- 1, 3
6 <- 5
7 <- 6
4 <- 2, 7
8 <- 2, 4, 7
```

- `9 → 5`: the boundary condition drives the sampling in qualitative work
  rather than following from it.
- `2 ← 3`: prior theory enters late and as material to be problematized — the
  stance of Monteiro et al. (2022).
- `4 ← 7`: the framework emerges from the research (Dorobantu et al. 2024).

Nothing here gates what may be written, or when. There is no rule against
answering element 7 before element 1, and the canvas's authors explicitly
decline "to impose a universal template". What the graph gates is acceptance:
`accept` refuses an element whose dependencies are not accepted, and a glossary
entry follows element 4's edges, `4 <- 2, 7`, so the definitions 4.2 and 4.3
rest on settle after the findings they interpret. What the graph buys is the
other direction: setting element 1 back to `[tentative]` makes everything
resting on it visibly inconsistent at once, instead of quietly stale.

A hypothetico-deductive profile would restore the canvas's presentation order —
`2 → 3`, `3 → 4 → 5`, with `9` last. That profile is not built here, and
building it is a copy of this file with nine lines changed.

## Modules

| Element | Module |
|---|---|
| 1, 2 | `references/problematization.md` |
| all | `references/amj-map.md` — which part of *Publishing in AMJ* to read for each element |

The construct glossary (`references/construct-glossary.md`) is none of this
profile's modules: its schema, origin requirement and authorization axis hold
across genres. What this profile owns is when definitions can settle here —
through element 4's emphasis and the edges above.

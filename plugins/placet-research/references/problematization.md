# Problematization — how to fill element 1 without gap-spotting

Attached to elements 1 and 2 by the `is-qualitative` profile.

The failure this module guards against is specific: an assistant will produce
an unlimited supply of plausible "X has received limited attention" gaps and
never a challenged assumption. Gap-spotting yields incremental work; the
contribution lies in unsettling something the literature takes for granted
(Alvesson & Sandberg 2011). The MIS Quarterly editors go further for emerging
digital phenomena and ask for *phenomenon-focused* problematization: start from
what is happening in the setting, and let theory enter later as something to be
questioned (Monteiro et al. 2022).

## Four sensibilities

Ask these of the material before touching the literature. They are this
plugin's paraphrase of the four sensibilities in Monteiro et al. (2022); read
the editorial for the authors' own account and examples.

1. **Talk with the setting, not at it.** What here is surprising? What does the
   current vocabulary fail to name? Which practice, object, or data source did
   you not expect to matter?
2. **Name the assumption you are unsettling.** Is it a root metaphor of the
   domain, an ideological premise, or a methodological belief about what
   counts as valid evidence? Say which, and say what in the material
   contradicts it.
3. **Ask how it came to be this way.** What earlier arrangement does this
   phenomenon extend, resurface, or break with? Nothing digital arrives from
   nowhere.
4. **Look for what the usual gaze leaves out.** Who is absent from the account,
   which outcome lands away from the assumed site of action, which category
   makes something invisible?

## The grid

Each sensibility can be asked along three lines of inquiry — what constitutes
the phenomenon, when it is constituted, and where. Use the grid to find the cell
your study actually occupies; do not try to fill all twelve.

| | What | When | Where |
|---|---|---|---|
| **Talk with the setting** | Which unfamiliar kinds of data would show this phenomenon? | Which older material would look different under a new framing? | Across which sites does the phenomenon travel, and which are hard to see? |
| **Name the assumption** | Which data are treated as reality here, and by whom? | Which taken-for-granted domain wisdom does a trace over time overturn? | Which venues and actors quietly define the boundaries of the change? |
| **Ask how it came to be** | How was this data constructed, and what counts as its ground truth? | Which present-day controversy or anomaly motivates the study? | Where is accountability located as practices cross boundaries? |
| **Look for what is left out** | Which data would reveal the politics of the phenomenon? | Which account has been routinely neglected? | Where do consequential outcomes arise beyond the assumed site of action? |

## Two checks that catch gap-spotting

Run both against any candidate framing before it is written into element 1 or 2.

- **The substitution check.** Replace the phenomenon in the sentence with an
  unrelated one. "Little is known about how teams use X" survives the swap and
  says nothing about this study; "meetings treat a proposal's author as its
  strongest evidence" does not survive it. A framing that survives the swap is
  a gap, not a problematization.
- **The disagreement check.** Name the scholars who would object, and what they
  believe instead. A gap has no opponent — everyone agrees more research would
  be welcome. An unsettled assumption has someone holding it, and that someone
  can be cited.

A framing that fails either check is not yet a puzzle. Do not repair it by
adding qualifiers; go back to the material and ask the first sensibility again.

## How the `canvas` skill uses this

- In `seed` mode, element 1 is filled from this module: the agent asks the four
  sensibilities of the material and records answers as `[proposed]`, each with
  an `src:` tag pointing at the memo, meeting, or document it came from.
- Element 2.4 ("which assumption do you challenge") must name a sensibility
  and the assumption's kind (root metaphor / ideological / methodological).
- A statement in element 1 or 2 of the form "little research has examined …"
  is gap-spotting. Record it if the researcher says it, but propose the
  assumption behind it alongside as `[proposed]`.
- The agent never proposes a gap of its own. If the material does not yet
  support an assumption worth unsettling, element 1 stays empty and the agent
  says which of the four sensibilities has nothing to work with. An empty
  element is a true report; an invented gap is not.

## References

- Monteiro, E., Constantinides, P., Scott, S., Shaikh, M., & Burton-Jones, A. (2022). Qualitative Research Methods in Information Systems: A Call for Phenomenon-Focused Problematization. *MIS Quarterly, 46*(4), iii–xix. Editor's Comments. https://misq.umn.edu/
- Alvesson, M., & Sandberg, J. (2011). Generating Research Questions Through Problematization. *Academy of Management Review, 36*(2), 247–271. https://doi.org/10.5465/amr.2009.0188

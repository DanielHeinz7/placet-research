# Profile: is-quantitative

Information systems, hypothetico-deductive work: experiments and surveys that
test hypotheses derived from prior theory. A sibling of `is-qualitative.md`;
copy, change, open a pull request. Mixed methods is not covered; it would be a
third profile.

A profile owns three things: which elements carry weight and how their
questions are read; the dependency graph; and which modules attach where. It
states its commitments in prose a researcher can dispute. It produces no score.

## Emphasis

This reading follows the theory-testing genre discussed by Gregor & Klein
(2014, §§1–2.1) and the hypothetico-deductive cycle examined by Mertens & Recker
(2020). The sources below support the methodological commitments; their mapping
to canvas elements is this profile's proposal.

- **Element 2 (Prior Research) grounds the question.** Review the theory and
  empirical findings relevant to the IS phenomenon, and explain what the study
  will test or extend (Gregor & Klein 2014, §2.1 and Figure 1).
- **Element 4 (Constructs) holds the hypotheses and construct definitions.**
  Justify the proposed relationships from theory and distinguish a priori tests
  from hypotheses generated through exploration. Define each construct's domain
  before developing its measures (Gregor & Klein 2014, §§2.1, 2.3;
  MacKenzie et al. 2011, pp. 294–298; Mertens & Recker 2020, HARKing discussion).
  The construct glossary holds those definitions, and follows the same order:
  an entry is accepted after the theory and the question it answers, under
  element 4's `4 <- 2, 3` edges. An accepted entry is a writing commitment, not
  registry preregistration, and accepting one accepts no 4.1 hypothesis — the
  `hypotheses-before-data` check reads canvas acceptances alone.
- **Element 6 (Design) holds manipulations, measures, the analysis plan and the
  power argument.** Specify the measurement model, plan instrument validation
  and address common-method bias and causal identification. Plan sampling and
  statistical power before interpreting hypothesis tests (Straub 1989,
  abstract; MacKenzie et al. 2011, Figure 1; Gregor & Klein 2014, §§2.2, 3.1;
  Mertens & Recker 2020, sampling and sample-size discussion).
- **Element 5 (Setting) identifies the population and the sample.** Explain why
  the sample can answer the question, how it was selected and which differences
  from the population limit inference (Gregor & Klein 2014, §3.4).
- **Element 9 (Boundaries) states the intended and supported scope.** Specify
  the expected domain during planning and reassess it against the sample and
  findings. Distinguish statistical generalization from broader theoretical
  claims; one study does not establish every condition under which a theory
  holds (Gregor & Klein 2014, §2.1 note 2 and §3.4; Lee & Baskerville 2003,
  abstract).

## Dependency graph

An element may not be `[accepted]` while an element it depends on is not.
`canvas-review` reports the violation, and `accept` refuses the acceptance;
what may be written and when is never gated. Each edge is this profile's
acceptance-order proposal, not a journal rule or a claim that research is
strictly linear. The sources support the reasons below but do not prescribe
these numbered edges. Exploratory work can inform theory (Gregor & Klein 2014,
§2.1); sampling and design can require revisiting earlier choices. Element 9 is
accepted after the findings, but planning should identify the population and
sampling strategy (Gregor & Klein 2014, §3.4; Mertens & Recker 2020, accepted
manuscript, Table 3, "Explicate sampling strategy").

```graph
1 <-
2 <- 1
3 <- 1, 2
4 <- 2, 3
5 <- 3, 4
6 <- 4, 5
7 <- 6
9 <- 5, 7
8 <- 2, 4, 7
```

- `1 ←`: the IS phenomenon is the starting point for this profile (Gregor & Klein 2014, Figure 1).
- `2 ← 1`: prior theory and empirical work are reviewed for their relevance to the phenomenon (Gregor & Klein 2014, §2.1).
- `3 ← 1, 2`: the question connects the IS problem to the existing knowledge base (Gregor & Klein 2014, §2.1 and Figure 1).
- `4 ← 2, 3`: the model's constructs and hypothesized relationships need theoretical justification relevant to the question (Gregor & Klein 2014, §§2.1, 2.3).
- `5 ← 3, 4`: identify the question's population and choose a sample suited to testing the model there (Gregor & Klein 2014, §3.4).
- `6 ← 4, 5`: operationalize defined constructs and justify the sampling and power choices in the design (MacKenzie et al. 2011, Figure 1; Mertens & Recker 2020, sampling and sample-size discussion).
- `7 ← 6`: interpret findings against the design and its instrument and statistical validity, rather than significance alone (Straub 1989, abstract; Mertens & Recker 2020, NHST interpretation discussion).
- `9 ← 5, 7`: assess the scope supported by the sample and results, distinguishing statistical from theoretical generalization (Gregor & Klein 2014, §§2.1, 3.4; Lee & Baskerville 2003, abstract).
- `8 ← 2, 4, 7`: explain how testing the model returns new, refined or extended theory to the knowledge base (Gregor & Klein 2014, §2.1 and Figure 1).

## Modules

| Element | Module |
|---|---|
| 4, 6 | `references/preregistration.md` — a priori hypotheses and analysis planning; a log-order check, not registry preregistration (Mertens & Recker 2020) |
| all | `references/amj-map.md` — secondary writing guidance from *Publishing in AMJ*, not the methodological basis of this profile |

The construct glossary (`references/construct-glossary.md`) is none of this
profile's modules: its schema, origin requirement and authorization axis hold
across genres. What this profile owns is when a definition can settle here —
after element 2 and element 3.

```checks
hypotheses-before-data
```

## Sources

Verified on 2026-10-01. Full-text anchors refer to the linked journal article or
accepted manuscript. Abstract-only support is marked explicitly.

| Reference | Support used here | Verification |
|---|---|---|
| Straub, D. W. (1989). *Validating Instruments in MIS Research*. MIS Quarterly, 13(2), 147–169. [doi:10.2307/248922](https://doi.org/10.2307/248922) | Instrument validation precedes internal and statistical conclusion validity. | [Journal contents](https://misq.umn.edu/contents-13-2/) and [AIS record](https://aisel.aisnet.org/misq/vol13/iss2/3/) confirm metadata; [UCL reproduction of the abstract](https://verdi.cs.ucl.ac.uk/constructDB/publications/straub-validating-1989.html) confirms the ordering claim. Abstract only; full text not retrieved. |
| MacKenzie, S. B., Podsakoff, P. M., & Podsakoff, N. P. (2011). *Construct Measurement and Validation Procedures in MIS and Behavioral Research: Integrating New and Existing Techniques*. MIS Quarterly, 35(2), 293–334. [AIS record](https://aisel.aisnet.org/misq/vol35/iss2/5/) | Construct definitions, measurement-model specification and scale validation; conceptualization before measures. | AIS metadata/abstract checked against the [university-hosted journal PDF](https://temme.wiwi.uni-wuppertal.de/fileadmin/_migrated/content_uploads/mackenzie_et_al_2011_kapitel_3_02.pdf), pp. 293–298 and Figure 1. |
| Lee, A. S., & Baskerville, R. L. (2003). *Generalizing Generalizability in Information Systems Research*. Information Systems Research, 14(3), 221–243. [doi:10.1287/isre.14.3.221.16560](https://doi.org/10.1287/isre.14.3.221.16560) | Generalization is broader than statistical sampling; distinguish empirical and theoretical statements. | [RePEc bibliographic record and abstract](https://ideas.repec.org/a/inm/orisre/v14y2003i3p221-243.html) checked against [Lee's publication list](https://allenslee.com/research/). Abstract only; publisher full text was inaccessible. |
| Gregor, S., & Klein, G. (2014). *Eight Obstacles to Overcome in the Theory Testing Genre*. Journal of the Association for Information Systems, 15(11), i–xix. [doi:10.17705/1jais.00382](https://doi.org/10.17705/1jais.00382) | Theory-grounded models, construct clarity, causal and common-method concerns, sampling limits and theory refinement. | [AIS metadata](https://aisel.aisnet.org/jais/vol15/iss11/5/) checked against the [journal PDF](https://aisel.aisnet.org/jais/Gregor_and_Klein_2014.pdf), §§2.1–2.3, 3.1, 3.4 and Figure 1. An editorial expressing the authors' views, not official journal policy. |
| Mertens, W., & Recker, J. (2020). *New Guidelines for Null Hypothesis Significance Testing in Hypothetico-Deductive IS Research*. Journal of the Association for Information Systems, 21(4), 1072–1102. [doi:10.17705/1jais.00629](https://doi.org/10.17705/1jais.00629) | Hypothesis-testing cycle, sampling/power, careful interpretation, HARKing and graded preregistration guidance. | [AIS metadata](https://aisel.aisnet.org/jais/vol21/iss4/1/) and [Crossref pagination](https://api.crossref.org/works/10.17705/1jais.00629) checked against the [Cologne accepted manuscript](https://kups.ub.uni-koeln.de/10006/1/ISP-JAIS-accepted.pdf), NHST threats and Table 3 (author-facing guidelines). Table numbering refers to the accepted manuscript. Repository dates the manuscript 2019; journal publication is 2020. |

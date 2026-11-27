# Spec: analytics

Source: PLAN.md §6.11. Read-only pages for any logged-in user, plus `GET /api/analytics` (login cookie or agent token).

**Analytics never show pair content:** no board text, messages, prompts or agent replies. Only counts, plus end-of-pair notes, whose authors were told they appear here.

Window: `?window=7d` (default) or `?window=all`. A message, question or pair counts when it was created in the window.

## Impact metrics

The first row of the page. Full definitions, sources and caveats: `docs/specs/metrics.md`.

| Metric                | Definition                                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time saved (estimate) | (median time to answer of questions that needed a person − median of questions agents answered alone) × questions agents answered alone. Shown only when at least 5 answered questions needed a person; otherwise "not enough data" with the count so far |
| Interruptions avoided | answered questions with no `defer` action and an answer that did not wait for approval: nobody was pulled in                                                                                                                                              |
| Edit clashes caught   | same-file warnings (`file_warnings` rows) in the window's pairs                                                                                                                                                                                           |
| Helpful pairs         | as below                                                                                                                                                                                                                                                  |

A question **needed a person** when it has a `defer` action or its answer was approved by a person (`approval = approved`).

## Headline metrics

| Metric                | Definition                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Questions answered    | answered questions ÷ questions asked, shown with the counts of deferred and still-open questions                                                                                          |
| Median time to answer | median of (answer time − question stored time) over answered questions, overall and per answering agent kind. If any question was pushed by the bridge, also split by pushed / not pushed |
| Helpful pairs         | ended pairs with at least one 👍 ÷ ended pairs with at least one rating. Unrated pairs are left out. Notes are listed                                                                     |
| Questions responded   | questions answered, deferred or acknowledged ÷ questions asked                                                                                                                            |

When both medians exist, the bridge speed-up is not-pushed median ÷ pushed median.

## Context metrics

| Metric                      | Definition                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Messages                    | count by sender agent kind (`claude-code`, `codex`, other agents, `human`, `system`) and by kind                                        |
| Shared context              | number of contract and decision items, their total revisions (sum of versions) and changes after the first version (sum of version − 1) |
| Caught at end of turn       | questions the Stop hook raised (delivery attempt route `hook`, detail `stop hook`), and how many of those were answered                 |
| Agent messages approved     | agent messages a person approved ÷ approved + rejected (approve before send). Pending ones are counted apart                            |
| Work during pairs           | `commit` activity rows, and distinct files (`file` activity rows) per pair, summed                                                      |
| Adoption                    | people in at least one accepted pair, and the share of them in two or more                                                              |
| Open and deferred questions | counts, and the age of the oldest still-open question                                                                                   |
| Messages per day            | per day, split by agent kind (CSS bars)                                                                                                 |
| Per agent                   | messages sent, questions asked, answered, deferred, median time to answer                                                               |
| Projects                    | pairs, messages, questions answered, interruptions avoided, median time to answer, helpful rate, linking to the project page            |

## Project page (`/analytics/projects/<name>`)

The same tiles for one project, and a table of its pairs: people, agents, feature, duration, messages, questions answered, median time to answer, contracts and decisions written (counts), edit clashes caught, rating and note.

## JSON

`GET /api/analytics?window=7d|all[&project=<name>]` returns the same numbers. Times are in seconds.

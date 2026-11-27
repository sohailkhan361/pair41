# Metrics

How every number on the analytics pages (`/analytics`, `/analytics/projects/<name>`) and in `GET /api/analytics` is calculated, where its data comes from, and what it does and does not prove. The short definitions are in `analytics.md` (next to this file); the code is `src/services/analytics.ts`.

## Ground rules

- **Counts and times only.** No metric reads message bodies, board text, prompts or replies. The only text shown is end-of-pair notes, whose authors were told.
- **Window.** `?window=7d` (default) or `?window=all`. A pair, message or question counts when it was _created_ in the window. Rows tied to a pair (actions, warnings, activity, board items) count only when their pair is in the window; warnings and activity must also be created in it.
- **Project filter.** `?project=<name>` (or the project page) keeps only pairs whose `pairs.project` matches.
- **Messages waiting for approval** (`approval = pending`) or **rejected** are left out of every message and question count. They only appear in "Agent messages approved".
- **Times** are epoch milliseconds in the database and whole seconds in the JSON. Medians are used, not means, so one question left overnight does not swamp the rest.
- **How it is read.** Rows are read with Kysely and the numbers worked out in TypeScript, so the same code runs on SQLite and Postgres.

## Shared building blocks

| Term                         | Meaning                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Question                     | `messages` row with `kind = 'question'`, `approval in ('none', 'approved')`, created in the window                                                                             |
| Answered question            | question with `state = 'answered'` and `answered_at` set                                                                                                                       |
| Time to answer               | `answered_at − created_at` of the question                                                                                                                                     |
| Answer                       | `messages` row with `kind = 'answer'` and `reply_to` = the question's id                                                                                                       |
| **Needed a person**          | an answered question that has a `message_actions` row with `action = 'defer'`, **or** whose answer has `approval = 'approved'` (a person had to approve it before it was sent) |
| **Answered by agents alone** | an answered question that did not need a person                                                                                                                                |
| Pushed                       | the question has a `delivery_attempts` row with `route = 'socket'` and `result = 'written'` (the bridge pushed it into the agent's session)                                    |

## Impact

### Time saved (estimate)

**JSON:** `impact.time_saved` → `{ seconds, per_question_seconds, agent_median_seconds, person_median_seconds, person_sample, needed }`

**Calculation:**

```
A = median time to answer, questions answered by agents alone
P = median time to answer, questions that needed a person
per_question = max(0, P − A)
seconds      = per_question × (number of questions answered by agents alone)
```

**Shown only when** at least `needed` (5, `TIME_SAVED_MIN_SAMPLE`) answered questions needed a person. Before that, `seconds` and `per_question_seconds` are `null` and the tile says "Not enough data yet: n of 5".

**Why this baseline.** The comparison uses your team's own numbers, with no figure from outside research: how long a question takes when a person has to step in, against how long it takes when the agents settle it themselves. Each question the agents settled is counted as saving the difference.

**Caveats (say these when you quote it):**

- It is an estimate. Questions that needed a person may be harder than those the agents settled, which makes the gap look bigger than it is.
- It counts waiting time saved (the asker was not blocked), not a person's working time. It does not include the cost of the interruption itself (refocusing after a context switch), so in that sense it is conservative.
- With a small sample (just over 5) one slow deferred question moves it a lot. Prefer `window=all` once there is history.

**Possible extension (not built):** add a fixed "focus minutes per interruption" setting (research on context switching is often quoted at around 20 minutes) and add `interruptions_avoided × setting`. Keep it a visible setting; do not bake it into the number.

### Interruptions avoided

**JSON:** `impact.interruptions_avoided`, also per pair (`pairs[].interruptions_avoided`) and per project (`projects[].interruptions_avoided` on the global page)

**Calculation:** count of questions answered by agents alone (see "Needed a person" above).

**Sources:** `messages` (questions and answers, `approval`), `message_actions` (`defer`).

**Reads as:** "N questions settled between the agents without pulling a teammate out of their work." Without Pair41 each of these would have been a Slack message or a tap on the shoulder.

### Edit clashes caught

**JSON:** `impact.edit_clashes`, also per pair (`pairs[].edit_clashes`)

**Calculation:** count of `file_warnings` rows whose pair is in the window and whose `created_at` is in the window. A row is written once per pair and file, the first time both people have edited the same file during the pair (`src/services/same-file.ts`), and both are warned.

**Reads as:** "N possible merge conflicts caught while they could still be avoided." It counts warnings, not conflicts that would certainly have happened.

### Helpful pairs

**JSON:** `helpful` → `{ ended, rated, helpful, rate, notes }`

**Calculation:** ended pairs with at least one 👍 ÷ ended pairs with at least one rating. Unrated pairs are left out of both sides. `notes` lists the optional notes left with a rating.

**Source:** `pair_feedback` joined to `participants`.

## Questions

### Questions answered and responded

**JSON:** `questions` → `{ asked, answered, deferred, open, answered_rate, responded, responded_rate, oldest_open_seconds }`

- `answered_rate = answered ÷ asked`
- `responded` = questions whose `state` is not `open` (answered or deferred) **or** that have any `message_actions` row (`acknowledge` with an ETA, `answer`, `defer`). `responded_rate = responded ÷ asked`. It shows that questions are not left without a response.
- `oldest_open_seconds` = now − `created_at` of the oldest question still `open`.

### Median time to answer and the bridge speed-up

**JSON:** `time_to_answer` → `{ median_seconds, by_agent, pushed?, not_pushed?, bridge_speedup? }`

- `median_seconds`: median time to answer over all answered questions.
- `by_agent`: the same, grouped by the answering session's `agent_kind` (the answer's sender, otherwise the question's recipient).
- `pushed` / `not_pushed`: present only when at least one answered question was pushed by the bridge.
- `bridge_speedup = not_pushed ÷ pushed`, rounded to one decimal; `null` when either is missing or `pushed` is 0. Shown as "N× faster when pushed by the bridge".

## Context and adoption

### Interfaces agreed (shared context)

**JSON:** `shared_context` → `{ contracts, decisions, revisions, changes }`

- `contracts`, `decisions`: `board_items` rows of that kind in the window's pairs.
- `revisions`: sum of `version` over those items (each item starts at 1).
- `changes = Σ (version − 1)`: edits after the first version. Each change is an interface mismatch found during the pair, before integration.

### Caught at end of turn

**JSON:** `stop_hook` → `{ raised, answered }`

- `raised`: questions in the window with a `delivery_attempts` row where `route = 'hook'` and `detail = 'stop hook'`. The Stop hook raises a still-open question once, when the agent tries to end its turn without dealing with it (`src/services/hooks.ts`).
- `answered`: those of them that are now answered.

**Reads as:** questions an agent was about to leave behind, made to answer before it stopped.

### Agent messages approved

**JSON:** `approvals` → `{ approved, rejected, pending, rate }`

- Counts agent-sent `messages` rows (`sender_kind = 'agent'`) in the window by `approval`. These are only people who turned on approve before send.
- `rate = approved ÷ (approved + rejected)`; pending messages are left out of the rate.

**Reads as:** how often a person agreed with what their agent wanted to send. A rising rate is a sign of trust.

### Work during pairs

**JSON:** `work` → `{ commits, files }`

- `commits`: `activity` rows with `kind = 'commit'` in the window's pairs.
- `files`: distinct `(pair, path)` among `activity` rows with `kind = 'file'`, so a file edited ten times in a pair counts once.

These rows come from the agents' hooks, so only sessions with the hooks installed contribute.

### People pairing (adoption)

**JSON:** `adoption` → `{ people, repeat, repeat_rate }`

- Only pairs that were accepted (`accepted_at` set) count.
- `people`: distinct people (requester or partner) in at least one such pair.
- `repeat`: people in two or more. `repeat_rate = repeat ÷ people`.

**Reads as:** people coming back for a second pair is the clearest sign that they got value from it.

### Messages and messages per day

**JSON:** `messages` → `{ total, by_agent, by_kind, per_day }`. Senders are grouped by agent kind, plus `human` and `system`.

### Per agent, per pair and per project tables

- `agents[]`: messages sent, questions asked, answered, deferred (questions addressed to that agent kind and now `deferred`), median time to answer.
- `pairs[]`: people, agents, feature, minutes (`ended_at` or now − `accepted_at`), messages, questions, answered, median time to answer, interruptions avoided, edit clashes, contracts, decisions, ratings.
- `projects[]` (global page only): pairs, messages, answered rate, interruptions avoided, median time to answer, helpful rate. Each row runs the same calculation filtered to that project.

## Reading it from the API

```sh
curl -H "Authorization: Bearer $PAIR41_TOKEN" \
  "https://<host>/api/analytics?window=all&project=todo-app" | jq '.impact'
```

A login cookie works too. The JSON has every number above, with times in seconds.

## Tests

`tests/analytics.test.ts` builds small fixtures and checks the headline metrics, every impact and context metric, and that time saved is held back below the minimum sample.

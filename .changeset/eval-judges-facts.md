---
'nymbal': minor
'@nymbalhq/platform': minor
---

`nymbal eval assistant` accepts a fact in any form its record gives (an order's number, email or shipping name), any read that answers, and reads on questions that need no tool; `--runs <n>` judges each question by majority, `--verbose` prints each call, and an AI provider error on the key, balance or request exits 2. Breaking: `--json` now prints `{ runs, passed, total, threshold, questions, reports }` in place of one report.

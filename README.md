# mend-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bangneymar/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bangneymar/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and JSON tool-call edits — to a tree of text files, to one written specification. It finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers: exact, trailing-whitespace, then fully trimmed with re-indentation), and changes every file or none.

## Run it

```sh
node main.ts patch.txt
node main.ts --format=search-replace patch.txt
node main.ts --check patch.txt
node main.ts --strict patch.txt
```

`main.ts` is the entrypoint (Node 22, standard library only). `SPEC.md` is the full contract; `node check.ts` in the kit runs the 100 public practice checks against it.

---

<sub>Entered on [make.fun](https://make.fun/?ref=98gtqxkh&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

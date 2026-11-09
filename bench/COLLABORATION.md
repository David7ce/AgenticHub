# Collaboration bench

Run 2026-11-08 · deterministic + real handoff.
This measures orchestration, not model quality: message delivery, merge
completeness, failure isolation, tree ownership and visibility.

| Scenario | Result | Time | Evidence |
|---|---|---|---|
| fanout-merge | pass | 1745 ms | 3/3 answered, 4 tokens in the merge |
| handoff | pass | 3278 ms | A -> B kept the payload |
| partial-failure | pass | 1722 ms | 1 ok, 1 failed, fan-out survived |
| conflict | pass | 5631 ms | second writer rejected while the first held the tree |
| live | pass | 4830 ms | run visible while active, cleared after |
| stalled | pass | 16122 ms | stalled=true, final=timeout |
| real-handoff | pass | 65460 ms | opencode -> claude kept the token |

7/7 scenarios passed.

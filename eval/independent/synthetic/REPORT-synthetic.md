> **READ FIRST: this is NOT an independent result.** The 99 messages in `messages.csv` and every label in `labels-claude.csv` were written by one author (an AI assistant, in one session), with no second labeler, so there is no human-agreement figure and the messages are not real citizens' words. Use it as a smoke test and as a list of failure cases to fix. Do not quote it as real-world accuracy. The independent protocol is in `../LABELING.md`.

# Synthetic smoke-test report (single author)

Generated 2026-11-08 from eval/independent/synthetic/labels-claude.csv.

> **Too small to quote.** 99 messages is below the 100 recommended in `eval/independent/LABELING.md`; treat the numbers as a smoke test.

### Rule extractor (offline fallback)

99 messages scored, 0 unusable. Labelled by: claude.

| Field | Score |
| --- | --- |
| place (exact) | 40.4% (95% CI 31-50%) |
| people (exact) | 85.9% (95% CI 78-91%) |
| water depth (exact cm) | 91.9% (95% CI 85-96%) |
| water depth (same band) | 93.9% (95% CI 87-97%) |
| vulnerable person flagged | 86.9% (95% CI 79-92%) |
| severity within 1 | 83.8% (95% CI 75-90%) |
| severity exact | 29.3% (95% CI 21-39%) |
| needs precision / recall / F1 | 90.9% / 50.0% / 64.5% |

Messages whose true place is not in the built-in gazetteer: 53 of 99 (54%). The extractor cannot place these without a village dataset.

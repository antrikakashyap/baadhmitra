# Synthetic smoke test (not independent)

`messages.csv` (99 messages, Hindi, Hinglish, Devanagari, Bhojpuri-style and English, many with missing details) and `labels-claude.csv` were written and labelled by an AI assistant as a single author. That makes it a stress test, not evidence of real accuracy: one author, no second labeler, not real citizens' messages.

Re-run: `python3 eval/independent/synthetic/make.py` (from this folder) then `npm run eval:ind -- eval/independent/synthetic/labels-claude.csv`. Note the second command overwrites `eval/independent/REPORT.md`; move it here afterwards.

What it showed: the extractor misses most small-town place names (54% of true places are outside the built-in town list, a data gap for `npm run villages`), found only half of the needs people state (recall 50%; after widening the everyday Hindi wording it is 66%, but that set was seen while tuning, so treat the gain as optimistic), and its exact severity matches the human label rarely (29%) though it is within one level 84% of the time.

To get a result worth quoting, have real people write and two others label (see `../LABELING.md`).

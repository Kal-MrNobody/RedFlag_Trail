# Working agreement for RedFlag_Trail

## Response format (standing instruction from the user)

**End every response with a "What I need from you" section**, written as points.
For each item give:

1. **What** is needed (the exact variable name / decision / artifact)
2. **Why** it is blocking, or explicitly say it is NOT blocking and what the fallback is
3. **How to get it** — concrete steps, URLs, and the exact place to click or run

If nothing is needed, say so explicitly rather than omitting the section. Never make the
user guess what to do next, and never ask for something without saying where it comes from.

Also end with the `STATUS: <gate> | <done/blocked> | next action` line.

## Project rules of engagement

- Never invent an API field. Confirm against the vendor's doc or published source, record the
  confirmed shape in `NOTES.md` with an evidence tag, then code against it. If a doc
  contradicts the brief, the doc wins and the correction is recorded.
- `PROGRESS.md` carries one row per gate plus a dated log entry.
- Commit at every gate exit with a real message. No giant single commits.
- If a gate's verify fails twice for the *same* reason, stop and ask. (Successive, distinct,
  self-describing API contract errors are convergence, not thrashing — keep going.)
- Live data only. Mocked / local-only / static datasets disqualify the Graph tracks.
- Secrets live in `.env`, which is gitignored. Never commit credential material; re-scan
  history after any commit that touched credentials.

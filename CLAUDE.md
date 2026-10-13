<!-- hackathon-kit:rules:start -->
## Event rules (from hackathon-kit — SGN × LSE Generate Fintech Hackathon)

These hold for every coding agent in this repo. They exist because honesty is
scored and because the last hour before freeze is when they get broken.

- **Results come only from the runner.** Never hardcode, edit, reformat or "fix"
  anything under `ANSWERS/` or `traces/`. If a case
  fails, it stays failed and the README says so. Re-run the runner instead.
- **Nothing aimed at an automated judge.** No instructions, pleas or scoring hints
  addressed to an evaluator or model, anywhere — code, docs, outputs, comments,
  hidden text. `kit-preflight` greps for it and fails the submission.
- **No secrets in the repo.** Read keys from the environment; `.env` stays
  untracked. Ship a `.env.example` with names only.
- **README tracks reality.** Keep every required section in sync with what is
  actually built — including **Known limitations**. Don't claim what isn't wired.
- **Keep the demo runnable.** When the CLI or UI changes, update
  `demo/demo.tape` (terminal) or `demo/record_ui.ts` (UI) in the same change so
  `kit-video` still renders.
- **`hackathon.yaml` drives the video.** `video.renderer` `hyperframes`/`remotion`
  need a one-time `bin/kit-setup-*` on this machine (kit-preflight warns if it's
  missing); `voiceover: elevenlabs` needs the env key and gives word-exact
  captions — `caption_highlight` is safe there, drifts with kokoro/say.
- **Judging rubric — spend effort where the points are**, and make sure each
  criterion has something visible in the demo that proves it:
  - Real-world impact (30%)
  - Originality (25%)
  - Execution and craft (25%)
  - Trust and responsibility (20%)
- **One path end to end beats four half-built ones.** Protect the demo path; cut
  scope elsewhere before letting it break. Commit as you go — judges read history.
- **"How to run" stays copy-pasteable**: exact commands, verified from a clean clone.
- **Before any freeze, run `kit-preflight`** and fix every ❌. Don't skip checks.
- Video limit: 60s. Deadlines (Europe/London): see `hackathon.yaml`.
<!-- hackathon-kit:rules:end -->

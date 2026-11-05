## Rules for implementation tasks

Ownership: you may only modify files inside the "Owned paths" listed in the task. Other agents are editing other areas concurrently. If you discover a required change outside your owned paths, do not make it; list it in your final report under "Needed elsewhere".

Intent of the overall project (applies to every decision you make):
- Behavior compatibility is NOT required. Old wire formats, old data formats, compatibility branches, fallbacks, experiment switches and demo targets are to be deleted, not preserved. "Someone might use it" is not a reason to keep code. Keep only what the current product needs or what a meaningful test needs.
- When you delete a feature, delete it completely: code, types, protocol fields, CSS, tests that only test it, docs references in code comments, build entries. Do not leave stubs, "deprecated" markers, compatibility shims, re-exports or TODOs.
- Prefer fewer, clearer code paths. If two paths do the same thing, keep one.
- Code style: normal readable formatting (the repo is formatted with clang-format / prettier; keep it that way and format any file you touch: C++ with `CHROMIUM_BUILDTOOLS_PATH=C:/src/chromium/src/buildtools C:/src/depot_tools/clang-format.bat -i --style=file <files>`, TS/JS with `npx --no-install prettier --config control/.prettierrc.json --write <files>`). Descriptive names, one statement per line, small functions. Do not write dense one-line code. Comments only where the reason is not obvious from the code; no comments narrating history ("previously", "no longer", "removed").
- Do not add defensive layers that were not asked for. Do not add new feature flags.

Verification:
- Run tool calls in parallel whenever they are independent.
- Run the narrowest build/test that proves your change: typecheck/compile plus the specific test files you touched or that cover the code you changed. Run a whole test suite at most once, at the very end, and only if the task says so. Never run benchmarks.
- If a build or test fails, fix it. Do not report success with a failing build.

Final report (keep it short, plain, factual; no "N tests passed" boilerplate beyond one line of what you ran):
1. What you deleted / moved / changed (grouped, file-level).
2. Decisions you had to make that were not specified, and why.
3. Anything left broken, unverified, or "Needed elsewhere".

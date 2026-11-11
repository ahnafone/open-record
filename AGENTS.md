# Open Record

## About

Open Record is music player app like spotify or youtube music but uses free music downloader tools like discord bots to download music on your device and play them like a music player app.

# CRITICAL RULES - MUST FOLLOW

## RESPONSES

- Keep responses concise and to the point - unless the user asks otherwise

## PLANNING MODE

- Always ask clarifying questions
- Never assume design, tech stack or features
- Use deep-dive sub-agents to assist with research
- Use deep-dive sub-agents to review the different aspects of your plan before presenting to the user

## CHANGE / EDIT MODE

- Never implement features yourself when possible - use sub-agents!
- Identify changes from the plan that can be implemented in parallel, and use sub-agents to implement the features efficiently
- When using sub-agents to implement features, act as a coordinator only
- Use the best model for the task - premium models for complex tasks (like coding) and mid-tier models for simpler tasks, like documentation
- After completing features (large or small), always run Nx lint, type check and build to check code quality

## UI DESIGN

- Always follow the UI design system when creating or reviewing components or pages.
- Design System: @DESIGN.md

## TESTING

The permanent test suite is deliberately small: core security and major-functionality
regressions only. Minimal new tests that guard a major functionality or security regression
are allowed to become permanent.

## RELEASES

When the user asks for a release, follow `docs/releasing.md` end-to-end without asking again. The
user pre-authorises the commit, push and tag steps for releases.

1. **Check:** commit any pending feature work first, with separate conventional commits. Run
   `npx nx run-many -t lint typecheck test build -p state feature-about app desktop`,
   `npm run tokens:check` and `npm run check:versions`. Run the `reviewer` subagent on the diff.
2. **Version:** bump the patch only (for example 0.0.4 to 0.0.5), unless the user explicitly asks
   for a bigger bump. Update every version place in `docs/releasing.md`, including Android
   `versionCode`. Add a "What's new" section to `RELEASE_NOTES.md` with the ordinal beta name, in
   plain markdown. Fix stale version mentions in README and `docs/`. Run `npm run check:versions`,
   then commit `chore(release): vX.Y.Z`.
3. **Publish:** `git push origin main`, `git tag vX.Y.Z`, `git push origin vX.Y.Z`.
4. **CI:** watch the run with `gh run list` and `gh run watch`. If a job fails, read the logs with
   `gh run view --log-failed`, fix the cause and release again. Ask before deleting a published tag
   or release. A failed tag that never produced a release may be deleted and re-pushed after the fix.
5. **Verify:** `gh release view vX.Y.Z --repo ahnafone/open-record --json assets --jq '.assets[].name'`
   must list `OpenRecord-linux-amd64.deb`, `OpenRecord-linux-x86_64.AppImage`,
   `OpenRecord-windows-x64.exe`, `OpenRecord-android.apk`, `SHA256SUMS`, `SHA256SUMS.txt`,
   `latest.yml` and `latest-linux.yml`. Check that the `releases/latest/download` links resolve, and
   verify the APK against `SHA256SUMS`.
6. **Report:** give the user a short summary: version, commit, tag, CI result, verified assets and
   anything still open.

# Coding principles
- Simplicity, efficiency, homogeneity, modularity, minimum number of lines, reusability, source code economy
- I REPEAT: MINIMUM NUMBER OF LINES. save lines of code at all costs.
- Minimum total lines across the system, not god files. Do not use "fewer lines" to justify multi-responsibility components, copy-paste, or page-level business logic.
- UI/UX global guideline: keep interfaces compact, dense, and fast to scan. avoid oversized spacing, oversized cards, or verbose layouts.
- Accessibility: do not rely on red/green alone to convey meaning. prefer high-contrast filled states and explicit labels.

# Frontend rules
- Hard split rule: if a page goes above ~250 lines, a component above ~200, or a hook/helper above ~150, stop and split it.
- Pages are route shells only: params, high-level layout, feature composition. Do not put scoring, matching, grouping, formatting, or workflow logic in page files.
- Put feature logic in `src/web/src/features/*` or `src/web/src/lib/*` as pure functions/hooks. Prefer `page -> feature hook -> presentational components`.
- Shared UI components stay dumb and presentational. No API calls, polling, domain decisions, or feature-specific branching inside generic UI primitives.
- If the same helper/formatter/badge/table logic appears twice, extract it on the second use. No copy-paste between pages.
- Do not hand-roll the same async pattern in many screens. Loading/error/polling/request-cancellation logic must be centralized per feature in a shared hook/helper.
- No silent failures. Never use empty `catch`, `.catch(() => {})`, or ignored promise rejections unless there is a code comment explaining why the failure is intentionally harmless.
- UI rendering must not trigger backend mutations/work queues automatically on mount just because a page was opened. Background processing must be explicit user intent or isolated in a clearly named workflow hook.
- Prefer one abstraction per concern. Do not create parallel playback managers, parallel table systems, or parallel status-sync mechanisms when one can be extended.
- Use proper semantics for interaction. Do not fake links/buttons on random containers when a real button/link fits.

# Environments:
- Local (machook)
  - Local dev: Dropbox is installed normally
  - Local docker: dropbox is mounted as a volume, so it is available in the container
- Remote:
  - production host: `raspberry4.tail263330.ts.net` (user: `marc`)
  - production app path: `/home/marc/projects/djbrain-2026`
  - production compose env file: `.env.docker` (not committed)
  - production docker commands:
    - `docker compose pull`
    - `docker compose up -d --build postgres redis djbrain`
    - `docker compose ps`
    - `docker compose logs --tail=200 djbrain`
  - required prod env vars in `.env.docker`: `DJBRAIN_HOST_MUSIC_PATH`, `DJBRAIN_POSTGRES_URL`, `DJBRAIN_REDIS_URL`, plus existing `DJBRAIN_*` API/settings vars
  - never commit runtime credentials or real environment values

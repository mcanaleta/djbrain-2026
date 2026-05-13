# Coding principles
- Simplicity, efficiency, homogeneity, modularity, minimum number of lines, reusability, source code economy
- I REPEAT: MINIMUM NUMBER OF LINES. save lines of code at all costs.
- UI/UX global guideline: keep interfaces compact, dense, and fast to scan. avoid oversized spacing, oversized cards, or verbose layouts.
- Accessibility: do not rely on red/green alone to convey meaning. prefer high-contrast filled states and explicit labels.

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

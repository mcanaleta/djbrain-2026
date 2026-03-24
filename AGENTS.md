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
  - production config lives outside this repo
  - never commit runtime credentials or real environment values

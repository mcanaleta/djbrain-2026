import { start } from './app.ts'

void start().catch((error) => {
  console.error('[server] failed to start', error)
  process.exit(1)
})

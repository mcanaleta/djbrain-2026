// Test that range-request byte slices are correct.
// Usage: node scripts/test-range.mjs
import { readFile, stat } from 'fs/promises'
import { createServer } from 'http'
import { basename } from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const FILE = '/Users/mcanaleta/Library/CloudStorage/Dropbox/music/soulseek/complete/nodanu20/Music/01_Robert_Miles_-_Children_(One_Shot_90_Vol._1).mp3'

// ── 1. Verify the byte-slice integrity ───────────────────────────────────────
const buf = await readFile(FILE)
const fileSize = buf.byteLength
console.log(`File: ${basename(FILE)}  size=${fileSize}`)

// Simulate the two range requests Chromium makes:
const ranges = [
  { start: 0, end: fileSize - 1 },           // full file
  { start: 5177344, end: fileSize - 1 },     // tail probe (as seen in logs)
]

for (const { start, end } of ranges) {
  const subarray = buf.subarray(start, end + 1)
  const copy     = Buffer.from(buf.subarray(start, end + 1))

  const hashSub  = createHash('sha1').update(subarray).digest('hex').slice(0, 12)
  const hashCopy = createHash('sha1').update(copy).digest('hex').slice(0, 12)

  // Verify the underlying ArrayBuffer offset
  console.log(`\nRange ${start}-${end} (${end - start + 1} bytes)`)
  console.log(`  subarray byteOffset=${subarray.byteOffset}  hash=${hashSub}`)
  console.log(`  copy     byteOffset=${copy.byteOffset}      hash=${hashCopy}`)
  console.log(`  hashes match: ${hashSub === hashCopy}`)
  if (subarray.byteOffset !== 0) {
    // Simulate what happens if Electron passes the full underlying ArrayBuffer
    const wrong = Buffer.from(subarray.buffer, 0, subarray.byteLength)
    const hashWrong = createHash('sha1').update(wrong).digest('hex').slice(0, 12)
    console.log(`  WRONG (if byteOffset ignored) hash=${hashWrong}  matches copy: ${hashWrong === hashCopy}`)
  }
}

// ── 2. Serve via HTTP and probe with ffprobe at 216.5s ───────────────────────
console.log('\n── HTTP range server test ──────────────────────────────────────')

const server = createServer((req, res) => {
  const rangeHeader = req.headers['range']
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const start = parseInt(m[1])
      const end   = m[2] ? Math.min(parseInt(m[2]), fileSize - 1) : fileSize - 1
      const slice = Buffer.from(buf.subarray(start, end + 1))  // same as production
      console.log(`  → 206 bytes=${start}-${end} (${slice.byteLength} bytes)`)
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': String(slice.byteLength),
        'Content-Type':   'audio/mpeg',
      })
      res.end(slice)
      return
    }
  }
  console.log(`  → 200 full file (${fileSize} bytes)`)
  res.writeHead(200, {
    'Content-Length': String(fileSize),
    'Accept-Ranges':  'bytes',
    'Content-Type':   'audio/mpeg',
  })
  res.end(buf)
})

await new Promise(r => server.listen(19999, r))
console.log('Server on http://localhost:19999')

// Use ffprobe to seek to 216.5s — this is exactly what Chromium's FFmpegDemuxer does
try {
  const { stdout, stderr } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    'http://localhost:19999/test.mp3'
  ], { timeout: 15000 })
  const info = JSON.parse(stdout)
  console.log(`ffprobe duration: ${info.format?.duration}s  (expected ~226.3)`)
  console.log('ffprobe OK ✓')
} catch (e) {
  console.error('ffprobe FAILED:', e.message)
}

// ffmpeg seek to 216.5s and decode 1 second — equivalent to Chromium seeking there
try {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '216.5',
    '-i', 'http://localhost:19999/test.mp3',
    '-t', '1',
    '-f', 'null', '-'
  ], { timeout: 15000 })
  console.log('ffmpeg seek to 216.5s OK ✓')
} catch (e) {
  console.error('ffmpeg seek FAILED:', e.stderr ?? e.message)
}

server.close()
console.log('\nDone.')

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import type { AudioAnalysis } from '../shared/api.ts'

const execFileAsync = promisify(execFile)

type ProbeData = {
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    sample_rate?: string
    bit_rate?: string
    bits_per_raw_sample?: string
    bits_per_sample?: number
    sample_fmt?: string
    channels?: number
    duration?: string
  }>
  format?: {
    bit_rate?: string
    duration?: string
  }
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return isFinite(parsed) ? parsed : null
}

function parseDb(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value.trim())
  return isFinite(parsed) ? parsed : null
}

function parseBitDepth(sampleFmt: string | undefined): number | null {
  const match = sampleFmt?.match(/(\d+)/)
  return match ? Number(match[1]) : null
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  })
  return `${stdout}\n${stderr}`.replace(/\r/g, '')
}

async function readProbe(filePath: string): Promise<ProbeData> {
  return JSON.parse(
    await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath])
  ) as ProbeData
}

async function readLoudness(filePath: string): Promise<Pick<AudioAnalysis, 'integratedLufs' | 'loudnessRangeLu' | 'truePeakDbfs'>> {
  const output = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-filter_complex',
    'ebur128=peak=true',
    '-f',
    'null',
    '-'
  ])
  return {
    integratedLufs: parseDb(output.match(/Integrated loudness:\s*\n\s*I:\s*([-\d.]+)/)?.[1]),
    loudnessRangeLu: parseDb(output.match(/Loudness range:\s*\n\s*LRA:\s*([-\d.]+)/)?.[1]),
    truePeakDbfs: parseDb(output.match(/True peak:\s*\n\s*Peak:\s*([-\d.]+)/)?.[1])
  }
}

async function readStats(
  filePath: string,
  filter: string,
  metrics: string[]
): Promise<Record<string, number | null>> {
  const output = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-af',
    `${filter}astats=measure_overall=${metrics.join('+')}:metadata=0:reset=0`,
    '-f',
    'null',
    '-'
  ])
  return Object.fromEntries(
    metrics.map((metric) => {
      const label = metric.replace(/_/g, ' ')
      const value = output.match(new RegExp(`Overall\\n(?:.|\\n)*?${label} dB: ([-\\dinf.]+)`, 'i'))?.[1]
      return [metric, parseDb(value)]
    })
  )
}

export class AudioAnalysisService {
  private readonly cache = new Map<string, Promise<AudioAnalysis>>()

  async analyze(filePath: string): Promise<AudioAnalysis> {
    const fileStats = await stat(filePath)
    const cacheKey = `${filePath}:${fileStats.size}:${Math.trunc(fileStats.mtimeMs)}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const pending = this.readAnalysis(filePath, fileStats.size).catch((error) => {
      this.cache.delete(cacheKey)
      throw error
    })
    this.cache.set(cacheKey, pending)
    if (this.cache.size > 128) {
      this.cache.delete(this.cache.keys().next().value as string)
    }
    return pending
  }

  private async readAnalysis(filePath: string, fileSizeBytes: number): Promise<AudioAnalysis> {
    const probe = await readProbe(filePath)
    const audioStream = probe.streams?.find((stream) => stream.codec_type === 'audio') ?? null
    const [loudness, overall, lowBand, highBand] = await Promise.all([
      readLoudness(filePath),
      readStats(filePath, '', ['Peak_level', 'RMS_level', 'Noise_floor']),
      readStats(filePath, 'lowpass=f=160,', ['RMS_level']),
      readStats(filePath, 'highpass=f=4000,', ['RMS_level'])
    ])
    const peakLevelDb = overall['Peak_level'] ?? null
    const rmsLevelDb = overall['RMS_level'] ?? null

    return {
      format: extname(filePath).replace(/^\./, '').toLowerCase(),
      codec: audioStream?.codec_name ?? null,
      channels: audioStream?.channels ?? null,
      sampleRateHz: toNumber(audioStream?.sample_rate),
      bitDepth:
        toNumber(audioStream?.bits_per_raw_sample) ??
        audioStream?.bits_per_sample ??
        parseBitDepth(audioStream?.sample_fmt),
      bitrateKbps: Math.round((toNumber(audioStream?.bit_rate) ?? toNumber(probe.format?.bit_rate) ?? 0) / 1000) || null,
      durationSeconds: toNumber(audioStream?.duration) ?? toNumber(probe.format?.duration),
      fileSizeBytes,
      integratedLufs: loudness.integratedLufs,
      loudnessRangeLu: loudness.loudnessRangeLu,
      truePeakDbfs: loudness.truePeakDbfs,
      peakLevelDb,
      rmsLevelDb,
      crestDb:
        peakLevelDb !== null && rmsLevelDb !== null ? Number((peakLevelDb - rmsLevelDb).toFixed(1)) : null,
      noiseFloorDb: overall['Noise_floor'] ?? null,
      lowBandRmsDb: lowBand['RMS_level'] ?? null,
      highBandRmsDb: highBand['RMS_level'] ?? null
    }
  }
}

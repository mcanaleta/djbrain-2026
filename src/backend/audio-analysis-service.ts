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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number | null, digits: number = 1): number | null {
  return value === null ? null : Number(value.toFixed(digits))
}

function scorePercent(value: number | null): number | null {
  return value === null ? null : Math.round(100 * clamp01(value))
}

function maxValue(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? Math.max(...present) : null
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
      const value = output.match(new RegExp(`Overall\\n(?:.|\\n)*?${label}(?: dB)?: ([-\\dinf.]+)`, 'i'))?.[1]
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
    const [loudness, overall, lowBand, highBand, subBand, airBand, hum50, hum100, introAir, introLowBand, introSubBand, introHum50Low, introHum50, introHum50High, introHum100Low, introHum100, introHum100High] = await Promise.all([
      readLoudness(filePath),
      readStats(filePath, '', ['Peak_level', 'RMS_level', 'Noise_floor']),
      readStats(filePath, 'lowpass=f=160,', ['RMS_level']),
      readStats(filePath, 'highpass=f=4000,', ['RMS_level']),
      readStats(filePath, 'lowpass=f=30,', ['RMS_level']),
      readStats(filePath, 'highpass=f=12000,', ['RMS_level']),
      readStats(filePath, 'highpass=f=45,lowpass=f=55,', ['RMS_level']),
      readStats(filePath, 'highpass=f=95,lowpass=f=105,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=9000,', ['RMS_level', 'Entropy']),
      readStats(filePath, 'atrim=end=30,lowpass=f=140,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,lowpass=f=35,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=35,lowpass=f=45,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=45,lowpass=f=55,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=55,lowpass=f=65,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=85,lowpass=f=95,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=95,lowpass=f=105,', ['RMS_level']),
      readStats(filePath, 'atrim=end=30,highpass=f=105,lowpass=f=115,', ['RMS_level'])
    ])
    const peakLevelDb = overall['Peak_level'] ?? null
    const rmsLevelDb = overall['RMS_level'] ?? null
    const noiseFloorDb = overall['Noise_floor'] ?? null
    const lowBandRmsDb = lowBand['RMS_level'] ?? null
    const highBandRmsDb = highBand['RMS_level'] ?? null
    const subBassRmsDb = subBand['RMS_level'] ?? null
    const airBandRmsDb = airBand['RMS_level'] ?? null
    const humRmsDb = maxValue(hum50['RMS_level'] ?? null, hum100['RMS_level'] ?? null)
    const cutoffDb =
      highBandRmsDb !== null && airBandRmsDb !== null ? round(Math.max(0, highBandRmsDb - airBandRmsDb)) : null
    const introAirRmsDb = introAir['RMS_level'] ?? null
    const introAirEntropy = introAir['Entropy'] ?? null
    const introLowBandRmsDb = introLowBand['RMS_level'] ?? null
    const introSubBassRmsDb = introSubBand['RMS_level'] ?? null
    const introHum50RmsDb = introHum50['RMS_level'] ?? null
    const introHum100RmsDb = introHum100['RMS_level'] ?? null
    const hum50BedDb = maxValue(introHum50Low['RMS_level'] ?? null, introHum50High['RMS_level'] ?? null) ?? -120
    const hum100BedDb = maxValue(introHum100Low['RMS_level'] ?? null, introHum100High['RMS_level'] ?? null) ?? -120
    const hum50ProminenceDb =
      introHum50RmsDb === null
        ? null
        : introHum50RmsDb - hum50BedDb
    const hum100ProminenceDb =
      introHum100RmsDb === null
        ? null
        : introHum100RmsDb - hum100BedDb
    const humProminenceDb = maxValue(hum50ProminenceDb, hum100ProminenceDb)
    const noiseEntropyScore = introAirEntropy === null ? null : clamp01((introAirEntropy - 0.26) / 0.12)
    const noiseScore = scorePercent(
      (noiseEntropyScore ?? 0) * 0.5 +
        clamp01(((cutoffDb ?? 0) - 8) / 6) * 0.25 +
        clamp01(((-1 * (introAirRmsDb ?? -46)) - 46) / 10) * 0.25
    )
    const rumbleScore = scorePercent(
      introLowBandRmsDb === null || introSubBassRmsDb === null ? null : clamp01((18 - (introLowBandRmsDb - introSubBassRmsDb)) / 7)
    )
    const humScore = scorePercent(
      humProminenceDb === null ? null : clamp01(humProminenceDb / 3)
    )
    const vinylLikelihood =
      noiseScore === null && rumbleScore === null && humScore === null
        ? null
        : Math.round(
            (noiseScore ?? 0) * 0.45 +
              (rumbleScore ?? 0) * 0.35 +
              (humScore ?? 0) * 0.2
          )

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
      noiseFloorDb,
      noiseScore,
      lowBandRmsDb,
      highBandRmsDb,
      subBassRmsDb,
      airBandRmsDb,
      humRmsDb,
      cutoffDb,
      rumbleScore,
      humScore,
      vinylLikelihood
    }
  }
}

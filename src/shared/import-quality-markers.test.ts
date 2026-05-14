import assert from 'node:assert/strict'
import test from 'node:test'
import { toListResult } from '../backend/collection-service-helpers.ts'
import type { AudioAnalysis } from './api.ts'

const audioAnalysis: AudioAnalysis = {
  format: 'mp3',
  codec: 'mp3',
  channels: 2,
  sampleRateHz: 44100,
  bitDepth: null,
  bitrateKbps: 320,
  durationSeconds: 353,
  fileSizeBytes: 1000,
  integratedLufs: -9,
  loudnessRangeLu: 5,
  truePeakDbfs: -0.5,
  peakLevelDb: -0.8,
  rmsLevelDb: -11,
  crestDb: 10,
  noiseFloorDb: -75,
  noiseScore: 12,
  lowBandRmsDb: -18,
  highBandRmsDb: -35,
  subBassRmsDb: -42,
  airBandRmsDb: -45,
  humRmsDb: -72,
  cutoffDb: 4,
  rumbleScore: 5,
  humScore: 3,
  vinylLikelihood: 8
}

test('download collection rows keep audio analysis for import quality markers', () => {
  const row = toListResult([{ id: 1, filename: 'hasoulseek/x.mp3', filesize: 1000, audioAnalysis } as never]).items[0]
  assert.equal(row?.audioAnalysis?.bitrateKbps, 320)
  assert.equal(row?.audioAnalysis?.noiseScore, 12)
})

import { rawURL, type ViewResult } from '../../api'

export default function WavContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  const d = data as Record<string, unknown>
  const url = d.audioUrl as string || rawURL(filePath)
  const channels = d.audioChannels as number | undefined
  const sampleRate = d.audioSampleRate as number | undefined
  const bitsPerSample = d.audioBitsPerSample as number | undefined
  const bitrate = d.audioBitrate as string | undefined
  const duration = d.audioDuration as string | undefined
  const durationFmt = d.audioDurationFormatted as string | undefined

  const fmt = (data.format || '').toLowerCase()
  const isMP3 = fmt.includes('mp3')
  const ext = isMP3 ? 'MP3' : 'WAV'

  return (
    <div>
      <div className="audio-player">
        <audio controls src={url} preload="auto">
          Your browser does not support audio playback.
        </audio>
      </div>

      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <a href={rawURL(filePath)} download className="download-btn">
          ⬇ Download {ext}
        </a>
      </div>

      {(channels || sampleRate || bitsPerSample || bitrate || duration) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="info-grid">
            {durationFmt && (
              <>
                <span className="label">Duration</span>
                <span className="value">{durationFmt}</span>
              </>
            )}
            {!durationFmt && duration != null && (
              <>
                <span className="label">Duration</span>
                <span className="value">{duration}s</span>
              </>
            )}
            {sampleRate != null && (
              <>
                <span className="label">Sample Rate</span>
                <span className="value">{sampleRate.toLocaleString()} Hz</span>
              </>
            )}
            {channels != null && (
              <>
                <span className="label">Channels</span>
                <span className="value">{channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : channels}</span>
              </>
            )}
            {bitrate && (
              <>
                <span className="label">Bitrate</span>
                <span className="value">{bitrate}</span>
              </>
            )}
            {bitsPerSample != null && (
              <>
                <span className="label">Bit Depth</span>
                <span className="value">{bitsPerSample}-bit</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

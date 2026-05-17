import { videoURL, type ViewResult } from '../../api'

export default function VideoContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  const vw = data.videoWidth ?? (data as Record<string, unknown>).VideoWidth as number | undefined
  const vh = data.videoHeight ?? (data as Record<string, unknown>).VideoHeight as number | undefined
  const frames = data.videoFrames ?? (data as Record<string, unknown>).VideoFrames as number | undefined
  const fps = data.videoFPS ?? (data as Record<string, unknown>).VideoFPS as number | undefined
  const duration = data.videoDuration ?? (data as Record<string, unknown>).VideoDuration as number | undefined

  return (
    <div>
      <div className="video-container">
        <video controls autoPlay loop>
          <source src={videoURL(filePath)} type="video/mp4" />
          Your browser does not support video playback.
        </video>
      </div>
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <a href={videoURL(filePath)} download={filePath.split('/').pop()?.replace(/\.[^.]+$/, '.mp4') || 'video.mp4'} className="download-btn">
          ⬇ Download MP4
        </a>
      </div>
      {(vw || vh || frames || fps || duration != null) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="info-grid">
            {vw != null && vh != null && (
              <>
                <span className="label">Resolution</span>
                <span className="value">{vw} × {vh}</span>
              </>
            )}
            {frames != null && (
              <>
                <span className="label">Frames</span>
                <span className="value">{frames.toLocaleString()}</span>
              </>
            )}
            {fps != null && (
              <>
                <span className="label">Frame Rate</span>
                <span className="value">{fps} fps</span>
              </>
            )}
            {duration != null && (
              <>
                <span className="label">Duration</span>
                <span className="value">{Number(duration).toFixed(2)}s</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

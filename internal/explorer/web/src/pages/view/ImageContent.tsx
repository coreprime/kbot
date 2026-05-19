import { rawURL, type ViewResult } from '../../api'
import { handleImgError } from '../../components/brokenAssetUtils'
import BrokenPlaceholder from '../../components/BrokenAsset'

export default function ImageContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  // imageUrl comes back from /api/view as /raw/<filePath>; fall back to the
  // /raw/ helper if the server omitted it for any reason.
  const src = (data.imageUrl as string) || rawURL(filePath)
  return (
    <div className="image-content">
      <img
        src={src}
        alt={filePath}
        className="image-content-img"
        onError={handleImgError}
      />
      <BrokenPlaceholder label="Failed to render image" style={{ width: 192, height: 128 }} />
    </div>
  )
}

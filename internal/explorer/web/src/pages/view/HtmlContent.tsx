import { rawURL, type ViewResult } from '../../api'

export default function HtmlContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  // The server rewrites relative asset URLs in the document through /raw/, so
  // we just point an iframe at /htmlview/<path> and let the browser do the rest.
  const src = (data.htmlUrl as string) || `/htmlview/${filePath.replace(/^\/+/, '')}`
  return (
    <div className="html-content">
      <iframe
        title={filePath}
        src={src}
        className="html-content-frame"
        // allow-same-origin so the rewritten /raw/ URLs work; we deliberately
        // omit allow-scripts because game-shipped HTML occasionally tries to
        // run ActiveX or other legacy script content we don't want executing.
        sandbox="allow-same-origin"
      />
      <p className="html-content-foot">
        <a href={rawURL(filePath)} download>Download raw HTML</a>
      </p>
    </div>
  )
}

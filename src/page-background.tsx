import { useState } from 'react'

export default function PageBackground({ url, dim = 0.6 }: { url?: string; dim?: number }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  if (!url) return null
  const visible = loadedUrl === url
  return (
    <div className="page-background" aria-hidden="true" style={{ opacity: visible ? 1 : 0 }}>
      <img
        key={url}
        src={url}
        alt=""
        crossOrigin="anonymous"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoadedUrl(url)}
        onError={() => setLoadedUrl(null)}
      />
      <div className="page-background-shade" style={{ opacity: dim }} />
    </div>
  )
}

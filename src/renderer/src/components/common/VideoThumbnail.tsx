import { FileVideo2 } from 'lucide-react'
import { useEffect, useRef, useState, type JSX } from 'react'

interface ThumbnailSource {
  filePath?: string
  /** 工作台重新添加同路径文件时，重新请求缩略图。 */
  uploadKey?: object
}

export function VideoThumbnail({ filePath, uploadKey, savedSrc }: ThumbnailSource & { savedSrc?: string }): JSX.Element {
  const container = useRef<HTMLSpanElement>(null)
  const [preview, setPreview] = useState<(ThumbnailSource & { src: string }) | null>(null)
  const [failedSavedSrc, setFailedSavedSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!filePath || !container.current) return
    let active = true
    const observer = new IntersectionObserver(([entry]) => {
      if (!active || !entry?.isIntersecting) return
      observer.disconnect()
      void window.framelens.getVideoThumbnail(filePath)
        .catch(() => null)
        .then((src) => {
          if (active) setPreview(src ? { filePath, uploadKey, src } : null)
        })
    }, { rootMargin: '160px' })
    observer.observe(container.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [filePath, uploadKey])

  const matchesUpload = preview && preview.filePath === filePath && preview.uploadKey === uploadKey
  const src = savedSrc ?? (matchesUpload ? preview.src : undefined)

  return (
    <span ref={container} className="video-thumbnail" aria-hidden="true">
      {src && src !== failedSavedSrc
        ? <img
            src={src}
            alt=""
            loading={savedSrc ? 'lazy' : undefined}
            onError={() => {
              if (savedSrc) setFailedSavedSrc(savedSrc)
              else setPreview(null)
            }}
          />
        : <FileVideo2 size={19} />}
    </span>
  )
}

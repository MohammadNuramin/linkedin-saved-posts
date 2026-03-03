import { FileText, PlayCircle } from "lucide-react";
import { isDocumentImage, isVideoThumbnail } from "@/lib/utils";
import type { MediaFile } from "@/types/post";

interface Props {
  mediaFiles: MediaFile[];
  onExpand?: () => void;
}

function Img({ m, alt, className }: { m: MediaFile; alt: string; className?: string }) {
  return (
    <img
      src={`/media/${m.file}`}
      alt={alt}
      loading="lazy"
      className={className}
      onError={(e) => {
        const img = e.currentTarget;
        if (!img.dataset.fallback) {
          img.dataset.fallback = "1";
          img.src = m.originalUrl;
        } else {
          img.style.display = "none";
        }
      }}
    />
  );
}

export function PostMedia({ mediaFiles, onExpand }: Props) {
  const images = mediaFiles.filter((m) => m.type === "image");
  const videos = mediaFiles.filter((m) => m.type === "video");

  if (images.length === 0 && videos.length === 0) return null;

  const isDoc = images.some((m) => isDocumentImage(m.originalUrl));
  const isVidThumb = !isDoc && images.every((m) => isVideoThumbnail(m.originalUrl));
  const [first, ...rest] = images;

  return (
    <div className="mt-3 space-y-2">
      {/* Native videos */}
      {videos.map((m, i) => (
        <video
          key={i}
          controls
          className="w-full rounded-md max-h-80 bg-black"
          onError={(e) => { (e.currentTarget).style.display = "none"; }}
        >
          <source src={`/media/${m.file}`} />
          <source src={m.originalUrl} />
        </video>
      ))}

      {/* Images (with doc / video-thumbnail overlays) */}
      {images.length > 0 && (
        <div className="cursor-pointer overflow-hidden rounded-md relative" onClick={onExpand}>
          {images.length === 1 && (
            <Img m={first} alt="Post image" className="w-full max-h-80 object-cover rounded-md" />
          )}
          {images.length === 2 && (
            <div className="grid grid-cols-2 gap-1">
              {images.map((m, i) => (
                <Img key={i} m={m} alt={`Post image ${i + 1}`} className="w-full h-40 object-cover rounded-md" />
              ))}
            </div>
          )}
          {images.length >= 3 && (
            <div className="grid grid-cols-2 gap-1">
              <Img m={first} alt="Post image" className="w-full h-48 object-cover rounded-md row-span-2" />
              <div className="grid gap-1">
                <Img m={images[1]} alt="Post image 2" className="w-full h-[92px] object-cover rounded-md" />
                <div className="relative">
                  <Img m={images[2]} alt="Post image 3" className="w-full h-[92px] object-cover rounded-md" />
                  {rest.length > 2 && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/60 text-white font-semibold text-lg">
                      +{rest.length - 1}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Document badge overlay */}
          {isDoc && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
              <FileText className="h-3 w-3" />
              Document · {images.length} page{images.length !== 1 ? "s" : ""}
            </div>
          )}

          {/* Video thumbnail badge */}
          {isVidThumb && (
            <div className="absolute inset-0 flex items-center justify-center">
              <PlayCircle className="h-12 w-12 text-white drop-shadow-lg opacity-80" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

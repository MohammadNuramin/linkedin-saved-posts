import { useState, useCallback } from "react";
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
  const [playing, setPlaying] = useState(false);

  const handlePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPlaying(true);
  }, []);

  if (images.length === 0 && videos.length === 0) return null;

  const isDoc = images.some((m) => isDocumentImage(m.originalUrl));
  const isVidThumb = !isDoc && images.every((m) => isVideoThumbnail(m.originalUrl));
  const hasVideoFile = videos.length > 0;
  const [first, ...rest] = images;

  // Video post with thumbnail: show thumbnail with play button, click to play
  if (hasVideoFile && isVidThumb && images.length > 0 && !playing) {
    return (
      <div className="mt-3">
        <div
          className="cursor-pointer overflow-hidden rounded-md relative"
          onClick={handlePlay}
        >
          <Img m={first} alt="Video thumbnail" className="w-full max-h-80 object-cover rounded-md" />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <PlayCircle className="h-14 w-14 text-white drop-shadow-lg opacity-90" />
          </div>
        </div>
      </div>
    );
  }

  // Video player (shown after clicking play, or if no thumbnail)
  if (hasVideoFile && (playing || !isVidThumb || images.length === 0)) {
    return (
      <div className="mt-3" onClick={(e) => e.stopPropagation()}>
        {videos.map((m, i) => (
          <video
            key={i}
            controls
            autoPlay={playing}
            className="w-full rounded-md max-h-80 bg-black"
          >
            <source src={`/media/${m.file}`} type="video/mp4" />
          </video>
        ))}
      </div>
    );
  }

  // Image-only posts
  return (
    <div className="mt-3 space-y-2">
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

        {isDoc && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
            <FileText className="h-3 w-3" />
            Document · {images.length} page{images.length !== 1 ? "s" : ""}
          </div>
        )}

        {isVidThumb && (
          <div className="absolute inset-0 flex items-center justify-center">
            <PlayCircle className="h-12 w-12 text-white drop-shadow-lg opacity-80" />
          </div>
        )}
      </div>
    </div>
  );
}

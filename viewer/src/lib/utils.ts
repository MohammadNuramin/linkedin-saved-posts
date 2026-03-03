import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Swap LinkedIn CDN shrink variants for a higher-quality version.
 *  Falls back to the original URL if the upgraded one 404s (handled by onError in the img). */
export function upgradeLinkedInImageUrl(url: string): string {
  return url
    .replace(/feedshare-shrink_\d+(?:_\d+)*/g, "feedshare-shrink_2048_1536")
    .replace(/\bimage-shrink_\d+\b/g, "image-shrink_1280")
    .replace(/company-logo_\d+_\d+/g, "company-logo_200_200");
}

/** True if this image URL is a LinkedIn document/PDF carousel cover or page */
export function isDocumentImage(url: string): boolean {
  return url.includes("document-cover-images") || url.includes("document-images");
}

/** True if this image URL is a video thumbnail/poster */
export function isVideoThumbnail(url: string): boolean {
  return url.includes("videocover") || url.includes("video-thumbnail");
}

export function getInitials(name: string): string {
  return name
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

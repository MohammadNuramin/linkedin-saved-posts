export interface MediaFile {
  type: "image" | "video";
  file: string;
  originalUrl: string;
}

export interface Post {
  index: number;
  author: string;
  authorUrl: string | null;
  authorImage: string | null;
  text: string | null;
  url: string | null;
  timestamp: string;
  images: string[];
  videos: string[];
  mediaFiles: MediaFile[];
}

export type MediaFilter = "all" | "has-image" | "no-media";
export type SortOrder = "original" | "newest" | "oldest";

export interface FilterState {
  search: string;
  author: string;
  hashtag: string;
  mediaType: MediaFilter;
  sortOrder: SortOrder;
  darkMode: boolean;
  selectedPost: Post | null;
  semanticResults: number[] | null; // post indices ordered by relevance
}

export type FilterAction =
  | { type: "SET_SEARCH"; payload: string }
  | { type: "SET_AUTHOR"; payload: string }
  | { type: "SET_HASHTAG"; payload: string }
  | { type: "SET_MEDIA_TYPE"; payload: MediaFilter }
  | { type: "SET_SORT"; payload: SortOrder }
  | { type: "TOGGLE_DARK_MODE" }
  | { type: "SELECT_POST"; payload: Post | null }
  | { type: "SET_SEMANTIC_RESULTS"; payload: number[] | null }
  | { type: "RESET_FILTERS" };

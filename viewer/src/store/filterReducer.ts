import type { FilterState, FilterAction } from "@/types/post";

function getInitialDarkMode(): boolean {
  try {
    const stored = localStorage.getItem("darkMode");
    if (stored !== null) return stored === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export const initialFilterState: FilterState = {
  search: "",
  author: "",
  hashtag: "",
  mediaType: "all",
  sortOrder: "newest",
  darkMode: getInitialDarkMode(),
  selectedPost: null,
  semanticResults: null,
};

export function filterReducer(
  state: FilterState,
  action: FilterAction
): FilterState {
  switch (action.type) {
    case "SET_SEARCH":
      return { ...state, search: action.payload };
    case "SET_AUTHOR":
      return { ...state, author: action.payload };
    case "SET_HASHTAG":
      return { ...state, hashtag: action.payload };
    case "SET_MEDIA_TYPE":
      return { ...state, mediaType: action.payload };
    case "SET_SORT":
      return { ...state, sortOrder: action.payload };
    case "TOGGLE_DARK_MODE": {
      const next = !state.darkMode;
      try { localStorage.setItem("darkMode", String(next)); } catch { /* ignore */ }
      return { ...state, darkMode: next };
    }
    case "SELECT_POST":
      return { ...state, selectedPost: action.payload };
    case "SET_SEMANTIC_RESULTS":
      return { ...state, semanticResults: action.payload };
    case "RESET_FILTERS":
      return {
        ...state,
        search: "",
        author: "",
        hashtag: "",
        mediaType: "all",
        sortOrder: "original",
        semanticResults: null,
      };
    default:
      return state;
  }
}

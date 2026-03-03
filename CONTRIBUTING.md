# Developer Guide

Technical reference for anyone (human or AI agent) picking up this codebase.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Scrapers (Playwright + Chrome profile)                      │
│  scraper.js              full initial scrape                 │
│  scraper-incremental.js  sync only new posts                 │
│  upgrade-quality.js      visit each post → srcset images     │
│  upgrade-videos.js       capture HLS → ffmpeg → MP4          │
│  upgrade-lowres.js       targeted re-upgrade of shrink_480   │
│  fix-duplicate-refs.js   repair colliding media filenames    │
├──────────────────────────────────────────────────────────────┤
│  Data layer (output/)                                        │
│  saved_posts.json        array of Post objects               │
│  media/                  post_NNNN_img_N.jpg, _vid_N.mp4     │
├──────────────────────────────────────────────────────────────┤
│  API server (server.js, port 3001)                           │
│  GET  /api/sync-log        sync history                      │
│  GET  /api/scheduler       Windows Task Scheduler status     │
│  POST /api/scheduler       create/update scheduled task      │
│  DELETE /api/scheduler     remove scheduled task             │
│  POST /api/sync            trigger incremental sync          │
│  GET  /api/sync/status     live sync output                  │
│  DELETE /api/posts/author  delete all posts by author (body) │
│  DELETE /api/posts/:index  delete single post by index       │
│  GET  /api/health          health check                      │
├──────────────────────────────────────────────────────────────┤
│  Viewer (viewer/, Vite + React + ShadcnUI)                   │
│  publicDir = ../output   → /media/file.jpg serves output/    │
│  proxy: /api → localhost:3001                                │
│  npm run viewer  starts both server.js and Vite via          │
│  concurrently                                                │
└──────────────────────────────────────────────────────────────┘
```

## Critical Technical Facts

### ES Modules
`"type": "module"` in package.json. All scripts use `import`, never `require()`. If you add a new script, use ES import syntax.

### LinkedIn CDN URLs
- Image URLs are HMAC path-signed: the `t=` query param is tied to the full path including the size variant (`shrink_480`, `shrink_1280`, etc.)
- You **cannot** swap `shrink_480` for `shrink_2048` — the signature will fail
- `upgrade-quality.js` works around this by visiting each post's LinkedIn page in a browser and extracting the highest-res URL from the `<img srcset>` attribute
- CDN tokens expire (the `e=` param is a Unix timestamp). Old URLs may return 403

### LinkedIn Video
- LinkedIn serves video via HLS (`.m3u8` manifests), not plain MP4
- `upgrade-videos.js` intercepts network requests via `page.on('request')` to capture the `.m3u8` URL
- ffmpeg converts HLS to MP4: `ffmpeg -y -i <m3u8> -c copy -movflags +faststart output.mp4`
- ffmpeg path is auto-discovered from WinGet Packages dir

### Chrome Profile
- All scrapers copy the user's Chrome profile to a temp dir (`%TEMP%/pw-*`) so Playwright doesn't fight with an open Chrome
- The copy skips `Cache`, `Code Cache`, `GPUCache`, `ShaderCache`, `DawnCache` (too large, not needed)
- Locked files (`Cookies`, `Web Data`, `Login Data`) are copied via PowerShell `[System.IO.File]::Open()` with shared read
- **Cleanup**: old `pw-*` temp dirs accumulate. If Chrome fails to launch with a lock error, delete all `%TEMP%/pw-*` dirs and kill zombie `chrome.exe` processes

### Vite Serving
- `vite.config.ts` sets `publicDir: "../output"` — Vite serves `output/media/file.jpg` at `/media/file.jpg`
- API calls from the viewer go through Vite's proxy: `/api/*` → `http://localhost:3001`
- In production/dev, run both `server.js` and Vite (`npm run viewer` does this via `concurrently`)

## Data Format

`output/saved_posts.json` is an array of objects:

```json
{
  "index": 42,
  "author": "Jane Doe",
  "authorUrl": "https://linkedin.com/in/janedoe",
  "authorImage": "post_0042_img_0.jpg",
  "text": "Post body text...",
  "url": "https://www.linkedin.com/feed/update/urn:li:activity:...",
  "timestamp": "2d",
  "images": ["post_0042_img_1.jpg"],
  "videos": [],
  "mediaFiles": [
    {
      "type": "image",
      "file": "post_0042_img_1.jpg",
      "originalUrl": "https://media.licdn.com/dms/image/v2/..."
    }
  ]
}
```

- `index` — 1-based, order of appearance on LinkedIn saved posts page
- `images` / `videos` — legacy arrays (filenames only), kept for compatibility
- `mediaFiles` — canonical list; each entry has `type`, `file` (local filename in `output/media/`), and `originalUrl` (LinkedIn CDN)
- `authorImage` — profile photo filename (also in `output/media/`)
- `timestamp` — relative timestamp string from LinkedIn ("2d", "1w", "3mo")

### Media File Naming

Files follow `post_NNNN_img_N.ext` or `post_NNNN_vid_N.mp4`:
- `NNNN` = zero-padded post index
- Second `N` = 0-based media index within that post
- After incremental syncs, new posts may have high indices (to avoid overwriting existing files)

**Known issue**: Some posts have `file` names where the number doesn't match `post.index` — this is residual from an early sync bug. The `file` field is always the source of truth for which file to load. Never derive filenames from `post.index`.

## Viewer Architecture

### Component Tree
```
App.tsx
├── Header.tsx (title, stats toggle, scheduler toggle, dark mode)
│   ├── StatsPanel.tsx (top authors, hashtags, media breakdown)
│   └── SchedulerSettings.tsx (scheduler status, sync history, manual sync)
├── Filter bar
│   ├── SearchBar.tsx
│   ├── AuthorSelect.tsx
│   ├── HashtagFilter.tsx
│   ├── MediaTypeFilter.tsx
│   └── SortToggle.tsx
├── PostGrid.tsx (CSS grid, responsive columns)
│   └── PostCard.tsx (per-post card)
│       ├── PostMedia.tsx (image thumbnails, video overlay)
│       ├── PostText.tsx (truncated text with "See more")
│       └── PostActions.tsx (copy, open link, expand, delete)
└── PostDetailDialog.tsx (full post view in modal)
```

### State Management
- `useReducer` in App.tsx via `filterReducer.ts` — manages search, author, hashtag, media filter, sort, dark mode, selected post
- `usePosts.ts` — fetches `/saved_posts.json` on mount, exposes `posts` and `setPosts`
- Delete is optimistic: `setPosts` removes immediately, then fires `DELETE /api/posts/...` in background

### Delete Feature
- Trash icon on each card; click = delete that post
- Hover over trash area = reveals "All by [author]" button to bulk-delete
- `App.tsx` → `PostGrid` → `PostCard` → `PostActions` callback chain
- Server endpoints: `DELETE /api/posts/:index` and `DELETE /api/posts/author` (body: `{ author }`)
- **Route order matters**: `/api/posts/author` must be defined before `/api/posts/:index` in Express, otherwise "author" gets captured as the `:index` param

## Scraper Details

### scraper.js (Full Scrape)
1. Copies Chrome profile to temp dir
2. Launches Playwright with the copied profile
3. Navigates to `https://www.linkedin.com/my-items/saved-posts/`
4. Scrolls to load all posts (with scroll-to-bottom every 3rd scroll)
5. Extracts post data from `div[data-chameleon-result-urn]` elements
6. Downloads images/videos to `output/media/`
7. Saves progress every 5 posts (safe to stop/resume)
8. Stops after 8 consecutive scrolls with no new posts

### scraper-incremental.js (Sync)
Same approach but:
- Loads existing `saved_posts.json` first
- Skips posts whose URL already exists in the dataset
- New posts get high indices (`existingPosts.length + newPosts.length + i + 1`) to avoid filename collisions
- Stops early after 8 consecutive pages with no new posts
- Handles login: checks for `/authwall`, verifies post content visibility, supports manual login in visible mode (2 min timeout)

### upgrade-quality.js
- Iterates all posts, visits each LinkedIn post URL
- For images: builds asset ID map, matches page `<img srcset>` by asset ID, downloads if better quality
- For videos: intercepts network requests for `.m3u8`/`.mp4`, downloads via ffmpeg
- Only upgrades images currently at `shrink_480`, `shrink_160`, `shrink_100`, or `videocover`
- Saves progress every 5 posts

### upgrade-videos.js
- Targets only posts with video thumbnails but no downloaded MP4
- Navigates to each post, triggers play button, waits for HLS manifest via network interception
- Downloads via ffmpeg
- Saves progress every 3 posts

### upgrade-lowres.js
- Targeted version of upgrade-quality.js — only visits posts that still have `shrink_480`/`shrink_160`/`shrink_100` images
- Much faster than full upgrade since it skips posts that are already high-res

### fix-duplicate-refs.js
- Scans `saved_posts.json` for multiple posts referencing the same media file
- Re-downloads the correct image for the non-owner post (owner = post whose index matches the filename)
- Run in a loop if cascading collisions exist — each pass fixes one level
- Safe to run anytime; no-ops if no duplicates found

## Known Issues / Pending Work

1. **Video playback in viewer** — `PostMedia.tsx` shows a play button overlay on video thumbnails but clicking doesn't play the local MP4 yet. Needs a `<video>` element wired to the local file.
2. **~84 video posts have no MP4** — `upgrade-videos.js` couldn't capture these (private posts, expired sessions, or LinkedIn's player didn't expose the HLS URL). Could retry with longer delays.
3. **Post index / filename mismatch** — Some posts have `mediaFiles[].file` names that don't match `post.index`. This is cosmetic; the viewer uses `file` directly. Don't "fix" by renaming files.
4. **Windows-only scheduler** — `setup-scheduler.js` uses `schtasks`. No Linux/macOS equivalent yet.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LINKEDIN_EMAIL` | No | — | LinkedIn login email (fallback to Chrome session) |
| `LINKEDIN_PASSWORD` | No | — | LinkedIn login password |
| `CHROME_USER_DATA` | No | `%LOCALAPPDATA%/Google/Chrome/User Data` | Chrome user data directory |
| `CHROME_PROFILE` | No | `Default` | Chrome profile folder name |
| `MAX_POSTS` | No | `0` (all) | Limit number of posts to scrape |
| `HEADLESS` | No | `true` | Set to `false` for visible browser |
| `PORT` | No | `3001` | API server port |

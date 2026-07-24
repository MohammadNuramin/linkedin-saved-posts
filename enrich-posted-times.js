import { readFileSync, writeFileSync, existsSync } from 'fs';
import { enrichPostsWithPostedAt, estimatePostedAt } from './post-time.js';

const OUTPUT_JSON = './output/saved_posts.json';
const SYNC_LOG = './output/sync-log.json';

function backfillFromSyncHistory(posts) {
  if (!existsSync(SYNC_LOG)) return 0;

  const successfulRuns = JSON.parse(readFileSync(SYNC_LOG, 'utf8'))
    .filter(entry => entry.status === 'success' && entry.date);
  const history = successfulRuns.filter(entry => entry.newPosts > 0);
  let offset = 0;
  let updated = 0;

  for (const entry of history) {
    const batch = posts.slice(offset, offset + entry.newPosts);
    for (const post of batch) {
      if (post.postedAt) continue;
      const estimated = estimatePostedAt(post.timestamp, entry.date);
      if (!estimated) continue;
      post.postedAt = estimated;
      post.postedAtSource = 'relative-sync-estimate';
      updated++;
    }
    offset += entry.newPosts;
  }

  // Records older than the incremental batches came from the initial scrape.
  // Use the earliest recorded successful sync as their observation time.
  const initialObservation = successfulRuns.at(-1)?.date;
  if (initialObservation) {
    for (const post of posts.slice(offset)) {
      if (post.postedAt) continue;
      const estimated = estimatePostedAt(post.timestamp, initialObservation);
      if (!estimated) continue;
      post.postedAt = estimated;
      post.postedAtSource = 'relative-sync-estimate';
      updated++;
    }
  }
  return updated;
}

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1] ?? '', 10) : Infinity;
  return {
    force: argv.includes('--force'),
    limit: Number.isFinite(limit) ? limit : Infinity,
  };
}

async function run() {
  if (!existsSync(OUTPUT_JSON)) {
    console.error('[dates] saved_posts.json not found. Run the scraper first.');
    process.exit(1);
  }

  const { force, limit } = parseArgs(process.argv.slice(2));
  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  console.log(`[dates] Loading ${posts.length} post(s)...`);

  const save = () => {
    writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2), 'utf8');
  };

  const result = await enrichPostsWithPostedAt(posts, {
    force,
    limit,
    concurrency: 8,
    onProgress: ({ processed, total, updated, postedAt }) => {
      const suffix = postedAt ? '' : ' (timestamp unresolved)';
      process.stdout.write(`\r[dates] ${processed}/${total} checked, ${updated} updated${suffix}   `);
    },
    onBatchComplete: save,
  });

  const estimated = backfillFromSyncHistory(posts);
  save();
  process.stdout.write('\n');
  console.log(`[dates] Done. Updated ${result.updated} exact and ${estimated} estimated timestamp(s).`);
}

run().catch(err => {
  console.error('[dates] Fatal:', err.message);
  process.exit(1);
});

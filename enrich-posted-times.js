import { readFileSync, writeFileSync, existsSync } from 'fs';
import { enrichPostsWithPostedAt } from './post-time.js';

const OUTPUT_JSON = './output/saved_posts.json';

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

  save();
  process.stdout.write('\n');
  console.log(`[dates] Done. Updated ${result.updated} post(s).`);
}

run().catch(err => {
  console.error('[dates] Fatal:', err.message);
  process.exit(1);
});

-- Fix the stuck house ad (Defect C, owner order 2026-11-25): the 6-hour
-- boost repeat rule reads the FIRST-EVER view timestamp because
-- recordPostView / recordReelView never updated createdAt, so a view
-- older than 6h stayed "stale" forever and the house ad was re-admitted
-- to slot 0 on every page 1. A new last_viewed_at column records the
-- latest view; the stale check (getStaleViewedPostIds /
-- getStaleViewedReelIds) reads it instead of created_at. STAGING ONLY —
-- apply only through the normal reviewed migration process, never
-- `prisma db push`.

-- Add lastViewedAt to post_views, backfilled from created_at (the best
-- available approximation of the last view for rows that predate it).
-- New rows get CURRENT_TIMESTAMP(3) by default; recordPostView refreshes
-- the column on every view. created_at is untouched: dashboards, the
-- 30-day census cleanup and watch-time windows still read first-view
-- semantics from it.
ALTER TABLE `post_views` ADD COLUMN `last_viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `post_views` SET `last_viewed_at` = `created_at`;

-- Same for reel_views (recordReelView refreshes it on every view).
ALTER TABLE `reel_views` ADD COLUMN `last_viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `reel_views` SET `last_viewed_at` = `created_at`;

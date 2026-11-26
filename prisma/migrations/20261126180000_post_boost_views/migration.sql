-- Repeat-view counting for boosted posts (owner order 2026-11-26):
-- post_views counts unique viewers only, so a repeat view by the same
-- person never moves an ad's Views. Repeat views on posts with a live
-- boost are now recorded in post_boost_views (at most one per viewer
-- per boost per 10 minutes, enforced by the ten_min_bucket unique
-- index — the same pattern as boost_link_clicks' hour_bucket) and
-- added to the boost's Views in getBoostResults. First views are NOT
-- recorded here (post_views already counts them) and the boost owner's
-- own views are never recorded here. The table starts empty, so boosts
-- that ran before this change (Ludo 480 views, house ad 1,072 views)
-- keep their exact old numbers.
-- STAGING ONLY — apply only through the normal reviewed migration
-- process, never `prisma db push`.

-- CreateTable
CREATE TABLE `post_boost_views` (
    `id` VARCHAR(191) NOT NULL,
    `boost_id` VARCHAR(191) NOT NULL,
    `post_id` VARCHAR(191) NOT NULL,
    `viewer_id` VARCHAR(191) NOT NULL,
    `ten_min_bucket` INTEGER NOT NULL,
    `viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `post_boost_views_boost_id_viewer_id_ten_min_bucket_key`(`boost_id`, `viewer_id`, `ten_min_bucket`),
    INDEX `post_boost_views_boost_id_viewed_at_idx`(`boost_id`, `viewed_at`),
    INDEX `post_boost_views_post_id_idx`(`post_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `post_boost_views` ADD CONSTRAINT `post_boost_views_boost_id_fkey` FOREIGN KEY (`boost_id`) REFERENCES `post_boosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

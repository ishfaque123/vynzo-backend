-- Link-click tracking for Boosts (owner order 2026-11-25): count
-- clicks on a boost's link button and end a boost automatically
-- once it reaches its click cap. STAGING ONLY — apply only through
-- the normal reviewed migration process, never `prisma db push`.

-- Add linkClicks + clickCap to post_boosts
ALTER TABLE `post_boosts` ADD COLUMN `link_clicks` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `post_boosts` ADD COLUMN `click_cap` INTEGER NULL;

-- CreateTable
CREATE TABLE `boost_link_clicks` (
    `id` VARCHAR(191) NOT NULL,
    `boost_id` VARCHAR(191) NOT NULL,
    `viewer_id` VARCHAR(191) NOT NULL,
    `hour_bucket` INTEGER NOT NULL,
    `clicked_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `boost_link_clicks_boost_id_viewer_id_hour_bucket_key`(`boost_id`, `viewer_id`, `hour_bucket`),
    INDEX `boost_link_clicks_boost_id_clicked_at_idx`(`boost_id`, `clicked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `boost_link_clicks` ADD CONSTRAINT `boost_link_clicks_boost_id_fkey` FOREIGN KEY (`boost_id`) REFERENCES `post_boosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

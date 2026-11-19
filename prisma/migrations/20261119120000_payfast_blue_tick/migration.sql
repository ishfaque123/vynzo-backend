-- PayFast Blue Tick payments — STAGING ONLY.
-- This file mirrors the Prisma schema addition in schema.prisma
-- (PayFastPayment model, PayFastPaymentStatus enum, users.verified_until).
-- DO NOT APPLY IT DIRECTLY and NEVER use `prisma db push`.
-- Apply it only through the normal reviewed migration process when
-- the PayFast integration is approved for deploy.

-- CreateTable
CREATE TABLE `payfast_payments` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `basket_id` VARCHAR(191) NOT NULL,
    `product` VARCHAR(30) NOT NULL,
    `amount_pkr` INTEGER NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL DEFAULT 'PKR',
    `status` ENUM('pending', 'paid', 'failed', 'expired') NOT NULL DEFAULT 'pending',
    `transaction_id` VARCHAR(100) NULL,
    `err_code` VARCHAR(20) NULL,
    `err_msg` VARCHAR(255) NULL,
    `raw_callback` JSON NULL,
    `paid_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payfast_payments_basket_id_key`(`basket_id`),
    INDEX `payfast_payments_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `payfast_payments_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: paid Blue Tick expiry. NULL means "no expiry" — that is
-- what every existing admin-granted verification has, so current
-- verified users are unaffected by this column appearing.
ALTER TABLE `users` ADD COLUMN `verified_until` DATETIME(3) NULL;

-- AddForeignKey
ALTER TABLE `payfast_payments` ADD CONSTRAINT `payfast_payments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

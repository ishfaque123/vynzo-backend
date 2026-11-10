// Backfill for the 2026-11-02 country-feed fix. NOT RUN automatically.
// Converts stored full country names (e.g. "Pakistan") to 2-letter codes
// (e.g. "PK") for users whose country matches a known name. Run ONLY
// after a fresh DB backup and a separate owner check, with:
//   npx ts-node scripts/backfill-country-codes.ts [--dry-run]
// Dry-run (default) prints how many rows would change and changes nothing.
import { prisma } from '../src/config/prisma';
import { normalizeCountry } from '../src/utils/country';

async function main() {
  const dryRun = !process.argv.includes('--apply');
  const users = await prisma.user.findMany({ where: { country: { not: null } }, select: { id: true, country: true } });
  let wouldChange = 0;
  for (const u of users) {
    const code = normalizeCountry(u.country);
    if (code && code !== u.country) {
      wouldChange += 1;
      if (!dryRun) await prisma.user.update({ where: { id: u.id }, data: { country: code } });
    }
  }
  console.log(dryRun ? `DRY RUN: ${wouldChange} of ${users.length} users would change.` : `APPLIED: ${wouldChange} users updated.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

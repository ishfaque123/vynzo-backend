import pathlib, sys

path = pathlib.Path("prisma/schema.prisma")
text = path.read_text()

edits = [
    (
        "  reels                  Reel[]\n  reelLikes              ReelLike[]",
        "  reels                  Reel[]\n  reelLikes              ReelLike[]\n  reelFavorites          ReelFavorite[]",
    ),
    (
        '''model ReelLike {
  id        String   @id @default(uuid())
  reelId    String   @map("reel_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")

  reel Reel @relation(fields: [reelId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([reelId, userId])
  @@index([reelId])
  @@map("reel_likes")
}''',
        '''model ReelLike {
  id        String   @id @default(uuid())
  reelId    String   @map("reel_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")

  reel Reel @relation(fields: [reelId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([reelId, userId])
  @@index([reelId])
  @@map("reel_likes")
}

model ReelFavorite {
  id        String   @id @default(uuid())
  reelId    String   @map("reel_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")

  reel Reel @relation(fields: [reelId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([reelId, userId])
  @@index([userId])
  @@map("reel_favorites")
}''',
    ),
    (
        '''  user  User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  likes ReelLike[]

  @@index([userId])
  @@index([createdAt])
  @@map("reels")
}''',
        '''  user      User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  likes     ReelLike[]
  favorites ReelFavorite[]

  @@index([userId])
  @@index([createdAt])
  @@map("reels")
}''',
    ),
]

errors = []
for i, (old, new) in enumerate(edits, start=1):
    count = text.count(old)
    if count != 1:
        errors.append(f"Edit {i}: expected 1 match, found {count}")
        continue
    text = text.replace(old, new)

if errors:
    print("FAILED:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

path.write_text(text)
print("schema.prisma patched successfully.")

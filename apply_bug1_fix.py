import pathlib, sys

path = pathlib.Path("src/services/postService.ts")
text = path.read_text()

edits = [
    # sharePost: block sharing someone else's private post
    (
        '''export async function sharePost(userId: string, originalPostId: string, content: string) {
  const original = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!original) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  const post = await prisma.post.create({''',
        '''export async function sharePost(userId: string, originalPostId: string, content: string) {
  const original = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!original) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  // Bug fix: sharing used to skip visibility entirely, so a private post
  // could be reshared by anyone who had its id, instantly turning it into
  // a brand-new PUBLIC post.
  if (original.visibility === 'private' && original.userId !== userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You cannot share this post.');
  }

  const post = await prisma.post.create({''',
    ),
    # getPostById: block direct-id access to a post explicitly marked private,
    # independent of whether the author's whole account is private
    (
        '''  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') {
      throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }

  return toPostDTO(post, currentUserId);
}''',
        '''  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') {
      throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }

  // Bug fix: a single post can be marked visibility: 'private' independently
  // of the author's account being private. This was completely unchecked
  // here, so a private post's full content was readable by anyone (even
  // logged out) who had or guessed its id.
  if (post.visibility === 'private' && post.userId !== currentUserId) {
    throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  }

  return toPostDTO(post, currentUserId);
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
    print("FAILED — some edits did not apply cleanly:")
    for e in errors:
        print(" -", e)
    print("\nNo changes were written. File left untouched.")
    sys.exit(1)

path.write_text(text)
print("Bug 1 (postService.ts) patched successfully.")

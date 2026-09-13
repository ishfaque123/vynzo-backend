import pathlib, sys

path = pathlib.Path("src/services/commentService.ts")
text = path.read_text()

edits = [
    (
        '''export async function getComments(postId: string, currentUserId?: string) {
  const allComments = await prisma.comment.findMany({''',
        '''export async function getComments(postId: string, currentUserId?: string) {
  // Bug fix: comments on a post used to be readable by anyone (even logged
  // out), regardless of whether they were allowed to see the post itself.
  // Same two checks as getPostById in postService.ts, for consistency:
  // account-level privacy first, then post-level visibility.
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { user: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') {
      throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }

  if (post.visibility === 'private' && post.userId !== currentUserId) {
    throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  }

  const allComments = await prisma.comment.findMany({''',
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
print("Bug 2 (commentService.ts) patched successfully.")

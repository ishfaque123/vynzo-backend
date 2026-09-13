f = 'src/services/statusService.ts'
lines = open(f).read().split('\n')

# line 31 (index 30): views include -> unfiltered
target31 = "    include: { user: { select: authorSelect }, views: { where: { viewerId: userId }, select: { id: true, liked: true } } },"
assert lines[30] == target31, 'LINE31 MISMATCH: ' + repr(lines[30])
lines[30] = "    include: { user: { select: authorSelect }, views: { select: { viewerId: true, liked: true } } },"

# line 34 (index 33): for loop start -> insert close-friends precheck logic before it
target34 = "  for (const s of statuses) {"
assert lines[33] == target34, 'LINE34 MISMATCH: ' + repr(lines[33])
insert_block = """  const closeFriendAuthorIds = [...new Set(statuses.filter((s) => s.visibility === 'close_friends' && s.userId !== userId).map((s) => s.userId))];
  const closeFriendChecks = closeFriendAuthorIds.length
    ? await prisma.closeFriend.findMany({ where: { ownerId: { in: closeFriendAuthorIds }, friendId: userId }, select: { ownerId: true } })
    : [];
  const allowedCloseFriendAuthors = new Set(closeFriendChecks.map((c) => c.ownerId));
"""
lines[33] = insert_block + "  for (const s of statuses) {\n    if (s.visibility === 'close_friends' && s.userId !== userId && !allowedCloseFriendAuthors.has(s.userId)) continue;"

# lines 36-38 (index 35-37): recompute seen/liked + add viewCount + visibility
target36 = "    const seen = s.views.length > 0;"
target37 = "    const liked = s.views[0]?.liked || false;"
target38 = "    grouped[s.userId].items.push({ id: s.id, mediaUrl: s.mediaUrl, mediaType: s.mediaType, textContent: s.textContent, bgColor: s.bgColor, createdAt: s.createdAt, seen, liked });"
assert lines[35] == target36, 'LINE36 MISMATCH: ' + repr(lines[35])
assert lines[36] == target37, 'LINE37 MISMATCH: ' + repr(lines[36])
assert lines[37] == target38, 'LINE38 MISMATCH: ' + repr(lines[37])
lines[35] = "    const myView = s.views.find((v) => v.viewerId === userId);"
lines[36] = "    const seen = !!myView;\n    const liked = myView?.liked || false;\n    const viewCount = s.userId === userId ? s.views.length : undefined;"
lines[37] = "    grouped[s.userId].items.push({ id: s.id, mediaUrl: s.mediaUrl, mediaType: s.mediaType, textContent: s.textContent, bgColor: s.bgColor, visibility: s.visibility, createdAt: s.createdAt, seen, liked, viewCount });"

open(f, 'w').write('\n'.join(lines))
print('DONE')

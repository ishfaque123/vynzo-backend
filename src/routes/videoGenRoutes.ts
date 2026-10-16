import { Router } from 'express';
import { startVideoGeneration, checkVideoStatus, isVideoGenEnabled, hasVideoGenAccess } from '../services/videoGenService';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// Check if video generation is available (global + per-user referral unlock)
router.get('/status', authMiddleware, async (req, res) => {
  const access = await hasVideoGenAccess(req.user!.id);
  res.json({
    success: true,
    data: {
      enabled: isVideoGenEnabled(),
      hasAccess: access.hasAccess,
      referralCount: access.referralCount,
      referralsNeeded: access.needed,
      threshold: 25,
    },
  });
});

// Start video generation (requires 25 referrals)
router.post('/generate', authMiddleware, async (req, res) => {
  const { prompt, aspectRatio, durationSeconds } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    res.status(400).json({ success: false, error: { message: 'Prompt is required (min 3 chars)' } });
    return;
  }

  if (prompt.length > 500) {
    res.status(400).json({ success: false, error: { message: 'Prompt too long (max 500 chars)' } });
    return;
  }

  // Referral gate: 25 referrals unlocks access
  const access = await hasVideoGenAccess(req.user!.id);
  if (!access.hasAccess) {
    res.status(403).json({
      success: false,
      error: {
        code: 'REFERRALS_REQUIRED',
        message: `Invite ${access.needed} more friend(s) to unlock AI video generation (${access.referralCount}/25 referrals)`,
        referralCount: access.referralCount,
        referralsNeeded: access.needed,
      },
    });
    return;
  }

  const result = await startVideoGeneration(
    prompt.trim(),
    aspectRatio === '16:9' ? '16:9' : '9:16',
    durationSeconds === 4 ? 4 : 8
  );

  if (!result.success) {
    res.status(500).json({ success: false, error: { message: result.error } });
    return;
  }

  res.json({
    success: true,
    data: { operationName: result.operationName },
  });
});

// Check generation status (poll)
router.get('/operation/:name', authMiddleware, async (req, res) => {
  const operationName = decodeURIComponent(req.params.name);
  const status = await checkVideoStatus(operationName);

  res.json({ success: true, data: status });
});

export default router;

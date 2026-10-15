import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { chatWithIsai, IsaiMessage } from '../services/aiAssistantService';

const router = Router();

// Chat with ISAI — Frianzo's AI assistant
router.post('/chat', authMiddleware, async (req, res) => {
  const { messages } = req.body as { messages?: IsaiMessage[] };

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 10) {
    res.status(400).json({ success: false, error: { message: 'messages array (1-10) is required' } });
    return;
  }

  const result = await chatWithIsai(req.user!.id, messages);

  if (!result.success) {
    const status =
      result.error === 'DAILY_LIMIT_REACHED' ? 429 : result.error === 'ISAI_NOT_CONFIGURED' ? 503 : 500;
    const message =
      result.error === 'DAILY_LIMIT_REACHED'
        ? 'Daily ISAI limit reached (20/day). Try again tomorrow.'
        : 'ISAI is having trouble right now. Please try again.';
    res.status(status).json({ success: false, error: { code: result.error, message } });
    return;
  }

  res.json({ success: true, data: { reply: result.reply, remaining: result.remaining } });
});

export default router;

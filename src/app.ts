import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { verifyOrigin } from './middleware/verifyOrigin';
import { globalLimiter } from './middleware/rateLimiter';
import { sendSuccess } from './utils/ApiResponse';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import postRoutes from './routes/postRoutes';
import followRoutes from './routes/followRoutes';
import commentRoutes from './routes/commentRoutes';
import uploadRoutes from './routes/uploadRoutes';
import notificationRoutes from './routes/notificationRoutes';
import shareRoutes from './routes/shareRoutes';
import messageRoutes from './routes/messageRoutes';
import blockRoutes from './routes/blockRoutes';
import deviceRoutes from './routes/deviceRoutes';
import usageRoutes from './routes/usageRoutes';
import closeFriendRoutes from './routes/closeFriendRoutes';
import statusRoutes from './routes/statusRoutes';
import highlightRoutes from './routes/highlightRoutes';
import payoutRoutes from './routes/payoutRoutes';
import boostRoutes from './routes/boostRoutes';
import payfastRoutes from './routes/payfastRoutes';
import payfastCallbackRoutes from './routes/payfastCallbackRoutes';
import reelRoutes from './routes/reelRoutes';
import adminRoutes from './routes/adminRoutes';
import authFailureRoutes from './routes/authFailureRoutes';
import geoRoutes from './routes/geoRoutes';
import settingsRoutes from './routes/settingsRoutes';
import tagRoutes from './routes/tagRoutes';
import searchRoutes from './routes/searchRoutes';
import videoGenRoutes from './routes/videoGenRoutes';
import aiAssistantRoutes from './routes/aiAssistantRoutes';

export const app = express();

// Behind Railway's proxy: use the real client IP for rate limiting.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
// PayFast gateway callbacks and payment returns are mounted BEFORE
// verifyOrigin on purpose: PayFast's servers (and the customer's
// browser coming back from PayFast's domain) do not send our
// frontend's Origin header, so the CSRF origin check would reject
// every genuine report. These endpoints are safe without it — the
// callback handler fulfils nothing unless PayFast's validation_hash
// verifies against the server-side secured key (payfastService).
app.use('/api/payfast', payfastCallbackRoutes);
app.use(verifyOrigin);
app.use(globalLimiter);

app.get('/api/health', (_req, res) => {
  sendSuccess(res, { status: 'ok', environment: env.nodeEnv });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/follows', followRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/blocks', blockRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/close-friends', closeFriendRoutes);
app.use('/api/statuses', statusRoutes);
app.use('/api/highlights', highlightRoutes);
app.use('/api/payout', payoutRoutes);
app.use('/api/boosts', boostRoutes);
app.use('/api/payfast', payfastRoutes);
app.use('/api/reels', reelRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth-failures', authFailureRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/settings', settingsRoutes)
app.use('/api/video-gen', videoGenRoutes);
app.use('/api/ai-assistant', aiAssistantRoutes);

app.use(notFound);
app.use(errorHandler);


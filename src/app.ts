import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { verifyOrigin } from './middleware/verifyOrigin';
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

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(verifyOrigin);

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
app.use('/api/messages', messageRoutes);
app.use('/api/blocks', blockRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/close-friends', closeFriendRoutes);
app.use('/api/statuses', statusRoutes);

app.use(notFound);
app.use(errorHandler);

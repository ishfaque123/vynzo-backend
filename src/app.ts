import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { sendSuccess } from './utils/ApiResponse';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  sendSuccess(res, { status: 'ok', environment: env.nodeEnv });
});

// Feature routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// More routes are added in later stages:
// app.use('/api/posts', postRoutes);
// app.use('/api/media', mediaRoutes);
// app.use('/api/comments', commentRoutes);
// app.use('/api/likes', likeRoutes);
// app.use('/api/follows', followRoutes);
// app.use('/api/notifications', notificationRoutes);
// app.use('/api/reports', reportRoutes);
// app.use('/api/admin', adminRoutes);

app.use(notFound);
app.use(errorHandler);

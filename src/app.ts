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
import postRoutes from './routes/postRoutes';
import followRoutes from './routes/followRoutes';
import commentRoutes from './routes/commentRoutes';
import uploadRoutes from './routes/uploadRoutes';
import notificationRoutes from './routes/notificationRoutes';
import shareRoutes from './routes/shareRoutes';
import messageRoutes from './routes/messageRoutes';
import blockRoutes from './routes/blockRoutes';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  sendSuccess(res, { status: 'ok', environment: env.nodeEnv });
});

app.get('/api/debug-env', (_req, res) => {
  sendSuccess(res, { frontendUrl: env.frontendUrl, googleRedirectUri: env.googleRedirectUri });
});

app.get('/api/debug-cookies', (req, res) => {
  sendSuccess(res, { rawCookieHeader: req.headers.cookie || null, parsedCookies: req.cookies });
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

app.use(notFound);
app.use(errorHandler);

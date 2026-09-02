import { app } from './app';
import { env } from './config/env';
import { testDbConnection } from './config/db';

async function start() {
  try {
    await testDbConnection();
    console.log('Database connection successful.');

    app.listen(env.port, () => {
      console.log(`Vynzo backend running on port ${env.port} (${env.nodeEnv})`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

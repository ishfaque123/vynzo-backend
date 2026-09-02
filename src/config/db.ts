import mysql from 'mysql2/promise';
import { env } from './env';

export const pool = mysql.createPool({
  uri: env.databaseUrl,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function testDbConnection() {
  const connection = await pool.getConnection();
  await connection.ping();
  connection.release();
}

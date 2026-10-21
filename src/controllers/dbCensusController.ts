import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/ApiResponse';

// READ-ONLY database census (added 2026-10-21 for the disk-full cleanup the
// owner ordered). Reports per-table row estimates and sizes from
// information_schema for the CURRENT database. This handler never writes,
// updates, or deletes anything.

interface TableSizeRow {
  table_name: string;
  table_rows: number;
  data_mb: number;
  index_mb: number;
  free_mb: number;
  total_mb: number;
}

export async function getDbCensusHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await prisma.$queryRawUnsafe<TableSizeRow[]>(
      `SELECT table_name AS table_name,
              CAST(table_rows AS DOUBLE) AS table_rows,
              CAST(data_length AS DOUBLE) / 1048576 AS data_mb,
              CAST(index_length AS DOUBLE) / 1048576 AS index_mb,
              CAST(data_free AS DOUBLE) / 1048576 AS free_mb,
              CAST(data_length + index_length AS DOUBLE) / 1048576 AS total_mb
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
        ORDER BY (data_length + index_length) DESC`,
    );
    const tables = rows.map((r) => ({
      table: r.table_name,
      rows: Math.round(Number(r.table_rows)),
      dataMb: Math.round(Number(r.data_mb) * 10) / 10,
      indexMb: Math.round(Number(r.index_mb) * 10) / 10,
      freeMb: Math.round(Number(r.free_mb) * 10) / 10,
      totalMb: Math.round(Number(r.total_mb) * 10) / 10,
    }));
    const totalMb = Math.round(tables.reduce((s, t) => s + t.totalMb, 0) * 10) / 10;
    sendSuccess(res, { totalMb, tables });
  } catch (err) {
    next(err);
  }
}

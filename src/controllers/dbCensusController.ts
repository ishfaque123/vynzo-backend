import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/ApiResponse';

// READ-ONLY database census (added 2026-10-21 for the disk-full cleanup the
// owner ordered; extended the same day with the InnoDB file map + binlog
// status). Reports per-table row estimates and sizes from
// information_schema for the CURRENT database, the on-disk InnoDB file
// sizes, binary-log usage, and the related global settings. This handler
// never writes, updates, or deletes anything.

interface TableSizeRow {
  table_name: string;
  table_rows: number;
  data_mb: number;
  index_mb: number;
  free_mb: number;
  total_mb: number;
}

interface FileSizeRow {
  file_name: string;
  file_type: string;
  allocated_mb: number;
  data_free_mb: number;
}

const round1 = (n: number) => Math.round(Number(n) * 10) / 10;

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
      dataMb: round1(r.data_mb),
      indexMb: round1(r.index_mb),
      freeMb: round1(r.free_mb),
      totalMb: round1(r.total_mb),
    }));
    const totalMb = round1(tables.reduce((s, t) => s + t.totalMb, 0));

    let files: Array<{ file: string; type: string; allocatedMb: number; dataFreeMb: number }> = [];
    try {
      const fileRows = await prisma.$queryRawUnsafe<FileSizeRow[]>(
        `SELECT file_name AS file_name,
                file_type AS file_type,
                CAST(total_extents * extent_size AS DOUBLE) / 1048576 AS allocated_mb,
                CAST(data_free AS DOUBLE) / 1048576 AS data_free_mb
           FROM information_schema.files
          ORDER BY (total_extents * extent_size) DESC
          LIMIT 40`,
      );
      files = fileRows.map((f) => ({
        file: f.file_name,
        type: f.file_type,
        allocatedMb: round1(f.allocated_mb),
        dataFreeMb: round1(f.data_free_mb),
      }));
    } catch (e) {
      files = [{ file: 'ERROR: ' + (e instanceof Error ? e.message.slice(0, 200) : String(e)), type: '', allocatedMb: 0, dataFreeMb: 0 }];
    }

    let binlogs: unknown = null;
    try {
      const logs = await prisma.$queryRawUnsafe<Array<{ Log_name: string; File_size: number }>>('SHOW BINARY LOGS');
      const totalBytes = logs.reduce((s, l) => s + Number(l.File_size), 0);
      binlogs = { count: logs.length, totalMb: round1(totalBytes / 1048576), files: logs.map((l) => l.Log_name) };
    } catch (e) {
      binlogs = { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }

    let globals: unknown = null;
    try {
      const g = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT @@GLOBAL.log_bin AS log_bin,
                @@GLOBAL.binlog_expire_logs_seconds AS binlog_expire_seconds,
                @@GLOBAL.innodb_redo_log_capacity AS redo_log_bytes,
                @@GLOBAL.innodb_file_per_table AS file_per_table`,
      );
      globals = g[0] ?? null;
      if (globals && typeof globals === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(globals as Record<string, unknown>)) {
          out[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        globals = out;
      }
    } catch (e) {
      globals = { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }

    sendSuccess(res, { totalMb, tables, files, binlogs, globals });
  } catch (err) {
    next(err);
  }
}

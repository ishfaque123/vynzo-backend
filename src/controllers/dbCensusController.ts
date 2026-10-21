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

// ---------------------------------------------------------------------------
// Temporary DB space-reclaim operation (owner-ordered 2026-10-21 for the
// disk-full incident). Rebuilds every table of the CURRENT database with
// OPTIMIZE TABLE, one at a time, which returns each file's unused/grown
// space to the filesystem WITHOUT deleting a single row. Runs in the
// background; progress is polled via the status handler.

interface OptimizeState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalTables: number;
  doneCount: number;
  current: string | null;
  results: Array<{ table: string; ok: boolean; note: string }>;
  error: string | null;
}

const optimizeState: OptimizeState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  totalTables: 0,
  doneCount: 0,
  current: null,
  results: [],
  error: null,
};

async function allocatedFilesMb(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ mb: number }>>(
    `SELECT CAST(COALESCE(SUM(total_extents * extent_size), 0) AS DOUBLE) / 1048576 AS mb FROM information_schema.files`,
  );
  return round1(rows[0]?.mb ?? 0);
}

async function runOptimizeAll(): Promise<void> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name AS table_name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
        ORDER BY (data_length + index_length) DESC`,
    );
    optimizeState.totalTables = rows.length;
    for (const r of rows) {
      const name = r.table_name;
      optimizeState.current = name;
      try {
        const res = await prisma.$queryRawUnsafe<Array<{ Msg_text?: string }>>(
          'OPTIMIZE TABLE `' + name.replace(/`/g, '') + '`',
        );
        const note = res.map((x) => x.Msg_text ?? '').join('; ').slice(0, 200);
        optimizeState.results.push({ table: name, ok: true, note });
      } catch (e) {
        optimizeState.results.push({
          table: name,
          ok: false,
          note: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
      }
      optimizeState.doneCount += 1;
    }
  } catch (e) {
    optimizeState.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  } finally {
    optimizeState.running = false;
    optimizeState.current = null;
    optimizeState.finishedAt = new Date().toISOString();
  }
}

export async function startDbOptimizeHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    if (optimizeState.running) {
      sendSuccess(res, { started: false, reason: 'already running' });
      return;
    }
    optimizeState.running = true;
    optimizeState.startedAt = new Date().toISOString();
    optimizeState.finishedAt = null;
    optimizeState.totalTables = 0;
    optimizeState.doneCount = 0;
    optimizeState.current = null;
    optimizeState.results = [];
    optimizeState.error = null;
    void runOptimizeAll();
    sendSuccess(res, { started: true });
  } catch (err) {
    next(err);
  }
}

export async function getDbOptimizeStatusHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const filesAllocatedMb = await allocatedFilesMb();
    sendSuccess(res, { ...optimizeState, filesAllocatedMb });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Temporary DB cleanup operation (owner-ordered 2026-10-21 for the disk-full
// incident). Deletes ONLY stale counting/analytics rows in bounded batches,
// then rebuilds those tables. Never touches content tables (posts, comments,
// users, follows, likes, messages). Targets and cutoffs (verified against
// the Prisma schema and the services that read them):
//   usage_pings              pinged_at  older than 7 days
//   post_views               created_at older than 30 days
//   reel_views               created_at older than 30 days
//   notifications            created_at older than 30 days
//   email_verification_codes expires_at in the past (dead codes)

interface CleanupTarget {
  table: string;
  condition: string;
}

const CLEANUP_TARGETS: CleanupTarget[] = [
  { table: 'usage_pings', condition: 'pinged_at < NOW() - INTERVAL 7 DAY' },
  { table: 'post_views', condition: 'created_at < NOW() - INTERVAL 30 DAY' },
  { table: 'reel_views', condition: 'created_at < NOW() - INTERVAL 30 DAY' },
  { table: 'notifications', condition: 'created_at < NOW() - INTERVAL 30 DAY' },
  { table: 'email_verification_codes', condition: 'expires_at < NOW()' },
];

interface CleanupState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: string;
  filesBeforeMb: number | null;
  filesAfterMb: number | null;
  perTable: Array<{ table: string; matched: number; deleted: number; optimized: boolean; note: string }>;
  error: string | null;
}

const cleanupState: CleanupState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  phase: 'idle',
  filesBeforeMb: null,
  filesAfterMb: null,
  perTable: [],
  error: null,
};

async function runCleanup(): Promise<void> {
  try {
    cleanupState.phase = 'measuring';
    cleanupState.filesBeforeMb = await allocatedFilesMb();
    for (const t of CLEANUP_TARGETS) {
      const entry = { table: t.table, matched: 0, deleted: 0, optimized: false, note: '' };
      cleanupState.perTable.push(entry);
      try {
        cleanupState.phase = 'counting:' + t.table;
        const cnt = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
          'SELECT CAST(COUNT(*) AS DOUBLE) AS c FROM `' + t.table + '` WHERE ' + t.condition,
        );
        entry.matched = Math.round(Number(cnt[0]?.c ?? 0));
        cleanupState.phase = 'deleting:' + t.table;
        for (let i = 0; i < 300; i++) {
          const affected = await prisma.$executeRawUnsafe(
            'DELETE FROM `' + t.table + '` WHERE ' + t.condition + ' LIMIT 5000',
          );
          entry.deleted += Number(affected);
          if (Number(affected) < 5000) break;
        }
        cleanupState.phase = 'optimizing:' + t.table;
        try {
          await prisma.$queryRawUnsafe('OPTIMIZE TABLE `' + t.table + '`');
          entry.optimized = true;
        } catch (e) {
          entry.note = 'optimize: ' + (e instanceof Error ? e.message.slice(0, 150) : String(e));
        }
      } catch (e) {
        entry.note = (e instanceof Error ? e.message.slice(0, 200) : String(e));
      }
    }
    cleanupState.phase = 'measuring-after';
    cleanupState.filesAfterMb = await allocatedFilesMb();
    cleanupState.phase = 'done';
  } catch (e) {
    cleanupState.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    cleanupState.phase = 'error';
  } finally {
    cleanupState.running = false;
    cleanupState.finishedAt = new Date().toISOString();
  }
}

export async function startDbCleanupHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    if (cleanupState.running) {
      sendSuccess(res, { started: false, reason: 'already running' });
      return;
    }
    cleanupState.running = true;
    cleanupState.startedAt = new Date().toISOString();
    cleanupState.finishedAt = null;
    cleanupState.phase = 'starting';
    cleanupState.filesBeforeMb = null;
    cleanupState.filesAfterMb = null;
    cleanupState.perTable = [];
    cleanupState.error = null;
    void runCleanup();
    sendSuccess(res, { started: true });
  } catch (err) {
    next(err);
  }
}

export async function getDbCleanupStatusHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, { ...cleanupState });
  } catch (err) {
    next(err);
  }
}

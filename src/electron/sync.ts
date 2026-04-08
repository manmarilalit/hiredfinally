// sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Syncs job_apps rows between the local SQLite DB and Supabase.
//
// Strategy:
//   • Local SQLite remains the primary store for speed + offline support.
//   • On login, we push all local rows to Supabase, then pull any rows the
//     user created on another device.
//   • After that, every write to SQLite also writes to Supabase (fire-and-forget).
//   • Screenshots are NEVER synced — they're too large and ephemeral.
//
// Usage in index.ts:
//
//   const { SyncManager } = require('./sync');
//   const sync = new SyncManager(auth, storageModule);
//   // After user logs in:
//   await sync.fullSync();
//   // After every local write:
//   sync.pushRow(url);
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://dwrbmeqmtogvsginvhfz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3cmJtZXFtdG9ndnNnaW52aGZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NTM3MzUsImV4cCI6MjA4OTUyOTczNX0.eqeq2XziG3563GGV6plfZDjMai0WNR-uOWQKUY10GGE';

// ── SQL to run once in the Supabase dashboard (SQL editor) ───────────────────
//
//  CREATE TABLE IF NOT EXISTS job_apps (
//    user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
//    url           TEXT NOT NULL,
//    status        TEXT NOT NULL,
//    applied_at    TIMESTAMPTZ,
//    completed_at  TIMESTAMPTZ,
//    job_title     TEXT,
//    company       TEXT,
//    updated_at    TIMESTAMPTZ DEFAULT now(),
//    PRIMARY KEY (user_id, url)
//  );
//
//  -- Row-level security: users can only see/write their own rows
//  ALTER TABLE job_apps ENABLE ROW LEVEL SECURITY;
//  CREATE POLICY "own rows" ON job_apps
//    USING (auth.uid() = user_id)
//    WITH CHECK (auth.uid() = user_id);
//
// ─────────────────────────────────────────────────────────────────────────────

interface LocalRow {
  url: string;
  status: string;
  applied_at: string;
  completed_at: string | null;
  job_title?: string;
  company?: string;
}

export class SyncManager {
  private supabase: any;
  private auth: any;        // AuthManager instance
  private storage: any;     // storage.ts module exports

  constructor(auth: any, storage: any) {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    this.auth = auth;
    this.storage = storage;
  }

  // ── Full two-way sync (call once after login) ──────────────────────────────

  async fullSync(): Promise<void> {
    const userId = this.auth.getUserId();
    if (!userId) return;

    console.log('[SYNC] starting full sync...');

    try {
      await this.pushAll(userId);
      await this.pullAll(userId);
      console.log('[SYNC] full sync complete');
    } catch (e) {
      console.error('[SYNC] full sync error:', e);
    }
  }

  // ── Push a single row (call after every local write) ───────────────────────

  async pushRow(url: string): Promise<void> {
    const userId = this.auth.getUserId();
    if (!userId) return;

    try {
      const rows: LocalRow[] = this.storage.getAll();
      const row = rows.find((r: LocalRow) => r.url === url);
      if (!row) return;

      await this.upsertRemote(userId, row);
    } catch (e) {
      // Fire-and-forget — local write already succeeded
      console.error(`[SYNC] pushRow failed for ${url}:`, e);
    }
  }

  // ── Push a remote delete (call after deleteApp) ────────────────────────────

  async deleteRow(url: string): Promise<void> {
    const userId = this.auth.getUserId();
    if (!userId) return;

    try {
      await this.supabase
        .from('job_apps')
        .delete()
        .eq('user_id', userId)
        .eq('url', url);
    } catch (e) {
      console.error(`[SYNC] deleteRow failed for ${url}:`, e);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async pushAll(userId: string): Promise<void> {
    const rows: LocalRow[] = this.storage.getAll();
    if (rows.length === 0) return;

    const payload = rows.map((r: LocalRow) => this.toRemoteRow(userId, r));

    // upsert in batches of 100 to stay within Supabase limits
    for (let i = 0; i < payload.length; i += 100) {
      const batch = payload.slice(i, i + 100);
      const { error } = await this.supabase
        .from('job_apps')
        .upsert(batch, { onConflict: 'user_id,url' });

      if (error) console.error('[SYNC] pushAll batch error:', error.message);
    }

    console.log(`[SYNC] pushed ${rows.length} local rows to Supabase`);
  }

  private async pullAll(userId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('job_apps')
      .select('url, status, applied_at, completed_at, job_title, company')
      .eq('user_id', userId);

    if (error) {
      console.error('[SYNC] pullAll error:', error.message);
      return;
    }

    if (!data || data.length === 0) return;

    // For each remote row, upsert into local SQLite only if it's newer or missing.
    // We compare by url — if local has no record we insert; if status differs we update.
    const localRows: LocalRow[] = this.storage.getAll();
    const localMap = new Map(localRows.map((r: LocalRow) => [r.url, r]));

    let inserted = 0;
    let updated = 0;

    for (const remote of data) {
      const local = localMap.get(remote.url);

      if (!local) {
        // New row from another device
        if (remote.status === 'IN_PROGRESS') {
          this.storage.upsertInProgress(remote.url, null);
        } else if (remote.status === 'COMPLETED') {
          this.storage.upsertCompleted(remote.url);
        }
        if (remote.job_title || remote.company) {
          this.storage.updateMeta(remote.url, remote.job_title || '', remote.company || '');
        }
        inserted++;
      } else if (local.status !== remote.status) {
        // Status mismatch — take the "more advanced" status
        const order: Record<string, number> = { NOT_STARTED: 0, IN_PROGRESS: 1, COMPLETED: 2 };
        const localOrder = order[local.status] ?? 0;
        const remoteOrder = order[remote.status] ?? 0;

        if (remoteOrder > localOrder) {
          if (remote.status === 'COMPLETED') this.storage.upsertCompleted(remote.url);
          if (remote.job_title || remote.company) {
            this.storage.updateMeta(remote.url, remote.job_title || '', remote.company || '');
          }
          updated++;
        }
      }
    }

    console.log(`[SYNC] pulled from Supabase: ${inserted} inserted, ${updated} updated`);
  }

  private async upsertRemote(userId: string, row: LocalRow): Promise<void> {
    const { error } = await this.supabase
      .from('job_apps')
      .upsert(this.toRemoteRow(userId, row), { onConflict: 'user_id,url' });

    if (error) console.error('[SYNC] upsertRemote error:', error.message);
  }

  private toRemoteRow(userId: string, r: LocalRow): object {
    return {
      user_id: userId,
      url: r.url,
      status: r.status,
      applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null,
      completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      job_title: r.job_title ?? null,
      company: r.company ?? null,
      updated_at: new Date().toISOString(),
    };
  }
}

module.exports = { SyncManager };

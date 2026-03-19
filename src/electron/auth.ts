// auth.ts

const { createClient } = require('@supabase/supabase-js');
const { ipcMain, safeStorage, app } = require('electron');
const path = require('path');
const fs = require('fs');


const SUPABASE_URL = 'https://dwrbmeqmtogvsginvhfz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3cmJtZXFtdG9ndnNnaW52aGZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NTM3MzUsImV4cCI6MjA4OTUyOTczNX0.eqeq2XziG3563GGV6plfZDjMai0WNR-uOWQKUY10GGE';


export interface AuthUser {
  id: string;
  email: string;
}

export class AuthManager {
  private supabase: any;
  private mainWindow: any;
  private sessionFilePath: string;
  private currentUser: AuthUser | null = null;

  constructor(mainWindow: any) {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    this.mainWindow = mainWindow;
    this.sessionFilePath = path.join(
      app.getPath('userData'),
      'hf-session.enc'
    );
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  /**
   * Call once on app ready. Tries to restore a persisted session so the user
   * doesn't have to log in every time.
   */
  async init(): Promise<void> {
    // Always register IPC handlers so sign-in/sign-out work from any state
    this.registerIpcHandlers();

    const saved = this.loadSession();
    if (saved) {
      try {
        const { data, error } = await this.supabase.auth.setSession(saved);
        if (!error && data?.user) {
          this.currentUser = { id: data.user.id, email: data.user.email };
          console.log(`[AUTH] restored session for ${data.user.email}`);
          return;
        }
      } catch (e) {
        console.error('[AUTH] session restore failed:', e);
      }
      // Saved session was invalid — clear it
      this.deleteSession();
    }

    console.log('[AUTH] no valid session found, user must log in');
    this.currentUser = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getUserId(): string | null {
    return this.currentUser?.id ?? null;
  }

  getUser(): AuthUser | null {
    return this.currentUser;
  }

  isLoggedIn(): boolean {
    return this.currentUser !== null;
  }

  async signOut(): Promise<{ success: boolean }> {
    try {
      await this.supabase.auth.signOut();
    } catch { /* ignore network errors */ }
    this.currentUser = null;
    this.deleteSession();
    return { success: true };
  }

  // ── IPC Handlers ──────────────────────────────────────────────────────────

  private registerIpcHandlers(): void {
    // ── auth-sign-up ──────────────────────────────────────────────────────
    ipcMain.handle('auth-sign-up', async (_e: any, { email, password }: { email: string; password: string }) => {
      try {
        const { data, error } = await this.supabase.auth.signUp({ email, password });
        if (error) return { success: false, message: error.message };

        // Supabase sends a confirmation email by default.
        // If you disable email confirmation in the Supabase dashboard,
        // data.session will be non-null here and you can save it immediately.
        if (data.session) {
          this.currentUser = { id: data.user.id, email: data.user.email };
          this.saveSession(data.session);
        }

        return {
          success: true,
          needsConfirmation: !data.session, // true when email confirm is required
          user: data.user ? { id: data.user.id, email: data.user.email } : null,
        };
      } catch (e: any) {
        return { success: false, message: e?.message ?? 'Unknown error' };
      }
    });

    // ── auth-sign-in ──────────────────────────────────────────────────────
    ipcMain.handle('auth-sign-in', async (_e: any, { email, password }: { email: string; password: string }) => {
      try {
        const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
        if (error) return { success: false, message: error.message };

        this.currentUser = { id: data.user.id, email: data.user.email };
        this.saveSession(data.session);

        return {
          success: true,
          user: { id: data.user.id, email: data.user.email },
        };
      } catch (e: any) {
        return { success: false, message: e?.message ?? 'Unknown error' };
      }
    });

    // ── auth-sign-out ─────────────────────────────────────────────────────
    ipcMain.handle('auth-sign-out', async () => {
      const result = await this.signOut();
      if (result.success) {
        const path = require('path');
        this.mainWindow?.loadFile(path.join(__dirname, 'login.html'));
      }
      return result;
    });

    // ── auth-get-user ─────────────────────────────────────────────────────
    ipcMain.handle('auth-get-user', () => {
      return this.currentUser;
    });

    // ── auth-reset-password ───────────────────────────────────────────────
    ipcMain.handle('auth-reset-password', async (_e: any, { email }: { email: string }) => {
      try {
        const { error } = await this.supabase.auth.resetPasswordForEmail(email);
        if (error) return { success: false, message: error.message };
        return { success: true };
      } catch (e: any) {
        return { success: false, message: e?.message ?? 'Unknown error' };
      }
    });
  }

  // ── Session persistence (encrypted via OS keychain) ───────────────────────

  private saveSession(session: any): void {
    try {
      const json = JSON.stringify(session);
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(json);
        fs.writeFileSync(this.sessionFilePath, encrypted);
      } else {
        // Fallback: plain JSON (still inside userData which is user-private)
        fs.writeFileSync(this.sessionFilePath, json, 'utf8');
      }
    } catch (e) {
      console.error('[AUTH] failed to save session:', e);
    }
  }

  private loadSession(): any | null {
    try {
      if (!fs.existsSync(this.sessionFilePath)) return null;
      const raw = fs.readFileSync(this.sessionFilePath);
      let json: string;
      if (safeStorage.isEncryptionAvailable()) {
        json = safeStorage.decryptString(raw);
      } else {
        json = raw.toString('utf8');
      }
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private deleteSession(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) fs.unlinkSync(this.sessionFilePath);
    } catch { /* ignore */ }
  }
}

module.exports = { AuthManager };
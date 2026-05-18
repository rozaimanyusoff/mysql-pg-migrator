import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';

const ACCESS_TOKEN_KEY  = 'auth_token';
const REFRESH_TOKEN_KEY = 'auth_refresh_token';

// Decode JWT payload without verification (client-side only)
function decodeJwt(token: string): { sub?: string; exp?: number } | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string; exp?: number;
    };
  } catch { return null; }
}

interface AuthCtx {
  authenticated: boolean;
  username: string;
  loading: boolean;
  login: (accessToken: string, refreshToken: string, username: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx>({
  authenticated: false,
  username: '',
  loading: true,
  login: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((accessToken: string) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    const payload = decodeJwt(accessToken);
    if (!payload?.exp) return;
    // Refresh 60s before expiry
    const msUntilRefresh = (payload.exp * 1000 - Date.now()) - 60_000;
    if (msUntilRefresh <= 0) return;
    refreshTimer.current = setTimeout(async () => {
      const rToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (!rToken) return;
      try {
        const { data } = await axios.post('/api/auth/refresh', { refreshToken: rToken });
        const d = data as { accessToken: string; username: string };
        localStorage.setItem(ACCESS_TOKEN_KEY, d.accessToken);
        setUsername(d.username);
        scheduleRefresh(d.accessToken);
      } catch {
        // Refresh failed — force logout
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        setAuthenticated(false);
        setUsername('');
      }
    }, msUntilRefresh);
  }, []);

  // Verify stored token once on mount; if expired, try refresh
  useEffect(() => {
    const bootstrap = async () => {
      const accessToken  = localStorage.getItem(ACCESS_TOKEN_KEY);
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);

      if (accessToken) {
        try {
          const { data } = await axios.post('/api/auth/verify', { token: accessToken });
          const d = data as { valid: boolean; username: string | null };
          if (d.valid && d.username) {
            setAuthenticated(true);
            setUsername(d.username);
            scheduleRefresh(accessToken);
            setLoading(false);
            return;
          }
        } catch { /* access token invalid — fall through to refresh */ }
      }

      // Try refresh token
      if (refreshToken) {
        try {
          const { data } = await axios.post('/api/auth/refresh', { refreshToken });
          const d = data as { accessToken: string; username: string };
          localStorage.setItem(ACCESS_TOKEN_KEY, d.accessToken);
          setAuthenticated(true);
          setUsername(d.username);
          scheduleRefresh(d.accessToken);
          setLoading(false);
          return;
        } catch { /* refresh token also invalid */ }
      }

      // Clear stale tokens
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      setLoading(false);
    };
    void bootstrap();

    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [scheduleRefresh]);

  const login = useCallback((accessToken: string, refreshToken: string, user: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    setAuthenticated(true);
    setUsername(user);
    scheduleRefresh(accessToken);
  }, [scheduleRefresh]);

  const logout = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    try { await axios.post('/api/auth/logout', { refreshToken }); } catch { /* ignore */ }
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    setAuthenticated(false);
    setUsername('');
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, username, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthCtx {
  return useContext(AuthContext);
}

import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { Inter } from 'next/font/google';
import axios from 'axios';
import { Toaster } from 'sonner';
import FooterBar from '../components/FooterBar';
import Navbar from '../components/Navbar';
import { AlertProvider } from '../lib/alert-context';
import '../styles/globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    const logRoute = async (url: string) => {
      try {
        await axios.post('/api/audit-event', {
          module: 'global',
          action: 'route_visit',
          source: 'client',
          details: { url },
        });
      } catch {
        // ignore logging errors
      }
    };

    void logRoute(window.location.pathname);
    const handler = (url: string) => { void logRoute(url); };
    router.events.on('routeChangeComplete', handler);
    return () => router.events.off('routeChangeComplete', handler);
  }, [router.events]);

  return (
    <AlertProvider>
      <div className={`${inter.variable} font-sans min-h-screen pt-12 pb-12`}>
        <Navbar />
        <Component {...pageProps} />
        <Toaster position="top-right" richColors closeButton />
        <FooterBar />
      </div>
    </AlertProvider>
  );
}

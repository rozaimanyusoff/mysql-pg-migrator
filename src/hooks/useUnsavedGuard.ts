import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAlert } from '../lib/alert-context';

export function useUnsavedGuard(dirty: boolean, description?: string) {
  const router = useRouter();
  const { showConfirm } = useAlert();
  const pendingUrl = useRef<string | null>(null);
  const confirming = useRef(false);

  useEffect(() => {
    // Browser tab close / refresh
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // In-app navigation via Next.js router
    const onRouteChangeStart = (url: string) => {
      if (!dirty || confirming.current) return;
      pendingUrl.current = url;
      // Abort the navigation
      router.events.emit('routeChangeError');
      throw 'Navigation aborted: unsaved changes';
    };

    const onRouteChangeError = () => {
      if (!pendingUrl.current) return;
      const url = pendingUrl.current;
      pendingUrl.current = null;

      showConfirm({
        title: 'Unsaved changes',
        description: description ?? 'You have unsaved changes that will be lost if you leave.\nDo you want to continue?',
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay',
        onConfirm: () => {
          confirming.current = true;
          void router.push(url).then(() => { confirming.current = false; });
        },
      });
    };

    router.events.on('routeChangeStart', onRouteChangeStart);
    router.events.on('routeChangeError', onRouteChangeError);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      router.events.off('routeChangeStart', onRouteChangeStart);
      router.events.off('routeChangeError', onRouteChangeError);
    };
  }, [dirty, description, router, showConfirm]);
}

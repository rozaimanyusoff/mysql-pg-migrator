import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { AlertDialog, AlertDialogOptions, AlertVariant } from '../components/AlertDialog';

interface AlertContextValue {
  showConfirm: (options: Omit<AlertDialogOptions, 'variant'>) => void;
  showWarning: (options: Omit<AlertDialogOptions, 'variant'>) => void;
  showError: (title: string, description?: string) => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);

interface State extends AlertDialogOptions {
  open: boolean;
  variant: AlertVariant;
}

const CLOSED: State = {
  open: false, variant: 'confirm', title: '',
};

export function AlertProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(CLOSED);

  const open = useCallback((opts: AlertDialogOptions & { variant: AlertVariant }) => {
    setState({ ...opts, open: true });
  }, []);

  const showConfirm = useCallback((opts: Omit<AlertDialogOptions, 'variant'>) => {
    open({ ...opts, variant: 'confirm' });
  }, [open]);

  const showWarning = useCallback((opts: Omit<AlertDialogOptions, 'variant'>) => {
    open({ ...opts, variant: 'warning' });
  }, [open]);

  const showError = useCallback((title: string, description?: string) => {
    open({ title, description, variant: 'error', confirmLabel: 'OK' });
  }, [open]);

  return (
    <AlertContext.Provider value={{ showConfirm, showWarning, showError }}>
      {children}
      <AlertDialog
        open={state.open}
        onOpenChange={o => setState(s => ({ ...s, open: o }))}
        title={state.title}
        description={state.description}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        variant={state.variant}
        onConfirm={state.onConfirm}
        onCancel={state.onCancel}
      />
    </AlertContext.Provider>
  );
}

export function useAlert() {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error('useAlert must be used within AlertProvider');
  return ctx;
}

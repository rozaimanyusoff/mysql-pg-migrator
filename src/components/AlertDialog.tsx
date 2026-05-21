import * as Radix from '@radix-ui/react-alert-dialog';
import { AlertTriangle, XCircle, Info } from 'lucide-react';

export type AlertVariant = 'confirm' | 'destructive' | 'warning' | 'error';

export interface AlertDialogOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: AlertVariant;
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface Props extends AlertDialogOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const variantConfig: Record<AlertVariant, {
  icon: React.ReactNode;
  iconBg: string;
  confirmBtn: string;
}> = {
  confirm: {
    icon: <Info size={18} className="text-blue-600 dark:text-blue-400" />,
    iconBg: 'bg-blue-100 dark:bg-blue-950/50',
    confirmBtn: 'bg-blue-600 hover:bg-blue-700 text-white',
  },
  destructive: {
    icon: <XCircle size={18} className="text-rose-600 dark:text-rose-400" />,
    iconBg: 'bg-rose-100 dark:bg-rose-950/50',
    confirmBtn: 'bg-rose-600 hover:bg-rose-700 text-white',
  },
  warning: {
    icon: <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400" />,
    iconBg: 'bg-amber-100 dark:bg-amber-950/50',
    confirmBtn: 'bg-amber-500 hover:bg-amber-600 text-white',
  },
  error: {
    icon: <XCircle size={18} className="text-rose-600 dark:text-rose-400" />,
    iconBg: 'bg-rose-100 dark:bg-rose-950/50',
    confirmBtn: 'bg-rose-600 hover:bg-rose-700 text-white',
  },
};

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'confirm',
  onConfirm,
  onCancel,
}: Props) {
  const cfg = variantConfig[variant];
  const isErrorOnly = variant === 'error';

  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm?.();
  };

  const handleCancel = () => {
    onOpenChange(false);
    onCancel?.();
  };

  return (
    <Radix.Root open={open} onOpenChange={onOpenChange}>
      <Radix.Portal>
        <Radix.Overlay className="fixed inset-0 z-50 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-in fade-in-0" />
        <Radix.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md animate-in fade-in-0 zoom-in-95">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-gray-200 dark:border-slate-700 overflow-hidden">
            <div className="p-6">
              {/* Icon + Title */}
              <div className="flex items-start gap-4 mb-3">
                <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${cfg.iconBg}`}>
                  {cfg.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <Radix.Title className="text-sm font-semibold text-gray-900 dark:text-slate-100 leading-snug">
                    {title}
                  </Radix.Title>
                  {description && (
                    <Radix.Description className="mt-1 text-xs text-gray-500 dark:text-slate-400 leading-relaxed whitespace-pre-line">
                      {description}
                    </Radix.Description>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 bg-gray-50 dark:bg-slate-800/60 border-t border-gray-100 dark:border-slate-700/60">
              {!isErrorOnly && (
                <Radix.Cancel asChild>
                  <button onClick={handleCancel}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                    {cancelLabel ?? 'Cancel'}
                  </button>
                </Radix.Cancel>
              )}
              <Radix.Action asChild>
                <button onClick={handleConfirm}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${cfg.confirmBtn}`}>
                  {confirmLabel ?? (isErrorOnly ? 'OK' : 'Confirm')}
                </button>
              </Radix.Action>
            </div>
          </div>
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}

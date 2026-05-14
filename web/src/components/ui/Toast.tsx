import { useState, useCallback } from 'react';

type ToastVariant = 'success' | 'error' | 'info';

type ToastItem = {
  id: number;
  variant: ToastVariant;
  message: string;
};

let globalCounter = 0;

export type ToastManager = {
  toasts: ToastItem[];
  add: (variant: ToastVariant, message: string) => void;
  remove: (id: number) => void;
};

export function useToastManager(): ToastManager {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const add = useCallback((variant: ToastVariant, message: string) => {
    const id = ++globalCounter;
    setToasts((prev) => [...prev, { id, variant, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, add, remove };
}

const VARIANT_COLORS: Record<ToastVariant, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-error)',
  info: 'var(--color-accent)',
};

export function ToastDisplay({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 2000,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            background: 'var(--color-surface)',
            border: `1px solid ${VARIANT_COLORS[toast.variant]}`,
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            fontSize: '14px',
            color: VARIANT_COLORS[toast.variant],
            fontFamily: 'inherit',
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
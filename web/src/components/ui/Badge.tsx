import type { CSSProperties, ReactNode } from 'react';

type BadgeVariant = 'info' | 'success' | 'warning' | 'error';

type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
  style?: CSSProperties;
};

const variantStyles: Record<BadgeVariant, CSSProperties> = {
  info: { background: 'rgba(0, 212, 255, 0.15)', color: 'var(--color-accent)' },
  success: { background: 'rgba(34, 197, 94, 0.15)', color: 'var(--color-success)' },
  warning: { background: 'rgba(255, 159, 67, 0.15)', color: 'var(--color-warning)' },
  error: { background: 'rgba(239, 68, 68, 0.15)', color: 'var(--color-error)' },
};

export default function Badge({ variant = 'info', children, style }: BadgeProps) {
  return (
    <span
      style={{
        ...variantStyles[variant],
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        fontSize: '12px',
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
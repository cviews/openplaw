import type { CSSProperties, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'danger' | 'ghost';

type ButtonProps = {
  variant?: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  style?: CSSProperties;
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: 'var(--color-accent)',
    color: '#fff',
    border: 'none',
  },
  danger: {
    background: 'var(--color-error)',
    color: '#fff',
    border: 'none',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
};

export default function Button({ variant = 'primary', onClick, disabled, children, style }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...variantStyles[variant],
        padding: '8px 16px',
        borderRadius: 'var(--radius-md)',
        fontSize: '14px',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s ease',
        fontFamily: 'inherit',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
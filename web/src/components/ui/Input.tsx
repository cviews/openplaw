import type { CSSProperties, ChangeEvent } from 'react';

type InputProps = {
  label?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  style?: CSSProperties;
};

export default function Input({ label, value, onChange, type = 'text', placeholder, disabled, style }: InputProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...style }}>
      {label && (
        <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500 }}>
          {label}
        </label>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          fontSize: '14px',
          color: 'var(--color-text)',
          fontFamily: 'var(--font-mono)',
          outline: 'none',
          width: '100%',
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </div>
  );
}
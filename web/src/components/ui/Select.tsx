import type { CSSProperties, ChangeEvent } from 'react';

type SelectProps = {
  label?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  style?: CSSProperties;
};

export default function Select({ label, value, onChange, options, disabled, style }: SelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...style }}>
      {label && (
        <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500 }}>
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          fontSize: '14px',
          color: 'var(--color-text)',
          outline: 'none',
          width: '100%',
          fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}
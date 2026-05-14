import type { CSSProperties, ChangeEvent } from 'react';

type CheckboxProps = {
  label?: string;
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  style?: CSSProperties;
};

export default function Checkbox({ label, checked, onChange, disabled, style }: CheckboxProps) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '14px',
        color: 'var(--color-text)',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{
          width: '16px',
          height: '16px',
          accentColor: 'var(--color-accent)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      />
      {label && <span>{label}</span>}
    </label>
  );
}
import { ArrowDropDown } from '@mui/icons-material';
import { InputAdornment, Menu, MenuItem, TextField } from '@mui/material';
import { useId, useRef, useState } from 'react';
import { scaledAnchor, useUiScale } from './ui-scale';

export function ScaledSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  fullWidth = false,
  ariaLabel,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  fullWidth?: boolean;
  ariaLabel?: string;
}) {
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const scale = useUiScale();
  const showMenu = () => {
    if (disabled) return;
    input.current?.focus();
    setOpen(true);
  };
  return (
    <>
      <TextField
        ref={field}
        inputRef={input}
        label={label}
        value={options.find((option) => option.value === value)?.label ?? ''}
        variant="outlined"
        size="small"
        fullWidth={fullWidth}
        disabled={disabled}
        onClick={showMenu}
        onKeyDown={(event) => {
          if (!disabled && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            if (event.key !== ' ') showMenu();
          }
        }}
        onKeyUp={(event) => {
          if (!disabled && event.key === ' ') {
            event.preventDefault();
            showMenu();
          }
        }}
        slotProps={{
          input: {
            readOnly: true,
            endAdornment: (
              <InputAdornment position="end">
                <ArrowDropDown />
              </InputAdornment>
            ),
          },
          htmlInput: {
            role: 'combobox',
            'aria-label': ariaLabel ?? label,
            'aria-expanded': open && !disabled,
            'aria-haspopup': 'menu',
            'aria-controls': open ? menuId : undefined,
            style: { cursor: disabled ? undefined : 'pointer' },
          },
        }}
      />
      <Menu
        anchorEl={scaledAnchor(field.current)}
        open={open && !disabled}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        onClose={() => setOpen(false)}
        slotProps={{
          list: { id: menuId, 'aria-label': ariaLabel ?? label },
          paper: { sx: { minWidth: (field.current?.getBoundingClientRect().width ?? 0) / scale } },
        }}
      >
        {options.map((option) => (
          <MenuItem
            key={option.value}
            selected={option.value === value}
            onClick={() => {
              setOpen(false);
              onChange(option.value);
            }}
          >
            {option.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import styles from './Select.module.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

interface SelectProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  ariaLabel?: string;
  /** Visible caption rendered before the trigger (the website pairs selects with a label). */
  caption?: string;
  className?: string;
  disabled?: boolean;
}

interface TriggerRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
  viewportHeight: number;
}

/**
 * Hand-rolled select matching the desktop primitive: button trigger, portal
 * listbox, keyboard navigation, click-outside and scroll-away close. The
 * website has no radix/shadcn; native <select> popups cannot be styled to the
 * RunHQ design language.
 */
export function Select<V extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  caption,
  className,
  disabled,
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<TriggerRect | null>(null);
  const [activeIdx, setActiveIdx] = useState<number>(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);
  const currentIdx = options.findIndex((o) => o.value === value);

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({
      left: r.left,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      viewportHeight: window.innerHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    const onScroll = (e: Event) => {
      if (listRef.current && listRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIdx(currentIdx >= 0 ? currentIdx : 0);
  }, [open, currentIdx]);

  const moveActive = (delta: number) => {
    setActiveIdx((prev) => {
      const len = options.length;
      if (len === 0) return -1;
      let next = prev;
      for (let i = 0; i < len; i++) {
        next = (next + delta + len) % len;
        if (!options[next]?.disabled) return next;
      }
      return prev;
    });
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt && !opt.disabled) {
        onChange(opt.value);
        setOpen(false);
        triggerRef.current?.focus();
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-select-idx="${activeIdx}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const menuMaxHeight = 280;
  const flipAbove =
    rect !== null &&
    rect.viewportHeight - rect.bottom < menuMaxHeight + 12 &&
    rect.top > menuMaxHeight + 12;

  return (
    <span className={[styles.root, className].filter(Boolean).join(' ')}>
      {caption && <span className={styles.caption}>{caption}</span>}
      <button
        type="button"
        ref={triggerRef}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={styles.trigger}
      >
        <span className={styles.value}>{selected?.label}</span>
        <ChevronDown size={12} aria-hidden="true" className={open ? styles.chevronOpen : ''} />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onListKey}
            className={styles.list}
            style={{
              left: rect.left,
              top: flipAbove ? undefined : rect.bottom + 4,
              bottom: flipAbove ? rect.viewportHeight - rect.top + 4 : undefined,
              minWidth: rect.width,
              maxHeight: menuMaxHeight,
            }}
            onMouseDown={(e) => {
              e.preventDefault();
            }}
          >
            <FocusOnMount />
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isActive = i === activeIdx;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-select-idx={i}
                  disabled={opt.disabled}
                  onMouseEnter={() => !opt.disabled && setActiveIdx(i)}
                  onClick={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={[
                    styles.option,
                    isActive ? styles.optionActive : '',
                    opt.disabled ? styles.optionDisabled : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={styles.optionLabel}>{opt.label}</span>
                  <Check size={13} aria-hidden="true" className={isSelected ? '' : styles.hidden} />
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}

function FocusOnMount() {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    host?.focus();
  }, []);
  return <span ref={ref} className="sr-only" aria-hidden />;
}

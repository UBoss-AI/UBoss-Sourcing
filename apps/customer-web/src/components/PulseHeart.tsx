import { useEffect, useId, useState } from 'react';
import './pulse-heart.css';

export interface PulseHeartProps {
  liked?: boolean;
  defaultLiked?: boolean;
  count?: number | null;
  showCount?: boolean;
  onChange?: (nextLiked: boolean) => void;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}

export function PulseHeart({
  liked,
  defaultLiked = false,
  count = null,
  showCount = false,
  onChange,
  className = '',
  disabled = false,
  size = 'sm',
  ariaLabel,
}: PulseHeartProps): React.JSX.Element {
  const [isLiked, setIsLiked] = useState(liked ?? defaultLiked);
  const [isPulsing, setIsPulsing] = useState(false);
  const generatedId = useId();

  useEffect(() => {
    if (liked !== undefined) {
      setIsLiked(liked);
    }
  }, [liked]);

  useEffect(() => {
    if (!isPulsing) return;

    const animationFrame = window.requestAnimationFrame(() => {
      setIsPulsing(false);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [isPulsing]);

  const handleClick = (): void => {
    if (disabled) return;

    const nextLiked = !isLiked;
    setIsLiked(nextLiked);
    setIsPulsing(true);
    onChange?.(nextLiked);
  };

  const computedClassName = [
    'pulse-heart',
    `pulse-heart--${size}`,
    isLiked ? 'pulse-heart--liked' : '',
    isPulsing ? 'pulse-heart--pulsing' : '',
    disabled ? 'pulse-heart--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? (isLiked ? 'Unlike product' : 'Like product')}
      aria-pressed={isLiked}
      className={computedClassName}
      data-liked={isLiked}
      data-pulse={isPulsing}
      onClick={handleClick}
      disabled={disabled}
    >
      <span aria-hidden="true" className="pulse-heart__icon" data-icon={generatedId}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20.25s-7.35-4.46-7.35-9.18A4.17 4.17 0 0 1 12 8.22a4.17 4.17 0 0 1 7.35 2.85c0 4.72-7.35 9.18-7.35 9.18Z" />
        </svg>
      </span>
      {showCount && count !== null && (
        <span aria-live="polite" className="pulse-heart__count">
          {count}
        </span>
      )}
    </button>
  );
}

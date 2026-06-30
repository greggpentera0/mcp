import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemeModeSelectorProps = {
  ariaLabel?: string;
  compact?: boolean;
  labels?: Record<ThemeMode, string>;
};

const DEFAULT_LABELS: Record<ThemeMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const OPTIONS: Array<{ value: ThemeMode; icon: typeof Monitor }> = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

function ThemeModeSelector({
  ariaLabel = 'Theme preference',
  compact = false,
  labels = DEFAULT_LABELS,
}: ThemeModeSelectorProps) {
  const { themeMode, setThemeMode } = useTheme() as {
    themeMode?: ThemeMode;
    setThemeMode?: (mode: ThemeMode) => void;
  };
  const selectedMode = themeMode ?? 'system';

  return (
    <div
      className={cn(
        'grid w-full grid-cols-3 rounded-lg border border-input bg-muted/40 p-1',
        compact ? 'w-full' : 'sm:w-auto',
      )}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {OPTIONS.map(({ value, icon: Icon }) => {
        const isSelected = selectedMode === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => setThemeMode?.(value)}
            className={cn(
              'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              compact ? 'text-xs' : 'text-sm sm:min-w-20',
              isSelected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span>{labels[value]}</span>
          </button>
        );
      })}
    </div>
  );
}

export default ThemeModeSelector;

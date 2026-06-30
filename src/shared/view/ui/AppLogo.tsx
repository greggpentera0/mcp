import type { ImgHTMLAttributes } from 'react';

import { cn } from '../../../lib/utils';

type AppLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string;
};

function AppLogo({
  alt = 'MCP Playground',
  className,
  src = '/logo-256.png',
  ...props
}: AppLogoProps) {
  return (
    <img
      src={src}
      alt={alt}
      className={cn('block flex-shrink-0 rounded-[22%] object-contain', className)}
      draggable={false}
      {...props}
    />
  );
}

export default AppLogo;

type AntigravityLogoProps = {
  className?: string;
};

const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => (
  <img
    src="/antigravity-logo.png"
    alt="Antigravity"
    className={className}
    style={{ objectFit: 'contain' }}
    loading="eager"
    decoding="async"
  />
);

export default AntigravityLogo;

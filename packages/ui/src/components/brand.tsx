export function VeilLogo({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Veil">
      <defs>
        <linearGradient id="vg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00A88E" />
          <stop offset="1" stopColor="#2AABEE" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#vg)" />
      <path d="M18 22c6 13 9 20 14 22 5-2 8-9 14-22" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="18" r="3.5" fill="#fff" opacity=".9" />
    </svg>
  );
}

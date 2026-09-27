/** Kubepit brand mark: a helm-wheel hexagon drawn with currentColor. */
export function KubepitMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
      <path
        d="M12 5.8v3.4M12 14.8v3.4M6.6 8.9l2.9 1.7M14.5 13.4l2.9 1.7M17.4 8.9l-2.9 1.7M9.5 13.4l-2.9 1.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

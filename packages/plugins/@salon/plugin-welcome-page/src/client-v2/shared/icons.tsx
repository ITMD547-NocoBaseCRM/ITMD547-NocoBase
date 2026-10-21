import React from 'react';

type IconProps = { size?: number };

/** Decorative icons: all are aria-hidden; the adjacent text carries the meaning. */
function Svg({ size = 22, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const CustomersIcon = () => (
  <Svg>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M15.8 14.2c2.5-.3 4.3 1.2 4.7 4.3" />
  </Svg>
);

export const CalendarIcon = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="15" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="m9.5 14.5 1.8 1.8 3.4-3.6" />
  </Svg>
);

export const ScissorsIcon = () => (
  <Svg>
    <circle cx="6.5" cy="7" r="2.5" />
    <circle cx="6.5" cy="17" r="2.5" />
    <path d="M8.6 8.4 20 17M8.6 15.6 20 7" />
  </Svg>
);

export const MembershipIcon = () => (
  <Svg>
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="m12 9.3 1 2 2.2.3-1.6 1.6.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.6 2.2-.3 1-2Z" />
  </Svg>
);

export const PaymentIcon = () => (
  <Svg>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M2.5 10h19M6.5 15h3" />
  </Svg>
);

export const ScheduleIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const ShieldIcon = () => (
  <Svg size={18}>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9.2 12 2 2 3.6-3.8" />
  </Svg>
);

export const ArrowIcon = () => (
  <Svg size={18}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

import React from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { salonLogo } from '../../asset';
import { brandName, namespace } from '../../constants';
import {
  ArrowIcon,
  CalendarIcon,
  CustomersIcon,
  MembershipIcon,
  PaymentIcon,
  ScheduleIcon,
  ScissorsIcon,
  ShieldIcon,
} from './icons';
import { SIGN_IN_PATH } from './session';
import { welcomeStyles } from './styles';

type T = (key: string) => string;

function useT(): T {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  return (key: string) => t(key);
}

const FEATURES: { title: string; text: string; Icon: ComponentType }[] = [
  {
    title: 'Customer management',
    text: 'Profiles, visit history, preferences and notes in one place.',
    Icon: CustomersIcon,
  },
  { title: 'Appointments', text: 'Book, reschedule and track every visit without double-booking.', Icon: CalendarIcon },
  { title: 'Services', text: 'Organize treatments, categories, durations and pricing.', Icon: ScissorsIcon },
  { title: 'Memberships', text: 'Manage plans and loyalty for your returning clients.', Icon: MembershipIcon },
  { title: 'Payments', text: 'Keep track of payments for every appointment and service.', Icon: PaymentIcon },
  { title: 'Employee scheduling', text: 'Plan shifts and availability for the whole team.', Icon: ScheduleIcon },
];

export function WelcomeHeader() {
  return (
    <header className="swp-header">
      <span className="swp-brand">
        <img className="swp-brand-logo" src={salonLogo} alt="Beauty Within Chicago logo" />

        <span className="swp-brand-name">{brandName}</span>
      </span>
    </header>
  );
}

export function StaffLoginButton({ t }: { t: T }) {
  return (
    <Link className="swp-cta" to={SIGN_IN_PATH}>
      {t('Staff Login')}
      <span className="swp-cta-arrow">
        <ArrowIcon />
      </span>
    </Link>
  );
}

export function Hero({ t }: { t: T }) {
  return (
    <section className="swp-hero" aria-labelledby="swp-title">
      <div>
        <span className="swp-eyebrow swp-reveal">{t('Salon management')}</span>
        <h1 id="swp-title" className="swp-title swp-reveal swp-delay-1">
          {t('Welcome to')} <span className="swp-title-accent">{brandName}</span>
        </h1>
        <p className="swp-subtitle swp-reveal swp-delay-2">{t('Your all-in-one salon management platform.')}</p>
        <p className="swp-description swp-reveal swp-delay-3">
          {t(
            'Simplify customer management, appointments, services, memberships, payments, and employee scheduling from one secure platform.',
          )}
        </p>
        <div className="swp-actions swp-reveal swp-delay-4">
          <StaffLoginButton t={t} />
          <span className="swp-note">
            <ShieldIcon />
            {t('For authorized salon staff')}
          </span>
        </div>
      </div>
      <div className="swp-visual" aria-hidden="true">
        <span className="swp-orb swp-orb-1" />
        <span className="swp-orb swp-orb-2" />
        <span className="swp-orb swp-orb-3" />
        <span className="swp-logo">
          {/* Decorative here: the whole visual is aria-hidden and the header already names the brand. */}
          <img src={salonLogo} alt="" />
        </span>
      </div>
    </section>
  );
}

export function FeatureCard({ title, text, Icon }: { title: string; text: string; Icon: ComponentType }) {
  return (
    <li className="swp-card">
      <span className="swp-card-icon">
        <Icon />
      </span>
      <h3 className="swp-card-title">{title}</h3>
      <p className="swp-card-text">{text}</p>
    </li>
  );
}

export function FeatureGrid({ t }: { t: T }) {
  return (
    <section className="swp-features" aria-labelledby="swp-features-title">
      <h2 id="swp-features-title" className="swp-features-title">
        {t('Everything your salon runs on')}
      </h2>
      <ul className="swp-grid">
        {FEATURES.map(({ title, text, Icon }) => (
          <FeatureCard key={title} title={t(title)} text={t(text)} Icon={Icon} />
        ))}
      </ul>
    </section>
  );
}

export function WelcomeFooter({ t }: { t: T }) {
  return (
    <footer className="swp-footer">
      <span>
        © {new Date().getFullYear()} {brandName}
      </span>
      <span>{t('Secure access for salon staff')}</span>
    </footer>
  );
}

/** Presentational page; routing and the session check live in WelcomeRoute. */
export function WelcomePage() {
  const t = useT();
  return (
    <div className="swp">
      <style>{welcomeStyles}</style>
      <a className="swp-skip" href="#swp-main">
        {t('Skip to content')}
      </a>
      <WelcomeHeader />
      <main id="swp-main" className="swp-main" tabIndex={-1}>
        <Hero t={t} />
        <FeatureGrid t={t} />
      </main>
      <WelcomeFooter t={t} />
    </div>
  );
}

export function SessionCheck() {
  const t = useT();
  return (
    <div className="swp swp-checking" role="status" aria-live="polite">
      <style>{welcomeStyles}</style>
      <div>
        <div className="swp-spinner" />
        {t('Loading…')}
      </div>
    </div>
  );
}

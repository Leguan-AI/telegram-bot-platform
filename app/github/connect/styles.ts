/**
 * Inline styles for the two public connect pages. These are seen by invitees who have no
 * /manage account, so they stay standalone (no manage.css, no client JS) and light, like
 * the privacy page.
 */
import type { CSSProperties } from 'react';

export const page: CSSProperties = {
  maxWidth: '680px',
  margin: '0 auto',
  padding: '48px 20px',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  lineHeight: 1.6,
  color: '#1a1a1a',
};

export const heading: CSSProperties = {
  fontSize: '1.6rem',
  marginBottom: '0.5rem',
};

export const lead: CSSProperties = {
  fontSize: '1.05rem',
  color: '#374151',
};

export const panel: CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px 24px',
  margin: '24px 0',
  background: '#f9fafb',
};

export const warning: CSSProperties = {
  border: '1px solid #fcd34d',
  background: '#fffbeb',
  borderRadius: '8px',
  padding: '16px 20px',
  margin: '24px 0',
};

export const button: CSSProperties = {
  display: 'inline-block',
  padding: '12px 20px',
  borderRadius: '6px',
  background: '#111827',
  color: '#ffffff',
  textDecoration: 'none',
  fontWeight: 600,
};

export const muted: CSSProperties = {
  fontSize: '0.875rem',
  color: '#6b7280',
};

export function toneColor(tone: 'success' | 'pending' | 'error'): string {
  if (tone === 'success') return '#047857';
  if (tone === 'pending') return '#b45309';
  return '#b91c1c';
}

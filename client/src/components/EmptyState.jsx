/**
 * EmptyState — shared treatment for "nothing to show yet" screens.
 *
 * Renders a Lucide icon inside a rounded soft-bg container, then a
 * headline, an optional sub-line, and an optional primary-button CTA.
 * Uses the .empty-state* CSS classes from index.css; dark-mode shifts the
 * icon to emerald (better contrast on dark petrol bg) via the
 * [data-theme="dark"] override.
 *
 * Usage:
 *   <EmptyState
 *     icon={FileText}
 *     title="No contracts yet"
 *     sub="Drop in a CSV or add your first contract manually."
 *     ctaLabel="New contract"
 *     ctaOnClick={() => navigate('/contracts/new')}
 *   />
 *
 * Shipped: v0.7.0.
 */

import React from 'react';
import { Link } from 'react-router-dom';

export default function EmptyState({ icon: Icon, title, sub, body, ctaLabel, ctaOnClick, ctaTo, children }) {
  return (
    <div className="empty-state">
      {Icon && (
        <div className="empty-state-icon">
          <Icon size={24} strokeWidth={1.75} />
        </div>
      )}
      {title && <div className="empty-state-title">{title}</div>}
      {(sub || body) && <div className="empty-state-sub">{sub || body}</div>}
      {ctaLabel && (
        ctaTo ? (
          <Link to={ctaTo} className="btn btn-primary empty-state-cta">
            {ctaLabel}
          </Link>
        ) : ctaOnClick ? (
          <button
            type="button"
            className="btn btn-primary empty-state-cta"
            onClick={ctaOnClick}
          >
            {ctaLabel}
          </button>
        ) : null
      )}
      {children}
    </div>
  );
}

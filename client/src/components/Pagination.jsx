// ─────────────────────────────────────────────────────────────────────────────
// Pagination.jsx — shared presentational pager control.
//
// PRESENTATION ONLY. This component owns NO state and fetches NO data; it
// renders the canonical .pagination / .page-btn markup (see index.css, matching
// AssetsList) so every list pager looks identical. Each page wires it to its own
// existing page state + prev/next handlers.
//
// Props:
//   page        (number)  — current 1-based page (required)
//   totalPages  (number)  — total page count; if omitted, derived from
//                           total / pageSize (required if those are absent)
//   total       (number)  — optional total item count (for "· N items" suffix
//                           and to derive totalPages)
//   pageSize    (number)  — optional page size (used with total to derive pages)
//   onPrev      (fn)      — called when Prev is clicked
//   onNext      (fn)      — called when Next is clicked
//   disabled    (bool)    — extra guard (e.g. while loading) that disables both
//   label       (node)    — optional custom info node; overrides the default
//   itemLabel   (string)  — noun for the default label suffix (default "items")
//
// Prev is disabled on page 1; Next is disabled on the last page.
// ─────────────────────────────────────────────────────────────────────────────

export default function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPrev,
  onNext,
  disabled = false,
  label,
  itemLabel = 'items',
}) {
  const pages =
    totalPages ??
    (total != null && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1);

  const info =
    label ??
    `Page ${page} of ${pages}${
      total != null ? ` · ${total.toLocaleString()} ${itemLabel}` : ''
    }`;

  return (
    <div className="pagination">
      <div className="pagination-info">{info}</div>
      <div className="pagination-controls">
        <button
          type="button"
          className="page-btn"
          aria-label="Previous page"
          disabled={disabled || page <= 1}
          onClick={onPrev}
        >
          <span aria-hidden="true">‹</span> Prev
        </button>
        <button
          type="button"
          className="page-btn"
          aria-label="Next page"
          disabled={disabled || page >= pages}
          onClick={onNext}
        >
          Next <span aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}

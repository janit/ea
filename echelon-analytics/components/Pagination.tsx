interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  baseUrl: string;
}

function buildUrl(base: string, page: number): string {
  const url = new URL(base);
  if (page > 1) {
    url.searchParams.set("page", String(page));
  } else {
    url.searchParams.delete("page");
  }
  return `${url.pathname}${url.search}`;
}

export function Pagination(
  { page, totalPages, total, baseUrl }: PaginationProps,
) {
  if (totalPages <= 1) {
    return (
      <div class="text-xs text-[var(--ea-muted)] mt-3">
        {total} record{total !== 1 ? "s" : ""}
      </div>
    );
  }

  return (
    <nav aria-label="Pagination" class="flex items-center justify-between mt-3">
      <span class="text-xs text-[var(--ea-muted)]">
        {total} record{total !== 1 ? "s" : ""}, page {page} of {totalPages}
      </span>
      <div class="flex gap-2">
        {page > 1
          ? (
            <a
              href={buildUrl(baseUrl, page - 1)}
              class="inline-flex items-center px-3 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-primary)] hover:bg-[var(--ea-surface-alt)]"
            >
              Previous
            </a>
          )
          : (
            <span class="px-3 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-muted)] opacity-50">
              Previous
            </span>
          )}
        {page < totalPages
          ? (
            <a
              href={buildUrl(baseUrl, page + 1)}
              class="inline-flex items-center px-3 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-primary)] hover:bg-[var(--ea-surface-alt)]"
            >
              Next
            </a>
          )
          : (
            <span class="px-3 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-muted)] opacity-50">
              Next
            </span>
          )}
      </div>
    </nav>
  );
}

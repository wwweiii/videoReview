import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState, type JSX } from 'react'

export function Pagination({ page, totalPages, onPageChange }: {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}): JSX.Element {
  const [pageInput, setPageInput] = useState(String(page))

  useEffect(() => setPageInput(String(page)), [page, totalPages])

  function jumpToPage(): void {
    if (!pageInput) {
      setPageInput(String(page))
      return
    }
    const nextPage = Math.max(1, Math.min(totalPages, Number(pageInput)))
    setPageInput(String(nextPage))
    onPageChange(nextPage)
  }

  return (
    <div className="pagination">
      <span>第 {page} / {totalPages} 页</span>
      <div className="pagination-actions">
        <button
          type="button"
          className="icon-button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="上一页"
        >
          <ChevronLeft size={18} />
        </button>
        <input
          className="pagination-jump"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          aria-label="跳转页码"
          value={pageInput}
          disabled={totalPages <= 1}
          onChange={(event) => {
            if (/^\d*$/.test(event.target.value)) setPageInput(event.target.value)
          }}
          onBlur={jumpToPage}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          className="icon-button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}

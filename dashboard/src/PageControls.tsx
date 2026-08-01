import { paginationWindow } from './pagination';

export function Pagination(props: {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    loading?: boolean;
    onPage: (page: number) => void;
    onPageSize?: (pageSize: 25 | 50 | 100) => void;
}) {
    const last = Math.max(1, props.totalPages);
    const start = props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
    const end = Math.min(props.total, props.page * props.pageSize);
    return (
        <div className="pagination" aria-label="Pagination">
            <span className="pagination-count">
                {props.total === 0 ? '0 records' : `${start}–${end} of ${props.total.toLocaleString()} records`}
            </span>
            <div className="pagination-controls">
                <button disabled={props.loading || props.page <= 1} onClick={() => props.onPage(1)}>First</button>
                <button disabled={props.loading || props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</button>
                {paginationWindow(props.page, props.totalPages).map(value => (
                    <button
                        key={value}
                        aria-current={value === props.page ? 'page' : undefined}
                        disabled={props.loading}
                        onClick={() => props.onPage(value)}
                    >
                        {value}
                    </button>
                ))}
                <button disabled={props.loading || props.page >= last} onClick={() => props.onPage(props.page + 1)}>Next</button>
                <button disabled={props.loading || props.page >= last} onClick={() => props.onPage(last)}>Last</button>
            </div>
            {props.onPageSize !== undefined && (
                <label className="pagination-size">
                    <span>Rows</span>
                    <select value={props.pageSize} onChange={event => props.onPageSize?.(Number(event.target.value) as 25 | 50 | 100)}>
                        <option value="25">25</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                    </select>
                </label>
            )}
        </div>
    );
}

export function Loading() {
  return <div className="loading">Loading…</div>
}

export function ErrorMsg({ message }: { message: string }) {
  return <div className="error-msg">⚠ {message}</div>
}

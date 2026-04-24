// In-memory token storage (never localStorage for v0.1)
let _token: string | null = null

export function setToken(token: string): void {
  _token = token
}

export function getToken(): string | null {
  return _token
}

export function clearToken(): void {
  _token = null
}

export function isAuthenticated(): boolean {
  return _token !== null
}

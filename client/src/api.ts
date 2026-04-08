const API_BASE = import.meta.env.VITE_BACKEND_URL;

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(API_BASE + path, { credentials: 'include', ...options });
}

export async function apiPost(path: string, body?: any): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiPatch(path: string, body?: any): Promise<Response> {
  return apiFetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiDelete(path: string): Promise<Response> {
  return apiFetch(path, { method: 'DELETE' });
}
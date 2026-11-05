export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('Cannot reach Worklog. Check that the local server is running.');
  }
  let value: { error?: string };
  try {
    value = await response.json();
  } catch {
    throw new Error(
      'The local server returned an invalid response. Restart Worklog and try again.',
    );
  }
  if (!response.ok) throw new Error(value.error ?? 'Request failed.');
  return value as T;
}

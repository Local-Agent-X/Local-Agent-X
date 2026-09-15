// Thin JSON helper shared by every resource module.
export async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

/** The database hands back at most 1,000 rows per request. Keep asking until everything is here. */
export async function pageAll<T = unknown>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = []
  for (let a = 0; ; a += 1000) {
    const { data, error } = await q(a, a + 999)
    if (error) return { data: null, error }
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return { data: out, error: null }
  }
}

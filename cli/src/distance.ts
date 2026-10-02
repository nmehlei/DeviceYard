/** Levenshtein distance, used only to decide whether a did-you-mean is worth
 * printing. Not hot: it runs once, on an error path, over a list of at most a
 * few dozen short strings. */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

/** The closest candidate within an edit distance of 2, or undefined. Two is
 * the threshold where a suggestion stops helping and starts misleading:
 * "--org" and "--url" are three apart and must never suggest each other. */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 3;
  for (const candidate of candidates) {
    const score = distance(candidate, input);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

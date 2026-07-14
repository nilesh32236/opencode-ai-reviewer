function tokenize(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function clusterFindings(
  messages: string[],
  threshold = 0.3,
): Array<{ centroid: string; messages: string[] }> {
  if (messages.length === 0) return [];

  const tokens = messages.map((m) => tokenize(m));
  const assigned = new Array(messages.length).fill(false);
  const clusters: Array<{ centroid: string; messages: string[] }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (assigned[i]) continue;

    const cluster: string[] = [messages[i]];
    assigned[i] = true;

    for (let j = i + 1; j < messages.length; j++) {
      if (assigned[j]) continue;
      const sim = jaccardSimilarity(tokens[i], tokens[j]);
      if (sim >= threshold) {
        cluster.push(messages[j]);
        assigned[j] = true;
      }
    }

    if (cluster.length >= 2) {
      clusters.push({ centroid: messages[i], messages: cluster });
    }
  }

  return clusters;
}

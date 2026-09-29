const RELEASE_ROOT = 'https://github.com/J3n5en/EnsoCode/releases/download/';
const TAG = /^ensobot-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 不使用 GitHub /latest：它属于 EnsoCode，EnsoBot 是同仓库独立产品。 */
export function selectEnsobotFeed(raw: unknown) {
  if (!Array.isArray(raw)) throw new Error('Invalid EnsoBot release response');
  const candidates = raw.flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      item.draft !== false ||
      typeof item.tag_name !== 'string'
    )
      return [];
    const match = TAG.exec(item.tag_name);
    if (!match) return [];
    const version = match.slice(1).map(Number);
    if (!version.every(Number.isSafeInteger)) return [];
    return [{ tag: item.tag_name, version }];
  });
  candidates.sort(
    (a, b) =>
      b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]
  );
  const latest = candidates[0];
  if (!latest) throw new Error('No published EnsoBot release found');
  return {
    provider: 'generic' as const,
    channel: 'ensobot',
    url: `${RELEASE_ROOT}${latest.tag}/`,
    useMultipleRangeRequest: false,
  };
}

/** Semantic-version ordering and exact-commit release validation. */
export function parseReleaseVersion(value) {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      String(value).trim(),
    );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index])
      return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function validateReleaseVersion({
  version,
  tags,
  headTags = [],
  requireExactTag = false,
}) {
  const current = parseReleaseVersion(version);
  if (!current) throw new Error(`Invalid module version: ${version}`);
  const released = tags
    .map((name) => ({ name, parsed: parseReleaseVersion(name) }))
    .filter((tag) => tag.parsed);
  const latest = released.sort((a, b) =>
    compareReleaseVersions(b.parsed, a.parsed),
  )[0];
  if (latest && compareReleaseVersions(current, latest.parsed) < 0)
    throw new Error(
      `Manifest version ${version} is behind the latest tag ${latest.name}. Sync the release source or bump its version.`,
    );
  if (requireExactTag && !headTags.includes(`v${version}`))
    throw new Error(
      `Release requires the exact tag v${version} at HEAD. Commit and tag this version before building a release.`,
    );
  return latest?.name ?? null;
}

type ParsedVersion = {
  core: [number, number, number]
  prerelease: Array<number | string>
}

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export const parseVersion = (value: string): ParsedVersion | null => {
  const match = value.trim().match(versionPattern)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  }
}

export const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error('invalid semantic version')
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export const isVersion = (value: string) => parseVersion(value) !== null

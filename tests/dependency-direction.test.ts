/**
 * Report I.28: dependencies point inward. `apps/web` depends on feature
 * packages, which depend on `domain`, `schemas`, `events` and `db`; nothing
 * inward depends on anything outward.
 *
 * The report says to add an eslint import boundary "when apps/web lands,
 * because that is the first point where the rule can actually be broken by
 * accident". It has landed, and this is the enforcement instead. pnpm links
 * strictly: a package can only import what its own package.json declares, so
 * the declared graph *is* the import graph, and checking the declarations
 * catches the same mistake without adding a lint toolchain to re-derive what
 * the package manager already enforces.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Rings, innermost first. A package may depend on its own ring and inward. */
const RINGS: string[][] = [
  ['@mineral/domain'],
  ['@mineral/events', '@mineral/schemas'],
  ['@mineral/db', '@mineral/identity', '@mineral/ingest', '@mineral/ai', '@mineral/research', '@mineral/monitoring'],
  ['@mineral/web'],
];

const ringOf = new Map<string, number>();
RINGS.forEach((ring, index) => ring.forEach((name) => ringOf.set(name, index)));

function manifests(): { name: string; deps: string[] }[] {
  const found: { name: string; deps: string[] }[] = [];
  for (const group of ['packages', 'apps']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, 'package.json');
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      found.push({
        name: parsed.name,
        deps: [
          ...Object.keys(parsed.dependencies ?? {}),
          ...Object.keys(parsed.devDependencies ?? {}),
        ].filter((dep) => dep.startsWith('@mineral/')),
      });
    }
  }
  return found;
}

describe('dependency direction (report I.28)', () => {
  const packages = manifests();

  it('knows every workspace package', () => {
    expect(packages.length).toBeGreaterThan(0);
    for (const pkg of packages) {
      expect(ringOf.has(pkg.name), `${pkg.name} is not placed in a ring`).toBe(true);
    }
  });

  it('never depends outward', () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      const ring = ringOf.get(pkg.name);
      if (ring === undefined) continue;
      for (const dep of pkg.deps) {
        const depRing = ringOf.get(dep);
        if (depRing === undefined) {
          violations.push(`${pkg.name} depends on unknown ${dep}`);
        } else if (depRing > ring) {
          violations.push(`${pkg.name} (ring ${ring}) depends outward on ${dep} (ring ${depRing})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps domain free of workspace dependencies', () => {
    const domain = packages.find((pkg) => pkg.name === '@mineral/domain');
    expect(domain?.deps).toEqual([]);
  });
});

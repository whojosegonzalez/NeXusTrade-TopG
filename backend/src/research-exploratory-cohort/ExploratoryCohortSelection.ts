import { createHash } from "node:crypto";

import type {
  DiscoveryCandidate,
  ExploratoryCohortPartition,
  SlotRecord,
} from "./ExploratoryCohortTypes.js";

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface SlotSelection {
  readonly candidate?: DiscoveryCandidate;
  readonly partition?: ExploratoryCohortPartition;
  readonly slotRecord: SlotRecord;
  readonly duplicateCount: number;
}

export function selectExploratoryCohortUnit(input: {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly slotIndex: number;
  readonly slotId: string;
  readonly anchorAt: Date;
  readonly priorMints: ReadonlySet<string>;
}): SlotSelection {
  const canonicalByMint = new Map<string, DiscoveryCandidate>();
  let technicallyValid = 0;

  for (const candidate of input.candidates) {
    if (
      !isCanonicalSolanaMint(candidate.mint) ||
      !candidate.sourceKind ||
      !isFiniteDate(candidate.firstObservedAt)
    ) {
      continue;
    }
    technicallyValid += 1;
    if (!canonicalByMint.has(candidate.mint)) canonicalByMint.set(candidate.mint, candidate);
  }

  const canonical = [...canonicalByMint.values()];
  const eligible = canonical.filter((candidate) => !input.priorMints.has(candidate.mint));
  const discoveryCounts = {
    returned: input.candidates.length,
    canonical: canonical.length,
    technicallyValid,
  };
  const duplicateCount = Math.max(0, input.candidates.length - canonical.length);

  if (eligible.length === 0) {
    return {
      duplicateCount,
      slotRecord: {
        slotId: input.slotId,
        slotIndex: input.slotIndex,
        anchorAt: input.anchorAt.toISOString(),
        state: "NO_SELECTION",
        reason: canonical.length === 0 ? "NO_TECHNICALLY_VALID_CANONICAL_MINT" : "DUPLICATE_MINT",
        discoveryCounts,
      },
    };
  }

  const candidate = [...eligible].sort((left, right) =>
    selectionHash(left.mint, input.slotId).localeCompare(selectionHash(right.mint, input.slotId)),
  )[0] as DiscoveryCandidate;
  return {
    candidate,
    duplicateCount,
    partition: partitionFor(candidate.mint, input.slotId),
    slotRecord: {
      slotId: input.slotId,
      slotIndex: input.slotIndex,
      anchorAt: input.anchorAt.toISOString(),
      state: "SKIP_UNIT_WITH_REASON",
      reason: "AWAITING_REQUIRED_ANCHOR",
      discoveryCounts,
      selectedMint: candidate.mint,
    },
  };
}

export function partitionFor(mint: string, slotId: string): ExploratoryCohortPartition {
  const hash = createHash("sha256")
    .update(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`)
    .digest("hex");
  const final = hash.at(-1) ?? "0";
  return Number.parseInt(final, 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
}

export function isCanonicalSolanaMint(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  return decodeBase58Length(value) === 32;
}

function selectionHash(mint: string, slotId: string): string {
  return createHash("sha256")
    .update(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`)
    .digest("hex");
}

function isFiniteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function decodeBase58Length(value: string): number {
  const bytes = [0];
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return 0;
    let carry = digit;
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      const next = (bytes[index] as number) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  for (const character of value) {
    if (character !== "1") break;
    leadingZeroes += 1;
  }
  return bytes.length + leadingZeroes - (bytes.length === 1 && bytes[0] === 0 ? 1 : 0);
}

/**
 * Categorical slots are assigned in fixed order and never cycled: tag #5 falls
 * into the muted "other" slot rather than reusing tag #1's colour. Every tag is
 * also direct-labelled with its short address, so identity never rests on
 * colour alone.
 */

const SLOTS = ['var(--s0)', 'var(--s1)', 'var(--s2)', 'var(--s3)'] as const;

export function slotVar(slot: number): string {
  return slot >= 0 && slot < SLOTS.length ? SLOTS[slot]! : 'var(--other)';
}

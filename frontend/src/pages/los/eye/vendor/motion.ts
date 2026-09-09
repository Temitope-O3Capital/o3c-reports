/**
 * Shared motion helpers.
 *
 * Anything that delays an unmount to let an exit animation play must check
 * this first — under prefers-reduced-motion the animation is collapsed to
 * ~0ms by styles.css, so the JS timeout would just be dead time where nothing
 * visibly happens, making close/navigate feel sluggish for exactly the users
 * who asked for less motion.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

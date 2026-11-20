// Placeholder. The step module's owner replaces the body; these signatures are fixed.

/**
 * `tool`: code. `agent`: a language-model session that works a task.
 * `advisory`: a language-model role with no queue, woken only by mentions.
 */
export type RoleKind = "tool" | "agent" | "advisory";

export interface RoleInfo {
  name: string;
  kind: RoleKind;
}

/** Every role this build knows, for `socialv up` to start. */
export function listRoles(): RoleInfo[] {
  return [];
}

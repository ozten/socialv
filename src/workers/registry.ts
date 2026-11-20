// Every role this build knows. To add one, define it next to its peers
// (`tools/`, `agents/<role>/`) and list it here.

import { annotator } from "./agents/annotator/index.ts";
import { creativeDirector } from "./agents/creative-director/index.ts";
import { toyDirector } from "./agents/toy-director/index.ts";
import { toyWriter } from "./agents/toy-writer/index.ts";
import { echo } from "./tools/echo.ts";
import { gateway } from "./tools/gateway.ts";
import { blueprint } from "./tools/blueprint.ts";
import { probe } from "./tools/probe.ts";
import { shots } from "./tools/shots.ts";
import type { Role } from "./types.ts";

/**
 * `tool`: code. `agent`: a language-model session that works a task.
 * `advisory`: a language-model role with no queue, woken only by mentions.
 */
export type RoleKind = "tool" | "agent" | "advisory";

export interface RoleInfo {
  name: string;
  kind: RoleKind;
  /** The channel (or `prefix/` subtree) whose ready tasks the role's worker claims. Default `work/`. */
  channel?: string;
}

const ROLES: Role[] = [echo, probe, shots, blueprint, toyWriter, toyDirector, gateway, annotator, creativeDirector];

/** Every role this build knows, for `socialv up` to start. */
export function listRoles(): RoleInfo[] {
  return ROLES.map(({ name, kind }) => ({ name, kind }));
}

/** The role named `name`, or undefined. */
export function getRole(name: string): Role | undefined {
  return ROLES.find((role) => role.name === name);
}

/** Names of the advisory roles: they may not mention, or be woken by, each other. */
export function advisoryRoles(): string[] {
  return ROLES.filter((role) => role.kind === "advisory").map((role) => role.name);
}

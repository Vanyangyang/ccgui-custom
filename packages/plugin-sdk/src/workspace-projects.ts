/** A project view associates existing local workspace directories. It does not
 * grant filesystem access, change a session cwd, or move project memory. */
export interface WorkspaceProjectMemberDefinition {
  id: string;
  path: string;
  label: string;
  /** A descriptive role, not an operating-system read-only restriction. */
  role: "development" | "reference";
}

export interface WorkspaceProjectDefinition {
  name: string;
  /** Must exactly match one member's path. Used only for new conversations. */
  defaultPath: string;
  members: WorkspaceProjectMemberDefinition[];
}

export interface PublishedWorkspaceProject {
  /** Host projection identity; the publisher's source key remains unchanged. */
  id: string;
}

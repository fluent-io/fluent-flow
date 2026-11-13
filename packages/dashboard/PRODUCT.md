# Dashboard product notes

[Dashboard README](README.md) · [Projects spec](../../docs/plans/2026-11-03-projects-spec.md)

Confirmed facts only. Design decisions that have not been agreed with the product owner do not belong here.

## Users

- Internal users sign in with GitHub or a provisioned password and also see the organization-scoped Agents, Repos, Pipelines and Settings screens.
- Invited client collaborators sign in with a password and see Board, Projects and Needs attention.

## Projects

- Projects is visible to every signed-in collaboration user and lists only their authorized projects, grouped by workspace.
- Members can read a project's name, overview, run instructions and test instructions. Project administrators can edit them. Workspace administrators can create projects.
- A project page links to its Board, and to Settings when the user can administer the project or its members. It never shows execution configuration or hosts.

## Current project

- The header has a Current project selector with workspace labels and an All projects option.
- The choice survives navigation and reload, is kept per signed-in principal and session version (signing in again keeps it; revoking sessions forgets it), and is checked against current memberships. A revoked or foreign saved choice falls back to All projects.
- Board and task creation use the selection. Board project links and project/task pages take precedence. Changing the selection on a task goes to the selected project's board.
- Agents, Repos and Pipelines stay organization-scoped.

## Look

- The existing dark dashboard style is kept. Header and project pages work at desktop and narrow widths.

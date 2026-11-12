# WoodPecker-OS

A computer that is alive: a NixOS virtual machine whose whole interface is Woody, a Claude-powered mind that lives in it. You interact with it instead of controlling it. Woody has its own time, memory, goals and interests, a screen it shapes itself, and the ability to change its own program, on top of a small locked core that keeps the machine recoverable.

- **[docs/VISION.md](docs/VISION.md)**: the goal, the decisions and the design.
- **[docs/PLAN.md](docs/PLAN.md)**: what is built, and the phases to come.
- **[docs/INSTALL.md](docs/INSTALL.md)** and **[docs/REBUILD-ROLLBACK.md](docs/REBUILD-ROLLBACK.md)**: installing the VM, rebuilding it, going back.
- **[docs/MIND.md](docs/MIND.md)**: how Woody's loop, memory and goals work today.
- **[docs/HUD.md](docs/HUD.md)**: the screen as it is today.
- **[docs/EXECUTOR.md](docs/EXECUTOR.md)**, **[docs/AGENT.md](docs/AGENT.md)**, **[docs/SELFMOD.md](docs/SELFMOD.md)**: the privileged core, the agent, and how Woody changes its own system.

Status (2026-11-12): the base system, the privileged core, the mind and the first HUD are built. The canvas, the inner state and the rest of the redesign are designed and not yet built.

The project first aimed at a security-testing toolkit for a home lab. That goal was dropped on 2026-11-12 and its code removed.

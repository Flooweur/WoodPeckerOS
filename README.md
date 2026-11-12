# WoodPecker-OS

A computer that is alive: a NixOS virtual machine whose whole interface is Woody, a Claude-powered mind that lives in it. You interact with it instead of controlling it. Woody has its own time, memory, goals and interests, a screen it shapes itself, and the ability to change its own program, on top of a small locked core that keeps the machine recoverable.

- **[docs/VISION.md](docs/VISION.md)**: the goal, the decisions and the design.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: how it is built today: the parts, who can talk to whom, the agent file by file, what a session may do, money, tests.
- **[docs/PLAN.md](docs/PLAN.md)** and **[docs/REVIEW.md](docs/REVIEW.md)**: the phases, the review of 2026-11-12, and the order of work that follows.
- **[docs/INSTALL.md](docs/INSTALL.md)** and **[docs/REBUILD-ROLLBACK.md](docs/REBUILD-ROLLBACK.md)**: installing the VM, rebuilding it, going back.
- **[docs/MIND.md](docs/MIND.md)**: how Woody's loop, memory, goals, reading, studies, methods, own life and identity work.
- **[docs/HUD.md](docs/HUD.md)**: the screen as it is today.
- **[docs/EXECUTOR.md](docs/EXECUTOR.md)**, **[docs/AGENT.md](docs/AGENT.md)**, **[docs/SELFMOD.md](docs/SELFMOD.md)**: the privileged core, the agent, and how Woody changes its own system.
- **[docs/HISTORY.md](docs/HISTORY.md)**: what each phase built, and the designs that were replaced.

Status (2026-11-12): the base system, the privileged core, the mind, the canvas, Woody's own life, studies and its methods are built and tested in the VM. A review of the whole project then set the next steps. The cleanup and the restructuring are done; next comes a workbench where Woody runs real programs.

The project first aimed at a security-testing toolkit for a home lab. That goal was dropped on 2026-11-12 and its code removed.

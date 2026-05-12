# project-docs

Public-facing project documentation. The root [`README.md`](../README.md) is the entry point; the files in this folder hold the detail behind each of its six sections.

| File | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component model, request flows, all design-decision rationale |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Prereqs, env vars, local build, CI/CD pipelines, lb02 manual update, ops commands |
| [SCALING.md](SCALING.md) | Per-bottleneck analysis: problem → evidence → fix → effect → tradeoff |
| [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) | Repo layout, key files, how-to recipes, debugging, known issues |
| [TEAM.md](TEAM.md) | Per-member contributions, communication, deadline process |
| [diagrams/](diagrams/) | Architecture diagram (mermaid source + rendered PNG) |

For raw session notes, performance investigations, and Claude-assisted artifacts that aren't curated for the rubric, see [`../claude-docs/`](../claude-docs/).

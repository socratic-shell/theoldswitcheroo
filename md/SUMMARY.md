# Summary

- [Overview](./overview.md)
- [Architecture](./architecture.md)
- [MVP](./mvp.md)
- [Components](./components.md)
  - [Setup Tool](./components/setup-tool.md)
  - [Electron App](./components/electron-app.md)
  - [MCP Server](./components/mcp-server.md)
- [Development](./development.md)

# Technical details

<!-- Describes how we manage the SSH connection(s) to the host -->
- [SSH connection handling](./ssh-connection-handling.md)
<!-- Describes the daemon-based communication system between taskspaces and Electron app -->
- [TaskSpace communication architecture](./taskspace-communication-architecture.md)

# Reference Material

<!--
Agents: these are research reports and other detailed documents.
Please read them as needed to get up to speed on particular topics.
-->


<!-- This document contains comprehensive technical architecture for multi-session remote VSCode systems. Content includes: system architecture, SSH tunnel management, session lifecycle, security considerations, performance analysis, deployment strategies, cost analysis, and implementation timelines. Use this for: architectural decisions, scaling considerations, production deployment planning.-->
- [Multi-Session Remote VS Code Architecture](./references/multi-session-vscode-technical-report.md)


<!-- This document provides practical implementation guidance for integrating openvscode-server with Electron applications. Content includes: webview configuration, authentication handling, connection troubleshooting, security setup, debugging techniques, and working code examples for Electron + remote VSCode integration. Use this for: solving webview integration issues, debugging connection problems, implementing authentication. -->
- [Complete Guide to Integrating openvscode-server with Electron](./references/complete-guide-to-integrating-openvscode-server-with-electron.md)


<!-- This document provides comprehensive strategies for ensuring VSCode server processes terminate when SSH connections drop. Content includes: built-in VSCode flags, systemd user services with cgroup tracking, PAM session hooks, process supervision tools, container isolation, and TTY monitoring. Use this for: solving orphaned process issues, implementing reliable server cleanup, production deployment strategies, debugging process termination problems. -->
- [Process termination strategies](./references/process-termination-strategies.md)


<!-- This document provides comprehensive guidance for SSH ControlMaster connection multiplexing in Node.js applications. Content includes: performance benchmarks (99%+ speed improvement), complete implementation classes, socket management, security considerations, troubleshooting guides, and best practices. Use this for: optimizing SSH connection performance, implementing connection reuse, managing multiple SSH sessions efficiently, debugging connection issues. -->
- [SSH ControlMaster](./references/ControlMaster-Report.md)


<!-- This document provides comprehensive guidance for SSH session management in Node.js applications using system SSH binary wrapping. Content includes: child_process patterns, ssh-config parsing, node-pty terminal emulation, ControlMaster multiplexing, ProxyCommand handling, background process management, security validation, and performance optimization. Use this for: implementing robust SSH connections, handling complex SSH configurations, managing remote processes, debugging SSH connectivity issues. -->
- [SSH Session Management in Node.js with System Binary Wrapping](./references/SSH-Session-Management-in-Node-with-System-Binary-Wrapping.md)


<!-- This document provides comprehensive guidance for VSCode server multi-session architecture using data directory flags and symlink strategies. Content includes: --user-data-dir vs --server-data-dir separation, extensions directory management, directory structuring for shared settings with isolated workspace state, setup scripts for session creation, and implementation patterns for replicating local "File → New Window" behavior remotely. Use this for: solving session persistence issues, implementing multi-session data strategies, sharing user preferences across sessions while maintaining workspace isolation. -->
- [VSCode Server Multi-Session Architecture Guide](./references/vscode-multi-session-architecture-guide.md)

OpenVSCode Server provides robust extension management through `--install-extension` flags that support marketplace IDs, local .vsix files, and remote URLs. Each multiplexer taskspace requires isolated `--user-data-dir` and `--extensions-dir` directories for complete separation. Extensions can be pre-installed at runtime (not during Docker builds due to missing IPC hooks), and custom .vsix files work seamlessly alongside marketplace extensions when deployed to each taskspace's isolated extension directory.

- [Installing VSCode Extensions](./references/installing-vscode-extensions.md)
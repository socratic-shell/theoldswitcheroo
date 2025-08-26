# Summary

- [Overview](./overview.md)
- [Architecture](./architecture.md)
- [Components](./components.md)
  - [Setup Tool](./components/setup-tool.md)
  - [Electron App](./components/electron-app.md)
  - [MCP Server](./components/mcp-server.md)
- [Development](./development.md)

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
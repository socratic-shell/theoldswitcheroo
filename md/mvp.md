# MVP

Notes describing the overall architecture we want for the MVP demo.

Key:

* The `[ ]` items indicate work that still remains to be done.
* The `[x]` items indicate completed work.
* Notations like [#4](https://github.com/socratic-shell/theoldswitcheroo/issues/4) refer to github issues tracking this work.

## Concepts and terms

* [x] A *project* defines a particular application that is under development via
    * [x] a `fresh-clone.sh` script that creates a fresh clone of the project (e.g., by executing `git clone`)
    * [x] a `vscode-extensions.json` file that defines the VSCode extensions needed for that project
    * [ ] a set of 
* [x] A *portal* is an instance of the project, containing its own
    * VSCode server settings
    * 

## Electron App

* [x] Presents the UI to the user
* [x] Connects to the host via SSH to run commands as needed
* [x] Loads from the local machine:
    * [x] project descriptions
    * [x] custom VSCode extension definition
* Creates an IPC daemon

## Open VSCode Server

* Installed from github (gitpod.io release) onto the remote desktop
* Runs for each session

## Setting up a new portal
## theoldswitcheroo-daemon

## theoldswitcheroo-daemon

* Daemon

* Electron app (runs on user's machine)
    * Loads project description
    * 
* Project
* IPC bus
    * Receives messages from the electron app or from servers and CLI running on the remote host
    * 


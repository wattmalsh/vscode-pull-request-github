# CLAUDE.md

## After pushing to master

Build and install the extension yourself, then tell Matt to reload his VS Code windows:

1. `npm ci` if `node_modules` is missing
2. `npm run bundle`
3. `npx @vscode/vsce package -o <scratchpad>/pr.vsix`
4. `code --install-extension <scratchpad>/pr.vsix --force`

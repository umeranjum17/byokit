// The byokit packages come from this repository (file: links), so Metro watches them and resolves their own
// dependencies from the repository's node_modules, as an install from npm would bring them. React is the one
// exception: the repository has its own copy for tests, and an app must have exactly one, its own.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const repo = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(repo, 'packages'), path.join(repo, 'node_modules')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.join(repo, 'node_modules')];
config.resolver.blockList = [new RegExp(`^${path.join(repo, 'node_modules', 'react').replace(/[/\\.]/g, '\\$&')}/.*`)];
module.exports = config;

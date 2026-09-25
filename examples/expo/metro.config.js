// The byokit packages come from this repository (file: links), so Metro watches them and resolves their imports from
// this app's own node_modules, never the repository's: one React, and none of the repository's Node-only dependencies.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const repo = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(repo, 'packages')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.blockList = [new RegExp(`^${path.join(repo, 'node_modules').replace(/[/\\.]/g, '\\$&')}/.*`)];
module.exports = config;

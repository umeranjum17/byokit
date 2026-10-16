// The byokit packages come from this repository (file: links), so Metro watches them and resolves their own
// dependencies from the repository's node_modules, as an install from npm would bring them. React, React Native
// and the Expo modules are the exception: the app must bundle exactly one copy, its own. That pin comes from
// "experiments.autolinkingModuleResolution" in app.json, so no blockList is needed here.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const repo = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(repo, 'examples'), path.join(repo, 'packages'), path.join(repo, 'node_modules')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.join(repo, 'node_modules')];
module.exports = config;

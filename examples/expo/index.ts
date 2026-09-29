import './polyfills';
import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';

import App, { BubblePanel } from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// The panel @byokit/overlay opens on a bubble tap (start's `panel` key).
AppRegistry.registerComponent('bubblePanel', () => BubblePanel);

import { createApp } from 'vue';
import App from './App.vue';
import ServerOwner from './ServerOwner.vue';
import './style.css';
import {readUiScale,applyUiScale} from '../shared/ui-scale.mjs';
applyUiScale(readUiScale());
createApp(location.pathname === '/admin' ? ServerOwner : App).mount('#app');
